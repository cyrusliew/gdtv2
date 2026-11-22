import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
// eslint-disable-next-line no-unused-vars
import { AnimatePresence, motion } from 'framer-motion';
import mediaManifest from '../../data/media-manifest.json';
import VideoSlide from './VideoSlide';
import {
  detectMediaType,
  getMediaManifestEntry,
  resolveSlideDuration,
  resolveTakeoverDuration,
} from '../../utils/media';

// Import all JSON files from the data directory
const tvDataModules = import.meta.glob('../../data/tv*.json', { eager: true });
const takeoverModules = import.meta.glob('../../data/takeovers/*.json', { eager: true });

export default function TVPlayer() {
  const { tvId } = useParams();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPreloading, setIsPreloading] = useState(true);

  // Debug Mode State
  const [debugMode, setDebugMode] = useState(false);
  const [debugClicks, setDebugClicks] = useState(0);
  const [currentVersion, setCurrentVersion] = useState('Unknown');
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [nextCheckTime, setNextCheckTime] = useState(() => Date.now() + 30000);
  const [videoTelemetry, setVideoTelemetry] = useState(null);
  const [manualOffsetSec, setManualOffsetSec] = useState(0);

  const debugClickTimeoutRef = useRef(null);
  const warmedVideoUrlsRef = useRef(new Set());

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

              return {
                ...slide,
                type,
                originalSrc: slide.src,
                src: manifestEntry?.src || slide.src,
                webmSrc: manifestEntry?.webmSrc || null,
                poster: manifestEntry?.poster || null,
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

        return {
          id: takeover.title || takeover.id,
          type,
          originalSrc: mediaSrc,
          src: manifestEntry?.src || mediaSrc,
          webmSrc: manifestEntry?.webmSrc || null,
          poster: manifestEntry?.poster || null,
          mimeType: manifestEntry?.mimeType || null,
          intrinsicDuration: manifestEntry?.duration || null,
          videoBehavior: takeover.videoBehavior || 'loop',
          duration,
          syncGroup: takeover.title || takeover.id,
        };
      })
      .filter(Boolean);

    return [...baseSlides, ...takeoverSlides];
  }, [tvId]);

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

  useEffect(() => {
    if (!hasImagesToPreload) return;

    let isMounted = true;

    const preloadImages = async () => {
      const imagePromises = preloadImageUrls.map((url) => {
        return new Promise((resolve) => {
          const img = new Image();
          img.src = url;
          if ('decode' in img && typeof img.decode === 'function') {
            img
              .decode()
              .then(resolve)
              .catch(() => {
                img.onload = resolve;
                img.onerror = resolve;
              });
          } else {
            img.onload = resolve;
            img.onerror = resolve;
          }
        });
      });

      await Promise.all(imagePromises);

      if (isMounted) {
        setIsPreloading(false);
      }
    };

    preloadImages();

    return () => {
      isMounted = false;
    };
  }, [preloadImageUrls, hasImagesToPreload]);

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

  // ── High-Precision Deterministic Time-Based Schedule Sync ─────────────────
  useEffect(() => {
    if (isLoading || playlistSchedule.totalDuration === 0) return;

    const syncToSchedule = () => {
      const nowMs = Date.now();
      setCurrentTime(nowMs);

      const totalDuration = playlistSchedule.totalDuration;
      const nowSec = nowMs / 1000 + manualOffsetSec;
      const rawMod = nowSec % totalDuration;
      const currentCycleTime = rawMod < 0 ? rawMod + totalDuration : rawMod;

      // Find active slide based on current cycle timestamp
      const windowIndex = playlistSchedule.windows.findIndex(
        (w) => currentCycleTime >= w.start && currentCycleTime < w.end
      );

      const activeIndex = windowIndex !== -1 ? windowIndex : 0;
      setCurrentIndex((prevIndex) => (prevIndex !== activeIndex ? activeIndex : prevIndex));
    };

    syncToSchedule();
    const intervalId = setInterval(syncToSchedule, 50);

    return () => {
      clearInterval(intervalId);
    };
  }, [isLoading, playlistSchedule, manualOffsetSec]);

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

  // Poll version for updates
  useEffect(() => {
    const checkVersion = async () => {
      try {
        const response = await fetch('/version.json?t=' + Date.now());
        const data = await response.json();

        setNextCheckTime(Date.now() + 30000);

        if (currentVersion === 'Unknown') {
          setCurrentVersion(data.timestamp);
        } else if (data.timestamp !== currentVersion) {
          console.log('New version detected, reloading...');
          window.location.reload();
        }
      } catch (error) {
        console.error('Failed to check version:', error);
      }
    };

    checkVersion();
    const intervalId = setInterval(checkVersion, 30000);
    return () => clearInterval(intervalId);
  }, [currentVersion]);

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

  // Use 'wait' mode when rendering video slides so Chromium 79 never runs two
  // hardware video decoders simultaneously during a crossfade.
  const animateMode = currentSlide.type === 'video' ? 'wait' : 'sync';

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

      <AnimatePresence mode={animateMode}>
        {currentSlide.type === 'image' ? (
          <motion.img
            key={`${currentSlide.id}-${safeIndex}-img`}
            src={currentSlide.src}
            alt="slide"
            className="absolute inset-0 w-full h-full object-contain"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          />
        ) : (
          <motion.div
            key={`${currentSlide.id}-${safeIndex}-vid`}
            className="absolute inset-0 w-full h-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <VideoSlide
              slide={currentSlide}
              activeWindow={activeWindow}
              totalPlaylistDuration={totalPlaylistDuration}
              manualOffsetSec={manualOffsetSec}
              onTelemetry={debugMode ? handleVideoTelemetry : null}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
