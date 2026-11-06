import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { LaunchRecord, LaunchParams, StageEvent } from '../types';
import { executeLaunch, simulateLaunch, fundingPlan, MAX_BUNDLE_WALLETS } from '../services/launch-executor';
import { readLaunches, saveLaunch, deleteLaunch } from '../services/launches';
import { requireFunding, type FundingRequest } from '../services/funding';
import { isNotBackedUp, notBackedUpBody } from '../services/backup';

const router = Router();

// ── launch progress: every event is kept so a stream that connects late replays the history ──

const streams = new Map<string, Array<(e: StageEvent) => void>>();
const history = new Map<string, { at: number; events: StageEvent[] }>();
const HISTORY_MAX_EVENTS = 300;
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

function emit(launchId: string, data: Record<string, unknown>) {
  const event = data as StageEvent;
  let hist = history.get(launchId);
  if (!hist) {
    hist = { at: Date.now(), events: [] };
    history.set(launchId, hist);
    for (const [id, h] of history) if (Date.now() - h.at > HISTORY_TTL_MS) history.delete(id);
  }
  if (hist.events.length < HISTORY_MAX_EVENTS) hist.events.push(event);
  for (const cb of streams.get(launchId) ?? []) cb(event);
}

function finalEventFor(launch: LaunchRecord | undefined): StageEvent | null {
  if (!launch) return null;
  if (launch.status === 'confirmed') return { stage: 'done', message: 'Launch confirmed!', signature: launch.signature, mint: launch.mintAddress };
  if (launch.status === 'error') return { stage: 'error', message: launch.error || 'Launch failed' };
  return null;
}

/** The form → launch params, with defaults. */
function readParams(body: any): LaunchParams {
  const n = (v: unknown, d: number) => (typeof v === 'number' && !isNaN(v) ? v : typeof v === 'string' && v.trim() && !isNaN(Number(v)) ? Number(v) : d);
  const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(x => n(x, 0.5)) : []);
  const ids = (v: unknown): (string | null)[] | undefined => (Array.isArray(v) && v.some(Boolean) ? v.map(x => (typeof x === 'string' && x ? x : null)) : undefined);
  return {
    tokenName: String(body.tokenName ?? '').trim(),
    tokenSymbol: String(body.tokenSymbol ?? '').trim(),
    description: String(body.description ?? ''),
    imageUrl: String(body.imageUrl ?? ''),
    website: String(body.website ?? ''),
    twitter: String(body.twitter ?? ''),
    telegram: String(body.telegram ?? ''),
    devBuyAmount: n(body.devBuyAmount, 0.5),
    bundleWalletCount: Math.max(0, Math.min(MAX_BUNDLE_WALLETS, Math.floor(n(body.bundleWalletCount, 0)))),
    bundleSwapAmounts: nums(body.bundleSwapAmounts),
    holderWalletCount: Math.max(0, Math.floor(n(body.holderWalletCount, 0))),
    holderSwapAmounts: nums(body.holderSwapAmounts),
    holderAutoBuy: body.holderAutoBuy === true,
    holderAutoBuyDelay: n(body.holderAutoBuyDelay, 0),
    useJito: body.useJito !== false,
    strictBundle: body.strictBundle !== false,
    autoSellAfterLaunch: body.autoSellAfterLaunch === true,
    mintAddressMode: body.mintAddressMode === 'vanity' ? 'vanity' : 'random',
    devWalletId: typeof body.devWalletId === 'string' && body.devWalletId ? body.devWalletId : undefined,
    bundleWalletIds: ids(body.bundleWalletIds),
    holderWalletIds: ids(body.holderWalletIds),
  };
}

router.get('/', (_req: Request, res: Response) => {
  res.json(readLaunches().slice(-50).reverse());
});

/** The cost of a plan, without touching anything (the Launch page's summary). */
router.post('/plan', (req: Request, res: Response) => {
  res.json(fundingPlan(readParams(req.body ?? {})));
});

/** Dry run: checks + a simulated create (POST /api/sol/simulate). Nothing moves. */
router.post('/simulate', requireFunding, async (req: FundingRequest, res: Response) => {
  try {
    res.json(await simulateLaunch(readParams(req.body ?? {}), req.fundingKeypair!));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/', requireFunding, (req: FundingRequest, res: Response) => {
  const params = readParams(req.body ?? {});
  if (!params.tokenName || !params.tokenSymbol) return res.status(400).json({ error: 'tokenName and tokenSymbol required' });
  if (!params.imageUrl) return res.status(400).json({ error: 'A launch needs an image: add one on the Launch form.' });

  const launchId = uuid();
  const launch: LaunchRecord = {
    id: launchId, tokenName: params.tokenName, tokenSymbol: params.tokenSymbol, imageUrl: params.imageUrl || undefined,
    status: 'pending', createdAt: new Date().toISOString(), params,
  };
  saveLaunch(launch);
  res.json({ launchId, status: 'pending', stream: `/api/launch/${launchId}/stream` });

  executeLaunch(launchId, params, emit, req.fundingKeypair!).catch(err => {
    console.error('[launch] fatal:', err);
    if (isNotBackedUp(err)) emit(launchId, { stage: 'error', message: notBackedUpBody(err).error, code: err.code });
  });
});

router.get('/:id', (req: Request, res: Response) => {
  const launch = readLaunches().find(l => l.id === String(req.params.id));
  if (!launch) return res.status(404).json({ error: 'Not found' });
  res.json(launch);
});

router.delete('/:id', (req: Request, res: Response) => {
  const removed = deleteLaunch(String(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: removed.id, tokenName: removed.tokenName });
});

/** Server-sent events: the launch's history first, then live stages until done / error. */
router.get('/:id/stream', (req: Request, res: Response) => {
  const launchId = String(req.params.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (e: StageEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  const events = history.get(launchId)?.events ?? [];
  send({ stage: 'replay-start', message: '' });
  for (const ev of events) send(ev);
  if (!events.some(ev => ev.stage === 'done' || ev.stage === 'error')) {
    const final = finalEventFor(readLaunches().find(l => l.id === launchId));
    if (final) send(final);
  }

  if (!streams.has(launchId)) streams.set(launchId, []);
  streams.get(launchId)!.push(send);
  const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15_000);
  req.on('close', () => {
    clearInterval(keepalive);
    const arr = streams.get(launchId) ?? [];
    const idx = arr.indexOf(send);
    if (idx >= 0) arr.splice(idx, 1);
  });
});

export default router;
