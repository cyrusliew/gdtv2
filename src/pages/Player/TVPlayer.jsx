import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams } from 'react-router-dom';
// eslint-disable-next-line no-unused-vars
import { AnimatePresence, motion } from 'framer-motion';

// Import all JSON files from the data directory
const tvDataModules = import.meta.glob('../../data/tv*.json', { eager: true });
const takeoverModules = import.meta.glob('../../data/takeovers/*.json', { eager: true });

// Auto-detect media type from file extension if explicit type is omitted
function detectMediaType(src, explicitType) {
  if (explicitType === 'video' || explicitType === 'image') return explicitType;
  if (!src) return 'image';
  return /\.(mp4|webm|ogg|mov|m4v)$/i.test(src) ? 'video' : 'image';
}

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

  const videoRef = useRef(null);
  const timerRef = useRef(null);
  const debugClickTimeoutRef = useRef(null);

  // Synchronously compute slides (base slides + active multi-screen takeovers)
  const slides = useMemo(() => {
    const path = `../../data/${tvId}.json`;
    const module = tvDataModules[path];
    const baseSlides = module && module.slides
      ? module.slides
          .filter((slide) => !slide.unpublish)
          .map((slide) => ({
            ...slide,
            type: detectMediaType(slide.src, slide.type),
          }))
      : [];

    // Process published Multi-Screen Takeovers
    const takeoverSlides = Object.values(takeoverModules)
      .map((m) => (m && m.default ? m.default : m))
      .filter((takeover) => takeover && (takeover.title || takeover.id) && !takeover.unpublish)
      .map((takeover) => {
        const mediaSrc = takeover[`${tvId}Media`];

        if (!mediaSrc) return null;

        return {
          id: takeover.title || takeover.id,
          type: detectMediaType(mediaSrc, takeover.type),
          src: mediaSrc,
          duration: takeover.duration || 15,
          syncGroup: takeover.title || takeover.id,
        };
      })
      .filter(Boolean);

    return [...baseSlides, ...takeoverSlides];
  }, [tvId]);

  const hasImagesToPreload = useMemo(
    () => slides.some((s) => s.type === 'image'),
    [slides]
  );

  const isLoading = hasImagesToPreload && isPreloading;

  // Preload images and manage loading state
  useEffect(() => {
    if (!hasImagesToPreload) return;

    let isMounted = true;

    const preloadImages = async () => {
      const imagePromises = slides
        .filter((slide) => slide.type === 'image')
        .map((slide) => {
          return new Promise((resolve) => {
            const img = new Image();
            img.src = slide.src;
            img.onload = resolve;
            img.onerror = resolve;
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
  }, [slides, hasImagesToPreload]);

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

  // ── Deterministic Time-Based Schedule Sync ──────────────────────────────
  useEffect(() => {
    if (isLoading || playlistSchedule.totalDuration === 0) return;

    const syncToSchedule = () => {
      const nowMs = Date.now();
      setCurrentTime(nowMs);

      const totalDuration = playlistSchedule.totalDuration;
      const nowSec = nowMs / 1000;
      const currentCycleTime = nowSec % totalDuration;

      // Find active slide based on current cycle timestamp
      const windowIndex = playlistSchedule.windows.findIndex(
        (w) => currentCycleTime >= w.start && currentCycleTime < w.end
      );

      const activeIndex = windowIndex !== -1 ? windowIndex : 0;
      setCurrentIndex(activeIndex);

      // Calculate remaining milliseconds until the end of the active slide window
      const activeWindow = playlistSchedule.windows[activeIndex];
      const remainingSec = activeWindow ? activeWindow.end - currentCycleTime : 10;
      const msUntilNextSlide = Math.max(50, Math.ceil(remainingSec * 1000));

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(syncToSchedule, msUntilNextSlide);
    };

    syncToSchedule();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isLoading, playlistSchedule]);

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

  // Clock tick for debug overlay
  useEffect(() => {
    if (!debugMode) return;
    const timerId = setInterval(() => {
      setCurrentTime(Date.now());
    }, 100);
    return () => clearInterval(timerId);
  }, [debugMode]);

  const handleNextSlide = () => {
    setCurrentIndex((prev) => (prev + 1) % slides.length);
  };

  const handleDebugTrigger = () => {
    setDebugClicks((prev) => prev + 1);

    if (debugClickTimeoutRef.current) clearTimeout(debugClickTimeoutRef.current);

    if (debugClicks + 1 >= 3) {
      setDebugMode((prev) => !prev);
      setDebugClicks(0);
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

  const currentSlide = slides[currentIndex];
  const activeWindow = playlistSchedule.windows[currentIndex];
  const totalPlaylistDuration = playlistSchedule.totalDuration;
  const currentCycleTime = totalPlaylistDuration ? (currentTime / 1000) % totalPlaylistDuration : 0;
  const elapsedInSlide = activeWindow ? Math.max(0, currentCycleTime - activeWindow.start) : 0;
  const slideDuration = activeWindow ? activeWindow.duration : (currentSlide?.duration || 10);

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
        <div className="absolute top-4 right-4 bg-black/80 text-green-400 p-4 rounded-md font-mono text-sm z-50 border border-green-800 shadow-lg pointer-events-none">
          <div className="flex flex-col gap-2">
            <div>
              <span className="text-gray-400">TV:</span> {tvId}
            </div>
            <div>
              <span className="text-gray-400">Sync Mode:</span> Time-Based NTP (Serverless)
            </div>
            <div>
              <span className="text-gray-400">Version:</span> {currentVersion}
            </div>
            <div>
              <span className="text-gray-400">Next Check:</span>{' '}
              {Math.max(0, Math.ceil((nextCheckTime - currentTime) / 1000))}s
            </div>
            <div>
              <span className="text-gray-400">Cycle Time:</span> {currentCycleTime.toFixed(1)}s / {totalPlaylistDuration}s
            </div>
            <div>
              <span className="text-gray-400">Slide Window:</span> [{activeWindow?.start}s - {activeWindow?.end}s]
            </div>
            <div>
              <span className="text-gray-400">Slide Time:</span> {elapsedInSlide.toFixed(1)}s / {slideDuration}s
            </div>
            <div>
              <span className="text-gray-400">Type:</span> {currentSlide.type}
            </div>
          </div>
        </div>
      )}

      <AnimatePresence mode="wait">
        {currentSlide.type === 'image' ? (
          <motion.img
            key={currentSlide.id + '-img'}
            src={currentSlide.src}
            alt="slide"
            className="w-full h-full object-contain"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
          />
        ) : (
          <motion.div
            key={currentSlide.id + '-vid'}
            className="w-full h-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
          >
            <video
              ref={videoRef}
              src={currentSlide.src}
              className="w-full h-full object-contain"
              autoPlay
              muted
              playsInline
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
