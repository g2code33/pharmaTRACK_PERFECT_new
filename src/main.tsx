import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './context/AppContext';
import App from './App';
import './index.css';
import { bootstrapPwa } from './pwa';
import { installAppZoomGuard } from './platform/zoomGuard';

// Best-effort on the web: the application remains a normal web app when
// service workers are unavailable (private browsing, old Safari, or a
// non-secure development origin). Inside a packaged shell (desktop app,
// Android APK) this instead removes any worker that managed to register, so
// the app is always served by the shell itself and can never be pinned to a
// stale cached build.
void bootstrapPwa();

// Before React, so the viewport is already locked on the very first paint and
// the app can never be caught mid-zoom during startup. No-op in a browser tab.
installAppZoomGuard();

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </StrictMode>
  );
}
