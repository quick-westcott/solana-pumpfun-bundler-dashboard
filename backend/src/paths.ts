/**
 * Where this launcher keeps its files. Everything is relative to backend/ (src/ in dev, dist/ when built), or to the
 * volume on a hosted box (KEYS_DATA_DIR / RAILWAY_VOLUME_MOUNT_PATH; the Dockerfile symlinks backend/data → /data/data).
 */
import path from 'path';

/** backend/data: launches, uploads, the vanity mint pool, live trade history. */
export const DATA_DIR = path.join(__dirname, '../data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const LAUNCHES_FILE = path.join(DATA_DIR, 'launches.json');
export const VANITY_POOL_FILE = path.join(DATA_DIR, 'vanity-pool.json');
export const LIVE_TRADES_DIR = path.join(DATA_DIR, 'live-trades');

/** backend/keys: the encrypted wallet vault, the generated encryption key, settings.json. */
export const KEYS_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.KEYS_DATA_DIR || path.join(__dirname, '../keys');
export const VAULT_FILE = path.join(KEYS_DIR, 'wallets.json');
export const SETTINGS_FILE = path.join(KEYS_DIR, 'settings.json');
