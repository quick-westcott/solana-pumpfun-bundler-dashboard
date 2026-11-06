import { Router, Request, Response } from 'express';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { requireFunding, type FundingRequest } from '../services/funding';
import { findLaunch, findLaunchByMint, launchRole } from '../services/launches';
import * as vault from '../services/vault';
import { trenchy, type Trenchy } from '../services/trenchy';
import { tracker, ownTrade } from '../services/live-trades';
import { assertBackedUp, isNotBackedUp, notBackedUpBody } from '../services/backup';

// Every trade here is built by the TrenchyTools API (POST /api/sol/trade-local), signed with the wallet's key from
// the local vault, and sent back through the API (POST /api/sol/send). pool "auto" follows a coin from the
// pump.fun curve to PumpSwap after it graduates.

const router = Router();
const TRADE_PRIORITY_FEE_SOL = 0.0005;
const MIN_SOL_FOR_SELL_TX = 0.005;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One wallet buys (amount = SOL) or sells (amount = tokens) a mint. */
router.post('/execute', async (req: Request, res: Response) => {
  const { type, mint, walletId, amount, slippage = 5 } = req.body ?? {};
  if (!type || !mint || !walletId || !amount) return res.status(400).json({ error: 'type, mint, walletId, amount required' });
  try {
    const api = trenchy();
    const w = vault.getWallet(String(walletId));
    if (!w) return res.status(404).json({ error: 'Wallet not found' });
    const keypair = vault.getKeypair(w.id);
    const built = await api.tradeLocal({
      publicKey: keypair.publicKey.toBase58(), action: type === 'buy' ? 'buy' : 'sell', mint, amount: Number(amount),
      denominatedInSol: type === 'buy' ? 'true' : 'false', slippage: Number(slippage) || 5, priorityFee: TRADE_PRIORITY_FEE_SOL, pool: 'auto',
    });
    const signature = await api.execute(built.tx, [keypair], 45_000);
    tracker.injectTrade(ownTrade(mint, type === 'buy' ? 'buy' : 'sell', keypair.publicKey.toBase58(), built.expected.sol, built.expected.tokens, w.type, w.label, signature));
    res.json({ signature, expected: built.expected, status: 'confirmed' });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

/**
 * Sell a percentage from many wallets at once: { mint, percentage, walletIds? | launchId? }. Without walletIds, every
 * dev / bundle / holder wallet of the launch. A wallet with no SOL for the fee is topped up from the funding wallet
 * first (which is why the funding wallet, and that wallet's backup, are required here).
 */
router.post('/rapid-sell', requireFunding, async (req: FundingRequest, res: Response) => {
  const { mint, percentage = 100, launchId, walletIds } = req.body ?? {};
  if (!mint) return res.status(400).json({ error: 'mint required' });
  const pct = Math.max(1, Math.min(100, Number(percentage) || 100));
  const api = trenchy();
  const fundingKp = req.fundingKeypair!;

  let wallets: vault.StoredWallet[];
  if (Array.isArray(walletIds) && walletIds.length > 0) {
    wallets = vault.listWallets().filter(w => walletIds.includes(w.id));
  } else {
    const launch = (launchId ? findLaunch(String(launchId)) : null) ?? findLaunchByMint(String(mint));
    wallets = vault.listWallets({ status: 'active', launchId: launch?.id }).filter(w => launch && launchRole(w, launch));
  }
  if (!wallets.length) return res.json({ summary: { totalWallets: 0, confirmed: 0, sent: 0, skipped: 0, errors: 0 }, results: [] });

  let balances: Map<string, { sol: number; raw: string }>;
  try {
    balances = new Map((await api.balances(wallets.map(w => w.publicKey), mint)).map(b => [b.wallet, { sol: b.sol, raw: b.token?.raw ?? '0' }]));
  } catch (err) {
    return res.status(502).json({ error: `Could not read balances: ${errMsg(err)}` });
  }

  const results = await Promise.all(wallets.map(async w => {
    try {
      const bal = balances.get(w.publicKey);
      if (!bal || bal.raw === '0') return { wallet: w.publicKey, status: 'skipped', reason: 'zero balance' };
      const keypair = vault.getKeypair(w.id);
      if (bal.sol < MIN_SOL_FOR_SELL_TX && !keypair.publicKey.equals(fundingKp.publicKey)) {
        assertBackedUp(w.publicKey);   // SOL moves into it: the backup rule applies
        await api.transferSol(fundingKp, keypair.publicKey, 0.01);
      }
      const built = await api.tradeLocal({ publicKey: w.publicKey, action: 'sell', mint, amount: `${pct}%`, denominatedInSol: 'false', slippage: 15, priorityFee: TRADE_PRIORITY_FEE_SOL, pool: 'auto' });
      built.tx.sign([keypair]);
      const { signature } = await api.send(built.tx);
      tracker.injectTrade(ownTrade(mint, 'sell', w.publicKey, built.expected.sol, built.expected.tokens, w.type, w.label, signature));
      const confirmed = await api.waitConfirmed(signature, 45_000);
      return { wallet: w.publicKey, status: confirmed ? 'confirmed' : 'sent', signature };
    } catch (err) {
      return { wallet: w.publicKey, status: 'error', error: isNotBackedUp(err) ? notBackedUpBody(err).error : errMsg(err), ...(isNotBackedUp(err) ? { code: err.code } : {}) };
    }
  }));

  const count = (s: string) => results.filter(r => r.status === s).length;
  res.json({ summary: { totalWallets: wallets.length, confirmed: count('confirmed'), sent: count('sent'), skipped: count('skipped'), errors: count('error') }, results });
});

/** The dev wallet that created a launch. */
function devWalletFor(launchId: string): vault.StoredWallet | null {
  const launch = findLaunch(launchId);
  const byType = vault.listWallets({ type: 'dev', launchId }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (byType) return byType;
  return launch?.params?.devWalletId ? vault.getWallet(launch.params.devWalletId) : null;
}

const resolveLaunchId = (launchId: unknown, mint: unknown): string | null =>
  (typeof launchId === 'string' && launchId) || (typeof mint === 'string' && findLaunchByMint(mint)?.id) || null;

/** Unclaimed creator fees for a launch (read-only). */
router.get('/creator-fees', async (req: Request, res: Response) => {
  const launchId = resolveLaunchId(req.query.launchId, req.query.mint);
  if (!launchId) return res.status(400).json({ error: 'launchId or mint required (only your own launches have a dev wallet here)' });
  const dev = devWalletFor(launchId);
  if (!dev) return res.status(404).json({ error: 'No dev wallet found for this launch' });
  try {
    const api = trenchy();
    const [fees, devSol] = await Promise.all([api.creatorFees(dev.publicKey), api.solBalance(dev.publicKey)]);
    res.json({ launchId, creator: dev.publicKey, availableSol: fees.sol, availableLamports: fees.lamports, devSol });
  } catch (err) {
    res.status(502).json({ error: errMsg(err) });
  }
});

const FUND_AMOUNT_LAMPORTS = 1_500_000;   // ~0.0015 SOL: rent exemption + the claim's fee
const TX_FEE_LAMPORTS = 5000;

/** Claim the dev wallet's creator fees (action collectCreatorFee), then sweep the dev wallet to funding. */
async function collectAndSweep(api: Trenchy, dev: Keypair, fundingKp: Keypair) {
  const fees = await api.creatorFees(dev.publicKey.toBase58());
  if (fees.lamports === '0') return { status: 'skipped' as const, collectedSol: 0, reason: 'No creator fees available' };

  let fundedFromFunding = false;
  const devLamports = Math.round((await api.solBalance(dev.publicKey)) * LAMPORTS_PER_SOL);
  if (devLamports < FUND_AMOUNT_LAMPORTS) {
    assertBackedUp(dev.publicKey.toBase58());
    await api.transferSol(fundingKp, dev.publicKey, 0, { lamports: FUND_AMOUNT_LAMPORTS - devLamports + TX_FEE_LAMPORTS });
    fundedFromFunding = true;
  }

  const built = await api.tradeLocal({ publicKey: dev.publicKey.toBase58(), action: 'collectCreatorFee', priorityFee: 0.0001 });
  built.tx.sign([dev]);
  const { signature } = await api.send(built.tx);
  if (!(await api.waitConfirmed(signature, 45_000))) return { status: 'error' as const, signature, error: 'Creator fee claim not confirmed in time' };

  let sweptSol = 0;
  let sweepSig: string | undefined;
  try {
    await new Promise(r => setTimeout(r, 1000));
    const sweepLamports = Math.round((await api.solBalance(dev.publicKey)) * LAMPORTS_PER_SOL) - TX_FEE_LAMPORTS;
    if (sweepLamports > 0) {
      sweepSig = await api.transferSol(dev, fundingKp.publicKey, 0, { lamports: sweepLamports, confirm: false });
      sweptSol = sweepLamports / LAMPORTS_PER_SOL;
    }
  } catch (err) {
    console.error('[fees] sweep failed:', errMsg(err));
  }
  return { status: 'confirmed' as const, signature, collectedSol: fees.sol, sweptSol, sweepSig, fundedFromFunding };
}

router.post('/collect-creator-fees', requireFunding, async (req: FundingRequest, res: Response) => {
  const launchId = resolveLaunchId(req.body?.launchId, req.body?.mint);
  if (!launchId) return res.status(400).json({ error: 'launchId or mint required' });
  const dev = devWalletFor(launchId);
  if (!dev) return res.status(404).json({ error: 'No dev wallet found for this launch' });
  try {
    const r = await collectAndSweep(trenchy(), vault.getKeypair(dev.id), req.fundingKeypair!);
    res.status(r.status === 'error' ? 500 : 200).json({ ...r, creator: dev.publicKey, launchId });
  } catch (err) {
    if (isNotBackedUp(err)) return res.status(409).json(notBackedUpBody(err));
    res.status(500).json({ status: 'error', error: errMsg(err), launchId });
  }
});

export default router;
