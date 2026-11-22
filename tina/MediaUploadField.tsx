import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useCMS, wrapFieldsWithMeta } from 'tinacms';
import {
  ACCEPTED_MEDIA_EXTENSIONS,
  detectFormatFromBytes,
  detectMediaType,
  formatFileSize,
  getFileExtension,
} from '../src/utils/media.js';

interface MediaProbeResult {
  type: 'image' | 'video';
  format: string;
  mimeType: string;
  duration?: number;
  width?: number;
  height?: number;
  size?: number;
  warning?: string;
  chromium79Compatible?: boolean;
}

function getSiblingFieldPath(fieldName: string, sibling: string): string | null {
  if (!fieldName) return null;
  if (/\.src$/.test(fieldName)) {
    return fieldName.replace(/\.src$/, `.${sibling}`);
  }
  if (/^tv[1-4]Media$/.test(fieldName)) {
    return sibling;
  }
  return null;
}

function getValueAtPath(obj: any, pathStr: string | null): any {
  if (!obj || !pathStr) return undefined;
  return pathStr.split('.').reduce((acc, part) => {
    if (acc == null) return undefined;
    return acc[part];
  }, obj);
}

function probeVideoUrl(url: string): Promise<{ duration: number; width: number; height: number } | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const cleanup = () => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    };

    const timeout = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, 8000);

    video.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const width = video.videoWidth || 0;
      const height = video.videoHeight || 0;
      cleanup();
      resolve({ duration, width, height });
    };

    video.onerror = () => {
      window.clearTimeout(timeout);
      cleanup();
      resolve(null);
    };

    video.src = url;
  });
}

function probeImageUrl(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function inspectDroppedFile(file: File): Promise<{
  probe: MediaProbeResult | null;
  error?: string;
  warnings: string[];
}> {
  const warnings: string[] = [];

  if (file.size > 200 * 1024 * 1024) {
    warnings.push(
      `Very large file (${formatFileSize(file.size)}). Upload will stream in 20 MB chunks to Cloudflare R2, and CI will compress it to 1080p H.264.`
    );
  }

  let headerBytes: Uint8Array | null = null;
  try {
    const buf = await file.slice(0, 64).arrayBuffer();
    headerBytes = new Uint8Array(buf);
  } catch {
    headerBytes = null;
  }

  const magic = headerBytes ? detectFormatFromBytes(headerBytes) : null;
  const ext = getFileExtension(file.name);

  if (!magic) {
    const fallbackType = detectMediaType(file.name, undefined, undefined);
    if (!ACCEPTED_MEDIA_EXTENSIONS.includes(ext)) {
      return {
        probe: null,
        error: `Unsupported file "${file.name}". Please upload an image (${['jpg', 'png', 'webp', 'gif'].join(', ')}) or video (${['mp4', 'webm', 'mov'].join(', ')}).`,
        warnings,
      };
    }
    return {
      probe: {
        type: fallbackType,
        format: ext || fallbackType,
        mimeType: file.type || (fallbackType === 'video' ? 'video/mp4' : 'image/jpeg'),
        size: file.size,
      },
      warnings,
    };
  }

  if (magic.warning) {
    warnings.push(magic.warning);
  }

  if (magic.type === 'image' && magic.chromium79Compatible === false) {
    return {
      probe: null,
      error: magic.warning || `Format "${magic.format}" is not supported on LG Signage TV (Chromium 79).`,
      warnings,
    };
  }

  if (magic.type === 'video' && (magic.format === 'avi' || magic.format === 'mkv')) {
    return {
      probe: null,
      error: magic.warning || `Container "${magic.format}" is not supported on Chromium 79.`,
      warnings,
    };
  }

  // Warn if extension disagrees with actual magic bytes
  if (ext && magic.type === 'video' && !['mp4', 'webm', 'mov', 'm4v', 'ogg'].includes(ext)) {
    warnings.push(`File extension ".${ext}" does not match detected ${magic.format.toUpperCase()} video content.`);
  }

  const probe: MediaProbeResult = {
    type: magic.type,
    format: magic.format,
    mimeType: magic.mimeType,
    size: file.size,
    chromium79Compatible: magic.chromium79Compatible,
    warning: magic.warning,
  };

  const objectUrl = URL.createObjectURL(file);
  try {
    if (magic.type === 'video') {
      const videoMeta = await probeVideoUrl(objectUrl);
      if (!videoMeta) {
        warnings.push(
          'Browser could not decode this video preview (possibly HEVC/H.265 or ProRes). CI will attempt H.264 transcoding, or re-export as MP4 (H.264).'
        );
      } else {
        probe.duration = videoMeta.duration;
        probe.width = videoMeta.width;
        probe.height = videoMeta.height;
        if (videoMeta.width > 1920 || videoMeta.height > 1080) {
          warnings.push(
            `Resolution is ${videoMeta.width}×${videoMeta.height} (>1080p). CI will scale down to 1920×1080 for LG Signage TV.`
          );
        }
        if (videoMeta.width > 0 && videoMeta.height > videoMeta.width) {
          warnings.push(
            `Portrait video detected (${videoMeta.width}×${videoMeta.height}) — displays are horizontal 16:9.`
          );
        }
      }
    } else {
      const imgMeta = await probeImageUrl(objectUrl);
      if (imgMeta) {
        probe.width = imgMeta.width;
        probe.height = imgMeta.height;
      }
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  return { probe, warnings };
}

export const MediaUploadField = wrapFieldsWithMeta((props: any) => {
  const cms = useCMS();
  const { input, field, form } = props;
  const value: string = input?.value || '';
  const durationPath = getSiblingFieldPath(input?.name || '', 'duration');
  const behaviorPath = getSiblingFieldPath(input?.name || '', 'videoBehavior');

  const [uploading, setUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [mediaInfo, setMediaInfo] = useState<MediaProbeResult | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastAutoFilledSrcRef = useRef<string>('');

  const formValues = form?.getState?.()?.values;
  const configuredDuration = Number(getValueAtPath(formValues, durationPath));
  const configuredBehavior = getValueAtPath(formValues, behaviorPath) || 'loop';

  const applyDurationToForm = useCallback(
    (seconds: number, force = false) => {
      if (!form || !durationPath || !Number.isFinite(seconds) || seconds <= 0) return;
      const rounded = Math.max(1, Math.ceil(seconds));
      const currentVal = getValueAtPath(form.getState().values, durationPath);
      if (force || currentVal === undefined || currentVal === null || currentVal === '' || Number(currentVal) <= 0) {
        form.change(durationPath, rounded);
      }
    },
    [form, durationPath]
  );

  // Probe currently selected media URL whenever value changes
  useEffect(() => {
    let active = true;
    if (!value) {
      setMediaInfo(null);
      return;
    }

    const detectedType = detectMediaType(value, undefined, undefined);
    const ext = getFileExtension(value) || detectedType;

    if (detectedType === 'video') {
      probeVideoUrl(value).then((meta) => {
        if (!active) return;
        const info: MediaProbeResult = {
          type: 'video',
          format: ext,
          mimeType: ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4',
          duration: meta?.duration,
          width: meta?.width,
          height: meta?.height,
        };
        setMediaInfo(info);

        if (meta?.duration && lastAutoFilledSrcRef.current !== value) {
          lastAutoFilledSrcRef.current = value;
          applyDurationToForm(meta.duration, false);
        }
      });
    } else {
      probeImageUrl(value).then((meta) => {
        if (!active) return;
        setMediaInfo({
          type: 'image',
          format: ext,
          mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
          width: meta?.width,
          height: meta?.height,
        });
      });
    }

    return () => {
      active = false;
    };
  }, [value, applyDurationToForm]);

  const handleSelectedMedia = useCallback(
    (media: any, droppedProbe?: MediaProbeResult | null) => {
      if (!media) return;
      const item = Array.isArray(media) ? media[0] : media;
      const parsedValue =
        typeof cms?.media?.store?.parse === 'function'
          ? cms.media.store.parse(item)
          : item.src || item;

      input.onChange(parsedValue);

      if (droppedProbe) {
        setMediaInfo(droppedProbe);
        if (droppedProbe.type === 'video' && droppedProbe.duration) {
          lastAutoFilledSrcRef.current = parsedValue;
          applyDurationToForm(droppedProbe.duration, false);
        }
      }
    },
    [cms, input, applyDurationToForm]
  );

  const handleUploadFile = async (file: File) => {
    setErrorMsg(null);
    setWarnings([]);
    setUploading(true);

    try {
      const { probe, error, warnings: fileWarnings } = await inspectDroppedFile(file);
      if (fileWarnings.length > 0) {
        setWarnings(fileWarnings);
      }
      if (error || !probe) {
        setErrorMsg(error || 'Unsupported media file.');
        cms?.alerts?.error?.(error || 'Unsupported media file.');
        return;
      }

      const uploadDir = field?.uploadDir ? field.uploadDir(form?.getState?.()?.values) : '';
      const persisted = await cms.media.persist([
        {
          directory: uploadDir,
          file,
        },
      ]);

      if (persisted && persisted[0]) {
        handleSelectedMedia(persisted[0], probe);
        if (probe.type === 'video' && probe.duration) {
          cms?.alerts?.info?.(
            `Detected ${probe.format.toUpperCase()} video (${probe.duration.toFixed(1)}s).`
          );
        }
      }
    } catch (err: any) {
      const message = err?.message || 'Failed to upload media file.';
      setErrorMsg(message);
      cms?.alerts?.error?.(message);
    } finally {
      setUploading(false);
    }
  };

  const openMediaManager = () => {
    setErrorMsg(null);
    const directory = field?.uploadDir ? field.uploadDir(form?.getState?.()?.values) : '';
    cms.media.open({
      allowDelete: true,
      directory,
      accept: field?.accept,
      onSelect: (media: any) => {
        setWarnings([]);
        handleSelectedMedia(media);
      },
    });
  };

  const isVideo = mediaInfo ? mediaInfo.type === 'video' : detectMediaType(value, undefined, undefined) === 'video';
  const roundedVideoDuration = mediaInfo?.duration ? Math.max(1, Math.ceil(mediaInfo.duration)) : null;

  let durationNotice: { tone: 'warn' | 'info'; text: string } | null = null;
  if (isVideo && mediaInfo?.duration && Number.isFinite(configuredDuration) && configuredDuration > 0) {
    const diff = configuredDuration - mediaInfo.duration;
    if (diff < -0.5) {
      durationNotice = {
        tone: 'warn',
        text: `Video is ${mediaInfo.duration.toFixed(1)}s, which is longer than the ${configuredDuration}s slot — playback will cut at ${configuredDuration}s.`,
      };
    } else if (diff > 0.8) {
      durationNotice = {
        tone: 'info',
        text: `Video is ${mediaInfo.duration.toFixed(1)}s inside a ${configuredDuration}s slot — it will ${
          configuredBehavior === 'hold' ? 'freeze on the final frame' : 'loop seamlessly'
        } until the slot ends.`,
      };
    }
  }

  return (
    <div
      className={`w-full rounded-md border transition-colors ${
        isDragOver ? 'border-blue-500 bg-blue-50/40' : 'border-gray-200 bg-white'
      } p-2`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        const droppedFile = e.dataTransfer?.files?.[0];
        if (droppedFile) {
          handleUploadFile(droppedFile);
        }
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) {
            handleUploadFile(picked);
          }
          e.target.value = '';
        }}
      />

      {uploading ? (
        <div className="py-6 text-center text-sm text-gray-500">
          Detecting format &amp; uploading media...
        </div>
      ) : value ? (
        <div className="flex flex-col gap-2">
          <div className="relative w-full overflow-hidden rounded bg-black/90 flex items-center justify-center max-h-52">
            {isVideo ? (
              <video
                key={value}
                src={value}
                muted
                playsInline
                controls
                preload="metadata"
                className="max-h-52 w-full object-contain"
              />
            ) : (
              <img
                src={value}
                alt="Media preview"
                className="max-h-52 w-full object-contain bg-gray-100"
              />
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
              <span
                className={`px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide ${
                  isVideo ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
                }`}
              >
                {isVideo ? 'Video' : 'Image'}
                {mediaInfo?.format ? ` · ${mediaInfo.format.toUpperCase()}` : ''}
              </span>
              {mediaInfo?.width && mediaInfo?.height ? (
                <span className="text-gray-500">
                  {mediaInfo.width}×{mediaInfo.height}
                </span>
              ) : null}
              {isVideo && mediaInfo?.duration ? (
                <span className="text-gray-600 font-medium">{mediaInfo.duration.toFixed(1)}s</span>
              ) : null}
            </div>

            <div className="flex items-center gap-1.5">
              {isVideo && roundedVideoDuration && configuredDuration !== roundedVideoDuration ? (
                <button
                  type="button"
                  onClick={() => applyDurationToForm(mediaInfo!.duration!, true)}
                  className="px-2 py-1 rounded bg-purple-600 text-white hover:bg-purple-700 font-medium"
                >
                  Set duration to {roundedVideoDuration}s
                </button>
              ) : null}
              <button
                type="button"
                onClick={openMediaManager}
                className="px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100"
              >
                Replace
              </button>
              <button
                type="button"
                onClick={() => {
                  input.onChange('');
                  setMediaInfo(null);
                  setWarnings([]);
                  setErrorMsg(null);
                }}
                className="px-2 py-1 rounded border border-gray-300 text-red-600 hover:bg-red-50"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="text-[11px] text-gray-400 truncate" title={value}>
            {value}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 py-4 px-2 text-center">
          <div className="text-sm text-gray-600">
            Drag &amp; drop an image or video here
          </div>
          <div className="text-xs text-gray-400">
            Auto-detects JPG, PNG, WebP, GIF, MP4 (H.264), WebM, MOV
          </div>
          <div className="flex items-center gap-2 mt-1">
            <button
              type="button"
              onClick={openMediaManager}
              className="px-3 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
            >
              Browse Media Library
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 rounded border border-gray-300 text-gray-700 text-xs font-medium hover:bg-gray-100"
            >
              Upload File
            </button>
          </div>
        </div>
      )}

      {durationNotice ? (
        <div
          className={`mt-2 rounded px-2.5 py-1.5 text-xs ${
            durationNotice.tone === 'warn'
              ? 'bg-amber-50 text-amber-800 border border-amber-200'
              : 'bg-blue-50 text-blue-800 border border-blue-200'
          }`}
        >
          {durationNotice.text}
        </div>
      ) : null}

      {warnings.map((w, idx) => (
        <div
          key={idx}
          className="mt-2 rounded bg-amber-50 border border-amber-200 px-2.5 py-1.5 text-xs text-amber-800"
        >
          {w}
        </div>
      ))}

      {errorMsg ? (
        <div className="mt-2 rounded bg-red-50 border border-red-200 px-2.5 py-1.5 text-xs text-red-700">
          {errorMsg}
        </div>
      ) : null}
    </div>
  );
});
