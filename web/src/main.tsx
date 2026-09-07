import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from 'react-oidc-context';
import { App } from './App.js';
import { loadConfig, oidcSettings } from './config.js';
import { applyStoredTheme } from './theme.js';
import './styles.css';

applyStoredTheme();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

loadConfig()
  .then((cfg) => {
    createRoot(root).render(
      <StrictMode>
        <AuthProvider {...oidcSettings(cfg)}>
          <App config={cfg} />
        </AuthProvider>
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    root.textContent = `Configuration not loaded: ${String(err)}`;
  });
