import { Router, Request, Response } from 'express';
import { tracker, type FormattedTrade } from '../services/live-trades';

const router = Router();

/** Server-sent events: the cached trades for a mint, then every new one from the API websocket. */
router.get('/', (req: Request, res: Response) => {
  const mint = String(req.query.mint || '');
  if (!mint || mint.length < 32) return res.status(400).json({ error: 'mint query param required' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  tracker.subscribe(mint);
  setTimeout(() => { try { res.write(`data: ${JSON.stringify({ type: 'initial', trades: tracker.getTrades() })}\n\n`); } catch { /* closed */ } }, 500);

  const onTrade = (trade: FormattedTrade) => { try { res.write(`data: ${JSON.stringify({ type: 'trade', trade })}\n\n`); } catch { /* closed */ } };
  tracker.addListener(onTrade);
  const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15_000);
  req.on('close', () => { clearInterval(keepalive); tracker.removeListener(onTrade); });
});

export default router;
