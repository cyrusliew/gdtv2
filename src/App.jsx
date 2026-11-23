import { Component } from 'react';
import { Router } from './Router';
import { getDeviceSnapshot, sendTelemetry } from './utils/telemetry';

function getCurrentTvIdFromHash() {
  try {
    const hash = (window.location.hash || '').replace(/^#\/?/, '').split(/[?#]/)[0];
    return hash || 'root';
  } catch {
    return 'root';
  }
}

if (typeof window !== 'undefined' && !window.__gdtvErrorHooksInstalled) {
  window.__gdtvErrorHooksInstalled = true;

  window.addEventListener('error', (event) => {
    sendTelemetry(getCurrentTvIdFromHash(), 'window_error', {
      message: event.message || 'Unknown error',
      filename: event.filename || null,
      lineno: event.lineno || null,
      colno: event.colno || null,
      stack: event.error && event.error.stack ? String(event.error.stack).slice(0, 800) : null,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    sendTelemetry(getCurrentTvIdFromHash(), 'unhandled_rejection', {
      message: reason && reason.message ? reason.message : String(reason || 'Unknown rejection'),
      stack: reason && reason.stack ? String(reason.stack).slice(0, 800) : null,
    });
  });
}

class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    sendTelemetry(getCurrentTvIdFromHash(), 'react_error', {
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? String(error.stack).slice(0, 800) : null,
      componentStack: info && info.componentStack ? String(info.componentStack).slice(0, 800) : null,
      device: getDeviceSnapshot(),
    });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="bg-black text-red-400 h-screen w-screen p-8 font-mono text-sm">
          <div className="font-bold mb-2">GDTV2 Runtime Error</div>
          <div>{this.state.error.message || String(this.state.error)}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <AppErrorBoundary>
      <Router />
    </AppErrorBoundary>
  );
}

export default App;
