/**
 * One-time helper to migrate existing files in public/assets/ to Cloudflare R2
 * via the deployed GDTV2 Media API Worker, and rewrite /assets/... paths inside
 * src/data/tv*.json and src/data/takeovers/*.json to the new R2 URLs.
 *
 * Usage:
 *   MEDIA_API_URL=https://gdtv2-media-api.<subdomain>.workers.dev \
 *   CI_UPLOAD_TOKEN=<your-secret> \
 *   node scripts/migrate-to-r2.js [--dry-run]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectFormatFromBytes, normalizeAssetPath } from '../src/utils/media.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT_DIR, 'public/assets');
const DATA_DIR = path.join(ROOT_DIR, 'src/data');
const TAKEOVERS_DIR = path.join(DATA_DIR, 'takeovers');

const DRY_RUN = process.argv.includes('--dry-run');
const MEDIA_API_URL = (process.env.MEDIA_API_URL || '').replace(/\/+$/, '');
const CI_UPLOAD_TOKEN = process.env.CI_UPLOAD_TOKEN || process.env.R2_CI_UPLOAD_TOKEN || '';

function sanitizeR2Key(filename) {
  const withoutControlChars = Array.from(filename.normalize('NFC'))
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
  return withoutControlChars
    .replace(/\s+/g, '-')
    .replace(/[<>:"|?*#%&[\]()]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const MULTIPART_THRESHOLD_BYTES = 50 * 1024 * 1024;
const MULTIPART_CHUNK_BYTES = 20 * 1024 * 1024;

async function uploadFileToR2(r2Key, filePath, detected) {
  const stat = fs.statSync(filePath);
  const authHeader = { Authorization: `Bearer ${CI_UPLOAD_TOKEN}` };

  if (stat.size <= MULTIPART_THRESHOLD_BYTES) {
    const uploadUrl = `${MEDIA_API_URL}/media/upload?key=${encodeURIComponent(r2Key)}`;
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        ...authHeader,
        'Content-Type': detected.mimeType,
        'X-Media-Type': detected.type,
      },
      body: fs.readFileSync(filePath),
    });
    if (!res.ok) {
      throw new Error(`Upload failed for ${r2Key} (${res.status}): ${await res.text()}`);
    }
    return res.json();
  }

  // >50 MB file: stream in 20 MB R2 multipart chunks
  const startRes = await fetch(`${MEDIA_API_URL}/media/multipart/start`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: r2Key,
      contentType: detected.mimeType,
      customMetadata: { mediaType: detected.type },
    }),
  });
  if (!startRes.ok) {
    throw new Error(`Multipart start failed for ${r2Key} (${startRes.status}): ${await startRes.text()}`);
  }
  const { uploadId } = await startRes.json();
  const fd = fs.openSync(filePath, 'r');
  const parts = [];

  try {
    let partNumber = 1;
    let offset = 0;
    while (offset < stat.size) {
      const len = Math.min(MULTIPART_CHUNK_BYTES, stat.size - offset);
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, offset);

      const partUrl = `${MEDIA_API_URL}/media/multipart/part?key=${encodeURIComponent(
        r2Key
      )}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;
      const partRes = await fetch(partUrl, {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/octet-stream' },
        body: chunk,
      });
      if (!partRes.ok) {
        throw new Error(`Multipart part ${partNumber} failed (${partRes.status}): ${await partRes.text()}`);
      }
      parts.push(await partRes.json());
      offset += len;
      partNumber += 1;
    }

    const completeRes = await fetch(`${MEDIA_API_URL}/media/multipart/complete`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: r2Key, uploadId, parts }),
    });
    if (!completeRes.ok) {
      throw new Error(`Multipart complete failed (${completeRes.status}): ${await completeRes.text()}`);
    }
    return completeRes.json();
  } catch (err) {
    await fetch(`${MEDIA_API_URL}/media/multipart/abort`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: r2Key, uploadId }),
    }).catch(() => {});
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

async function migrate() {
  if (!DRY_RUN && (!MEDIA_API_URL || !CI_UPLOAD_TOKEN)) {
    console.error('❌ Set MEDIA_API_URL and CI_UPLOAD_TOKEN environment variables (or pass --dry-run).');
    process.exit(1);
  }

  const files = fs
    .readdirSync(ASSETS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.endsWith(':Zone.Identifier'))
    .map((e) => e.name)
    .sort();

  console.log(`Found ${files.length} files in public/assets/${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const urlMap = new Map();

  for (const file of files) {
    const filePath = path.join(ASSETS_DIR, file);
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(64);
    const read = fs.readSync(fd, head, 0, 64, 0);
    fs.closeSync(fd);
    const detected = detectFormatFromBytes(head.subarray(0, read));
    if (!detected) {
      console.log(`⏭️  Skipping unrecognized file: ${file}`);
      continue;
    }

    const r2Key = sanitizeR2Key(file);
    const localKey = normalizeAssetPath(`/assets/${file}`);
    const sizeMb = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);

    if (DRY_RUN) {
      const mode = fs.statSync(filePath).size > MULTIPART_THRESHOLD_BYTES ? 'multipart' : 'direct';
      console.log(`   [dry-run] ${localKey} (${sizeMb} MB, ${mode}) → R2 key "${r2Key}" (${detected.mimeType})`);
      urlMap.set(localKey, `https://media.yourdomain.com/${encodeURIComponent(r2Key)}`);
      continue;
    }

    const uploaded = await uploadFileToR2(r2Key, filePath, detected);
    console.log(`✅ Uploaded ${file} (${sizeMb} MB) → ${uploaded.src}`);
    urlMap.set(localKey, uploaded.src);
  }

  // Rewrite JSON references in src/data/tv*.json and src/data/takeovers/*.json
  const jsonTargets = [
    ...fs
      .readdirSync(DATA_DIR)
      .filter((f) => /^tv\d+\.json$/i.test(f))
      .map((f) => path.join(DATA_DIR, f)),
    ...(fs.existsSync(TAKEOVERS_DIR)
      ? fs
          .readdirSync(TAKEOVERS_DIR)
          .filter((f) => f.endsWith('.json'))
          .map((f) => path.join(TAKEOVERS_DIR, f))
      : []),
  ];

  for (const jsonPath of jsonTargets) {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    let changed = false;

    if (Array.isArray(data.slides)) {
      for (const slide of data.slides) {
        const mapped = urlMap.get(normalizeAssetPath(slide.src));
        if (mapped && slide.src !== mapped) {
          slide.src = mapped;
          changed = true;
        }
      }
    }

    for (const k of ['tv1Media', 'tv2Media', 'tv3Media', 'tv4Media']) {
      if (data[k]) {
        const mapped = urlMap.get(normalizeAssetPath(data[k]));
        if (mapped && data[k] !== mapped) {
          data[k] = mapped;
          changed = true;
        }
      }
    }

    if (changed) {
      if (DRY_RUN) {
        console.log(`   [dry-run] Would update URLs in ${path.relative(ROOT_DIR, jsonPath)}`);
      } else {
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
        console.log(`📝 Updated media URLs in ${path.relative(ROOT_DIR, jsonPath)}`);
      }
    }
  }

  console.log('\n🎉 Migration step complete!');
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
