import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import mediaManifest from '../../data/media-manifest.json';
import VideoSlide from './VideoSlide';
import {
  detectMediaType,
  getMediaManifestEntry,
  resolveSlideDuration,
  resolveTakeoverDuration,
} from '../../utils/media';
import {
  BUILD_VERSION,
  getDeviceSnapshot,
  probeUrlError,
  sendTelemetry,
} from '../../utils/telemetry';

function hasDebugQueryFlag() {
  try {
    return (
      window.location.search.indexOf('debug=1') !== -1 ||
      window.location.hash.indexOf('debug=1') !== -1
    );
  } catch {
    return false;
  }
}

function getR2QueryOverride() {
  try {
    const combined = `${window.location.search}&${window.location.hash}`;
    if (/(?:[?&#])r2=1(?:&|$)/.test(combined)) return true;
    if (/(?:[?&#])r2=0(?:&|$)/.test(combined)) return false;
  } catch {
    // Ignore
  }
  return null;
}

function resolveSlideMediaSources(rawSrc, manifestEntry, useR2) {
  if (useR2) {
    return {
      src: (manifestEntry && manifestEntry.src) || rawSrc,
      webmSrc: (manifestEntry && manifestEntry.webmSrc) || null,
      poster: (manifestEntry && manifestEntry.poster) || null,
    };
  }

  return {
    src:
      (manifestEntry && manifestEntry.localSrc) ||
      (typeof rawSrc === 'string' && rawSrc.startsWith('/assets/') ? rawSrc : null) ||
      (manifestEntry && manifestEntry.src) ||
      rawSrc,
    webmSrc: (manifestEntry && manifestEntry.localWebmSrc) || null,
    poster: (manifestEntry && manifestEntry.localPoster) || null,
  };
}

// Import all JSON files from the data directory
const tvDataModules = import.meta.glob('../../data/tv*.json', { eager: true });
const takeoverModules = import.meta.glob('../../data/takeovers/*.json', { eager: true });

export default function TVPlayer() {
  const { tvId } = useParams();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPreloading, setIsPreloading] = useState(true);

  // Debug Mode State
  const [debugMode, setDebugMode] = useState(() => hasDebugQueryFlag());
  const [debugClicks, setDebugClicks] = useState(0);
  const [currentVersion, setCurrentVersion] = useState(() => BUILD_VERSION);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [nextCheckTime, setNextCheckTime] = useState(() => Date.now() + 30000);
  const [videoTelemetry, setVideoTelemetry] = useState(null);
  const [lastImageError, setLastImageError] = useState(null);
  const [manualOffsetSec, setManualOffsetSec] = useState(0);

  const debugClickTimeoutRef = useRef(null);
  const debugModeRef = useRef(debugMode);
  const warmedVideoUrlsRef = useRef(new Set());
  const loggedLoadedImagesRef = useRef(new Set());
  const loggedErrorImagesRef = useRef(new Set());

  useEffect(() => {
    debugModeRef.current = debugMode;
    if (debugMode) {
      setCurrentTime(Date.now());
    }
  }, [debugMode]);

  // Determine whether this TV serves assets from Cloudflare R2 or local /assets/
  const useR2 = useMemo(() => {
    const override = getR2QueryOverride();
    if (override !== null) return override;
    const tvPath = `../../data/${tvId}.json`;
    const tvMod = tvDataModules[tvPath];
    return Boolean(tvMod && tvMod.useR2 === true);
  }, [tvId]);

  // Synchronously compute slides (base slides + active multi-screen takeovers)
  // enriched with build-time media-manifest metadata so durations are 100% deterministic.
  const slides = useMemo(() => {
    const path = `../../data/${tvId}.json`;
    const module = tvDataModules[path];

    const baseSlides =
      module && module.slides
        ? module.slides
            .filter((slide) => !slide.unpublish)
            .map((slide) => {
              const manifestEntry = getMediaManifestEntry(slide.src, mediaManifest);
              const type = detectMediaType(slide.src, slide.type, mediaManifest);
              const duration = resolveSlideDuration(slide, mediaManifest);
              const resolved = resolveSlideMediaSources(slide.src, manifestEntry, useR2);

              return {
                ...slide,
                type,
                originalSrc: slide.src,
                src: resolved.src,
                webmSrc: resolved.webmSrc,
                poster: resolved.poster,
                mimeType: manifestEntry?.mimeType || null,
                intrinsicDuration: manifestEntry?.duration || null,
                videoBehavior: slide.videoBehavior || 'loop',
                duration,
              };
            })
        : [];

    // Process published Multi-Screen Takeovers
    const takeoverSlides = Object.values(takeoverModules)
      .map((m) => (m && m.default ? m.default : m))
      .filter((takeover) => takeover && (takeover.title || takeover.id) && !takeover.unpublish)
      .map((takeover) => {
        const mediaSrc = takeover[`${tvId}Media`];
        if (!mediaSrc) return null;

        const manifestEntry = getMediaManifestEntry(mediaSrc, mediaManifest);
        const type = detectMediaType(mediaSrc, takeover.type, mediaManifest);
        const duration = resolveTakeoverDuration(takeover, mediaManifest);
        const resolved = resolveSlideMediaSources(mediaSrc, manifestEntry, useR2);

        return {
          id: takeover.title || takeover.id,
          type,
          originalSrc: mediaSrc,
          src: resolved.src,
          webmSrc: resolved.webmSrc,
          poster: resolved.poster,
          mimeType: manifestEntry?.mimeType || null,
          intrinsicDuration: manifestEntry?.duration || null,
          videoBehavior: takeover.videoBehavior || 'loop',
          duration,
          syncGroup: takeover.title || takeover.id,
        };
      })
      .filter(Boolean);

    return [...baseSlides, ...takeoverSlides];
  }, [tvId, useR2]);

  // Preload all image slides AND video poster frames so transitions never flash black
  const preloadImageUrls = useMemo(() => {
    const urls = [];
    for (const slide of slides) {
      if (slide.type === 'image' && slide.src) {
        urls.push(slide.src);
      } else if (slide.type === 'video' && slide.poster) {
        urls.push(slide.poster);
      }
    }
    return urls;
  }, [slides]);

  const hasImagesToPreload = preloadImageUrls.length > 0;
  const isLoading = hasImagesToPreload && isPreloading;

  // Log device boot & resolved slide URLs once per TV mount
  useEffect(() => {
    sendTelemetry(tvId, 'boot', {
      useR2,
      device: getDeviceSnapshot(),
      slideCount: slides.length,
      slides: slides.map((s) => ({
        id: s.id,
        type: s.type,
        src: s.src,
        webmSrc: s.webmSrc || null,
        poster: s.poster || null,
        duration: s.duration,
      })),
    });
  }, [tvId, slides, useR2]);

  // Calculate total playlist duration and slide time windows
  const playlistSchedule = useMemo(() => {
    if (slides.length === 0) return { totalDuration: 0, windows: [] };

    let cumulative = 0;
    const windows = slides.map((slide) => {
      const duration = slide.duration || 10;
      const start = cumulative;
      const end = cumulative + duration;
      cumulative = end;
      return { slide, start, end, duration };
    });

    return { totalDuration: cumulative, windows };
  }, [slides]);

  const computeActiveIndexAt = useCallback(
    (nowMs) => {
      const totalDuration = playlistSchedule.totalDuration;
      if (totalDuration <= 0) return 0;
      const nowSec = nowMs / 1000 + manualOffsetSec;
      const rawMod = nowSec % totalDuration;
      const currentCycleTime = rawMod < 0 ? rawMod + totalDuration : rawMod;
      const windowIndex = playlistSchedule.windows.findIndex(
        (w) => currentCycleTime >= w.start && currentCycleTime < w.end
      );
      return windowIndex !== -1 ? windowIndex : 0;
    },
    [playlistSchedule, manualOffsetSec]
  );

  useEffect(() => {
    if (!hasImagesToPreload) return;

    let isMounted = true;
    const preloadStartedAt = Date.now();

    const preloadImages = async () => {
      const imagePromises = preloadImageUrls.map((url) => {
        return new Promise((resolve) => {
          let settled = false;
          const startedAt = Date.now();
          const done = (status, extra) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timerId);
            resolve({ url, status, ms: Date.now() - startedAt, ...(extra || {}) });
          };
          const timerId = window.setTimeout(() => done('timeout'), 8000);
          const img = new Image();
          img.onload = () => {
            const dims = { w: img.naturalWidth, h: img.naturalHeight };
            if ('decode' in img && typeof img.decode === 'function') {
              img
                .decode()
                .then(() => done('ok', dims))
                .catch((err) =>
                  done('decode_error', {
                    ...dims,
                    error: err && err.message ? err.message : String(err),
                  })
                );
            } else {
              done('ok', dims);
            }
          };
          img.onerror = () => done('error');
          img.src = url;
        });
      });

      const results = await Promise.all(imagePromises);

      if (isMounted) {
        // Set the exact NTP slide index before leaving loading state (no 1-frame flash of slide 0)
        setCurrentIndex(computeActiveIndexAt(Date.now()));
        setIsPreloading(false);
        const failed = results.filter((r) => r.status !== 'ok');
        sendTelemetry(tvId, 'preload_done', {
          totalMs: Date.now() - preloadStartedAt,
          total: results.length,
          okCount: results.length - failed.length,
          failedCount: failed.length,
          results,
        });
      }
    };

    preloadImages();

    return () => {
      isMounted = false;
    };
  }, [preloadImageUrls, hasImagesToPreload, tvId, computeActiveIndexAt]);

  // ── High-Precision Deterministic Time-Based Schedule Sync ─────────────────
  // Only updates currentTime React state when Debug Mode is open so the TV
  // does not re-render 20 times/second during normal playback.
  useEffect(() => {
    if (isLoading || playlistSchedule.totalDuration === 0) return;

    const syncToSchedule = () => {
      const nowMs = Date.now();
      if (debugModeRef.current) {
        setCurrentTime(nowMs);
      }
      const activeIndex = computeActiveIndexAt(nowMs);
      setCurrentIndex((prevIndex) => (prevIndex !== activeIndex ? activeIndex : prevIndex));
    };

    syncToSchedule();
    const intervalId = setInterval(syncToSchedule, 50);

    return () => {
      clearInterval(intervalId);
    };
  }, [isLoading, playlistSchedule.totalDuration, computeActiveIndexAt]);

  // ── 1-Slide Lookahead HTTP Cache Warmup for Upcoming Video Slides ─────────
  // Warms only the first 2 MB (moov atom + opening GOP) via Range request for
  // same-origin videos so large videos start fast without saturating bandwidth
  // or claiming a 2nd hardware video decoder on LG Signage TV (Chromium 79).
  // For cross-origin media (e.g. Cloudflare R2 without CORS), skip the Range
  // fetch (which triggers a blocked OPTIONS preflight) and preconnect instead.
  useEffect(() => {
    if (isLoading || slides.length <= 1) return;

    const nextIndex = (currentIndex + 1) % slides.length;
    const nextSlide = slides[nextIndex];
    if (!nextSlide || nextSlide.type !== 'video' || !nextSlide.src) return;
    if (warmedVideoUrlsRef.current.has(nextSlide.src)) return;

    let isSameOrigin = false;
    let targetOrigin = null;
    try {
      const parsed = new URL(nextSlide.src, window.location.href);
      targetOrigin = parsed.origin;
      isSameOrigin = parsed.origin === window.location.origin;
    } catch {
      isSameOrigin = !/^https?:\/\//i.test(nextSlide.src);
    }

    if (!isSameOrigin) {
      warmedVideoUrlsRef.current.add(nextSlide.src);
      if (targetOrigin && typeof document !== 'undefined') {
        const existing = document.head.querySelector(
          `link[rel="preconnect"][href="${targetOrigin}"]`
        );
        if (!existing) {
          const link = document.createElement('link');
          link.rel = 'preconnect';
          link.href = targetOrigin;
          document.head.appendChild(link);
        }
      }
      return;
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    warmedVideoUrlsRef.current.add(nextSlide.src);

    fetch(nextSlide.src, {
      headers: { Range: 'bytes=0-2097151' },
      ...(controller ? { signal: controller.signal } : {}),
    }).catch(() => {
      warmedVideoUrlsRef.current.delete(nextSlide.src);
    });

    return () => {
      if (controller) controller.abort();
    };
  }, [currentIndex, slides, isLoading]);

  // Poll version for updates (cache-busting reload avoids LG webOS stale index.html cache)
  useEffect(() => {
    let baselineVersion = BUILD_VERSION !== 'dev' ? BUILD_VERSION : null;

    const checkVersion = async () => {
      try {
        const response = await fetch('/version.json?t=' + Date.now(), { cache: 'no-store' });
        const data = await response.json();
        const remoteVersion = String(data.timestamp);

        setNextCheckTime(Date.now() + 30000);

        if (!baselineVersion) {
          baselineVersion = remoteVersion;
          setCurrentVersion(remoteVersion);
        } else if (remoteVersion !== baselineVersion) {
          console.log('New version detected, reloading...', baselineVersion, '->', remoteVersion);
          sendTelemetry(tvId, 'version_reload', {
            fromVersion: baselineVersion,
            toVersion: remoteVersion,
          });
          const hash = window.location.hash || '';
          window.location.replace(`/?v=${encodeURIComponent(remoteVersion)}${hash}`);
        }
      } catch (error) {
        console.error('Failed to check version:', error);
      }
    };

    checkVersion();
    const intervalId = setInterval(checkVersion, 30000);
    return () => clearInterval(intervalId);
  }, [tvId]);

  const handleVideoTelemetry = useCallback((telemetry) => {
    setVideoTelemetry(telemetry);
  }, []);

  // Manual next-slide tap shifts local schedule offset so manual testing works with time sync
  const handleNextSlide = () => {
    if (playlistSchedule.windows.length <= 1) return;
    const nextIdx = (currentIndex + 1) % playlistSchedule.windows.length;
    const nextWin = playlistSchedule.windows[nextIdx];
    const nowSec = Date.now() / 1000;
    const rawNowMod = nowSec % playlistSchedule.totalDuration;
    setManualOffsetSec(nextWin.start - rawNowMod + 0.05);
    setCurrentIndex(nextIdx);
  };

  const handleDebugTrigger = () => {
    setDebugClicks((prev) => prev + 1);

    if (debugClickTimeoutRef.current) clearTimeout(debugClickTimeoutRef.current);

    if (debugClicks + 1 >= 3) {
      setDebugMode((prev) => !prev);
      setDebugClicks(0);
      // Reset any manual slide offset when toggling debug mode so TV returns to true NTP sync
      setManualOffsetSec(0);
    } else {
      debugClickTimeoutRef.current = setTimeout(() => {
        setDebugClicks(0);
      }, 1000);
    }
  };

  if (isLoading) {
    return (
      <div className="bg-primary h-screen w-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-t-2 border-b-2 border-white"></div>
      </div>
    );
  }

  if (slides.length === 0)
    return (
      <div className="bg-primary text-white h-screen flex items-center justify-center text-2xl">
        No content scheduled
      </div>
    );

  const safeIndex = currentIndex < slides.length ? currentIndex : 0;
  const currentSlide = slides[safeIndex];
  const activeWindow = playlistSchedule.windows[safeIndex];
  const totalPlaylistDuration = playlistSchedule.totalDuration;
  const rawCycle = totalPlaylistDuration
    ? (currentTime / 1000 + manualOffsetSec) % totalPlaylistDuration
    : 0;
  const currentCycleTime = rawCycle < 0 ? rawCycle + totalPlaylistDuration : rawCycle;
  const elapsedInSlide = activeWindow ? Math.max(0, currentCycleTime - activeWindow.start) : 0;
  const slideDuration = activeWindow ? activeWindow.duration : currentSlide?.duration || 10;

  return (
    <div className="bg-black h-screen w-screen overflow-hidden flex items-center justify-center relative">
      {/* Hidden fullscreen next-slide button */}
      <button
        type="button"
        className="absolute inset-0 z-40 w-full h-full opacity-0"
        aria-label="Next slide"
        onClick={handleNextSlide}
      />

      {/* Debug Trigger Area (Top-Left) */}
      <div
        className="absolute top-0 left-0 w-24 h-24 z-50 cursor-default"
        onClick={handleDebugTrigger}
      ></div>

      {/* Debug Overlay */}
      {debugMode && (
        <div className="absolute top-4 right-4 bg-black/80 text-green-400 p-4 rounded-md font-mono text-sm z-50 border border-green-800 shadow-lg pointer-events-none max-w-sm">
          <div className="flex flex-col space-y-1.5">
            <div>
              <span className="text-gray-400">TV:</span> {tvId}
            </div>
            <div>
              <span className="text-gray-400">Media Source:</span>{' '}
              {useR2 ? 'Cloudflare R2' : 'Local (/assets)'}
            </div>
            <div>
              <span className="text-gray-400">Sync Mode:</span> Time-Based NTP (50ms)
            </div>
            <div>
              <span className="text-gray-400">Version:</span> {currentVersion}
            </div>
            <div>
              <span className="text-gray-400">Next Check:</span>{' '}
              {Math.max(0, Math.ceil((nextCheckTime - currentTime) / 1000))}s
            </div>
            <div>
              <span className="text-gray-400">Cycle Time:</span> {currentCycleTime.toFixed(1)}s /{' '}
              {totalPlaylistDuration}s
            </div>
            <div>
              <span className="text-gray-400">Slide Window:</span> [{activeWindow?.start}s -{' '}
              {activeWindow?.end}s]
            </div>
            <div>
              <span className="text-gray-400">Slide Time:</span> {elapsedInSlide.toFixed(1)}s /{' '}
              {slideDuration}s
            </div>
            <div>
              <span className="text-gray-400">Type:</span> {currentSlide.type}
              {currentSlide.mimeType ? ` (${currentSlide.mimeType})` : ''}
            </div>
            {lastImageError && (
              <div className="text-red-400">
                <span className="text-gray-400">Img Error:</span> {lastImageError}
              </div>
            )}
            {currentSlide.type === 'video' && (
              <>
                <div>
                  <span className="text-gray-400">Behavior:</span> {currentSlide.videoBehavior}
                </div>
                {videoTelemetry && (
                  <>
                    <div>
                      <span className="text-gray-400">Video Pos:</span>{' '}
                      {videoTelemetry.videoTime.toFixed(2)}s / Target{' '}
                      {videoTelemetry.targetTime.toFixed(2)}s
                    </div>
                    <div>
                      <span className="text-gray-400">Drift / Rate:</span>{' '}
                      {videoTelemetry.driftMs >= 0 ? '+' : ''}
                      {videoTelemetry.driftMs}ms ({videoTelemetry.playbackRate.toFixed(2)}x)
                    </div>
                    <div>
                      <span className="text-gray-400">ReadyState:</span> {videoTelemetry.readyState}
                    </div>
                    {videoTelemetry.error && (
                      <div className="text-red-400">
                        <span className="text-gray-400">Error:</span> {videoTelemetry.error}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Keep image slides persistently mounted with CSS opacity crossfades so LG
          webOS Chromium 79 never re-decodes images or stalls WAAPI animations on transitions */}
      {slides.map((slide, idx) => {
        if (slide.type !== 'image') return null;
        const isActive = idx === safeIndex;
        const hideForVideo = currentSlide.type === 'video';
        return (
          <img
            key={`${slide.id}-${idx}-img`}
            src={slide.src}
            alt={slide.id || 'slide'}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
            style={{
              opacity: isActive ? 1 : 0,
              visibility: hideForVideo ? 'hidden' : 'visible',
              zIndex: isActive ? 10 : 1,
              transition: hideForVideo ? 'none' : 'opacity 300ms ease-in-out',
            }}
            onLoad={(e) => {
              const imgEl = e.currentTarget;
              if (!loggedLoadedImagesRef.current.has(slide.src)) {
                loggedLoadedImagesRef.current.add(slide.src);
                sendTelemetry(tvId, 'img_loaded', {
                  slideId: slide.id,
                  src: slide.src,
                  w: imgEl.naturalWidth,
                  h: imgEl.naturalHeight,
                });
              }
            }}
            onError={() => {
              const failedSrc = slide.src;
              setLastImageError(failedSrc);
              if (!loggedErrorImagesRef.current.has(failedSrc)) {
                loggedErrorImagesRef.current.add(failedSrc);
                probeUrlError(failedSrc).then((probe) => {
                  sendTelemetry(tvId, 'img_error', {
                    slideId: slide.id,
                    src: failedSrc,
                    probe,
                  });
                });
              }
            }}
          />
        );
      })}

      {/* Mount only the single active video slide so Chromium 79 never allocates
          two hardware video decoders simultaneously */}
      {currentSlide.type === 'video' && (
        <div
          key={`${currentSlide.id}-${safeIndex}-vid`}
          className="absolute inset-0 w-full h-full z-20"
        >
          <VideoSlide
            tvId={tvId}
            slide={currentSlide}
            activeWindow={activeWindow}
            totalPlaylistDuration={totalPlaylistDuration}
            manualOffsetSec={manualOffsetSec}
            onTelemetry={debugMode ? handleVideoTelemetry : null}
          />
        </div>
      )}
    </div>
  );
}
