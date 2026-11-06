/**
 * Encryption at rest for the vault (backend/keys/wallets.json). AES-256-GCM under a key derived from ENCRYPTION_KEY.
 *
 * ENCRYPTION_KEY is optional: without one the app generates a key into backend/keys/.encryption-key and warns. The
 * vault is the app's working store; the user's real backup is the plaintext folder written by services/backup.ts.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { KEYS_DIR } from '../paths';

const PREFIX = 'enc:v1:';
const SALT = 'pumpfun-launcher-keys-v1';
const KEY_FILE = path.join(KEYS_DIR, '.encryption-key');

let derived: Buffer | null = null;

/** Resolve ENCRYPTION_KEY once at startup; generates and persists one when missing. Never logs the key itself. */
export function initEncryption(): void {
  let raw = (process.env.ENCRYPTION_KEY || '').trim();
  if (!raw) {
    if (fs.existsSync(KEY_FILE)) raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (!raw) {
      raw = crypto.randomBytes(32).toString('base64');
      fs.mkdirSync(KEYS_DIR, { recursive: true });
      fs.writeFileSync(KEY_FILE, raw, { mode: 0o600 });
      console.warn(`[vault] ENCRYPTION_KEY not set: generated one into ${KEY_FILE}. Keep that file (or set ENCRYPTION_KEY in backend/.env) or the vault becomes unreadable; your wallet backups on disk are not affected.`);
    } else {
      console.warn(`[vault] ENCRYPTION_KEY not set: using the generated key in ${KEY_FILE}`);
    }
  }
  derived = crypto.scryptSync(raw, SALT, 32);
}

function key(): Buffer {
  if (!derived) initEncryption();
  return derived!;
}

export const isEncrypted = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIX);

export function encryptSecret(plain: string): string {
  if (isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

/** A legacy plaintext value (no prefix) comes back unchanged so it can be migrated. */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':');
  if (!iv || !tag || !ct) throw new Error('Corrupt encrypted record');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Could not decrypt a stored key: ENCRYPTION_KEY differs from the one it was encrypted with. Your plaintext backups in the wallet backup folder still work.');
  }
}
