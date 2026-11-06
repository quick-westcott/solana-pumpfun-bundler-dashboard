/**
 * Wallet backups: the one place that writes them, and the gate every funding path goes through.
 *
 * The rule (TrenchyTools AGENTS.md rule 3): every wallet is written to disk, in a place the user can find, BEFORE it
 * is funded or used, and the path is printed. The API never sees a key and cannot give one back.
 *
 * Folder: WALLET_BACKUP_DIR, else <home>/Desktop/trenchytools-wallets (when a Desktop folder exists), else
 * <home>/trenchytools-wallets. One JSON file per wallet (<date>-<label>-<publicKey>.json, plaintext base58 secret)
 * plus one line per wallet in wallets.csv. A wallet with no file in this folder cannot be funded: assertBackedUp()
 * throws NotBackedUpError, which the routes turn into HTTP 409 { code: "not_backed_up" }.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const APP_NAME = 'trenchytools-pumpfun-launcher';
const CSV_FILE = 'wallets.csv';
const CSV_HEADER = 'createdAt,role,label,publicKey,privateKey\n';

export const BACKUP_DIR: string = (() => {
  const env = (process.env.WALLET_BACKUP_DIR || '').trim();
  if (env) return path.resolve(env);
  const desktop = path.join(os.homedir(), 'Desktop');
  return path.join(fs.existsSync(desktop) ? desktop : os.homedir(), 'trenchytools-wallets');
})();

export interface WalletBackup {
  publicKey: string;
  /** base58 secret key */
  privateKey: string;
  label: string;
  role: string;
  createdAt: string;
  app: typeof APP_NAME;
  note: string;
}

export class NotBackedUpError extends Error {
  code = 'not_backed_up' as const;
  hint = 'run Export backup on the Wallets page';
  constructor(public publicKey: string) {
    super(`Wallet ${publicKey.slice(0, 8)}… has no backup file in ${BACKUP_DIR}; refusing to fund or use it`);
  }
}

/** Create the folder and say where it is. Called once at startup; throws if the folder cannot be created. */
export function initBackups(): string {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const csv = path.join(BACKUP_DIR, CSV_FILE);
  if (!fs.existsSync(csv)) fs.writeFileSync(csv, CSV_HEADER);
  console.log(`[backup] wallet backups → ${BACKUP_DIR}`);
  return BACKUP_DIR;
}

const safe = (s: string) => (s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'wallet').slice(0, 40);
const csvField = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

/**
 * Write one wallet's backup file (and its CSV line). Synchronous and done BEFORE the wallet is stored anywhere else:
 * if this throws, the caller must not keep the wallet. An existing file for the same public key is left alone
 * (idempotent), so an export never overwrites an earlier backup.
 */
export function writeWalletBackup(w: { publicKey: string; privateKey: string; label: string; role: string; createdAt?: string }): { path: string; existed: boolean } {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const existing = findFile(w.publicKey);
  if (existing) return { path: existing, existed: true };
  const createdAt = w.createdAt || new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, '-');   // colons are not allowed in Windows file names
  const file = path.join(BACKUP_DIR, `${stamp}-${safe(w.label || w.role)}-${w.publicKey}.json`);
  const body: WalletBackup = {
    publicKey: w.publicKey, privateKey: w.privateKey, label: w.label, role: w.role, createdAt,
    app: APP_NAME, note: 'Keep this file. Anyone with privateKey controls the wallet.',
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2), { flag: 'wx', mode: 0o600 });
  const csv = path.join(BACKUP_DIR, CSV_FILE);
  if (!fs.existsSync(csv)) fs.writeFileSync(csv, CSV_HEADER);
  fs.appendFileSync(csv, [createdAt, w.role, csvField(w.label), w.publicKey, w.privateKey].join(',') + '\n');
  index.set(w.publicKey, file);
  console.log(`[backup] ${w.role} ${w.publicKey.slice(0, 8)}… → ${file}`);
  return { path: file, existed: false };
}

// ── index of the folder by public key (file names end in -<publicKey>.json) ──

const index = new Map<string, string>();
let indexedAt = 0;

function refreshIndex(force = false): void {
  if (!force && Date.now() - indexedAt < 2000) return;
  index.clear();
  if (fs.existsSync(BACKUP_DIR)) {
    for (const name of fs.readdirSync(BACKUP_DIR)) {
      const m = /-([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/.exec(name);
      if (m) index.set(m[1], path.join(BACKUP_DIR, name));
    }
  }
  indexedAt = Date.now();
}

/** The backup file for a public key, verified to exist and to hold that key, or null. */
function findFile(publicKey: string): string | null {
  refreshIndex();
  let file = index.get(publicKey);
  if (!file) { refreshIndex(true); file = index.get(publicKey); }
  if (!file || !fs.existsSync(file)) { if (file) index.delete(publicKey); return null; }
  try {
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WalletBackup>;
    if (body.publicKey === publicKey && typeof body.privateKey === 'string' && body.privateKey) return file;
  } catch { /* unreadable: treat as missing */ }
  index.delete(publicKey);
  return null;
}

export const isBackedUp = (publicKey: string): boolean => !!findFile(publicKey);

/** The gate: call before any SOL moves into a wallet or a launch uses it. */
export function assertBackedUp(publicKey: string): void {
  if (!findFile(publicKey)) throw new NotBackedUpError(publicKey);
}

/** Every vault wallet into the folder (files that already exist are kept). Returns the folder and how many files exist now. */
export function exportAll(wallets: Array<{ publicKey: string; privateKey: string; label: string; role: string; createdAt?: string }>): { dir: string; count: number; written: number } {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  let written = 0;
  for (const w of wallets) if (!writeWalletBackup(w).existed) written++;
  refreshIndex(true);
  console.log(`[backup] export: ${written} new file(s), ${index.size} wallet(s) backed up in ${BACKUP_DIR}`);
  return { dir: BACKUP_DIR, count: index.size, written };
}

/** Express helper: the 409 every refused funding path answers with. */
export function isNotBackedUp(err: unknown): err is NotBackedUpError { return err instanceof NotBackedUpError; }
export const notBackedUpBody = (err: NotBackedUpError) => ({ error: err.message, code: err.code, hint: err.hint, publicKey: err.publicKey, dir: BACKUP_DIR });
