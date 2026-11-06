import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { UPLOADS_DIR } from './paths';
import { initEncryption } from './services/keycrypt';
import { initBackups } from './services/backup';
import { initVault } from './services/vault';
import { importFundingFromEnv } from './services/funding';
import { effectiveSettings } from './services/settings';
import { POOL_FILE } from './services/vanity';
import settingsRoutes from './routes/settings';
import walletRoutes from './routes/wallets';
import launchRoutes from './routes/launch';
import tradingRoutes from './routes/trading';
import uploadRoutes from './routes/upload';
import liveTradesRoutes from './routes/live-trades';
import vanityRoutes from './routes/vanity';

const PORT = Number(process.env.PORT) || 3101;

// ── startup: encryption key, the backup folder (the rule), the vault, the funding wallet from .env ──
initEncryption();
try {
  initBackups();
} catch (err) {
  console.error(`[backup] cannot create the wallet backup folder: ${err instanceof Error ? err.message : err}. Set WALLET_BACKUP_DIR to a writable folder.`);
  process.exit(1);
}
initVault();
importFundingFromEnv();
{
  const s = effectiveSettings();
  console.log(`[api] ${s.apiUrl} · key ${s.apiKey ? `set (from ${s.apiKeyFrom})` : 'MISSING: add one in Settings or backend/.env'} · Jito tip ${s.jitoTipLamports} lamports`);
  console.log(`[vanity] mint keys from the API are saved to ${POOL_FILE} before a launch uses them`);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Uploaded coin images, raster only (anything else is served as a download, never rendered same-origin).
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/api/uploads', express.static(UPLOADS_DIR, {
  setHeaders: (res, filePath) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!/\.(png|jpe?g|gif|webp)$/i.test(filePath)) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment');
    }
  },
}));

app.use('/api/settings', settingsRoutes);
app.use('/api/wallets', walletRoutes);
app.use('/api/launch', launchRoutes);
app.use('/api/trading', tradingRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/live-trades', liveTradesRoutes);
app.use('/api/vanity', vanityRoutes);
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// The built frontend (npm run build puts it in backend/public).
const publicDir = path.join(__dirname, '../public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

const server = app.listen(PORT, () => console.log(`[backend] http://localhost:${PORT}`));
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') console.error(`[backend] port ${PORT} is in use: stop the other process or set PORT in backend/.env`);
  else console.error('[backend]', err);
  process.exit(1);
});

const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
