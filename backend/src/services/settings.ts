/**
 * The one settings file: backend/keys/settings.json { apiKey?, apiUrl?, jitoTipLamports? }, written by the Settings
 * page. backend/.env (TRENCHY_API_KEY, TRENCHY_API_URL, JITO_TIP_LAMPORTS) holds the defaults.
 */
import fs from 'fs';
import path from 'path';
import { SETTINGS_FILE } from '../paths';

export interface Settings { apiKey?: string; apiUrl?: string; jitoTipLamports?: number }

export const DEFAULT_API_URL = 'https://api.trenchy.tools';
const DEFAULT_TIP_LAMPORTS = 5_000_000;   // 0.005 SOL

export function readSettings(): Settings {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Settings;
    return {
      apiKey: typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : undefined,
      apiUrl: typeof raw.apiUrl === 'string' && raw.apiUrl.trim() ? raw.apiUrl.trim() : undefined,
      jitoTipLamports: typeof raw.jitoTipLamports === 'number' && raw.jitoTipLamports >= 0 ? raw.jitoTipLamports : undefined,
    };
  } catch {
    return {};
  }
}

/** A field left undefined keeps its value; null or '' clears it (back to the .env default). */
export function updateSettings(patch: { [K in keyof Settings]?: Settings[K] | null }): Settings {
  const cur = readSettings();
  const next: Settings = { ...cur };
  for (const k of ['apiKey', 'apiUrl'] as const) {
    if (patch[k] === undefined) continue;
    const v = typeof patch[k] === 'string' ? (patch[k] as string).trim() : '';
    if (v) next[k] = v; else delete next[k];
  }
  if (patch.jitoTipLamports !== undefined) {
    const t = patch.jitoTipLamports;
    if (typeof t === 'number' && !isNaN(t) && t >= 0) next.jitoTipLamports = Math.round(t); else delete next.jitoTipLamports;
  }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** What the app actually uses: settings.json over backend/.env over the built-in default. */
export function effectiveSettings(): { apiUrl: string; apiKey: string; jitoTipLamports: number; apiKeyFrom: 'settings' | 'env' | 'none' } {
  const s = readSettings();
  const apiUrl = (s.apiUrl || process.env.TRENCHY_API_URL || DEFAULT_API_URL).trim().replace(/\/+$/, '');
  const envKey = (process.env.TRENCHY_API_KEY || '').trim();
  const apiKey = s.apiKey || envKey;
  const jitoTipLamports = s.jitoTipLamports ?? (Number(process.env.JITO_TIP_LAMPORTS) || DEFAULT_TIP_LAMPORTS);
  return { apiUrl, apiKey, jitoTipLamports, apiKeyFrom: s.apiKey ? 'settings' : envKey ? 'env' : 'none' };
}
