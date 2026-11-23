/**
 * GDTV2 Cloudflare R2 Media API Worker
 *
 * Provides authenticated media upload/list/delete/rename endpoints for TinaCMS
 * and GitHub Actions CI transcoding, backed directly by an R2 bucket binding.
 *
 * - Streams request bodies directly to R2 (no full-file buffering in Worker RAM).
 * - Uses Web Crypto SHA-256 + timingSafeEqual for secret verification.
 * - Verifies TinaCMS browser sessions against TinaCloud before permitting writes.
 */

export interface Env {
  MEDIA_BUCKET: R2Bucket;
  PUBLIC_MEDIA_URL: string;
  ALLOWED_ORIGINS: string;
  TINA_CLIENT_ID?: string;
  TINA_BRANCH?: string;
  CI_UPLOAD_TOKEN?: string;
  ADMIN_UPLOAD_TOKEN?: string;
}

const MAX_DIRECT_UPLOAD_BYTES = 95 * 1024 * 1024; // 95 MB (Cloudflare Workers Free plan max request body is 100 MB; larger files use /media/multipart/*)
const GENERATED_PREFIX = '.generated/';
const TELEMETRY_PREFIX = '.generated/logs/';
const MAX_TELEMETRY_EVENTS = 60;
const MAX_TELEMETRY_BODY_BYTES = 8192;

const ALLOWED_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'svg',
  'mp4',
  'webm',
  'mov',
  'm4v',
  'ogg',
]);

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  ogg: 'video/ogg',
};

function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowedList = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const allowOrigin =
    allowedList.includes('*') || (origin && allowedList.includes(origin))
      ? origin || '*'
      : allowedList[0] || '*';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, X-Media-Type, X-Media-Duration, X-Media-Width, X-Media-Height, X-Source-Hash, X-Original-Key, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(
  data: unknown,
  status: number,
  corsHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

async function timingSafeTokenEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

async function authorizeRequest(
  request: Request,
  env: Env
): Promise<{ authorized: boolean; actor: 'ci' | 'admin' | 'tina' | 'none' }> {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : '';

  if (!token) {
    return { authorized: false, actor: 'none' };
  }

  if (env.CI_UPLOAD_TOKEN && (await timingSafeTokenEqual(token, env.CI_UPLOAD_TOKEN.trim()))) {
    return { authorized: true, actor: 'ci' };
  }

  if (env.ADMIN_UPLOAD_TOKEN && (await timingSafeTokenEqual(token, env.ADMIN_UPLOAD_TOKEN.trim()))) {
    return { authorized: true, actor: 'admin' };
  }

  // Validate logged-in TinaCMS editor JWT against TinaCloud content endpoint
  if (env.TINA_CLIENT_ID) {
    const branch = env.TINA_BRANCH || 'main';
    const tinaUrl = `https://content.tinajs.io/1.6/content/${encodeURIComponent(
      env.TINA_CLIENT_ID
    )}/github/${encodeURIComponent(branch)}`;

    try {
      const verifyRes = await fetch(tinaUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: '{ __typename }' }),
      });

      if (verifyRes.ok) {
        const body = (await verifyRes.json()) as { data?: { __typename?: string }; errors?: unknown[] };
        if (body?.data?.__typename && (!body.errors || body.errors.length === 0)) {
          return { authorized: true, actor: 'tina' };
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'tina token verification failed',
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  return { authorized: false, actor: 'none' };
}

function sanitizeKey(rawKey: string, allowGeneratedPrefix = false): string | null {
  const trimmed = rawKey.trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (!trimmed || trimmed.includes('..') || trimmed.includes('\\')) {
    return null;
  }

  if (trimmed.startsWith(GENERATED_PREFIX) && !allowGeneratedPrefix) {
    return null;
  }

  const segments = trimmed.split('/').map((seg) =>
    seg
      .normalize('NFC')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[<>:"|?*#%]/g, '-')
      .trim()
  );

  if (segments.some((s) => !s || s === '.' || s === '..')) {
    return null;
  }

  const normalized = segments.join('/');
  const ext = getExtension(normalized);
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    return null;
  }

  return normalized;
}

function getExtension(key: string): string {
  const filename = key.split('/').pop() || '';
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

function buildPublicUrl(key: string, request: Request, env: Env): string {
  const encodedKey = key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');

  const base = (env.PUBLIC_MEDIA_URL || '').replace(/\/+$/, '');
  if (base && !base.includes('yourdomain.com')) {
    return `${base}/${encodedKey}`;
  }

  // Fallback to this Worker's /file/<key> streaming endpoint before custom domain is attached
  const origin = new URL(request.url).origin;
  return `${origin}/file/${encodedKey}`;
}

function toTinaMediaItem(obj: R2Object, request: Request, env: Env) {
  const parts = obj.key.split('/');
  const filename = parts.pop() || obj.key;
  const directory = parts.join('/');
  const src = buildPublicUrl(obj.key, request, env);
  const ext = getExtension(filename);
  const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext);

  return {
    id: obj.key,
    type: 'file' as const,
    filename,
    directory,
    src,
    thumbnails: isImage
      ? {
          '75x75': src,
          '400x400': src,
          '1000x1000': src,
        }
      : undefined,
    size: obj.size,
    etag: obj.httpEtag,
    uploaded: obj.uploaded.toISOString(),
    customMetadata: obj.customMetadata || {},
  };
}

async function handleListMedia(
  request: Request,
  url: URL,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const rawDir = (url.searchParams.get('directory') || '').replace(/^\/+|\/+$/g, '');
  const prefix = rawDir ? `${rawDir}/` : '';
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
  const cursor = url.searchParams.get('cursor') || undefined;
  const search = (url.searchParams.get('search') || '').trim().toLowerCase();
  const extParam = (url.searchParams.get('ext') || '').trim().toLowerCase();
  const extFilter = extParam
    ? new Set(extParam.split(',').map((s) => s.trim().replace(/^\./, '')))
    : null;
  const filesOnly = url.searchParams.get('filesOnly') === 'true';

  const listed = await env.MEDIA_BUCKET.list({
    prefix,
    delimiter: search ? undefined : '/',
    limit,
    cursor,
    include: ['customMetadata', 'httpMetadata'],
  });

  const items: Array<Record<string, unknown>> = [];

  if (!filesOnly && !search && listed.delimitedPrefixes) {
    for (const dirPrefix of listed.delimitedPrefixes) {
      const cleanDir = dirPrefix.replace(/\/+$/, '');
      if (cleanDir === '.generated' || cleanDir.startsWith('.generated/')) continue;
      const parts = cleanDir.split('/');
      const dirname = parts.pop() || cleanDir;
      items.push({
        id: cleanDir,
        type: 'dir',
        filename: dirname,
        directory: parts.join('/'),
      });
    }
  }

  for (const obj of listed.objects) {
    if (obj.key.startsWith(GENERATED_PREFIX)) continue;
    const filename = obj.key.split('/').pop() || obj.key;
    if (search && !filename.toLowerCase().includes(search)) continue;
    if (extFilter && !extFilter.has(getExtension(filename))) continue;
    items.push(toTinaMediaItem(obj, request, env));
  }

  return jsonResponse(
    {
      items,
      nextOffset: listed.truncated ? listed.cursor : undefined,
    },
    200,
    corsHeaders
  );
}

async function handleManifest(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;

  do {
    const page = await env.MEDIA_BUCKET.list({
      cursor,
      limit: 500,
      include: ['customMetadata', 'httpMetadata'],
    });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const generatedByOriginal = new Map<
    string,
    {
      optimizedUrl?: string;
      webmUrl?: string;
      posterUrl?: string;
      duration?: number;
      width?: number;
      height?: number;
      sourceHash?: string;
    }
  >();

  for (const obj of objects) {
    if (!obj.key.startsWith(GENERATED_PREFIX)) continue;
    const meta = obj.customMetadata || {};
    const origKey = meta.originalKey;
    if (!origKey) continue;

    const entry = generatedByOriginal.get(origKey) || {};
    const publicUrl = buildPublicUrl(obj.key, request, env);

    if (obj.key.endsWith('.poster.jpg')) {
      entry.posterUrl = publicUrl;
    } else if (obj.key.endsWith('.webm')) {
      entry.webmUrl = publicUrl;
    } else if (obj.key.endsWith('.mp4')) {
      entry.optimizedUrl = publicUrl;
      if (meta.duration) entry.duration = Number(meta.duration);
      if (meta.width) entry.width = Number(meta.width);
      if (meta.height) entry.height = Number(meta.height);
      if (meta.sourceHash) entry.sourceHash = meta.sourceHash;
    }
    generatedByOriginal.set(origKey, entry);
  }

  const manifest: Record<string, unknown> = {};
  for (const obj of objects) {
    if (obj.key.startsWith(GENERATED_PREFIX)) continue;
    const ext = getExtension(obj.key);
    const meta = obj.customMetadata || {};
    const isVideo =
      meta.mediaType === 'video' || ['mp4', 'webm', 'mov', 'm4v', 'ogg'].includes(ext);
    const publicUrl = buildPublicUrl(obj.key, request, env);
    const gen = generatedByOriginal.get(obj.key);

    manifest[publicUrl] = {
      key: obj.key,
      etag: obj.etag,
      type: isVideo ? 'video' : 'image',
      format: ext,
      mimeType: obj.httpMetadata?.contentType || CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream',
      duration: gen?.duration ?? (meta.duration ? Number(meta.duration) : null),
      width: gen?.width ?? (meta.width ? Number(meta.width) : null),
      height: gen?.height ?? (meta.height ? Number(meta.height) : null),
      src: gen?.optimizedUrl || publicUrl,
      webmSrc: gen?.webmUrl || null,
      poster: gen?.posterUrl || null,
      sourceHash: gen?.sourceHash || null,
      size: obj.size,
    };
  }

  return jsonResponse({ manifest }, 200, corsHeaders);
}

async function handleUpload(
  request: Request,
  url: URL,
  env: Env,
  corsHeaders: Record<string, string>,
  actor: 'ci' | 'admin' | 'tina'
): Promise<Response> {
  const rawKey = url.searchParams.get('key') || '';
  const allowGenerated = actor === 'ci' || actor === 'admin';
  const key = sanitizeKey(rawKey, allowGenerated);

  if (!key) {
    return jsonResponse(
      { error: 'Invalid file key or unsupported file extension.' },
      400,
      corsHeaders
    );
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_DIRECT_UPLOAD_BYTES) {
    return jsonResponse(
      { error: 'File exceeds 100 MB Worker direct upload limit.' },
      413,
      corsHeaders
    );
  }

  if (!request.body) {
    return jsonResponse({ error: 'Empty request body.' }, 400, corsHeaders);
  }

  const ext = getExtension(key);
  const contentType =
    request.headers.get('Content-Type') ||
    CONTENT_TYPE_BY_EXT[ext] ||
    'application/octet-stream';

  const customMetadata: Record<string, string> = {};
  const headerMap: Array<[string, string]> = [
    ['X-Media-Type', 'mediaType'],
    ['X-Media-Duration', 'duration'],
    ['X-Media-Width', 'width'],
    ['X-Media-Height', 'height'],
    ['X-Source-Hash', 'sourceHash'],
    ['X-Original-Key', 'originalKey'],
  ];

  for (const [headerName, metaKey] of headerMap) {
    const val = request.headers.get(headerName);
    if (val) customMetadata[metaKey] = val;
  }

  // Stream body directly into R2 — never buffer large videos in Worker RAM
  const uploaded = await env.MEDIA_BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata,
  });

  if (!uploaded) {
    return jsonResponse({ error: 'R2 upload failed.' }, 500, corsHeaders);
  }

  console.log(
    JSON.stringify({
      message: 'r2 media uploaded',
      actor,
      key,
      size: uploaded.size,
      contentType,
    })
  );

  return jsonResponse(toTinaMediaItem(uploaded, request, env), 201, corsHeaders);
}

async function handleMultipartStart(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
  actor: 'ci' | 'admin' | 'tina'
): Promise<Response> {
  const body = (await request.json()) as {
    key?: string;
    contentType?: string;
    customMetadata?: Record<string, string>;
  };

  const allowGenerated = actor === 'ci' || actor === 'admin';
  const key = sanitizeKey(body.key || '', allowGenerated);
  if (!key) {
    return jsonResponse({ error: 'Invalid file key or unsupported file extension.' }, 400, corsHeaders);
  }

  const ext = getExtension(key);
  const contentType = body.contentType || CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream';

  const multipart = await env.MEDIA_BUCKET.createMultipartUpload(key, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: body.customMetadata || {},
  });

  return jsonResponse({ key: multipart.key, uploadId: multipart.uploadId }, 200, corsHeaders);
}

async function handleMultipartPart(
  request: Request,
  url: URL,
  env: Env,
  corsHeaders: Record<string, string>,
  actor: 'ci' | 'admin' | 'tina'
): Promise<Response> {
  const key = sanitizeKey(url.searchParams.get('key') || '', actor === 'ci' || actor === 'admin');
  const uploadId = url.searchParams.get('uploadId') || '';
  const partNumber = Number(url.searchParams.get('partNumber') || 0);

  if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return jsonResponse({ error: 'Invalid multipart parameters.' }, 400, corsHeaders);
  }
  if (!request.body) {
    return jsonResponse({ error: 'Empty part body.' }, 400, corsHeaders);
  }

  const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(key, uploadId);
  const uploadedPart = await multipart.uploadPart(partNumber, request.body);

  return jsonResponse(
    { partNumber: uploadedPart.partNumber, etag: uploadedPart.etag },
    200,
    corsHeaders
  );
}

async function handleMultipartComplete(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
  actor: 'ci' | 'admin' | 'tina'
): Promise<Response> {
  const body = (await request.json()) as {
    key?: string;
    uploadId?: string;
    parts?: R2UploadedPart[];
  };

  const key = sanitizeKey(body.key || '', actor === 'ci' || actor === 'admin');
  const uploadId = body.uploadId || '';
  const parts = Array.isArray(body.parts) ? body.parts : [];

  if (!key || !uploadId || parts.length === 0) {
    return jsonResponse({ error: 'Invalid multipart complete payload.' }, 400, corsHeaders);
  }

  const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(key, uploadId);
  const completed = await multipart.complete(parts);

  console.log(
    JSON.stringify({
      message: 'r2 multipart media uploaded',
      actor,
      key,
      size: completed.size,
      parts: parts.length,
    })
  );

  return jsonResponse(toTinaMediaItem(completed, request, env), 201, corsHeaders);
}

async function handleMultipartAbort(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
  actor: 'ci' | 'admin' | 'tina'
): Promise<Response> {
  const body = (await request.json()) as { key?: string; uploadId?: string };
  const key = sanitizeKey(body.key || '', actor === 'ci' || actor === 'admin');
  const uploadId = body.uploadId || '';

  if (!key || !uploadId) {
    return jsonResponse({ error: 'Invalid multipart abort payload.' }, 400, corsHeaders);
  }

  const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(key, uploadId);
  await multipart.abort();
  return jsonResponse({ aborted: true, key }, 200, corsHeaders);
}

async function handleDelete(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  corsHeaders: Record<string, string>,
  actor: 'ci' | 'admin' | 'tina'
): Promise<Response> {
  const rawKey = url.searchParams.get('key') || '';
  const key = sanitizeKey(rawKey, actor === 'ci' || actor === 'admin');

  if (!key) {
    return jsonResponse({ error: 'Invalid object key.' }, 400, corsHeaders);
  }

  await env.MEDIA_BUCKET.delete(key);

  // Clean up any associated .generated transcodes/posters in the background
  if (!key.startsWith(GENERATED_PREFIX)) {
    ctx.waitUntil(
      (async () => {
        const genList = await env.MEDIA_BUCKET.list({
          prefix: GENERATED_PREFIX,
          include: ['customMetadata'],
        });
        const toDelete = genList.objects
          .filter((o) => o.customMetadata?.originalKey === key)
          .map((o) => o.key);
        if (toDelete.length > 0) {
          await env.MEDIA_BUCKET.delete(toDelete);
        }
      })()
    );
  }

  console.log(JSON.stringify({ message: 'r2 media deleted', actor, key }));
  return jsonResponse({ deleted: key }, 200, corsHeaders);
}

async function handleRename(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
  actor: 'ci' | 'admin' | 'tina'
): Promise<Response> {
  const body = (await request.json()) as { from?: string; to?: string };
  const fromKey = sanitizeKey(body.from || '', false);
  const toKey = sanitizeKey(body.to || '', false);

  if (!fromKey || !toKey) {
    return jsonResponse({ error: 'Invalid source or destination key.' }, 400, corsHeaders);
  }

  const existingDest = await env.MEDIA_BUCKET.head(toKey);
  if (existingDest) {
    return jsonResponse({ error: 'Destination filename already exists.' }, 409, corsHeaders);
  }

  const sourceObj = await env.MEDIA_BUCKET.get(fromKey);
  if (!sourceObj) {
    return jsonResponse({ error: 'Source file not found.' }, 404, corsHeaders);
  }

  const copied = await env.MEDIA_BUCKET.put(toKey, sourceObj.body, {
    httpMetadata: sourceObj.httpMetadata,
    customMetadata: sourceObj.customMetadata,
  });

  if (!copied) {
    return jsonResponse({ error: 'Failed to copy object during rename.' }, 500, corsHeaders);
  }

  await env.MEDIA_BUCKET.delete(fromKey);
  console.log(JSON.stringify({ message: 'r2 media renamed', actor, fromKey, toKey }));

  return jsonResponse(toTinaMediaItem(copied, request, env), 200, corsHeaders);
}

async function handleStreamFile(
  request: Request,
  key: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  let cleanKey = '';
  try {
    cleanKey = decodeURIComponent(key).replace(/^\/+/, '');
  } catch {
    return new Response('Bad Request', { status: 400, headers: corsHeaders });
  }
  if (!cleanKey || cleanKey.includes('..')) {
    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }

  if (request.method === 'HEAD') {
    const headObj = await env.MEDIA_BUCKET.head(cleanKey);
    if (!headObj) {
      return new Response('Not Found', { status: 404, headers: corsHeaders });
    }
    const headers = new Headers(corsHeaders);
    headObj.writeHttpMetadata(headers);
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', CONTENT_TYPE_BY_EXT[getExtension(cleanKey)] || 'application/octet-stream');
    }
    headers.set('ETag', headObj.httpEtag);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', String(headObj.size));
    if (!headers.has('Cache-Control')) {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
    return new Response(null, { status: 200, headers });
  }

  const rangeHeader = request.headers.get('Range');
  const object = await env.MEDIA_BUCKET.get(cleanKey, {
    range: rangeHeader ? request.headers : undefined,
    onlyIf: request.headers,
  });

  if (!object) {
    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }

  const headers = new Headers(corsHeaders);
  object.writeHttpMetadata(headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', CONTENT_TYPE_BY_EXT[getExtension(cleanKey)] || 'application/octet-stream');
  }
  headers.set('ETag', object.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  }

  // Handle conditional 304 Not Modified
  if (!('body' in object) || !object.body) {
    return new Response(null, { status: 304, headers });
  }

  let status = 200;
  if (rangeHeader && object.range) {
    const r = object.range as { offset?: number; length?: number; suffix?: number };
    const offset =
      typeof r.offset === 'number'
        ? r.offset
        : typeof r.suffix === 'number'
          ? Math.max(0, object.size - r.suffix)
          : 0;
    const length =
      typeof r.length === 'number' ? r.length : Math.max(0, object.size - offset);
    const end = Math.min(object.size - 1, offset + length - 1);

    headers.set('Content-Range', `bytes ${offset}-${end}/${object.size}`);
    headers.set('Content-Length', String(end - offset + 1));
    status = 206;
  } else {
    headers.set('Content-Length', String(object.size));
  }

  return new Response(object.body, {
    status,
    headers,
  });
}

async function handlePostTelemetry(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const rawText = await request.text();
  if (!rawText || rawText.length > MAX_TELEMETRY_BODY_BYTES) {
    return jsonResponse({ error: 'Invalid or oversized telemetry payload.' }, 400, corsHeaders);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: 'Malformed JSON.' }, 400, corsHeaders);
  }

  const rawTvId = typeof body.tvId === 'string' ? body.tvId : 'unknown';
  const tvId = rawTvId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'unknown';
  const event = typeof body.event === 'string' ? body.event.slice(0, 64) : 'log';

  const cf = (request as Request & { cf?: { country?: string; colo?: string; tlsVersion?: string; httpProtocol?: string } }).cf;
  const record = {
    receivedAt: new Date().toISOString(),
    tvId,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId.slice(0, 64) : null,
    buildVersion: typeof body.buildVersion === 'string' ? body.buildVersion.slice(0, 32) : null,
    event,
    clientTs: typeof body.ts === 'string' ? body.ts.slice(0, 64) : null,
    ip: request.headers.get('CF-Connecting-IP') || null,
    ua: request.headers.get('User-Agent') || null,
    tls: cf?.tlsVersion || null,
    httpProtocol: cf?.httpProtocol || null,
    colo: cf?.colo || null,
    data: body.data ?? null,
  };

  console.log(JSON.stringify({ message: 'tv_telemetry', ...record }));

  const logKey = `${TELEMETRY_PREFIX}${tvId}.json`;
  let existingEvents: Array<Record<string, unknown>> = [];
  try {
    const existingObj = await env.MEDIA_BUCKET.get(logKey);
    if (existingObj) {
      const parsed = (await existingObj.json()) as { events?: Array<Record<string, unknown>> };
      if (Array.isArray(parsed.events)) {
        existingEvents = parsed.events;
      }
    }
  } catch {
    existingEvents = [];
  }

  existingEvents.push(record);
  if (existingEvents.length > MAX_TELEMETRY_EVENTS) {
    existingEvents = existingEvents.slice(existingEvents.length - MAX_TELEMETRY_EVENTS);
  }

  await env.MEDIA_BUCKET.put(
    logKey,
    JSON.stringify({
      tvId,
      updatedAt: record.receivedAt,
      lastUa: record.ua,
      lastBuildVersion: record.buildVersion,
      lastTls: record.tls,
      lastHttpProtocol: record.httpProtocol,
      events: existingEvents,
    }),
    {
      httpMetadata: {
        contentType: 'application/json',
        cacheControl: 'no-store',
      },
    }
  );

  return jsonResponse({ ok: true }, 200, corsHeaders);
}

async function handleGetTelemetry(
  url: URL,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const tvIdParam = (url.searchParams.get('tvId') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...corsHeaders,
  };

  if (tvIdParam) {
    const obj = await env.MEDIA_BUCKET.get(`${TELEMETRY_PREFIX}${tvIdParam}.json`);
    if (!obj) {
      return new Response(JSON.stringify({ tvId: tvIdParam, events: [] }, null, 2), { status: 200, headers });
    }
    const data = await obj.json();
    return new Response(JSON.stringify(data, null, 2), { status: 200, headers });
  }

  const listed = await env.MEDIA_BUCKET.list({ prefix: TELEMETRY_PREFIX, limit: 50 });
  const devices: Record<string, unknown> = {};
  for (const item of listed.objects) {
    if (!item.key.endsWith('.json')) continue;
    const obj = await env.MEDIA_BUCKET.get(item.key);
    if (!obj) continue;
    try {
      const parsed = (await obj.json()) as { tvId?: string };
      const id = parsed.tvId || item.key.slice(TELEMETRY_PREFIX.length, -5);
      devices[id] = parsed;
    } catch {
      // Ignore corrupt log file
    }
  }

  return new Response(JSON.stringify({ devices }, null, 2), { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const corsHeaders = getCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/health' && request.method === 'GET') {
        return jsonResponse({ ok: true, bucket: 'MEDIA_BUCKET' }, 200, corsHeaders);
      }

      if (url.pathname === '/telemetry' || url.pathname === '/r2/telemetry') {
        if (request.method === 'POST') {
          return await handlePostTelemetry(request, env, corsHeaders);
        }
        if (request.method === 'GET') {
          return await handleGetTelemetry(url, env, corsHeaders);
        }
      }

      if (url.pathname.startsWith('/r2/') && (request.method === 'GET' || request.method === 'HEAD')) {
        return await handleStreamFile(request, url.pathname.slice('/r2/'.length), env, corsHeaders);
      }

      if (url.pathname.startsWith('/file/') && (request.method === 'GET' || request.method === 'HEAD')) {
        return await handleStreamFile(request, url.pathname.slice('/file/'.length), env, corsHeaders);
      }

      if (url.pathname === '/media/manifest' && request.method === 'GET') {
        return await handleManifest(request, env, corsHeaders);
      }

      if (url.pathname === '/media' && request.method === 'GET') {
        return await handleListMedia(request, url, env, corsHeaders);
      }

      // All write/delete/rename operations require authentication
      const auth = await authorizeRequest(request, env);
      if (!auth.authorized || auth.actor === 'none') {
        return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
      }

      if (url.pathname === '/media/upload' && request.method === 'PUT') {
        return await handleUpload(request, url, env, corsHeaders, auth.actor);
      }

      if (url.pathname === '/media/multipart/start' && request.method === 'POST') {
        return await handleMultipartStart(request, env, corsHeaders, auth.actor);
      }

      if (url.pathname === '/media/multipart/part' && request.method === 'PUT') {
        return await handleMultipartPart(request, url, env, corsHeaders, auth.actor);
      }

      if (url.pathname === '/media/multipart/complete' && request.method === 'POST') {
        return await handleMultipartComplete(request, env, corsHeaders, auth.actor);
      }

      if (url.pathname === '/media/multipart/abort' && request.method === 'POST') {
        return await handleMultipartAbort(request, env, corsHeaders, auth.actor);
      }

      if (url.pathname === '/media/object' && request.method === 'DELETE') {
        return await handleDelete(url, env, ctx, corsHeaders, auth.actor);
      }

      if (url.pathname === '/media/rename' && request.method === 'POST') {
        return await handleRename(request, env, corsHeaders, auth.actor);
      }

      return jsonResponse({ error: 'Not Found' }, 404, corsHeaders);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(
        JSON.stringify({
          message: 'unhandled media-api error',
          method: request.method,
          path: url.pathname,
          error: message,
        })
      );
      return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
    }
  },
} satisfies ExportedHandler<Env>;
