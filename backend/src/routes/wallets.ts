import { Router, Request, Response } from 'express';
import { PublicKey, LAMPORTS_PER_SOL, SystemProgram, type VersionedTransaction } from '@solana/web3.js';
import { createCloseAccountInstruction } from '@solana/spl-token';
import * as vault from '../services/vault';
import { trenchy, Trenchy, TrenchyError, isLegError, type TransferMode, type TransferStatus } from '../services/trenchy';
import { requireFunding, type FundingRequest } from '../services/funding';
import { findLaunch, findLaunchByMint, launchRole } from '../services/launches';
import { BACKUP_DIR, assertBackedUp, isBackedUp, exportAll, isNotBackedUp, notBackedUpBody } from '../services/backup';

// Balances, transfers and sweeps all go through the TrenchyTools API: GET /api/sol/balances (one call for up to
// 100 wallets), GET /api/sol/blockhash to build transfers here, POST /api/sol/send to send them.
//
// Wallet backup rule: a wallet is created → written to the backup folder → stored in the vault, in that order
// (vault.ts). Every route below that moves SOL into a wallet calls assertBackedUp() first and answers 409
// { code: "not_backed_up" } when the file is missing.

const router = Router();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function sendError(res: Response, err: unknown, what: string) {
  if (isNotBackedUp(err)) return res.status(409).json(notBackedUpBody(err));
  if (err instanceof TrenchyError) return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({ error: `${what}: ${err.message}`, code: err.code, hint: err.hint, docs: err.docs });
  res.status(500).json({ error: `${what}: ${errMsg(err)}` });
}

/** A wallet for the UI: public fields plus whether its backup file exists. */
const view = (w: vault.StoredWallet) => ({ ...vault.publicWallet(w), backedUp: isBackedUp(w.publicKey) });

/** GET / → active wallets (?status=archived for the archive, ?type=, ?launchId=). Mint keypairs are not listed. */
router.get('/', (req: Request, res: Response) => {
  const q = (k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);
  res.json(vault.listWallets({ type: q('type'), status: q('status') ?? 'active', launchId: q('launchId') }).filter(w => w.type !== 'mint').map(view));
});

/** Wallets a launch may pick as dev / bundle / holder. */
router.get('/available', (_req: Request, res: Response) => {
  res.json(vault.listAvailable().map(view));
});

/** The funding wallet card: { configured, id, publicKey, label, balance, backedUp }. */
router.get('/funding', async (_req: Request, res: Response) => {
  const w = vault.getFunding();
  if (!w) return res.json({ configured: false });
  let balance: number | null = null;
  let error: string | undefined;
  try { balance = await trenchy().solBalance(w.publicKey); } catch (e) { error = errMsg(e); }
  res.json({ configured: true, ...view(w), balance, error });
});

/** Create a funding wallet (when none exists) or N wallets: { count, type, label } → { wallets, backups }. */
router.post('/generate', (req: Request, res: Response) => {
  const { count = 1, type = 'manual', label } = req.body ?? {};
  const t = ['funding', 'dev', 'bundle', 'holder', 'manual'].includes(type) ? (type as vault.WalletType) : 'manual';
  const n = t === 'funding' ? 1 : Math.min(Math.max(Number(count) || 1, 1), 50);
  try {
    if (t === 'funding' && vault.getFunding()) return res.status(409).json({ error: 'A funding wallet already exists. Use "Make funding" on another wallet to switch.' });
    const made = n === 1 && t === 'funding'
      ? [vault.generateAndStore('funding', label || 'Funding')]
      : vault.generateBatch(n, t, label || t.charAt(0).toUpperCase() + t.slice(1));
    const wallets = made.map(m => view(m.wallet));
    const backups = made.map(m => m.backupPath).filter((p): p is string => !!p);
    console.log(`[wallets] ${wallets.length} ${t} wallet(s) generated; backups in ${BACKUP_DIR}`);
    res.json({ wallets, backups, dir: BACKUP_DIR });
  } catch (err) {
    sendError(res, err, 'Generate');
  }
});

/** Import a base58 key. With no funding wallet yet, the import becomes it. */
router.post('/import', (req: Request, res: Response) => {
  const { privateKey, type = 'manual', label } = req.body ?? {};
  if (!privateKey || typeof privateKey !== 'string') return res.status(400).json({ error: 'privateKey required' });
  const makeFunding = type === 'funding' || !vault.getFunding();
  try {
    const { wallet, backupPath } = vault.importKey(privateKey, makeFunding ? 'funding' : (['dev', 'bundle', 'holder', 'manual'].includes(type) ? type : 'manual'), label || (makeFunding ? 'Funding' : 'Imported'));
    if (makeFunding) vault.setFunding(wallet.id);
    res.json({ ...view(vault.getWallet(wallet.id)!), funding: makeFunding, backup: backupPath, dir: BACKUP_DIR });
  } catch (err) {
    res.status(400).json({ error: errMsg(err) });
  }
});

router.post('/:id/make-funding', (req: Request, res: Response) => {
  try { res.json(view(vault.setFunding(String(req.params.id)))); }
  catch (err) { res.status(404).json({ error: errMsg(err) }); }
});

router.patch('/:id/label', (req: Request, res: Response) => {
  const label = String(req.body?.label ?? '').trim();
  if (!label) return res.status(400).json({ error: 'label required' });
  const w = vault.update(String(req.params.id), { label });
  if (!w) return res.status(404).json({ error: 'Not found' });
  res.json(view(w));
});

/** SOL balances for a list of wallet ids (or every active wallet). */
router.post('/refresh-balances', async (req: Request, res: Response) => {
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : null;
  const wallets = (ids ? vault.listWallets().filter(w => ids.includes(w.id)) : vault.listWallets({ status: 'active' })).filter(w => w.type !== 'mint');
  let sol = new Map<string, number>();
  try { sol = new Map((await trenchy().balances(wallets.map(w => w.publicKey))).map(b => [b.wallet, b.sol])); }
  catch (err) { return sendError(res, err, 'Reading balances'); }
  res.json(wallets.map(w => ({ id: w.id, publicKey: w.publicKey, balance: sol.get(w.publicKey) ?? 0 })));
});

/** POST /export-backup → { dir, count }: every vault wallet into the backup folder (idempotent). */
router.post('/export-backup', (_req: Request, res: Response) => {
  try {
    const wallets = vault.listWallets().filter(w => w.type !== 'mint');
    res.json(exportAll(wallets.map(w => ({ publicKey: w.publicKey, privateKey: w.privateKey, label: w.label, role: w.type, createdAt: w.createdAt }))));
  } catch (err) {
    sendError(res, err, 'Export backup');
  }
});

/** The one way to read a key over HTTP (the Copy key button). */
router.get('/:id/private-key', (req: Request, res: Response) => {
  try { res.json({ privateKey: vault.getPrivateKey(String(req.params.id)) }); }
  catch (err) { res.status(404).json({ error: errMsg(err) }); }
});

// ── funding ───────────────────────────────────────────────────────────────

/** Direct: one plain transfer from the funding wallet (0.001–1 SOL). Refused with 409 when the wallet has no backup. */
router.post('/:id/fund', requireFunding, async (req: FundingRequest, res: Response) => {
  const amount = Math.max(0.001, Math.min(1, Number(req.body?.amount) || 0.01));
  const w = vault.getWallet(String(req.params.id));
  if (!w) return res.status(404).json({ error: 'Wallet not found' });
  if (w.type === 'mint') return res.status(400).json({ error: 'A mint keypair is not a wallet' });
  try {
    assertBackedUp(w.publicKey);
    const signature = await trenchy().transferSol(req.fundingKeypair!, new PublicKey(w.publicKey), amount);
    console.log(`[fund] ${w.publicKey.slice(0, 8)}… +${amount} SOL (${signature.slice(0, 8)}…)`);
    res.json({ signature, amount, publicKey: w.publicKey });
  } catch (err) {
    sendError(res, err, 'Fund');
  }
});

// Fund via exchange: POST /api/transfer/batch on the API. Each wallet is paid by an exchange hot wallet instead of
// by the funding wallet; the API returns one unsigned deposit transaction per wallet, this route checks, signs and
// sends each one, records the signature, and hands back one leg per wallet for the UI to follow.
const EXPLAIN_EXCHANGE = 'Each wallet is paid by an exchange hot wallet instead of by your funding wallet. Reduces on-chain linkability.';

router.get('/transfer-venues', async (_req: Request, res: Response) => {
  try { res.json({ ...(await trenchy().transferVenues()), explain: EXPLAIN_EXCHANGE }); }
  catch (err) { sendError(res, err, 'Could not read the exchange venues'); }
});

router.get('/transfers/:id', async (req: Request, res: Response) => {
  try { res.json(await trenchy().transferStatus(String(req.params.id))); }
  catch (err) { sendError(res, err, 'Could not read the transfer'); }
});

/** The deposit transaction the API built must be exactly what we agreed to sign. */
function checkDeposit(tx: VersionedTransaction, payer: PublicKey, depositAddress: string, expectedLamports: number): void {
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  if (!keys[0]?.equals(payer)) throw new Error('deposit transaction is not paid by the funding wallet');
  if (msg.compiledInstructions.length !== 1) throw new Error(`deposit transaction has ${msg.compiledInstructions.length} instructions, expected 1`);
  const ix = msg.compiledInstructions[0];
  if (!keys[ix.programIdIndex]?.equals(SystemProgram.programId)) throw new Error('deposit transaction is not a system transfer');
  const data = Buffer.from(ix.data);
  if (data.length !== 12 || data.readUInt32LE(0) !== 2) throw new Error('deposit transaction is not a SOL transfer');
  const lamports = Number(data.readBigUInt64LE(4));
  if (lamports !== expectedLamports) throw new Error(`deposit transaction moves ${lamports / LAMPORTS_PER_SOL} SOL, expected ${expectedLamports / LAMPORTS_PER_SOL}`);
  if (!keys[ix.accountKeyIndexes[0]]?.equals(payer)) throw new Error('deposit transaction does not send from the funding wallet');
  if (keys[ix.accountKeyIndexes[1]]?.toBase58() !== depositAddress) throw new Error('deposit transaction does not send to the deposit address of this transfer');
}

export type FundLeg = {
  walletId: string; publicKey: string;
  transferId?: string; status: string; route?: string; mode?: string | null; venue?: string | null;
  deposit?: { address: string; amount: number; deadline?: string } | null;
  signature?: string; receipt?: string; poll?: string;
  error?: string; code?: string;
};

/** { walletIds: string[] (≤ 25), amountSol, mode?: float|fixed|private, venue? } → { batchId, legs }. */
router.post('/fund-via-exchange', requireFunding, async (req: FundingRequest, res: Response) => {
  const body = (req.body ?? {}) as { walletIds?: unknown; amountSol?: unknown; mode?: unknown; venue?: unknown };
  const walletIds = Array.isArray(body.walletIds) ? body.walletIds.filter((x): x is string => typeof x === 'string') : [];
  const amountSol = Number(body.amountSol);
  const mode = (typeof body.mode === 'string' ? body.mode : 'float') as TransferMode;
  const venue = typeof body.venue === 'string' && body.venue ? body.venue : 'random';
  if (!walletIds.length || walletIds.length > 25) return res.status(400).json({ error: 'walletIds: 1 to 25 wallet ids' });
  if (!(amountSol > 0)) return res.status(400).json({ error: 'amountSol must be greater than zero' });
  if (!['float', 'fixed', 'private'].includes(mode)) return res.status(400).json({ error: 'mode must be float, fixed or private' });

  const fundingKp = req.fundingKeypair!;
  const fundingPk = fundingKp.publicKey;
  const api = trenchy();

  // Only wallets with a backup file are funded; the rest come back as refused legs.
  const targets: Array<{ walletId: string; publicKey: string }> = [];
  const legs: FundLeg[] = [];
  for (const id of walletIds) {
    const w = vault.getWallet(id);
    if (!w || w.type === 'mint') { legs.push({ walletId: id, publicKey: w?.publicKey ?? '', status: 'refused', error: 'not a vault wallet' }); continue; }
    if (w.publicKey === fundingPk.toBase58()) { legs.push({ walletId: id, publicKey: w.publicKey, status: 'skipped', error: 'this is the funding wallet' }); continue; }
    if (!isBackedUp(w.publicKey)) { legs.push({ walletId: id, publicKey: w.publicKey, status: 'refused', error: `no backup file in ${BACKUP_DIR}: refusing to fund it`, code: 'not_backed_up' }); continue; }
    targets.push({ walletId: id, publicKey: w.publicKey });
  }
  if (!targets.length) return res.status(legs.some(l => l.code === 'not_backed_up') ? 409 : 400).json({ error: 'none of the wallets can be funded', code: legs.some(l => l.code === 'not_backed_up') ? 'not_backed_up' : undefined, hint: 'run Export backup on the Wallets page', legs });

  let batch;
  try {
    batch = await api.createTransferBatch({ from: { chain: 'sol', wallet: fundingPk.toBase58() }, to: targets.map(t => ({ chain: 'sol', address: t.publicKey, amount: amountSol })), mode, venue });
  } catch (err) {
    return sendError(res, err, 'Creating the transfers');
  }

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const leg = batch.legs[i];
    if (!leg) { legs.push({ ...t, status: 'failed', error: 'the API returned no leg for this wallet' }); continue; }
    if (isLegError(leg)) { legs.push({ ...t, status: 'failed', error: leg.error, code: leg.code }); continue; }
    const out: FundLeg = { ...t, transferId: leg.transferId, status: leg.status, route: leg.route, mode: leg.mode ?? null, venue: leg.venue ?? null, deposit: leg.deposit ? { address: leg.deposit.address, amount: leg.deposit.amount, deadline: leg.deposit.deadline } : null, poll: `/api/wallets/transfers/${leg.transferId}` };
    try {
      if (!leg.deposit || !leg.transaction) throw new Error(`the order is still ${leg.status}; no deposit address yet (poll it)`);
      if (leg.deposit.amount > amountSol * 1.05) throw new Error(`deposit amount ${leg.deposit.amount} SOL is above the ${amountSol} SOL asked for; refusing`);
      const tx = Trenchy.depositTx(leg);
      checkDeposit(tx, fundingPk, leg.deposit.address, Math.round(leg.deposit.amount * LAMPORTS_PER_SOL));
      tx.sign([fundingKp]);
      const { signature } = await api.send(tx, { skipPreflight: false });   // simulated first: an empty funding wallet fails here with the reason
      out.signature = signature;
      await api.transferSent(leg.transferId, signature).catch(e => console.warn(`[fund-via-exchange] /sent for ${leg.transferId}: ${errMsg(e)}`));
      const s: TransferStatus | null = await api.transferStatus(leg.transferId).catch(() => null);
      if (s) { out.status = s.status; out.receipt = s.receipt; out.venue = s.venue ?? out.venue; }
      console.log(`[fund-via-exchange] ${t.publicKey.slice(0, 8)}… ${amountSol} SOL via ${out.venue ?? 'auto'} (${mode}): deposit ${signature.slice(0, 8)}… transfer ${leg.transferId}`);
    } catch (err) {
      out.status = 'failed';
      out.error = errMsg(err);
      if (err instanceof TrenchyError) out.code = err.code;
    }
    legs.push(out);
  }
  res.json({ batchId: batch.batchId, explain: EXPLAIN_EXCHANGE, legs });
});

// ── balances per mint, gather, close token accounts ──────────────────────

/** Launch wallets with their SOL and this mint's token balance: { mint, launchId? }. */
router.post('/balances', async (req: Request, res: Response) => {
  const { mint } = req.body ?? {};
  if (!mint) return res.status(400).json({ error: 'mint required' });
  try { new PublicKey(mint); } catch { return res.status(400).json({ error: 'invalid mint' }); }
  const launch = (typeof req.body?.launchId === 'string' ? findLaunch(req.body.launchId) : null) ?? findLaunchByMint(mint);

  // Our launch: its wallets (archived too, they may still hold tokens). Any other mint: every active wallet, the ones holding it.
  let wallets = launch
    ? vault.listWallets({ launchId: launch.id }).filter(w => launchRole(w, launch))
    : vault.listWallets({ status: 'active' }).filter(w => w.type !== 'mint');
  let byWallet = new Map<string, { sol: number; balance: number; raw: string }>();
  try {
    byWallet = new Map((await trenchy().balances(wallets.map(w => w.publicKey), mint)).map(b => [b.wallet, { sol: b.sol, balance: b.token?.balance ?? 0, raw: b.token?.raw ?? '0' }]));
  } catch (err) {
    return sendError(res, err, 'Reading balances');
  }
  let rows = wallets.map(w => {
    const b = byWallet.get(w.publicKey);
    return { id: w.id, publicKey: w.publicKey, type: launchRole(w, launch) ?? w.type, label: w.label, solBalance: b?.sol ?? 0, tokenBalance: b?.balance ?? 0, tokenRaw: b?.raw ?? '0' };
  });
  if (!launch) rows = rows.filter(r => r.tokenBalance > 0);
  res.json(rows);
});

/** Sweep all SOL from every active non-funding wallet (or one launch's wallets) back to the funding wallet. */
router.post('/gather', requireFunding, async (req: FundingRequest, res: Response) => {
  const fundingKp = req.fundingKeypair!;
  const launchId = typeof req.body?.launchId === 'string' ? req.body.launchId : typeof req.body?.mint === 'string' ? findLaunchByMint(req.body.mint)?.id : undefined;
  const ids = Array.isArray(req.body?.walletIds) ? (req.body.walletIds as string[]) : null;
  const wallets = vault.listWallets({ status: 'active', launchId }).filter(w => w.type !== 'funding' && w.type !== 'mint' && w.publicKey !== fundingKp.publicKey.toBase58() && (!ids || ids.includes(w.id)));
  const api = trenchy();
  const TX_FEE_LAMPORTS = 5000;

  let sol: Map<string, number>;
  try { sol = new Map((await api.balances(wallets.map(w => w.publicKey))).map(b => [b.wallet, b.sol])); }
  catch (err) { return sendError(res, err, 'Reading balances'); }

  const results: { id: string; publicKey: string; recovered: number; error?: string }[] = [];
  for (const w of wallets) {
    try {
      const lamports = Math.round((sol.get(w.publicKey) ?? 0) * LAMPORTS_PER_SOL) - TX_FEE_LAMPORTS;
      if (lamports <= 0) { results.push({ id: w.id, publicKey: w.publicKey, recovered: 0 }); continue; }
      assertBackedUp(w.publicKey);   // the source wallet's key is what moves the money: it must be on disk
      await api.transferSol(vault.getKeypair(w.id), fundingKp.publicKey, 0, { lamports, confirm: false });
      results.push({ id: w.id, publicKey: w.publicKey, recovered: lamports / LAMPORTS_PER_SOL });
    } catch (err) {
      results.push({ id: w.id, publicKey: w.publicKey, recovered: 0, error: isNotBackedUp(err) ? notBackedUpBody(err).error : errMsg(err) });
    }
  }
  res.json({ totalRecovered: results.reduce((s, r) => s + r.recovered, 0), wallets: results });
});

/** Close empty token accounts in archived (or the given) wallets; the funding wallet pays the fee and gets the rent. */
router.post('/close-token-accounts', requireFunding, async (req: FundingRequest, res: Response) => {
  const fundingKp = req.fundingKeypair!;
  const api = trenchy();
  const ids = Array.isArray(req.body?.walletIds) ? (req.body.walletIds as string[]) : null;
  const wallets = (ids ? vault.listWallets().filter(w => ids.includes(w.id)) : vault.listWallets({ status: 'archived' })).filter(w => w.type !== 'funding' && w.type !== 'mint');
  const results: { publicKey: string; closed: number; recoveredSol: number; error?: string }[] = [];

  for (const w of wallets) {
    try {
      const owner = new PublicKey(w.publicKey);
      const kp = vault.getKeypair(w.id);
      const closeable = (await api.tokenAccounts(w.publicKey, true)).filter(a => a.raw === '0');
      if (!closeable.length) continue;
      let closed = 0;
      for (let i = 0; i < closeable.length; i += 10) {
        const batch = closeable.slice(i, i + 10);
        await api.sendInstructions(fundingKp, batch.map(a => createCloseAccountInstruction(new PublicKey(a.account), fundingKp.publicKey, owner, [], new PublicKey(a.program))), [kp], false);
        closed += batch.length;
        await new Promise(r => setTimeout(r, 300));
      }
      results.push({ publicKey: w.publicKey, closed, recoveredSol: closed * 0.00203 });
    } catch (err) {
      results.push({ publicKey: w.publicKey, closed: 0, recoveredSol: 0, error: errMsg(err) });
    }
  }
  res.json({ walletsProcessed: wallets.length, totalClosed: results.reduce((s, r) => s + r.closed, 0), totalRecoveredSol: results.reduce((s, r) => s + r.recoveredSol, 0), results });
});

// ── archive / delete ──────────────────────────────────────────────────────

router.patch('/:id/archive', (req: Request, res: Response) => {
  const w = vault.getWallet(String(req.params.id));
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (w.type === 'funding') return res.status(400).json({ error: 'The funding wallet cannot be archived' });
  res.json(view(vault.update(w.id, { status: 'archived' })!));
});

router.patch('/:id/unarchive', (req: Request, res: Response) => {
  const w = vault.update(String(req.params.id), { status: 'active' });
  if (!w) return res.status(404).json({ error: 'Not found' });
  res.json(view(w));
});

/** Delete one wallet from the vault (its backup file stays in the backup folder). */
router.delete('/:id', (req: Request, res: Response) => {
  const w = vault.getWallet(String(req.params.id));
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (w.type === 'funding') return res.status(400).json({ error: 'Make another wallet the funding wallet first' });
  vault.deleteWallet(w.id);
  res.json({ deleted: w.id, backupKept: isBackedUp(w.publicKey) });
});

/** Delete every archived wallet from the vault (their backup files stay). */
router.delete('/', (req: Request, res: Response) => {
  if (req.query.status !== 'archived') return res.status(400).json({ error: 'only ?status=archived is supported' });
  res.json({ deleted: vault.deleteAllArchived() });
});

export default router;
