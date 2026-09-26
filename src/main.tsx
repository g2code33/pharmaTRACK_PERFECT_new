import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './context/AppContext';
import App from './App';
import './index.css';
import { registerPwa } from './pwa';

// Registration is intentionally best-effort. The application remains a normal
// web app when service workers are unavailable (private browsing, old Safari,
// or a non-secure development origin).
void registerPwa();

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
