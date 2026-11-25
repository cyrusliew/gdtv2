import { useEffect, useRef, useState } from 'react';
import {
  computeVideoTargetTime,
  computeShortestLoopDrift,
  isNearLoopBoundary,
} from '../../utils/media';
import { probeUrlError, sendTelemetry } from '../../utils/telemetry';

const STANDALONE_CHECK_INTERVAL_MS = 2000;
const SYNC_CHECK_INTERVAL_MS = 1500;
const SYNC_HARD_SEEK_THRESHOLD_SEC = 1.2;
const INITIAL_SEEK_MIN_OFFSET_SEC = 1.5;
const SEEK_COOLDOWN_MS = 4000;
const LOOP_BOUNDARY_MARGIN_SEC = 0.5;

let cachedH264Support = null;
const loggedVideoMounts = new Set();
const loggedVideoPlaying = new Set();

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
  tvId,
  slide,
  activeWindow,
  totalPlaylistDuration,
  manualOffsetSec = 0,
  onTelemetry,
  onReady,
}) {
  const videoRef = useRef(null);
  const onTelemetryRef = useRef(onTelemetry);
  const onReadyRef = useRef(onReady);
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

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const behavior = slide.videoBehavior === 'hold' ? 'hold' : 'loop';
  const manifestDuration = slide.intrinsicDuration || null;
  const isMultiScreenSynced = Boolean(slide.syncGroup);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeWindow || !totalPlaylistDuration || !activeSrc) return undefined;

    let isMounted = true;
    let loggedPlaying = false;
    let loggedStalled = false;
    let notifiedReady = false;
    let lastSeekAtMs = 0;

    const notifyReady = () => {
      if (notifiedReady || !isMounted) return;
      notifiedReady = true;
      if (onReadyRef.current) {
        onReadyRef.current();
      }
    };

    // Safety fallback so a slow network still fades the video in rather than holding
    // the previous slide indefinitely.
    const readyFallbackTimerId = window.setTimeout(notifyReady, 1500);

    const telemetryKey = `${tvId || 'tv'}|${activeSrc}`;
    if (!loggedVideoMounts.has(telemetryKey)) {
      loggedVideoMounts.add(telemetryKey);
      sendTelemetry(tvId, 'video_mount', {
        slideId: slide.id,
        activeSrc,
        primarySrc: slide.src,
        webmSrc: slide.webmSrc || null,
        h264Supported: browserSupportsH264(),
      });
    }

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

      // Only seek on mount if joining mid-window (>1.5s in); avoid flushing the
      // LG webOS hardware decoder when starting normally near the start of a slide.
      try {
        if (targetTime > INITIAL_SEEK_MIN_OFFSET_SEC && Math.abs(video.currentTime - targetTime) > 0.5) {
          video.currentTime = targetTime;
          lastSeekAtMs = Date.now();
        }
      } catch {
        // Ignore if Chromium 79 hasn't buffered seekable ranges yet
      }

      if (behavior === 'hold' && videoDuration > 0 && elapsedInSlide >= videoDuration - 0.05) {
        video.pause();
        notifyReady();
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

    const handlePlaying = () => {
      if (!isMounted) return;
      notifyReady();
      if (loggedPlaying) return;
      loggedPlaying = true;
      if (!loggedVideoPlaying.has(telemetryKey)) {
        loggedVideoPlaying.add(telemetryKey);
        sendTelemetry(tvId, 'video_playing', {
          slideId: slide.id,
          src: activeSrc,
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : null,
          currentTime: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(2)) : 0,
        });
      }
    };

    const handleStalled = () => {
      if (!isMounted || loggedStalled) return;
      loggedStalled = true;
      sendTelemetry(tvId, 'video_stalled', {
        slideId: slide.id,
        src: activeSrc,
        readyState: video.readyState,
        networkState: video.networkState,
        currentTime: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(2)) : 0,
      });
    };

    const handleError = () => {
      if (!isMounted) return;
      // Ignore spurious error events with no MediaError (e.g. queued asynchronously
      // when cleanup runs video.removeAttribute('src'); video.load()).
      if (!video.error) return;
      const code = video.error.code;
      const msg = video.error.message || `MediaError code ${code}`;

      // If primary MP4 failed to decode and a VP9 WebM fallback is available, switch to it
      if (slide.webmSrc && activeSrc !== slide.webmSrc) {
        console.warn(`Video playback error (${activeSrc}): ${msg} — falling back to WebM`);
        sendTelemetry(tvId, 'video_fallback', {
          slideId: slide.id,
          failedSrc: activeSrc,
          fallbackSrc: slide.webmSrc,
          errorCode: code,
          errorMessage: msg,
          readyState: video.readyState,
          networkState: video.networkState,
        });
        setFallbackState({
          slideKey: currentSlideKey,
          useWebmFallback: true,
          hasError: false,
        });
        return;
      }

      console.error(`Video playback error (${activeSrc}):`, msg);
      const errSnapshot = {
        slideId: slide.id,
        src: activeSrc,
        errorCode: code,
        errorMessage: msg,
        readyState: video.readyState,
        networkState: video.networkState,
      };
      probeUrlError(activeSrc).then((probe) => {
        sendTelemetry(tvId, 'video_error', { ...errSnapshot, probe });
      });
      setFallbackState({
        slideKey: currentSlideKey,
        useWebmFallback,
        hasError: true,
      });
      notifyReady();
      reportTelemetry(0, 0, msg);
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('stalled', handleStalled);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleError);

    // If already buffered from cache, sync immediately
    if (video.readyState >= 1) {
      syncInitialPosition();
    }

    // Lightweight health / sync check:
    // - Never mutate playbackRate (0.95x/1.05x causes visible frame stutter on LG webOS hardware decoders).
    // - Standalone videos (no syncGroup) play untouched at native 1.0x after mount.
    // - Multi-screen synced takeovers only hard-seek when drift exceeds 1.2s (with 4s cooldown).
    const checkIntervalMs = isMultiScreenSynced ? SYNC_CHECK_INTERVAL_MS : STANDALONE_CHECK_INTERVAL_MS;
    const driftIntervalId = window.setInterval(() => {
      if (!isMounted || video.readyState < 2 || video.seeking) return;

      const { elapsedInSlide, videoDuration, targetTime } = computeCurrentSchedule();

      // Hold mode: freeze cleanly on last frame once elapsed passes clip duration
      if (behavior === 'hold' && videoDuration > 0 && elapsedInSlide >= videoDuration - 0.05) {
        if (!video.paused) {
          video.pause();
        }
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

      if (isMultiScreenSynced) {
        const absDrift = Math.abs(drift);
        const now = Date.now();
        if (
          absDrift > SYNC_HARD_SEEK_THRESHOLD_SEC &&
          now - lastSeekAtMs >= SEEK_COOLDOWN_MS &&
          !(behavior === 'loop' && isNearLoopBoundary(targetTime, videoDuration, LOOP_BOUNDARY_MARGIN_SEC))
        ) {
          lastSeekAtMs = now;
          try {
            video.currentTime = targetTime;
          } catch {
            // Ignore seek error
          }
        }
      }

      reportTelemetry(targetTime, drift, null);
    }, checkIntervalMs);

    return () => {
      isMounted = false;
      window.clearTimeout(readyFallbackTimerId);
      window.clearInterval(driftIntervalId);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('stalled', handleStalled);
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
    tvId,
    slide.id,
    slide.src,
    activeSrc,
    slide.webmSrc,
    isMultiScreenSynced,
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
      className="w-full h-full object-contain"
      autoPlay
      muted
      playsInline
      loop={behavior === 'loop'}
      preload="auto"
    />
  );
}
