import { Router, Request, Response } from 'express';
import { readSettings, updateSettings, effectiveSettings, DEFAULT_API_URL } from '../services/settings';
import { trenchy } from '../services/trenchy';
import { BACKUP_DIR } from '../services/backup';

const router = Router();

/**
 * The API URL may only point at a TrenchyTools API: https on trenchy.tools / Railway, or localhost when you run
 * the API yourself (apps/api). Anything else would turn this server into a request forger for whatever you type.
 */
const API_HOST_SUFFIXES = ['trenchy.tools', 'up.railway.app'];
function apiUrlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'The API URL is not a valid URL'; }
  if (u.username || u.password || u.search || u.hash) return 'The API URL must be a plain origin (no credentials, query or fragment)';
  const host = u.hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) && (u.protocol === 'http:' || u.protocol === 'https:')) return null;
  if (u.protocol !== 'https:') return 'The API URL must use https://';
  if (!API_HOST_SUFFIXES.some(s => host === s || host.endsWith(`.${s}`))) return `The API URL must be a TrenchyTools API host (${API_HOST_SUFFIXES.map(s => `*.${s}`).join(', ')}) or localhost`;
  return null;
}

/** Current settings, never the key itself. */
router.get('/', (_req: Request, res: Response) => {
  const saved = readSettings();
  const eff = effectiveSettings();
  res.json({
    apiUrl: saved.apiUrl ?? '',
    apiKeySet: !!eff.apiKey,
    apiKeyFrom: eff.apiKeyFrom,
    jitoTipLamports: saved.jitoTipLamports ?? null,
    effective: { apiUrl: eff.apiUrl, jitoTipLamports: eff.jitoTipLamports },
    defaults: { apiUrl: (process.env.TRENCHY_API_URL || DEFAULT_API_URL).trim().replace(/\/+$/, ''), apiKeySet: !!(process.env.TRENCHY_API_KEY || '').trim(), jitoTipLamports: Number(process.env.JITO_TIP_LAMPORTS) || 5_000_000 },
    backupDir: BACKUP_DIR,
    createKeyUrl: `${eff.apiUrl}/api/create-api-key`,
  });
});

/** { apiKey?, apiUrl?, jitoTipLamports? }: undefined keeps, null or '' clears (back to the .env default). */
router.put('/', (req: Request, res: Response) => {
  const { apiKey, apiUrl, jitoTipLamports } = (req.body ?? {}) as { apiKey?: unknown; apiUrl?: unknown; jitoTipLamports?: unknown };
  if (typeof apiUrl === 'string' && apiUrl.trim()) {
    const why = apiUrlProblem(apiUrl.trim());
    if (why) return res.status(400).json({ error: why });
  }
  const tip = jitoTipLamports === null ? null : typeof jitoTipLamports === 'number' ? jitoTipLamports : typeof jitoTipLamports === 'string' && jitoTipLamports.trim() ? Number(jitoTipLamports) : undefined;
  updateSettings({
    apiKey: typeof apiKey === 'string' ? apiKey : apiKey === null ? null : undefined,
    apiUrl: typeof apiUrl === 'string' ? apiUrl : apiUrl === null ? null : undefined,
    jitoTipLamports: tip,
  });
  res.json({ ok: true });
});

/** Is the key good? GET /api/me on the API: key prefix + 30-day call count. */
router.get('/status', async (_req: Request, res: Response) => {
  const api = trenchy();
  if (!api.configured) return res.json({ url: api.url, configured: false, ok: false, error: 'No API key yet' });
  try {
    const me = await api.me() as { keyPrefix?: string; usage30d?: Array<{ n: number }> };
    res.json({ url: api.url, configured: true, ok: true, keyPrefix: me.keyPrefix, calls30d: (me.usage30d ?? []).reduce((s, r) => s + (r.n || 0), 0) });
  } catch (err) {
    res.json({ url: api.url, configured: true, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
