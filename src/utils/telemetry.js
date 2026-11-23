const DEFAULT_MEDIA_API_URL = 'https://gdtv2-media-api.cyrusliew02.workers.dev';

const MEDIA_API_URL = (
  import.meta.env.VITE_MEDIA_API_URL ||
  DEFAULT_MEDIA_API_URL
).replace(/\/+$/, '');

// eslint-disable-next-line no-undef
export const BUILD_VERSION = typeof __APP_BUILD_VERSION__ !== 'undefined' ? String(__APP_BUILD_VERSION__) : 'dev';

function getSessionId() {
  try {
    if (!window.__gdtvSessionId) {
      window.__gdtvSessionId =
        Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }
    return window.__gdtvSessionId;
  } catch {
    return 'unknown';
  }
}

export function getDeviceSnapshot() {
  const codecs = { h264: '', vp9: '', av1: '' };
  try {
    const v = document.createElement('video');
    if (v && typeof v.canPlayType === 'function') {
      codecs.h264 = v.canPlayType('video/mp4; codecs="avc1.42E01E"') || '';
      codecs.vp9 = v.canPlayType('video/webm; codecs="vp9"') || '';
      codecs.av1 = v.canPlayType('video/mp4; codecs="av01.0.04M.08"') || '';
    }
  } catch {
    // Ignore codec probe failures
  }

  return {
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    href: typeof window !== 'undefined' ? window.location.href : '',
    origin: typeof window !== 'undefined' ? window.location.origin : '',
    screen:
      typeof window !== 'undefined'
        ? `${window.innerWidth}x${window.innerHeight} (screen ${window.screen?.width || 0}x${window.screen?.height || 0})`
        : '',
    dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
    online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    buildVersion: BUILD_VERSION,
    codecs,
  };
}

function getTelemetryEndpoints() {
  return [`${MEDIA_API_URL}/telemetry`];
}

/**
 * Fire-and-forget remote telemetry logger for LG Signage TV debugging.
 * Never throws or blocks playback.
 */
export function sendTelemetry(tvId, event, data = {}) {
  try {
    const safeTvId = String(tvId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'unknown';
    const payload = JSON.stringify({
      tvId: safeTvId,
      sessionId: getSessionId(),
      ts: new Date().toISOString(),
      buildVersion: BUILD_VERSION,
      event,
      data,
    });

    const endpoints = getTelemetryEndpoints();

    const tryPost = (index) => {
      if (index >= endpoints.length) return;
      const url = endpoints[index];

      // Use text/plain so cross-origin fallback avoids CORS OPTIONS preflight in Chromium 79
      // (the Worker parses JSON directly from request.text()).
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: payload,
      })
        .then((res) => {
          if (!res.ok && index + 1 < endpoints.length) {
            tryPost(index + 1);
          }
        })
        .catch(() => {
          if (index + 1 < endpoints.length) {
            tryPost(index + 1);
          }
        });
    };

    tryPost(0);
  } catch {
    // Never let telemetry crash the TV player
  }
}

/**
 * Probe a failing asset URL with fetch() to capture the exact HTTP status or
 * network/CORS/TLS error message directly from the LG TV browser.
 */
export async function probeUrlError(url) {
  if (!url) return { error: 'empty-url' };
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type') || null,
      contentLength: res.headers.get('content-length') || null,
      cfRay: res.headers.get('cf-ray') || null,
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      errorName: err && err.name ? err.name : 'Error',
      errorMessage: err && err.message ? err.message : String(err),
      ms: Date.now() - startedAt,
    };
  }
}
