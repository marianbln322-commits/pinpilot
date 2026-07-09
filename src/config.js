// Minimal .env loader (no external dependency) + app configuration.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// --- tiny .env parser ---
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // strip optional surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

export const config = {
  port: Number(process.env.PORT) || 3000,

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },

  // Public base used to build image URLs for the Pinterest CSV export.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),

  pinterest: {
    appId: process.env.PINTEREST_APP_ID || '',
    appSecret: process.env.PINTEREST_APP_SECRET || '',
    redirectUri:
      process.env.PINTEREST_REDIRECT_URI ||
      'http://localhost:3000/auth/pinterest/callback',
    apiBase: (
      process.env.PINTEREST_API_BASE || 'https://api.pinterest.com/v5'
    ).replace(/\/$/, ''),
  },

  paths: {
    root: ROOT,
    data: path.join(ROOT, 'data'),
    uploads: path.join(ROOT, 'uploads'),
    db: path.join(ROOT, 'data', 'db.json'),
    public: path.join(ROOT, 'public'),
  },
};

export function aiEnabled() {
  return Boolean(config.gemini.apiKey);
}

export function pinterestConfigured() {
  return Boolean(config.pinterest.appId && config.pinterest.appSecret);
}
