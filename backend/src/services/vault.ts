/**
 * The wallet vault: backend/keys/wallets.json, every secret encrypted at rest (keycrypt.ts). This is the app's
 * working store. The user's backup is the plaintext folder (backup.ts): every wallet is written THERE first, and a
 * wallet whose backup write fails is never stored here.
 *
 * Roles: funding (one at a time, pays for everything), dev / bundle / holder (launch slots), manual (anything else),
 * mint (a launch's mint keypair: not a wallet, never funded, never backed up as one).
 */
import { Keypair } from '@solana/web3.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import { KEYS_DIR, VAULT_FILE } from '../paths';
import { encryptSecret, decryptSecret, isEncrypted } from './keycrypt';
import { writeWalletBackup } from './backup';

export type WalletType = 'funding' | 'dev' | 'bundle' | 'holder' | 'manual' | 'mint';

export interface StoredWallet {
  id: string;
  publicKey: string;
  /** base58 secret (encrypted on disk, plaintext in memory) */
  privateKey: string;
  type: WalletType;
  label: string;
  status: 'active' | 'archived';
  createdAt: string;
  launchId?: string;
  source: 'generated' | 'imported';
}

/** What the HTTP API returns: never the secret. */
export type PublicWallet = Omit<StoredWallet, 'privateKey'>;
export function publicWallet<T extends { privateKey?: string }>(w: T): Omit<T, 'privateKey'> {
  const { privateKey: _s, ...rest } = w; void _s; return rest;
}

const LEGACY_IMPORTED_FILE = path.join(KEYS_DIR, 'imported-wallets.json');

function readAll(): StoredWallet[] {
  let wallets: any[] = [];
  let migrated = false;
  if (fs.existsSync(VAULT_FILE)) {
    try { wallets = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8') || '[]'); } catch { wallets = []; }
  }
  // One-time migration from the older two-file vault (imported-wallets.json next to wallets.json).
  if (fs.existsSync(LEGACY_IMPORTED_FILE)) {
    try {
      const imported = JSON.parse(fs.readFileSync(LEGACY_IMPORTED_FILE, 'utf8') || '[]') as any[];
      for (const w of imported) if (!wallets.some(x => x.publicKey === w.publicKey)) wallets.push({ ...w, source: 'imported' });
      fs.renameSync(LEGACY_IMPORTED_FILE, `${LEGACY_IMPORTED_FILE}.migrated`);
      migrated = true;
    } catch { /* leave it */ }
  }
  const result: StoredWallet[] = wallets.filter(w => w && w.publicKey && w.privateKey).map(w => {
    if (!w.source) { w.source = 'generated'; migrated = true; }
    if (!isEncrypted(w.privateKey)) migrated = true;
    return { ...w, privateKey: decryptSecret(w.privateKey) } as StoredWallet;
  });
  if (migrated) writeAll(result);
  return result;
}

function writeAll(wallets: StoredWallet[]): void {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const atRest = wallets.map(w => ({ ...w, privateKey: encryptSecret(w.privateKey) }));
  fs.writeFileSync(VAULT_FILE, JSON.stringify(atRest, null, 2), { mode: 0o600 });
}

export function initVault(): void {
  const n = readAll().length;
  console.log(`[vault] ${n} wallet(s) in ${VAULT_FILE} (encrypted at rest)`);
}

/** Store a new wallet: backup file first (throws → nothing stored), then the vault. Returns the backup path. */
function store(kp: Keypair, type: WalletType, label: string, source: StoredWallet['source'], launchId?: string): { wallet: StoredWallet; keypair: Keypair; backupPath: string | null } {
  const wallet: StoredWallet = {
    id: crypto.randomUUID(), publicKey: kp.publicKey.toBase58(), privateKey: bs58.encode(kp.secretKey),
    type, label, status: 'active', createdAt: new Date().toISOString(), launchId, source,
  };
  // Mint keypairs hold no funds and are not wallets: they are not backed up as one.
  const backupPath = type === 'mint' ? null : writeWalletBackup({ publicKey: wallet.publicKey, privateKey: wallet.privateKey, label, role: type, createdAt: wallet.createdAt }).path;
  const wallets = readAll();
  wallets.push(wallet);
  writeAll(wallets);
  return { wallet, keypair: kp, backupPath };
}

export function generateAndStore(type: WalletType, label: string, launchId?: string) {
  return store(Keypair.generate(), type, label, 'generated', launchId);
}

export function generateBatch(count: number, type: WalletType, labelPrefix: string, launchId?: string) {
  const out: ReturnType<typeof store>[] = [];
  for (let i = 0; i < count; i++) out.push(generateAndStore(type, `${labelPrefix} ${i + 1}`, launchId));
  return out;
}

/** Store a keypair the app already holds (a vanity mint from the pool). */
export function importKeypair(kp: Keypair, type: WalletType, label: string, launchId?: string) {
  return store(kp, type, label, 'imported', launchId);
}

/** Import a base58 private key. Refuses a key that is already in the vault. */
export function importKey(privateKeyB58: string, type: WalletType, label: string) {
  let kp: Keypair;
  try { kp = Keypair.fromSecretKey(bs58.decode(privateKeyB58.trim())); } catch { throw new Error('Invalid base58 private key'); }
  if (readAll().some(w => w.publicKey === kp.publicKey.toBase58())) throw new Error('This wallet is already in the vault');
  return store(kp, type, label, 'imported');
}

export function listWallets(filter: { type?: string; status?: string; launchId?: string } = {}): StoredWallet[] {
  let ws = readAll();
  if (filter.type) ws = ws.filter(w => w.type === filter.type);
  if (filter.status) ws = ws.filter(w => w.status === filter.status);
  if (filter.launchId) ws = ws.filter(w => w.launchId === filter.launchId);
  return ws;
}

export function getWallet(id: string): StoredWallet | null {
  return readAll().find(w => w.id === id) ?? null;
}

export function getWalletByPublicKey(publicKey: string): StoredWallet | null {
  return readAll().find(w => w.publicKey === publicKey) ?? null;
}

export function getKeypair(id: string): Keypair {
  const w = getWallet(id);
  if (!w) throw new Error(`Wallet ${id} not found`);
  return Keypair.fromSecretKey(bs58.decode(w.privateKey));
}

export function getPrivateKey(id: string): string {
  const w = getWallet(id);
  if (!w) throw new Error(`Wallet ${id} not found`);
  return w.privateKey;
}

/** Active wallets a launch may pick as dev / bundle / holder (not the funding wallet, not mints, not already used). */
export function listAvailable(): StoredWallet[] {
  return readAll().filter(w => w.status === 'active' && !w.launchId && w.type !== 'funding' && w.type !== 'mint');
}

export function update(id: string, patch: Partial<Pick<StoredWallet, 'type' | 'label' | 'status' | 'launchId'>>): StoredWallet | null {
  const wallets = readAll();
  const w = wallets.find(x => x.id === id);
  if (!w) return null;
  Object.assign(w, patch);
  writeAll(wallets);
  return w;
}

export function assignToLaunch(id: string, launchId: string): { wallet: StoredWallet; keypair: Keypair } {
  const w = getWallet(id);
  if (!w) throw new Error(`Wallet ${id} not found`);
  if (w.status !== 'active') throw new Error(`Wallet ${id} is ${w.status}, cannot use it in a launch`);
  update(id, { launchId });
  return { wallet: { ...w, launchId }, keypair: Keypair.fromSecretKey(bs58.decode(w.privateKey)) };
}

/** The funding wallet: the one active wallet of type funding. */
export function getFunding(): StoredWallet | null {
  return readAll().find(w => w.type === 'funding' && w.status === 'active') ?? null;
}

/** Make a wallet THE funding wallet; the previous one becomes manual. */
export function setFunding(id: string): StoredWallet {
  const wallets = readAll();
  const w = wallets.find(x => x.id === id);
  if (!w) throw new Error('Wallet not found');
  if (w.type === 'mint') throw new Error('A mint keypair cannot be the funding wallet');
  for (const o of wallets) if (o.type === 'funding' && o.id !== id) o.type = 'manual';
  w.type = 'funding';
  w.status = 'active';
  w.launchId = undefined;
  writeAll(wallets);
  return w;
}

export function deleteWallet(id: string): boolean {
  const wallets = readAll();
  const idx = wallets.findIndex(w => w.id === id);
  if (idx === -1) return false;
  wallets.splice(idx, 1);
  writeAll(wallets);
  return true;
}

export function deleteAllArchived(): number {
  const wallets = readAll();
  const keep = wallets.filter(w => w.status !== 'archived');
  writeAll(keep);
  return wallets.length - keep.length;
}
