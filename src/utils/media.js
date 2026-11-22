/**
 * Shared media format detection, metadata resolution, and deterministic
 * video playback synchronization helpers.
 *
 * Compatible with Node.js (build scripts), TinaCMS admin UI, and Chromium 79
 * (LG Signage TV 43UH5J-HP).
 */

export const SUPPORTED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
export const SUPPORTED_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'ogg'];
export const ACCEPTED_MEDIA_EXTENSIONS = [
  ...SUPPORTED_IMAGE_EXTENSIONS,
  ...SUPPORTED_VIDEO_EXTENSIONS,
];

export const DEFAULT_IMAGE_DURATION = 10;
export const DEFAULT_TAKEOVER_DURATION = 15;
export const VIDEO_FILE_SIZE_WARN_BYTES = 25 * 1024 * 1024; // 25 MB
export const VIDEO_FILE_SIZE_LIMIT_BYTES = 50 * 1024 * 1024; // 50 MB (GitHub warning threshold)

const VIDEO_EXT_REGEX = /\.(mp4|webm|ogg|mov|m4v)$/i;
const IMAGE_EXT_REGEX = /\.(jpg|jpeg|png|webp|gif|svg|avif|bmp|ico)$/i;

/**
 * Strip query/hash fragments and normalize asset paths so manifest lookups
 * match regardless of URL encoding (%20 vs spaces) or leading slashes.
 * Preserves absolute http:// and https:// URLs (e.g., Cloudflare R2 custom domains).
 */
export function normalizeAssetPath(src) {
  if (!src || typeof src !== 'string') return '';
  const clean = src.split(/[?#]/)[0].trim();
  if (!clean) return '';

  if (/^https?:\/\//i.test(clean)) {
    try {
      const parsed = new URL(clean);
      const decodedPath = decodeURIComponent(parsed.pathname);
      return `${parsed.origin}${decodedPath}`;
    } catch {
      return clean;
    }
  }

  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  return decoded.startsWith('/') ? decoded : `/${decoded}`;
}

/**
 * Extract lowercase file extension (without dot) from a filename or URL.
 */
export function getFileExtension(src) {
  const normalized = normalizeAssetPath(src);
  if (!normalized) return '';
  const lastSlash = normalized.lastIndexOf('/');
  const filename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) return '';
  return filename.slice(lastDot + 1).toLowerCase();
}

function readAscii(bytes, start, length) {
  let out = '';
  const end = Math.min(bytes.length, start + length);
  for (let i = start; i < end; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

/**
 * Detect media container format directly from file header magic bytes.
 * Requires at least the first 64 bytes of the file for reliable sniffing.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{
 *   type: 'image' | 'video',
 *   format: string,
 *   mimeType: string,
 *   chromium79Compatible: boolean,
 *   needsTranscode?: boolean,
 *   warning?: string
 * } | null}
 */
export function detectFormatFromBytes(input) {
  if (!input) return null;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 4) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return {
      type: 'image',
      format: 'jpeg',
      mimeType: 'image/jpeg',
      chromium79Compatible: true,
    };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return {
      type: 'image',
      format: 'png',
      mimeType: 'image/png',
      chromium79Compatible: true,
    };
  }

  // GIF: GIF87a / GIF89a
  if (bytes.length >= 6) {
    const sig6 = readAscii(bytes, 0, 6);
    if (sig6 === 'GIF87a' || sig6 === 'GIF89a') {
      return {
        type: 'image',
        format: 'gif',
        mimeType: 'image/gif',
        chromium79Compatible: true,
      };
    }
  }

  // RIFF containers: WebP or AVI
  if (bytes.length >= 12 && readAscii(bytes, 0, 4) === 'RIFF') {
    const fourcc = readAscii(bytes, 8, 4);
    if (fourcc === 'WEBP') {
      return {
        type: 'image',
        format: 'webp',
        mimeType: 'image/webp',
        chromium79Compatible: true,
      };
    }
    if (fourcc === 'AVI ') {
      return {
        type: 'video',
        format: 'avi',
        mimeType: 'video/x-msvideo',
        chromium79Compatible: false,
        needsTranscode: true,
        warning: 'AVI is not supported on LG Signage TV (Chromium 79). Convert to MP4 (H.264).',
      };
    }
  }

  // ISO Base Media File Format (MP4, M4V, MOV, HEIC, AVIF): "ftyp" at offset 4
  if (bytes.length >= 12 && readAscii(bytes, 4, 4) === 'ftyp') {
    const majorBrand = readAscii(bytes, 8, 4);
    const compatibleBrands = readAscii(bytes, 12, Math.min(32, bytes.length - 12));

    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/i.test(majorBrand)) {
      return {
        type: 'image',
        format: 'heic',
        mimeType: 'image/heic',
        chromium79Compatible: false,
        warning: 'HEIC images are not supported on Chromium 79. Export as JPG or PNG.',
      };
    }

    if (/^(avif|avis)$/i.test(majorBrand)) {
      return {
        type: 'image',
        format: 'avif',
        mimeType: 'image/avif',
        chromium79Compatible: false,
        warning: 'AVIF is not supported on Chromium 79 (added in Chrome 85). Export as JPG, PNG, or WebP.',
      };
    }

    if (majorBrand === 'qt  ') {
      return {
        type: 'video',
        format: 'mov',
        mimeType: 'video/quicktime',
        chromium79Compatible: false,
        needsTranscode: true,
        warning:
          'QuickTime (.mov) is not guaranteed to play on Chromium 79. CI build will transcode it to H.264 MP4.',
      };
    }

    // Standard MP4 / M4V brands
    if (
      /^(isom|iso2|iso3|iso4|iso5|iso6|mp41|mp42|avc1|m4v |M4V |dash|mp71|3gp4|3gp5)$/i.test(
        majorBrand
      ) ||
      compatibleBrands.includes('mp4') ||
      compatibleBrands.includes('isom') ||
      compatibleBrands.includes('avc1')
    ) {
      return {
        type: 'video',
        format: 'mp4',
        mimeType: 'video/mp4',
        chromium79Compatible: true,
      };
    }

    // Generic ISO BMFF fallback (treat as MP4 video)
    return {
      type: 'video',
      format: 'mp4',
      mimeType: 'video/mp4',
      chromium79Compatible: true,
    };
  }

  // EBML (WebM / Matroska): 1A 45 DF A3
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const headerAscii = readAscii(bytes, 0, Math.min(64, bytes.length)).toLowerCase();
    if (headerAscii.includes('webm')) {
      return {
        type: 'video',
        format: 'webm',
        mimeType: 'video/webm',
        chromium79Compatible: true,
      };
    }
    return {
      type: 'video',
      format: 'mkv',
      mimeType: 'video/x-matroska',
      chromium79Compatible: false,
      needsTranscode: true,
      warning: 'Matroska (.mkv) is not reliably supported on Chromium 79. Convert to MP4 (H.264) or WebM.',
    };
  }

  // Ogg: "OggS"
  if (readAscii(bytes, 0, 4) === 'OggS') {
    return {
      type: 'video',
      format: 'ogg',
      mimeType: 'video/ogg',
      chromium79Compatible: true,
    };
  }

  // SVG (text-based)
  const textHead = readAscii(bytes, 0, Math.min(64, bytes.length)).trimStart();
  if (textHead.startsWith('<svg') || (textHead.startsWith('<?xml') && textHead.includes('svg'))) {
    return {
      type: 'image',
      format: 'svg',
      mimeType: 'image/svg+xml',
      chromium79Compatible: true,
    };
  }

  return null;
}

/**
 * Look up an asset entry in media-manifest.json using exact, decoded, or encoded keys.
 * Supports both local /assets/... paths and absolute https://... R2 URLs.
 */
export function getMediaManifestEntry(src, manifest) {
  if (!src || !manifest || typeof manifest !== 'object') return null;

  if (manifest[src]) return manifest[src];

  const normalized = normalizeAssetPath(src);
  if (manifest[normalized]) return manifest[normalized];

  if (/^https?:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      const encodedPath = parsed.pathname
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const encodedUrl = `${parsed.origin}${encodedPath}`;
      if (manifest[encodedUrl]) return manifest[encodedUrl];
    } catch {
      // Ignore invalid URL
    }
    return null;
  }

  // Try matching encoded local path variant (e.g. spaces vs %20)
  const encoded = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  if (manifest[encoded]) return manifest[encoded];

  return null;
}

/**
 * Resolve media type ('video' | 'image') using:
 *  1. Build-time media manifest (magic-byte / ffprobe authoritative)
 *  2. Explicit slide/takeover type override
 *  3. Filename extension fallback
 */
export function detectMediaType(src, explicitType, manifest) {
  const entry = getMediaManifestEntry(src, manifest);
  if (entry && (entry.type === 'video' || entry.type === 'image')) {
    return entry.type;
  }

  if (explicitType === 'video' || explicitType === 'image') {
    return explicitType;
  }

  if (!src) return 'image';

  const normalized = normalizeAssetPath(src);
  if (VIDEO_EXT_REGEX.test(normalized)) return 'video';
  if (IMAGE_EXT_REGEX.test(normalized)) return 'image';

  return 'image';
}

/**
 * Determine a slide's deterministic slot duration (in seconds):
 *  1. Explicit positive duration configured in CMS
 *  2. Auto-detected video duration from media-manifest.json (rounded up to whole seconds)
 *  3. Fallback default duration (10s for regular slides)
 */
export function resolveSlideDuration(slide, manifest, defaultDuration = DEFAULT_IMAGE_DURATION) {
  const configured = Number(slide && slide.duration);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  const entry = getMediaManifestEntry(slide && slide.src, manifest);
  if (entry && entry.type === 'video' && Number.isFinite(entry.duration) && entry.duration > 0) {
    return Math.max(1, Math.ceil(entry.duration));
  }

  return defaultDuration;
}

/**
 * Determine a multi-screen takeover's unified deterministic duration across TV1-TV4:
 *  1. Explicit positive duration configured on the takeover
 *  2. Maximum auto-detected video duration across all assigned TV media slots
 *  3. Fallback default (15s)
 */
export function resolveTakeoverDuration(takeover, manifest, defaultDuration = DEFAULT_TAKEOVER_DURATION) {
  const configured = Number(takeover && takeover.duration);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  const mediaKeys = ['tv1Media', 'tv2Media', 'tv3Media', 'tv4Media'];
  let maxVideoDuration = 0;

  for (const key of mediaKeys) {
    const src = takeover && takeover[key];
    if (!src) continue;
    const entry = getMediaManifestEntry(src, manifest);
    if (entry && entry.type === 'video' && Number.isFinite(entry.duration) && entry.duration > maxVideoDuration) {
      maxVideoDuration = entry.duration;
    }
  }

  if (maxVideoDuration > 0) {
    return Math.max(1, Math.ceil(maxVideoDuration));
  }

  return defaultDuration;
}

/**
 * Compute the deterministic playback timestamp (seconds) inside a video
 * given how far we are into the slide's scheduled time window.
 */
export function computeVideoTargetTime({ elapsedInSlide, videoDuration, behavior = 'loop' }) {
  const safeElapsed = Math.max(0, Number.isFinite(elapsedInSlide) ? elapsedInSlide : 0);
  if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
    return safeElapsed;
  }

  if (behavior === 'hold') {
    const endClamp = Math.max(0, videoDuration - 0.05);
    return Math.min(safeElapsed, endClamp);
  }

  // Default: seamless loop
  return safeElapsed % videoDuration;
}

/**
 * Returns true if the target timestamp is within `margin` seconds of a loop seam
 * (start or end of video), where seeking can cause redundant double-jumps.
 */
export function isNearLoopBoundary(time, videoDuration, margin = 0.35) {
  if (!Number.isFinite(videoDuration) || videoDuration <= margin * 2) return false;
  return time < margin || videoDuration - time < margin;
}

/**
 * Compute signed drift (actualTime - targetTime) in seconds.
 * When looping, wraps across the 0 / videoDuration boundary so 14.95s vs 0.02s
 * on a 15s clip yields -0.07s instead of +14.93s.
 */
export function computeShortestLoopDrift(actualTime, targetTime, videoDuration, looping = true) {
  let drift = actualTime - targetTime;
  if (looping && Number.isFinite(videoDuration) && videoDuration > 0) {
    const half = videoDuration / 2;
    if (drift > half) {
      drift -= videoDuration;
    } else if (drift < -half) {
      drift += videoDuration;
    }
  }
  return drift;
}

/**
 * Format bytes to a human-readable string (e.g., "14.2 MB").
 */
export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
