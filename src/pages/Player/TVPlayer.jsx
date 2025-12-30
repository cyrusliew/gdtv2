import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';

// Import all JSON files from the data directory
const tvDataModules = import.meta.glob('../../data/tv*.json', { eager: true });

export default function TVPlayer() {
  const { tvId } = useParams();
  const [slides, setSlides] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // Debug Mode State
  const [debugMode, setDebugMode] = useState(false);
  const [debugClicks, setDebugClicks] = useState(0);
  const [currentVersion, setCurrentVersion] = useState('Unknown');
  const [slideStartTime, setSlideStartTime] = useState(Date.now());
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [nextCheckTime, setNextCheckTime] = useState(Date.now() + 30000);

  const videoRef = useRef(null);
  const timeoutRef = useRef(null);
  const debugClickTimeoutRef = useRef(null);

  useEffect(() => {
    setIsLoading(true);
    // Construct the path to the specific JSON file
    const path = `../../data/${tvId}.json`;
    const module = tvDataModules[path];

    if (module && module.slides) {
      setSlides(module.slides);
    } else {
      console.warn(`No configuration found for ${tvId}`);
      setSlides([]);
      setIsLoading(false);
    }

    // Reset index when TV changes
    setCurrentIndex(0);
  }, [tvId]);

  // Preload images
  useEffect(() => {
    if (slides.length === 0) return;

    let isMounted = true;

    const preloadImages = async () => {
      const imagePromises = slides
        .filter((slide) => slide.type === 'image')
        .map((slide) => {
          return new Promise((resolve) => {
            const img = new Image();
            img.src = slide.src;
            img.onload = resolve;
            img.onerror = resolve; // Proceed even if fails
          });
        });

      await Promise.all(imagePromises);

      if (isMounted) {
        setIsLoading(false);
      }
    };

    preloadImages();

    return () => {
      isMounted = false;
    };
  }, [slides]);

  // Check for updates
  useEffect(() => {
    const checkVersion = async () => {
      try {
        console.log('Checking version...');
        const response = await fetch('/version.json?t=' + Date.now());
        const data = await response.json();

        // Set next check time
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

    // Initial check
    checkVersion();

    // Poll every 30 seconds
    const intervalId = setInterval(checkVersion, 30000);

    return () => clearInterval(intervalId);
  }, [currentVersion]);

  // Timer for debug mode
  useEffect(() => {
    if (!debugMode) return;
    const timerId = setInterval(() => {
      setCurrentTime(Date.now());
    }, 100); // 100ms for smoother updates if we wanted, but 1s is fine. sticking to 100ms for responsiveness.
    return () => clearInterval(timerId);
  }, [debugMode]);

  // Handle slide transition logic
  useEffect(() => {
    if (isLoading || slides.length === 0) return;

    const currentSlide = slides[currentIndex];

    // Reset timer for the new slide
    setSlideStartTime(Date.now());
    setCurrentTime(Date.now());

    // Clear any existing timeout
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    const advanceSlide = () => {
      setCurrentIndex((prev) => (prev + 1) % slides.length);
    };

    if (currentSlide.type === 'image') {
      const duration = (currentSlide.duration || 10) * 1000;
      timeoutRef.current = setTimeout(advanceSlide, duration);
    } else if (currentSlide.type === 'video') {
      // Video handled by onEnded
    }

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [currentIndex, slides, isLoading]);

  const handleVideoEnded = () => {
    setCurrentIndex((prev) => (prev + 1) % slides.length);
  };

  const handleDebugTrigger = () => {
    setDebugClicks((prev) => prev + 1);

    // Reset clicks if not reached 3 within a short time
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

  if (slides.length === 0) return <div className="bg-primary text-white h-screen flex items-center justify-center text-2xl">No content scheduled</div>;

  const currentSlide = slides[currentIndex];

  // Debug Info Calculation
  const elapsedSeconds = ((currentTime - slideStartTime) / 1000).toFixed(1);
  const totalDuration = currentSlide.duration || (currentSlide.type === 'video' ? 'Video' : 10);

  return (
    <div className="bg-black h-screen w-screen overflow-hidden flex items-center justify-center relative">
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
              <span className="text-gray-400">Version:</span> {currentVersion}
            </div>
            <div>
              <span className="text-gray-400">Next Check:</span> {Math.max(0, Math.ceil((nextCheckTime - currentTime) / 1000))}s
            </div>
            <div>
              <span className="text-gray-400">Slide Time:</span> {elapsedSeconds}s / {totalDuration}s
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
              onEnded={handleVideoEnded}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
