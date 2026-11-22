import {
  DEFAULT_MEDIA_UPLOAD_TYPES,
  sanitizeFilename,
  type Media,
  type MediaList,
  type MediaListOptions,
  type MediaStore,
  type MediaUploadOptions,
} from 'tinacms';
import { detectFormatFromBytes } from '../src/utils/media.js';

const DEFAULT_MEDIA_API_URL = 'https://gdtv2-media-api.cyrusliew02.workers.dev';

const MEDIA_API_URL = (
  process.env.NEXT_PUBLIC_MEDIA_API_URL ||
  DEFAULT_MEDIA_API_URL
).replace(/\/+$/, '');

const FALLBACK_ADMIN_TOKEN = (
  process.env.NEXT_PUBLIC_MEDIA_API_TOKEN ||
  ''
).trim();

function probeDroppedVideoMetadata(
  file: File
): Promise<{ duration?: number; width?: number; height?: number }> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const cleanup = () => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };

    const timer = window.setTimeout(() => {
      cleanup();
      resolve({});
    }, 6000);

    video.onloadedmetadata = () => {
      window.clearTimeout(timer);
      const result = {
        duration:
          Number.isFinite(video.duration) && video.duration > 0
            ? Number(video.duration.toFixed(3))
            : undefined,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
      };
      cleanup();
      resolve(result);
    };

    video.onerror = () => {
      window.clearTimeout(timer);
      cleanup();
      resolve({});
    };

    video.src = objectUrl;
  });
}

/**
 * Custom TinaCMS MediaStore backed by Cloudflare R2 via the GDTV2 Media API Worker.
 *
 * - Passes the signed-in TinaCloud JWT in the Authorization header so only
 *   authenticated CMS editors can upload, delete, or rename objects in R2.
 * - Streams raw File objects directly to R2 with auto-detected format & duration headers.
 */
export class R2MediaStore implements MediaStore {
  accept = DEFAULT_MEDIA_UPLOAD_TYPES;
  // Supports files up to 500 MB via automatic 20 MB chunked R2 multipart uploads
  maxSize = 500 * 1024 * 1024;
  searchable = true;
  extensionFilterable = true;

  private static readonly MULTIPART_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MB
  private static readonly MULTIPART_CHUNK_BYTES = 20 * 1024 * 1024; // 20 MB per part (>5 MB R2 min, <100 MB Worker max)

  private tinaClient: any;

  constructor(tinaClient?: any) {
    this.tinaClient = tinaClient;
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    try {
      const tokenObj = await this.tinaClient?.authProvider?.getToken?.();
      const idToken =
        typeof tokenObj === 'string'
          ? tokenObj
          : tokenObj?.id_token || tokenObj?.access_token;
      if (idToken) {
        return { Authorization: `Bearer ${idToken}` };
      }
    } catch {
      // Fall through to optional local dev token
    }

    if (FALLBACK_ADMIN_TOKEN) {
      return { Authorization: `Bearer ${FALLBACK_ADMIN_TOKEN}` };
    }

    return {};
  }

  parse(media: Media): string {
    return media.src || media.id;
  }

  async persist(files: MediaUploadOptions[]): Promise<Media[]> {
    if (!MEDIA_API_URL) {
      throw new Error(
        'NEXT_PUBLIC_MEDIA_API_URL is not configured. Set it to your deployed Cloudflare Worker URL.'
      );
    }

    const authHeaders = await this.getAuthHeaders();
    const uploadedItems: Media[] = [];

    for (const { directory, file } of files) {
      const cleanDir = (directory || '').replace(/^\/+|\/+$/g, '');
      const cleanName = sanitizeFilename(file.name);
      const key = cleanDir ? `${cleanDir}/${cleanName}` : cleanName;

      // Auto-detect media format from magic bytes before upload
      let detectedType: 'image' | 'video' = file.type.startsWith('video/')
        ? 'video'
        : 'image';
      let contentType = file.type || 'application/octet-stream';

      try {
        const headBuf = await file.slice(0, 64).arrayBuffer();
        const magic = detectFormatFromBytes(new Uint8Array(headBuf));
        if (magic) {
          detectedType = magic.type;
          contentType = magic.mimeType;
        }
      } catch {
        // Use browser MIME fallback
      }

      const customMetadata: Record<string, string> = { mediaType: detectedType };
      if (detectedType === 'video') {
        const videoMeta = await probeDroppedVideoMetadata(file);
        if (videoMeta.duration) customMetadata.duration = String(videoMeta.duration);
        if (videoMeta.width) customMetadata.width = String(videoMeta.width);
        if (videoMeta.height) customMetadata.height = String(videoMeta.height);
      }

      if (file.size <= R2MediaStore.MULTIPART_THRESHOLD_BYTES) {
        const headers: Record<string, string> = {
          ...authHeaders,
          'Content-Type': contentType,
          'X-Media-Type': detectedType,
          ...(customMetadata.duration ? { 'X-Media-Duration': customMetadata.duration } : {}),
          ...(customMetadata.width ? { 'X-Media-Width': customMetadata.width } : {}),
          ...(customMetadata.height ? { 'X-Media-Height': customMetadata.height } : {}),
        };

        const uploadUrl = `${MEDIA_API_URL}/media/upload?key=${encodeURIComponent(key)}`;
        const res = await fetch(uploadUrl, {
          method: 'PUT',
          headers,
          body: file,
        });

        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`R2 upload failed (${res.status}): ${errBody}`);
        }

        const item = (await res.json()) as Media;
        uploadedItems.push(item);
      } else {
        // Large video (>50 MB): stream in 20 MB R2 multipart chunks
        const startRes = await fetch(`${MEDIA_API_URL}/media/multipart/start`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, contentType, customMetadata }),
        });
        if (!startRes.ok) {
          throw new Error(`R2 multipart start failed (${startRes.status}): ${await startRes.text()}`);
        }
        const { uploadId } = (await startRes.json()) as { uploadId: string };

        const parts: Array<{ partNumber: number; etag: string }> = [];
        try {
          const chunkSize = R2MediaStore.MULTIPART_CHUNK_BYTES;
          let partNumber = 1;
          for (let offset = 0; offset < file.size; offset += chunkSize) {
            const slice = file.slice(offset, Math.min(file.size, offset + chunkSize));
            const partUrl = `${MEDIA_API_URL}/media/multipart/part?key=${encodeURIComponent(
              key
            )}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;

            const partRes = await fetch(partUrl, {
              method: 'PUT',
              headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' },
              body: slice,
            });
            if (!partRes.ok) {
              throw new Error(`R2 multipart part ${partNumber} failed (${partRes.status}): ${await partRes.text()}`);
            }
            const uploadedPart = (await partRes.json()) as { partNumber: number; etag: string };
            parts.push(uploadedPart);
            partNumber += 1;
          }

          const completeRes = await fetch(`${MEDIA_API_URL}/media/multipart/complete`, {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, uploadId, parts }),
          });
          if (!completeRes.ok) {
            throw new Error(`R2 multipart complete failed (${completeRes.status}): ${await completeRes.text()}`);
          }
          const item = (await completeRes.json()) as Media;
          uploadedItems.push(item);
        } catch (err) {
          await fetch(`${MEDIA_API_URL}/media/multipart/abort`, {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, uploadId }),
          }).catch(() => {});
          throw err;
        }
      }
    }

    return uploadedItems;
  }

  async list(options?: MediaListOptions): Promise<MediaList> {
    if (!MEDIA_API_URL) {
      return { items: [] };
    }

    const params = new URLSearchParams();
    if (options?.directory) params.set('directory', options.directory);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('cursor', String(options.offset));
    if (options?.search) params.set('search', options.search);
    if (options?.filesOnly) params.set('filesOnly', 'true');
    if (options?.ext && options.ext.length > 0) {
      params.set('ext', options.ext.join(','));
    }

    const res = await fetch(`${MEDIA_API_URL}/media?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Failed to list R2 media (${res.status})`);
    }

    const data = (await res.json()) as { items?: Media[]; nextOffset?: string };
    return {
      items: data.items || [],
      nextOffset: data.nextOffset,
    };
  }

  async delete(media: Media): Promise<void> {
    if (!MEDIA_API_URL) return;
    const authHeaders = await this.getAuthHeaders();
    const key = media.id || (media.directory ? `${media.directory}/${media.filename}` : media.filename);

    const res = await fetch(`${MEDIA_API_URL}/media/object?key=${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: authHeaders,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Failed to delete R2 media (${res.status}): ${errBody}`);
    }
  }

  async rename(from: string, to: string): Promise<Media> {
    if (!MEDIA_API_URL) {
      throw new Error('NEXT_PUBLIC_MEDIA_API_URL is not configured.');
    }

    const authHeaders = await this.getAuthHeaders();
    const res = await fetch(`${MEDIA_API_URL}/media/rename`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Failed to rename R2 media (${res.status}): ${errBody}`);
    }

    return (await res.json()) as Media;
  }
}
