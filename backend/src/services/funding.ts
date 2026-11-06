/**
 * The funding wallet: the vault wallet with role `funding`. It pays for every launch, every direct fund and every
 * exchange deposit, and receives gathers and fee sweeps.
 *
 * FUNDING_PRIVATE_KEY in backend/.env is an optional way to provide it: on startup the key is imported into the
 * vault (and backed up) once, if it is not there yet.
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Request, Response, NextFunction } from 'express';
import * as vault from './vault';
import { assertBackedUp } from './backup';

export interface FundingRequest extends Request { fundingKeypair?: Keypair; fundingWallet?: vault.StoredWallet }

export class NoFundingError extends Error {
  code = 'no_funding_wallet' as const;
  constructor() { super('No funding wallet yet: create or import one on the Wallets page.'); }
}

export function getFundingKeypair(): { wallet: vault.StoredWallet; keypair: Keypair } {
  const wallet = vault.getFunding();
  if (!wallet) throw new NoFundingError();
  return { wallet, keypair: Keypair.fromSecretKey(bs58.decode(wallet.privateKey)) };
}

/** Routes that spend from the funding wallet: 400 without one, 409 when its backup file is missing. */
export function requireFunding(req: FundingRequest, res: Response, next: NextFunction) {
  try {
    const { wallet, keypair } = getFundingKeypair();
    assertBackedUp(wallet.publicKey);
    req.fundingKeypair = keypair;
    req.fundingWallet = wallet;
    next();
  } catch (err) {
    if (err instanceof NoFundingError) return res.status(400).json({ error: err.message, code: err.code });
    const e = err as { message?: string; code?: string; hint?: string; publicKey?: string };
    if (e.code === 'not_backed_up') return res.status(409).json({ error: e.message, code: e.code, hint: e.hint, publicKey: e.publicKey });
    res.status(500).json({ error: e.message || String(err) });
  }
}

/** Startup: FUNDING_PRIVATE_KEY → vault (+ backup) when set and not stored yet. */
export function importFundingFromEnv(): void {
  const key = (process.env.FUNDING_PRIVATE_KEY || '').trim();
  if (!key || key === 'YOUR_BASE58_PRIVATE_KEY_HERE') return;
  let kp: Keypair;
  try { kp = Keypair.fromSecretKey(bs58.decode(key)); } catch { console.warn('[funding] FUNDING_PRIVATE_KEY is not a valid base58 secret key; ignored'); return; }
  const existing = vault.getWalletByPublicKey(kp.publicKey.toBase58());
  if (existing) {
    if (existing.type !== 'funding') vault.setFunding(existing.id);
    return;
  }
  const { wallet, backupPath } = vault.importKey(key, 'funding', 'Funding');
  vault.setFunding(wallet.id);
  console.log(`[funding] FUNDING_PRIVATE_KEY imported as the funding wallet ${wallet.publicKey.slice(0, 8)}… (backup: ${backupPath})`);
}
