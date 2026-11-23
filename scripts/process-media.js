import sharp from 'sharp';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  detectFormatFromBytes,
  normalizeAssetPath,
  resolveSlideDuration,
  resolveTakeoverDuration,
} from '../src/utils/media.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT_DIR, 'public/assets');
const GENERATED_DIR = path.join(ASSETS_DIR, '.generated');
const LOCAL_MIRROR_DIR = path.join(ASSETS_DIR, 'local');
const DATA_DIR = path.join(ROOT_DIR, 'src/data');
const TAKEOVERS_DIR = path.join(DATA_DIR, 'takeovers');
const MANIFEST_PATH = path.join(DATA_DIR, 'media-manifest.json');

// Load local .env automatically if present (Node 20.12+ / 26 built-in)
try {
  const envPath = path.join(ROOT_DIR, '.env');
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
} catch {
  // Ignore .env load errors
}

const DEFAULT_MEDIA_API_URL = 'https://gdtv2-media-api.cyrusliew02.workers.dev';
const LEGACY_MEDIA_BASES = ['https://media.hanrusplus.com'];
const MEDIA_API_URL = (
  process.env.MEDIA_API_URL ||
  process.env.NEXT_PUBLIC_MEDIA_API_URL ||
  process.env.VITE_MEDIA_API_URL ||
  DEFAULT_MEDIA_API_URL
).replace(/\/+$/, '');
const CI_UPLOAD_TOKEN = (
  process.env.CI_UPLOAD_TOKEN ||
  process.env.R2_CI_UPLOAD_TOKEN ||
  process.env.ADMIN_UPLOAD_TOKEN ||
  process.env.NEXT_PUBLIC_MEDIA_API_TOKEN ||
  ''
).trim();

const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const MAX_FPS = 30;
const MAX_BITRATE_BPS = 12_000_000;
const TRANSCODE_PROFILE_VERSION = 'c79-h264-1080p30-vp9-v2';

// ── Toolchain Detection ─────────────────────────────────────────────────────

function hasBinary(cmd) {
  try {
    execFileSync(cmd, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_FFMPEG = hasBinary('ffmpeg');
const HAS_FFPROBE = hasBinary('ffprobe');
const MANIFEST_ONLY = process.argv.includes('--manifest-only');

// ── Pure-JS Video Metadata Fallback (for local dev without ffprobe) ─────────

function readHeaderBytes(filePath, length = 64) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Inspect top-level MP4 boxes to detect moov position (faststart), duration,
 * dimensions, and video codec without needing ffprobe.
 */
function inspectMp4PureJs(filePath) {
  const result = {
    duration: null,
    width: null,
    height: null,
    codec: null,
    faststart: false,
    hasAudio: false,
  };

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const fd = fs.openSync(filePath, 'r');

  function readChunk(offset, len) {
    const safeLen = Math.min(len, Math.max(0, fileSize - offset));
    if (safeLen <= 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(safeLen);
    const read = fs.readSync(fd, buf, 0, safeLen, offset);
    return buf.subarray(0, read);
  }

  function parseContainer(buf, start, end) {
    let pos = start;
    while (pos + 8 <= end) {
      let size = buf.readUInt32BE(pos);
      const type = buf.toString('ascii', pos + 4, pos + 8);
      let headerSize = 8;

      if (size === 1 && pos + 16 <= end) {
        size = Number(buf.readBigUInt64BE(pos + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - pos;
      }

      if (size < headerSize || pos + size > end) break;
      const bodyStart = pos + headerSize;
      const boxEnd = pos + size;

      if (type === 'mvhd' && bodyStart + 20 <= boxEnd) {
        const version = buf[bodyStart];
        if (version === 0 && bodyStart + 20 <= boxEnd) {
          const timescale = buf.readUInt32BE(bodyStart + 12);
          const duration = buf.readUInt32BE(bodyStart + 16);
          if (timescale > 0) result.duration = Number((duration / timescale).toFixed(3));
        } else if (version === 1 && bodyStart + 32 <= boxEnd) {
          const timescale = buf.readUInt32BE(bodyStart + 20);
          const duration = Number(buf.readBigUInt64BE(bodyStart + 24));
          if (timescale > 0) result.duration = Number((duration / timescale).toFixed(3));
        }
      } else if (type === 'tkhd' && bodyStart + 84 <= boxEnd) {
        const version = buf[bodyStart];
        const dimOffset = version === 1 ? bodyStart + 88 : bodyStart + 76;
        if (dimOffset + 8 <= boxEnd) {
          const w = buf.readUInt32BE(dimOffset) >>> 16;
          const h = buf.readUInt32BE(dimOffset + 4) >>> 16;
          if (w > 0 && h > 0) {
            result.width = w;
            result.height = h;
          }
        }
      } else if (type === 'hdlr' && bodyStart + 12 <= boxEnd) {
        const handlerType = buf.toString('ascii', bodyStart + 8, bodyStart + 12);
        if (handlerType === 'soun') result.hasAudio = true;
      } else if (type === 'stsd' && bodyStart + 16 <= boxEnd) {
        const codecFourcc = buf.toString('ascii', bodyStart + 12, bodyStart + 16);
        if (/^(avc1|avc3|hvc1|hev1|vp08|vp09|av01|mp4v)$/i.test(codecFourcc)) {
          result.codec = codecFourcc.toLowerCase();
        }
      } else if (['trak', 'mdia', 'minf', 'stbl'].includes(type)) {
        parseContainer(buf, bodyStart, boxEnd);
      }

      pos = boxEnd;
    }
  }

  try {
    let offset = 0;
    let seenMdat = false;
    let moovOffset = -1;
    let moovSize = 0;

    while (offset + 8 <= fileSize) {
      const header = readChunk(offset, 16);
      if (header.length < 8) break;

      let size = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      let headerSize = 8;

      if (size === 1 && header.length >= 16) {
        size = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (size === 0) {
        size = fileSize - offset;
      }

      if (size < headerSize) break;

      if (type === 'mdat') {
        seenMdat = true;
      } else if (type === 'moov') {
        result.faststart = !seenMdat;
        moovOffset = offset + headerSize;
        moovSize = size - headerSize;
      }

      offset += size;
    }

    // Parse moov payload if reasonable size (<= 16 MB)
    if (moovOffset >= 0 && moovSize > 0 && moovSize <= 16 * 1024 * 1024) {
      const moovBuf = readChunk(moovOffset, moovSize);
      parseContainer(moovBuf, 0, moovBuf.length);
    }
  } finally {
    fs.closeSync(fd);
  }

  return result;
}

/**
 * Minimal EBML reader for WebM duration/dimensions when ffprobe is unavailable.
 */
function inspectWebmPureJs(filePath) {
  const result = { duration: null, width: null, height: null, codec: 'vp8/vp9', hasAudio: false };
  const fd = fs.openSync(filePath, 'r');
  try {
    // WebM Segment Info & Tracks almost always sit within the first 256 KB
    const buf = Buffer.alloc(Math.min(262144, fs.statSync(filePath).size));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const slice = buf.subarray(0, read);

    function readVint(pos, maskFirstByte = true) {
      if (pos >= slice.length) return null;
      const first = slice[pos];
      if (first === 0) return null;
      let length = 1;
      let mask = 0x80;
      while (length <= 8 && (first & mask) === 0) {
        mask >>= 1;
        length += 1;
      }
      if (length > 8 || pos + length > slice.length) return null;
      let value = maskFirstByte ? first & (mask - 1) : first;
      for (let i = 1; i < length; i += 1) {
        value = value * 256 + slice[pos + i];
      }
      return { value, length };
    }

    let timecodeScale = 1000000; // default 1ms in ns
    let rawDuration = null;

    function walk(start, end) {
      let pos = start;
      while (pos < end) {
        const idInfo = readVint(pos, false);
        if (!idInfo) break;
        pos += idInfo.length;
        const sizeInfo = readVint(pos, true);
        if (!sizeInfo) break;
        pos += sizeInfo.length;

        const elemId = idInfo.value;
        const elemSize = sizeInfo.value;
        const unknownSize = elemSize === Math.pow(2, 7 * sizeInfo.length) - 1;
        const elemEnd = unknownSize ? end : Math.min(end, pos + elemSize);

        // Master elements: Segment (0x18538067), Info (0x1549A966), Tracks (0x1654AE6B), TrackEntry (0xAE), Video (0xE0)
        if ([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0].includes(elemId)) {
          walk(pos, elemEnd);
        } else if (elemId === 0x2ad7b1 && elemSize <= 8) {
          // TimecodeScale
          let v = 0;
          for (let i = 0; i < elemSize; i += 1) v = v * 256 + slice[pos + i];
          if (v > 0) timecodeScale = v;
        } else if (elemId === 0x4489 && (elemSize === 4 || elemSize === 8)) {
          // Duration (float32 or float64)
          rawDuration = elemSize === 4 ? slice.readFloatBE(pos) : slice.readDoubleBE(pos);
        } else if (elemId === 0xb0 && elemSize <= 4) {
          // PixelWidth
          let v = 0;
          for (let i = 0; i < elemSize; i += 1) v = v * 256 + slice[pos + i];
          if (v > 0) result.width = v;
        } else if (elemId === 0xba && elemSize <= 4) {
          // PixelHeight
          let v = 0;
          for (let i = 0; i < elemSize; i += 1) v = v * 256 + slice[pos + i];
          if (v > 0) result.height = v;
        }

        if (unknownSize) break;
        pos = elemEnd;
      }
    }

    walk(0, slice.length);

    if (rawDuration && rawDuration > 0) {
      result.duration = Number(((rawDuration * timecodeScale) / 1e9).toFixed(3));
    }
  } finally {
    fs.closeSync(fd);
  }
  return result;
}

function parseFrameRate(rateStr) {
  if (!rateStr || typeof rateStr !== 'string') return null;
  const parts = rateStr.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Number((num / den).toFixed(3));
    }
  }
  const val = Number(rateStr);
  return Number.isFinite(val) && val > 0 ? val : null;
}

function probeVideoWithFfprobe(filePath) {
  const stdout = execFileSync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { encoding: 'utf8' }
  );
  const parsed = JSON.parse(stdout);
  const videoStream = (parsed.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (parsed.streams || []).find((s) => s.codec_type === 'audio');
  const durationRaw = Number(videoStream?.duration || parsed.format?.duration);
  const bitRateRaw = Number(videoStream?.bit_rate || parsed.format?.bit_rate);

  return {
    duration: Number.isFinite(durationRaw) && durationRaw > 0 ? Number(durationRaw.toFixed(3)) : null,
    width: videoStream?.width || null,
    height: videoStream?.height || null,
    codec: videoStream?.codec_name || null,
    pixFmt: videoStream?.pix_fmt || null,
    level: Number.isFinite(Number(videoStream?.level)) ? Number(videoStream.level) : null,
    fps: parseFrameRate(videoStream?.avg_frame_rate) || parseFrameRate(videoStream?.r_frame_rate),
    bitRate: Number.isFinite(bitRateRaw) && bitRateRaw > 0 ? bitRateRaw : null,
    hasAudio: Boolean(audioStream),
    formatName: parsed.format?.format_name || null,
  };
}

function transcodeToH264Mp4(inputPath, outputPath) {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      inputPath,
      '-c:v',
      'libx264',
      '-profile:v',
      'high',
      '-level:v',
      '4.1',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      `scale='min(${MAX_WIDTH},iw)':'min(${MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=${MAX_FPS}`,
      '-crf',
      '23',
      '-maxrate',
      '8M',
      '-bufsize',
      '16M',
      '-preset',
      'medium',
      '-g',
      String(MAX_FPS),
      '-keyint_min',
      String(MAX_FPS),
      '-sc_threshold',
      '0',
      '-movflags',
      '+faststart',
      '-an',
      outputPath,
    ],
    { stdio: 'pipe' }
  );
}

function transcodeToVp9Webm(inputPath, outputPath) {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      inputPath,
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      `scale='min(${MAX_WIDTH},iw)':'min(${MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=${MAX_FPS}`,
      '-crf',
      '33',
      '-b:v',
      '0',
      '-deadline',
      'realtime',
      '-cpu-used',
      '6',
      '-row-mt',
      '1',
      '-g',
      String(MAX_FPS),
      '-an',
      outputPath,
    ],
    { stdio: 'pipe' }
  );
}

function extractPosterJpeg(inputPath, outputPath) {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      inputPath,
      '-vframes',
      '1',
      '-q:v',
      '3',
      '-vf',
      `scale='min(${MAX_WIDTH},iw)':'min(${MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease`,
      outputPath,
    ],
    { stdio: 'pipe' }
  );
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(TRANSCODE_PROFILE_VERSION);
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex').slice(0, 12);
}

// ── Image & Video Processors ────────────────────────────────────────────────

async function processImage(filePath, file, detected) {
  try {
    const image = sharp(filePath);
    const metadata = await image.metadata();

    // Only optimize jpg/png/webp during full build (skip in --manifest-only dev mode and skip animated gif / svg)
    if (!MANIFEST_ONLY && ['jpeg', 'jpg', 'png', 'webp'].includes(metadata.format)) {
      if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
        image.jpeg({ quality: 80, mozjpeg: true });
      } else if (metadata.format === 'png') {
        image.png({ compressionLevel: 9, palette: true });
      } else if (metadata.format === 'webp') {
        image.webp({ quality: 80 });
      }

      const tempPath = filePath + '.tmp';
      await image
        .resize({
          width: MAX_WIDTH,
          height: MAX_HEIGHT,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toFile(tempPath);

      const originalStats = fs.statSync(filePath);
      const newStats = fs.statSync(tempPath);

      if (newStats.size < originalStats.size) {
        fs.renameSync(tempPath, filePath);
        const saved = ((originalStats.size - newStats.size) / 1024).toFixed(2);
        console.log(`✅ Optimized image ${file}: Saved ${saved}KB`);
      } else {
        fs.unlinkSync(tempPath);
      }
    }

    const finalMeta = await sharp(filePath).metadata();
    return {
      type: 'image',
      format: detected?.format || finalMeta.format || 'image',
      mimeType: detected?.mimeType || `image/${finalMeta.format || 'jpeg'}`,
      width: finalMeta.width || null,
      height: finalMeta.height || null,
      size: fs.statSync(filePath).size,
    };
  } catch (error) {
    console.error(`❌ Failed to process image ${file}:`, error.message);
    return {
      type: 'image',
      format: detected?.format || 'image',
      mimeType: detected?.mimeType || 'image/jpeg',
      size: fs.statSync(filePath).size,
    };
  }
}

function processVideo(filePath, file, detected) {
  const assetPublicPath = `/assets/${file}`;
  const stat = fs.statSync(filePath);

  let probe = {
    duration: null,
    width: null,
    height: null,
    codec: null,
    pixFmt: null,
    hasAudio: false,
    faststart: false,
  };

  if (HAS_FFPROBE) {
    probe = { ...probe, ...probeVideoWithFfprobe(filePath) };
    if (detected.format === 'mp4') {
      probe.faststart = inspectMp4PureJs(filePath).faststart;
    }
  } else if (detected.format === 'mp4' || detected.format === 'mov') {
    probe = { ...probe, ...inspectMp4PureJs(filePath) };
  } else if (detected.format === 'webm') {
    probe = { ...probe, ...inspectWebmPureJs(filePath) };
  }

  let optimizedSrc = assetPublicPath;
  let webmSrc = detected.format === 'webm' ? assetPublicPath : null;
  let posterSrc = null;
  let finalWidth = probe.width;
  let finalHeight = probe.height;
  let finalDuration = probe.duration;
  let finalCodec = probe.codec;
  let finalMime = detected.mimeType;

  if (HAS_FFMPEG && !MANIFEST_ONLY) {
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    const fileHash = hashFile(filePath);
    const safeBase = path
      .basename(file, path.extname(file))
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 80);

    const isH264Mp4 =
      detected.format === 'mp4' &&
      (probe.codec === 'h264' || probe.codec === 'avc1' || probe.codec === 'avc3') &&
      (!probe.pixFmt || probe.pixFmt === 'yuv420p') &&
      (!probe.level || probe.level <= 41);

    const exceedsResolution =
      (probe.width && probe.width > MAX_WIDTH) || (probe.height && probe.height > MAX_HEIGHT);
    const exceedsFps = Boolean(probe.fps && probe.fps > MAX_FPS + 1);
    const exceedsBitRate = Boolean(probe.bitRate && probe.bitRate > MAX_BITRATE_BPS);

    const needsTranscode =
      detected.needsTranscode ||
      !isH264Mp4 ||
      exceedsResolution ||
      exceedsFps ||
      exceedsBitRate ||
      probe.hasAudio ||
      !probe.faststart;

    let videoSourceForPoster = filePath;

    if (needsTranscode) {
      const outName = `${safeBase}-${fileHash}.mp4`;
      const outPath = path.join(GENERATED_DIR, outName);

      if (!fs.existsSync(outPath)) {
        console.log(`🎬 Transcoding ${file} for LG Chromium 79 (H.264 1080p30 Level 4.1 faststart muted)...`);
        transcodeToH264Mp4(filePath, outPath);
        const origMb = (stat.size / (1024 * 1024)).toFixed(2);
        const newMb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2);
        console.log(`✅ Transcoded ${file}: ${origMb}MB → ${newMb}MB`);
      } else {
        console.log(`⚡ Using cached Chromium 79 H.264 transcode for ${file}`);
      }

      optimizedSrc = `/assets/.generated/${outName}`;
      videoSourceForPoster = outPath;
      finalMime = 'video/mp4';
      finalCodec = 'h264';

      if (HAS_FFPROBE) {
        const outProbe = probeVideoWithFfprobe(outPath);
        finalDuration = outProbe.duration ?? finalDuration;
        finalWidth = outProbe.width ?? finalWidth;
        finalHeight = outProbe.height ?? finalHeight;
      }
    }

    // Generate VP9 WebM fallback so open-source Chromium 79 (without H.264) also plays without MediaError code 4
    const webmName = `${safeBase}-${fileHash}.webm`;
    const webmPath = path.join(GENERATED_DIR, webmName);
    if (!fs.existsSync(webmPath)) {
      try {
        console.log(`🎬 Generating VP9 WebM fallback for ${file}...`);
        transcodeToVp9Webm(videoSourceForPoster, webmPath);
      } catch (err) {
        console.warn(`⚠️ Failed to generate VP9 WebM fallback for ${file}:`, err.message);
      }
    }
    if (fs.existsSync(webmPath)) {
      webmSrc = `/assets/.generated/${webmName}`;
    }

    // Extract frame-0 poster JPEG so TVPlayer never flashes black while decoder initializes
    const posterName = `${safeBase}-${fileHash}.poster.jpg`;
    const posterPath = path.join(GENERATED_DIR, posterName);
    if (!fs.existsSync(posterPath)) {
      try {
        extractPosterJpeg(videoSourceForPoster, posterPath);
      } catch (err) {
        console.warn(`⚠️ Failed to extract poster for ${file}:`, err.message);
      }
    }
    if (fs.existsSync(posterPath)) {
      posterSrc = `/assets/.generated/${posterName}`;
    }
  } else {
    console.log(
      `ℹ️  ffmpeg not installed locally — indexed ${file} via pure-JS parser (${
        finalDuration ? `${finalDuration}s` : 'unknown duration'
      }). Full Chromium 79 transcoding & poster extraction will run in CI.`
    );
  }

  return {
    type: 'video',
    format: detected.format,
    mimeType: finalMime,
    codec: finalCodec,
    duration: finalDuration,
    width: finalWidth,
    height: finalHeight,
    src: optimizedSrc,
    webmSrc,
    poster: posterSrc,
    size: stat.size,
  };
}

// ── Playlist Sync Audit ─────────────────────────────────────────────────────

function auditPlaylistDurations(manifest) {
  if (!fs.existsSync(DATA_DIR)) return;

  const takeovers = [];
  if (fs.existsSync(TAKEOVERS_DIR)) {
    for (const f of fs.readdirSync(TAKEOVERS_DIR).filter((n) => n.endsWith('.json'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(TAKEOVERS_DIR, f), 'utf8'));
        if (data && !data.unpublish) {
          takeovers.push(data);
        }
      } catch {
        // Ignore invalid JSON
      }
    }
  }

  const tvFiles = fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^tv\d+\.json$/i.test(f))
    .sort();

  if (tvFiles.length === 0) return;

  console.log('\n📊 Deterministic Playlist Duration Audit:');
  const totals = [];

  for (const tvFile of tvFiles) {
    const tvId = path.basename(tvFile, '.json');
    try {
      const tvData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, tvFile), 'utf8'));
      const baseSlides = (tvData.slides || []).filter((s) => !s.unpublish);
      let total = 0;

      for (const slide of baseSlides) {
        total += resolveSlideDuration(slide, manifest);
      }

      for (const takeover of takeovers) {
        if (takeover[`${tvId}Media`]) {
          total += resolveTakeoverDuration(takeover, manifest);
        }
      }

      totals.push({ tvId, total, slideCount: baseSlides.length });
      console.log(`   - ${tvId}: ${total}s (${baseSlides.length} active base slides)`);
    } catch (err) {
      console.warn(`   - ${tvId}: failed to audit (${err.message})`);
    }
  }

  const uniqueTotals = [...new Set(totals.map((t) => t.total).filter((d) => d > 0))];
  if (uniqueTotals.length > 1) {
    console.log(
      `   ⚠️ Note: TVs have different cycle durations (${totals
        .map((t) => `${t.tvId}=${t.total}s`)
        .join(', ')}). Ensure displays meant to sync in lockstep share matching totals.`
    );
  }
}

// ── Cloudflare R2 Remote Media Sync & CI Transcoding ───────────────────────

function collectReferencedRemoteUrls() {
  const allReferenced = new Set();
  const localMirrorNeeded = new Set();
  const tvUseR2Map = new Map();

  if (!fs.existsSync(DATA_DIR)) {
    return { allReferenced, localMirrorNeeded };
  }

  const tvFiles = fs.readdirSync(DATA_DIR).filter((f) => /^tv\d+\.json$/i.test(f));
  for (const tvFile of tvFiles) {
    const tvId = path.basename(tvFile, '.json');
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, tvFile), 'utf8'));
      const useR2 = data.useR2 === true;
      tvUseR2Map.set(tvId, useR2);
      for (const slide of data.slides || []) {
        if (!slide.unpublish && typeof slide.src === 'string' && /^https?:\/\//i.test(slide.src)) {
          const normalized = normalizeAssetPath(slide.src);
          allReferenced.add(normalized);
          if (!useR2) {
            localMirrorNeeded.add(normalized);
          }
        }
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  if (fs.existsSync(TAKEOVERS_DIR)) {
    for (const f of fs.readdirSync(TAKEOVERS_DIR).filter((n) => n.endsWith('.json'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(TAKEOVERS_DIR, f), 'utf8'));
        if (data.unpublish) continue;
        for (const tvId of ['tv1', 'tv2', 'tv3', 'tv4']) {
          const k = `${tvId}Media`;
          if (typeof data[k] === 'string' && /^https?:\/\//i.test(data[k])) {
            const normalized = normalizeAssetPath(data[k]);
            allReferenced.add(normalized);
            if (tvUseR2Map.get(tvId) !== true) {
              localMirrorNeeded.add(normalized);
            }
          }
        }
      } catch {
        // Ignore malformed JSON
      }
    }
  }

  return { allReferenced, localMirrorNeeded };
}

async function mirrorRemoteAssetLocally(url, fileName, { optimizeImage = false } = {}) {
  if (!url) return null;
  fs.mkdirSync(LOCAL_MIRROR_DIR, { recursive: true });
  const destPath = path.join(LOCAL_MIRROR_DIR, fileName);

  if (fs.existsSync(destPath)) {
    return `/assets/local/${fileName}`;
  }

  if (MANIFEST_ONLY) {
    return null;
  }

  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`⚠️  Failed to mirror ${url} locally (HTTP ${res.status})`);
    return null;
  }

  const rawBuf = Buffer.from(await res.arrayBuffer());
  const tmpPath = `${destPath}.tmp`;

  if (optimizeImage) {
    try {
      const img = sharp(rawBuf);
      const meta = await img.metadata();
      const fmt = (meta.format || '').toLowerCase();
      if (['jpeg', 'jpg', 'png', 'webp'].includes(fmt)) {
        const pipeline = sharp(rawBuf)
          .toColorspace('srgb')
          .resize({
            width: MAX_WIDTH,
            height: MAX_HEIGHT,
            fit: 'inside',
            withoutEnlargement: true,
          });
        if (fmt === 'jpeg' || fmt === 'jpg') {
          pipeline.jpeg({ quality: 82, mozjpeg: true });
        } else if (fmt === 'png') {
          pipeline.png({ compressionLevel: 9, palette: true });
        } else if (fmt === 'webp') {
          pipeline.webp({ quality: 82 });
        }
        await pipeline.toFile(tmpPath);
        fs.renameSync(tmpPath, destPath);
        console.log(`📦 Mirrored & optimized image to /assets/local/${fileName}`);
        return `/assets/local/${fileName}`;
      }
    } catch (err) {
      console.warn(`⚠️  sharp optimization failed for ${fileName}, saving raw copy:`, err.message);
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  }

  fs.writeFileSync(tmpPath, rawBuf);
  fs.renameSync(tmpPath, destPath);
  console.log(`📦 Mirrored asset to /assets/local/${fileName}`);
  return `/assets/local/${fileName}`;
}

async function uploadBufferToR2(key, filePath, contentType, metadataHeaders = {}) {
  const stat = fs.statSync(filePath);
  const authHeader = { Authorization: `Bearer ${CI_UPLOAD_TOKEN}` };
  const MULTIPART_THRESHOLD = 50 * 1024 * 1024;
  const PART_SIZE = 20 * 1024 * 1024;

  if (stat.size <= MULTIPART_THRESHOLD) {
    const uploadUrl = `${MEDIA_API_URL}/media/upload?key=${encodeURIComponent(key)}`;
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        ...authHeader,
        'Content-Type': contentType,
        ...metadataHeaders,
      },
      body: fs.readFileSync(filePath),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`R2 upload failed for ${key} (${res.status}): ${errText}`);
    }

    return res.json();
  }

  // >50 MB transcoded output: use chunked R2 multipart upload
  const customMetadata = {};
  if (metadataHeaders['X-Media-Type']) customMetadata.mediaType = metadataHeaders['X-Media-Type'];
  if (metadataHeaders['X-Original-Key']) customMetadata.originalKey = metadataHeaders['X-Original-Key'];
  if (metadataHeaders['X-Source-Hash']) customMetadata.sourceHash = metadataHeaders['X-Source-Hash'];
  if (metadataHeaders['X-Media-Duration']) customMetadata.duration = metadataHeaders['X-Media-Duration'];
  if (metadataHeaders['X-Media-Width']) customMetadata.width = metadataHeaders['X-Media-Width'];
  if (metadataHeaders['X-Media-Height']) customMetadata.height = metadataHeaders['X-Media-Height'];

  const startRes = await fetch(`${MEDIA_API_URL}/media/multipart/start`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, contentType, customMetadata }),
  });
  if (!startRes.ok) {
    throw new Error(`R2 multipart start failed (${startRes.status}): ${await startRes.text()}`);
  }
  const { uploadId } = await startRes.json();
  const fd = fs.openSync(filePath, 'r');
  const parts = [];

  try {
    let partNumber = 1;
    let offset = 0;
    while (offset < stat.size) {
      const len = Math.min(PART_SIZE, stat.size - offset);
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, offset);

      const partUrl = `${MEDIA_API_URL}/media/multipart/part?key=${encodeURIComponent(
        key
      )}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;
      const partRes = await fetch(partUrl, {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/octet-stream' },
        body: chunk,
      });
      if (!partRes.ok) {
        throw new Error(`R2 multipart part ${partNumber} failed (${partRes.status}): ${await partRes.text()}`);
      }
      parts.push(await partRes.json());
      offset += len;
      partNumber += 1;
    }

    const completeRes = await fetch(`${MEDIA_API_URL}/media/multipart/complete`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, uploadId, parts }),
    });
    if (!completeRes.ok) {
      throw new Error(`R2 multipart complete failed (${completeRes.status}): ${await completeRes.text()}`);
    }
    return completeRes.json();
  } catch (err) {
    await fetch(`${MEDIA_API_URL}/media/multipart/abort`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, uploadId }),
    }).catch(() => {});
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

async function syncR2MediaManifest(manifest) {
  if (!MEDIA_API_URL) return;

  console.log(`\n☁️  Syncing Cloudflare R2 media manifest from ${MEDIA_API_URL}...`);
  let r2Manifest = {};
  try {
    const res = await fetch(`${MEDIA_API_URL}/media/manifest`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = await res.json();
    r2Manifest = payload.manifest || {};
  } catch (err) {
    console.warn(`⚠️  Could not fetch R2 manifest (${err.message}); skipping R2 sync.`);
    return;
  }

  const { allReferenced: referencedUrls, localMirrorNeeded } = collectReferencedRemoteUrls();
  const activeMirrorFiles = new Set();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdtv2-r2-'));

  try {
    for (const [publicUrl, entry] of Object.entries(r2Manifest)) {
      const normalizedUrl = normalizeAssetPath(publicUrl);
      const legacyAliasUrls = entry.key
        ? LEGACY_MEDIA_BASES.map((base) => normalizeAssetPath(`${base.replace(/\/+$/, '')}/${entry.key}`)).filter(
            (alias) => alias && alias !== normalizedUrl
          )
        : [];
      const expectedSourceHash = crypto
        .createHash('sha256')
        .update(`${TRANSCODE_PROFILE_VERSION}:${entry.etag || entry.size || ''}`)
        .digest('hex')
        .slice(0, 12);

      let finalEntry = {
        type: entry.type,
        format: entry.format,
        mimeType: entry.mimeType,
        duration: entry.duration ?? null,
        width: entry.width ?? null,
        height: entry.height ?? null,
        src: entry.src || publicUrl,
        webmSrc: entry.webmSrc || null,
        poster: entry.poster || null,
        size: entry.size,
      };

      const isVideo = entry.type === 'video';
      const isReferenced =
        referencedUrls.size === 0 ||
        referencedUrls.has(normalizedUrl) ||
        legacyAliasUrls.some((alias) => referencedUrls.has(alias));
      const alreadyOptimizedInR2 =
        entry.sourceHash === expectedSourceHash &&
        Boolean(entry.poster) &&
        Boolean(entry.webmSrc) &&
        entry.src !== publicUrl;

      if (isVideo && isReferenced && !MANIFEST_ONLY && HAS_FFMPEG && CI_UPLOAD_TOKEN && !alreadyOptimizedInR2) {
        console.log(`🎬 Downloading & optimizing R2 video for Chromium 79: ${entry.key}...`);
        const dlRes = await fetch(publicUrl);
        if (!dlRes.ok) {
          console.warn(`⚠️  Failed to download ${publicUrl} (${dlRes.status}); keeping original URL.`);
        } else {
          const ext = path.extname(entry.key) || '.mp4';
          const safeBase = path
            .basename(entry.key, ext)
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .slice(0, 80);

          const srcTmp = path.join(tmpDir, `${safeBase}-src${ext}`);
          const outTmp = path.join(tmpDir, `${safeBase}-${expectedSourceHash}.mp4`);
          const webmTmp = path.join(tmpDir, `${safeBase}-${expectedSourceHash}.webm`);
          const posterTmp = path.join(tmpDir, `${safeBase}-${expectedSourceHash}.poster.jpg`);

          fs.writeFileSync(srcTmp, Buffer.from(await dlRes.arrayBuffer()));

          transcodeToH264Mp4(srcTmp, outTmp);
          transcodeToVp9Webm(outTmp, webmTmp);
          extractPosterJpeg(outTmp, posterTmp);

          const outProbe = HAS_FFPROBE ? probeVideoWithFfprobe(outTmp) : inspectMp4PureJs(outTmp);
          const optimizedKey = `.generated/${safeBase}-${expectedSourceHash}.mp4`;
          const webmKey = `.generated/${safeBase}-${expectedSourceHash}.webm`;
          const posterKey = `.generated/${safeBase}-${expectedSourceHash}.poster.jpg`;

          const uploadedVideo = await uploadBufferToR2(optimizedKey, outTmp, 'video/mp4', {
            'X-Media-Type': 'video',
            'X-Original-Key': entry.key,
            'X-Source-Hash': expectedSourceHash,
            ...(outProbe.duration ? { 'X-Media-Duration': String(outProbe.duration) } : {}),
            ...(outProbe.width ? { 'X-Media-Width': String(outProbe.width) } : {}),
            ...(outProbe.height ? { 'X-Media-Height': String(outProbe.height) } : {}),
          });

          const uploadedWebm = await uploadBufferToR2(webmKey, webmTmp, 'video/webm', {
            'X-Media-Type': 'video',
            'X-Original-Key': entry.key,
            'X-Source-Hash': expectedSourceHash,
          });

          const uploadedPoster = await uploadBufferToR2(posterKey, posterTmp, 'image/jpeg', {
            'X-Media-Type': 'image',
            'X-Original-Key': entry.key,
            'X-Source-Hash': expectedSourceHash,
          });

          console.log(
            `✅ Uploaded Chromium 79 H.264 + VP9 WebM + poster to R2 for ${entry.key} (${
              outProbe.duration ? `${outProbe.duration}s` : 'unknown duration'
            })`
          );

          finalEntry = {
            ...finalEntry,
            mimeType: 'video/mp4',
            duration: outProbe.duration ?? finalEntry.duration,
            width: outProbe.width ?? finalEntry.width,
            height: outProbe.height ?? finalEntry.height,
            src: uploadedVideo.src,
            webmSrc: uploadedWebm.src,
            poster: uploadedPoster.src,
          };
        }
      } else if (isVideo && alreadyOptimizedInR2) {
        console.log(`⚡ Using cached R2 Chromium 79 transcode for ${entry.key}`);
      } else if (isVideo && isReferenced && !MANIFEST_ONLY && !alreadyOptimizedInR2) {
        const missing = [];
        if (!HAS_FFMPEG) missing.push('ffmpeg');
        if (!CI_UPLOAD_TOKEN) missing.push('CI_UPLOAD_TOKEN / NEXT_PUBLIC_MEDIA_API_TOKEN');
        console.warn(
          `⚠️  Skipped Chromium 79 transcode for ${entry.key} (missing: ${missing.join(', ')})`
        );
      }

      const needsLocalMirror =
        localMirrorNeeded.has(normalizedUrl) ||
        legacyAliasUrls.some((alias) => localMirrorNeeded.has(alias));

      if (needsLocalMirror) {
        const ext = (path.extname(entry.key || '') || (isVideo ? '.mp4' : '.jpg')).toLowerCase();
        const safeBase = path
          .basename(entry.key || 'asset', path.extname(entry.key || ''))
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 80);
        const mirrorHash = crypto
          .createHash('sha256')
          .update(`${entry.etag || entry.size || ''}:${finalEntry.src}`)
          .digest('hex')
          .slice(0, 10);

        if (isVideo) {
          const mp4File = `${safeBase}-${mirrorHash}.mp4`;
          const localSrc = await mirrorRemoteAssetLocally(finalEntry.src, mp4File);
          if (localSrc) {
            finalEntry.localSrc = localSrc;
            activeMirrorFiles.add(mp4File);
          }

          if (finalEntry.webmSrc) {
            const webmFile = `${safeBase}-${mirrorHash}.webm`;
            const localWebmSrc = await mirrorRemoteAssetLocally(finalEntry.webmSrc, webmFile);
            if (localWebmSrc) {
              finalEntry.localWebmSrc = localWebmSrc;
              activeMirrorFiles.add(webmFile);
            }
          }

          if (finalEntry.poster) {
            const posterFile = `${safeBase}-${mirrorHash}.poster.jpg`;
            const localPoster = await mirrorRemoteAssetLocally(finalEntry.poster, posterFile, {
              optimizeImage: true,
            });
            if (localPoster) {
              finalEntry.localPoster = localPoster;
              activeMirrorFiles.add(posterFile);
            }
          }
        } else {
          const imgFile = `${safeBase}-${mirrorHash}${ext}`;
          const localSrc = await mirrorRemoteAssetLocally(finalEntry.src, imgFile, {
            optimizeImage: true,
          });
          if (localSrc) {
            finalEntry.localSrc = localSrc;
            activeMirrorFiles.add(imgFile);
          }
        }
      }

      manifest[normalizedUrl] = finalEntry;
      // Keep legacy media.hanrusplus.com keys aliased to the new same-origin tv.hanrusplus.com/r2 URLs
      for (const alias of legacyAliasUrls) {
        manifest[alias] = finalEntry;
      }
    }

    // Prune unused mirrored files in public/assets/local/ during full builds
    if (!MANIFEST_ONLY && fs.existsSync(LOCAL_MIRROR_DIR)) {
      for (const existing of fs.readdirSync(LOCAL_MIRROR_DIR)) {
        if (!activeMirrorFiles.has(existing)) {
          fs.rmSync(path.join(LOCAL_MIRROR_DIR, existing), { force: true });
        }
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Main Entrypoint ─────────────────────────────────────────────────────────

async function processMedia() {
  const manifest = {};

  if (fs.existsSync(ASSETS_DIR)) {
    const entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.endsWith(':Zone.Identifier') && !e.name.endsWith('.tmp'))
      .map((e) => e.name)
      .sort();

    console.log(
      `Inspecting ${files.length} local media files in ${ASSETS_DIR} (ffmpeg: ${HAS_FFMPEG ? 'yes' : 'no'})`
    );

    for (const file of files) {
      const filePath = path.join(ASSETS_DIR, file);
      const header = readHeaderBytes(filePath, 64);
      const detected = detectFormatFromBytes(header);
      const key = normalizeAssetPath(`/assets/${file}`);

      if (!detected) {
        console.log(`Skipping unrecognized asset: ${file}`);
        continue;
      }

      if (detected.type === 'image') {
        manifest[key] = await processImage(filePath, file, detected);
      } else if (detected.type === 'video') {
        manifest[key] = processVideo(filePath, file, detected);
      }
    }
  }

  // Merge Cloudflare R2 assets and transcode any unoptimized videos back to R2
  await syncR2MediaManifest(manifest);

  // Write deterministic sorted manifest
  const sortedManifest = {};
  for (const key of Object.keys(manifest).sort()) {
    sortedManifest[key] = manifest[key];
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(sortedManifest, null, 2) + '\n', 'utf8');
  console.log(`\n📝 Wrote media manifest (${Object.keys(sortedManifest).length} assets) to ${path.relative(ROOT_DIR, MANIFEST_PATH)}`);

  auditPlaylistDurations(sortedManifest);
}

processMedia().catch((err) => {
  console.error('❌ Media processing failed:', err);
  process.exit(1);
});
