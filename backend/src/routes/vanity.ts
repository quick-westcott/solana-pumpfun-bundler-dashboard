import { Router } from 'express';
import { Keypair } from '@solana/web3.js';
import * as vanity from '../services/vanity';
import { TrenchyError } from '../services/trenchy';

// Vanity mints are ground by the TrenchyTools API (POST /api/sol/vanity → poll GET /api/sol/vanity/:jobId); every key
// it hands back is saved to data/vanity-pool.json first and read from there by the launch executor.

const router = Router();

const sendError = (res: import('express').Response, err: unknown) => {
  if (err instanceof TrenchyError) return res.status(err.status || 502).json({ error: err.message, code: err.code, hint: err.hint, docs: err.docs });
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
};

router.get('/preview-random', (_req, res) => {
  const kp = Keypair.generate();
  res.json({ publicKey: kp.publicKey.toBase58() });
});

router.get('/pool-status', (_req, res) => {
  try {
    res.json(vanity.getPoolStatus());
  } catch (err) {
    sendError(res, err);
  }
});

/** A pool entry without its secret: the launch executor reads the keypair server-side (vanity.getKeypairFromPool). */
const publicAddress = ({ secretKey: _secret, ...rest }: vanity.VanityAddress) => { void _secret; return rest; };

router.get('/next', (_req, res) => {
  try {
    const addr = vanity.getNextAvailable();
    res.json({ address: addr ? publicAddress(addr) : null });
  } catch (err) {
    sendError(res, err);
  }
});

/** { suffix?: "pump", prefix?: string, caseSensitive?: boolean } — suffix + prefix ≤ 4 characters (the API's cap). */
router.post('/start', async (req, res) => {
  try {
    const body = (req.body ?? {}) as { suffix?: unknown; prefix?: unknown; caseSensitive?: unknown };
    const result = await vanity.startGenerator({
      suffix: typeof body.suffix === 'string' ? body.suffix : 'pump',
      prefix: typeof body.prefix === 'string' ? body.prefix : undefined,
      caseSensitive: body.caseSensitive === undefined ? true : body.caseSensitive !== false && body.caseSensitive !== 'false',
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/stop', (_req, res) => {
  try {
    res.json(vanity.stopGenerator());
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/pool', (_req, res) => {
  try {
    const pool = vanity.getPool();
    res.json({
      addresses: pool.map(publicAddress),
      available: pool.filter(a => a.status === 'available').length,
      used: pool.filter(a => a.status === 'used').length,
      total: pool.length,
      poolFile: vanity.POOL_FILE,
    });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
