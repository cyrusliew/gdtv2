import { useEffect, useRef, useState } from 'react';
import {
  computeVideoTargetTime,
  computeShortestLoopDrift,
  isNearLoopBoundary,
} from '../../utils/media';

const DRIFT_CHECK_INTERVAL_MS = 500;
const DRIFT_IGNORE_THRESHOLD_SEC = 0.15;
const DRIFT_HARD_SEEK_THRESHOLD_SEC = 0.6;
const LOOP_BOUNDARY_MARGIN_SEC = 0.35;

let cachedH264Support = null;

function browserSupportsH264() {
  if (cachedH264Support !== null) return cachedH264Support;
  if (typeof document === 'undefined') return true;
  try {
    const v = document.createElement('video');
    cachedH264Support = Boolean(
      v.canPlayType &&
        (v.canPlayType('video/mp4; codecs="avc1.42E01E"') !== '' ||
          v.canPlayType('video/mp4; codecs="avc1.640028"') !== '')
    );
  } catch {
    cachedH264Support = true;
  }
  return cachedH264Support;
}

function isMp4Url(url) {
  return typeof url === 'string' && /\.m(p4|4v)([?#]|$)/i.test(url);
}

function pickInitialVideoSrc(slide) {
  if (!slide) return '';
  const primary = slide.src || '';
  const webm = slide.webmSrc || '';
  if (webm && primary && isMp4Url(primary) && !browserSupportsH264()) {
    return webm;
  }
  return primary || webm;
}

/**
 * Deterministic clock-synced HTML5 video slide built for LG Signage TV (Chromium 79).
 *
 * - Prefers hardware-decoded H.264 MP4 when supported, automatically falling back
 *   to VP9 WebM (if available) on browsers without proprietary H.264 codecs or on
 *   runtime MediaError code 4.
 * - Seeks immediately to wall-clock-derived targetTime on mid-window joins/reloads.
 * - Keeps multi-screen displays aligned via 500ms drift checks (gentle playbackRate
 *   nudging for small drift, hard seek only when drift exceeds 0.6s).
 * - Handles video length != slide duration via `loop` (default) or `hold`.
 * - Explicitly frees the hardware video decoder on unmount for Chromium 79 stability.
 */
export default function VideoSlide({
  slide,
  activeWindow,
  totalPlaylistDuration,
  manualOffsetSec = 0,
  onTelemetry,
}) {
  const videoRef = useRef(null);
  const onTelemetryRef = useRef(onTelemetry);
  const [fallbackState, setFallbackState] = useState({
    slideKey: `${slide.src || ''}|${slide.webmSrc || ''}`,
    useWebmFallback: false,
    hasError: false,
  });

  const currentSlideKey = `${slide.src || ''}|${slide.webmSrc || ''}`;
  const isCurrentState = fallbackState.slideKey === currentSlideKey;
  const useWebmFallback = isCurrentState && fallbackState.useWebmFallback;
  const hasError = isCurrentState && fallbackState.hasError;

  const activeSrc = useWebmFallback && slide.webmSrc ? slide.webmSrc : pickInitialVideoSrc(slide);

  useEffect(() => {
    onTelemetryRef.current = onTelemetry;
  }, [onTelemetry]);

  const behavior = slide.videoBehavior === 'hold' ? 'hold' : 'loop';
  const manifestDuration = slide.intrinsicDuration || null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeWindow || !totalPlaylistDuration || !activeSrc) return undefined;

    let isMounted = true;

    // Ensure src is set (handles React StrictMode double-mount and fallback switches)
    if (video.getAttribute('src') !== activeSrc) {
      video.setAttribute('src', activeSrc);
      video.load();
    }

    const getEffectiveVideoDuration = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        return video.duration;
      }
      if (Number.isFinite(manifestDuration) && manifestDuration > 0) {
        return manifestDuration;
      }
      return activeWindow.duration;
    };

    const computeCurrentSchedule = () => {
      const nowSec = Date.now() / 1000 + manualOffsetSec;
      const rawMod = nowSec % totalPlaylistDuration;
      const currentCycleTime = rawMod < 0 ? rawMod + totalPlaylistDuration : rawMod;
      const elapsedInSlide = Math.max(0, currentCycleTime - activeWindow.start);
      const videoDuration = getEffectiveVideoDuration();
      const targetTime = computeVideoTargetTime({
        elapsedInSlide,
        videoDuration,
        behavior,
      });
      return { elapsedInSlide, videoDuration, targetTime };
    };

    const reportTelemetry = (targetTime, driftSec, errorText = null) => {
      const cb = onTelemetryRef.current;
      if (!cb || !isMounted) return;
      cb({
        videoTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        targetTime,
        driftMs: Math.round(driftSec * 1000),
        readyState: video.readyState,
        playbackRate: video.playbackRate,
        videoDuration: getEffectiveVideoDuration(),
        error: errorText,
      });
    };

    const safePlay = () => {
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => {
          // Ignore AbortError during fast transitions/unmount
          if (err && err.name !== 'AbortError') {
            console.warn('Video autoplay/resume warning:', err);
          }
        });
      }
    };

    const syncInitialPosition = () => {
      if (!isMounted) return;
      const { elapsedInSlide, videoDuration, targetTime } = computeCurrentSchedule();

      // Seek to exact deterministic offset before playback starts
      try {
        if (Math.abs(video.currentTime - targetTime) > 0.1) {
          video.currentTime = targetTime;
        }
      } catch {
        // Ignore if Chromium 79 hasn't buffered seekable ranges yet
      }

      if (behavior === 'hold' && videoDuration > 0 && elapsedInSlide >= videoDuration - 0.05) {
        video.pause();
      } else {
        safePlay();
      }

      reportTelemetry(targetTime, video.currentTime - targetTime, null);
    };

    const handleLoadedMetadata = () => {
      syncInitialPosition();
    };

    const handleCanPlay = () => {
      if (video.paused) {
        const { elapsedInSlide, videoDuration } = computeCurrentSchedule();
        if (!(behavior === 'hold' && videoDuration > 0 && elapsedInSlide >= videoDuration - 0.05)) {
          safePlay();
        }
      }
    };

    const handleEnded = () => {
      if (!isMounted) return;
      if (behavior === 'loop') {
        try {
          video.currentTime = 0;
        } catch {
          // Ignore seek error
        }
        safePlay();
      } else {
        video.pause();
      }
    };

    const handleError = () => {
      if (!isMounted) return;
      const code = video.error ? video.error.code : 'unknown';
      const msg = video.error?.message || `MediaError code ${code}`;

      // If primary MP4 failed to decode and a VP9 WebM fallback is available, switch to it
      if (slide.webmSrc && activeSrc !== slide.webmSrc) {
        console.warn(`Video playback error (${activeSrc}): ${msg} — falling back to WebM`);
        setFallbackState({
          slideKey: currentSlideKey,
          useWebmFallback: true,
          hasError: false,
        });
        return;
      }

      console.error(`Video playback error (${activeSrc}):`, msg);
      setFallbackState({
        slideKey: currentSlideKey,
        useWebmFallback,
        hasError: true,
      });
      reportTelemetry(0, 0, msg);
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleError);

    // If already buffered from cache, sync immediately
    if (video.readyState >= 1) {
      syncInitialPosition();
    }

    // Periodic drift check (500ms) — avoids constant decoder flushes on Chromium 79
    const driftIntervalId = window.setInterval(() => {
      if (!isMounted || video.readyState < 2 || video.seeking) return;

      const { elapsedInSlide, videoDuration, targetTime } = computeCurrentSchedule();

      // Hold mode: freeze cleanly on last frame once elapsed passes clip duration
      if (behavior === 'hold' && videoDuration > 0 && elapsedInSlide >= videoDuration - 0.05) {
        if (!video.paused) {
          video.pause();
        }
        video.playbackRate = 1.0;
        reportTelemetry(targetTime, video.currentTime - targetTime, null);
        return;
      }

      if (video.paused) {
        safePlay();
      }

      const drift = computeShortestLoopDrift(
        video.currentTime,
        targetTime,
        videoDuration,
        behavior === 'loop'
      );
      const absDrift = Math.abs(drift);

      if (behavior === 'loop' && isNearLoopBoundary(targetTime, videoDuration, LOOP_BOUNDARY_MARGIN_SEC)) {
        if (video.playbackRate !== 1.0) video.playbackRate = 1.0;
        reportTelemetry(targetTime, drift, null);
        return;
      }

      if (absDrift < DRIFT_IGNORE_THRESHOLD_SEC) {
        if (video.playbackRate !== 1.0) {
          video.playbackRate = 1.0;
        }
      } else if (absDrift <= DRIFT_HARD_SEEK_THRESHOLD_SEC) {
        // Gently nudge playback rate instead of hard seeking to prevent keyframe stutter
        video.playbackRate = drift > 0 ? 0.95 : 1.05;
      } else {
        // Large drift (e.g. buffer stall or major clock jump): hard seek into lockstep
        video.playbackRate = 1.0;
        try {
          video.currentTime = targetTime;
        } catch {
          // Ignore seek error
        }
      }

      reportTelemetry(targetTime, drift, null);
    }, DRIFT_CHECK_INTERVAL_MS);

    return () => {
      isMounted = false;
      window.clearInterval(driftIntervalId);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleError);

      // Explicitly release hardware decoder resources on Chromium 79 (LG Signage TV)
      try {
        video.pause();
        video.playbackRate = 1.0;
        video.removeAttribute('src');
        video.load();
      } catch {
        // Ignore teardown errors
      }
    };
  }, [
    activeSrc,
    slide.webmSrc,
    currentSlideKey,
    useWebmFallback,
    activeWindow,
    totalPlaylistDuration,
    behavior,
    manifestDuration,
    manualOffsetSec,
  ]);

  if (hasError) {
    if (slide.poster) {
      return (
        <img
          src={slide.poster}
          alt={slide.id || 'video fallback'}
          className="w-full h-full object-contain"
        />
      );
    }
    return <div className="w-full h-full bg-black" />;
  }

  return (
    <video
      ref={videoRef}
      src={activeSrc}
      poster={slide.poster || undefined}
      className="w-full h-full object-contain"
      autoPlay
      muted
      playsInline
      loop={behavior === 'loop'}
      preload="auto"
    />
  );
}
