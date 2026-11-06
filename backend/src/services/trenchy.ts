/**
 * The TrenchyTools API client. Every chain call this launcher makes goes through here: building pump.fun
 * transactions, sending them, Jito bundles, balances, confirmations, metadata uploads and the live trade feed.
 * The launcher never talks to an RPC node, Jito or IPFS itself; it signs locally and the API does the rest.
 *
 * Where the URL and key come from: backend/keys/settings.json (the Settings page) first, then backend/.env
 * (TRENCHY_API_URL, TRENCHY_API_KEY). See services/settings.ts.
 *
 * Copy this file into your own bot: one class, one method per endpoint, typed responses, retries on 429 and on an
 * unreachable host, and every error as TrenchyError { status, code, hint, docs } so you can match on `code`.
 */
import {
  Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL,
  type TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { effectiveSettings, DEFAULT_API_URL } from './settings';

export { DEFAULT_API_URL };

/**
 * Every API error body is `{ error, code, hint?, docs }`: `code` is stable (match on it), `hint` says what to do about
 * it, `docs` links the page for that code. All four ride along here so a bot can act on them.
 */
export class TrenchyError extends Error {
  constructor(message: string, public status: number, public code?: string, public hint?: string, public docs?: string) { super(message); }
}

export type Expected = { tokens: number; sol: number };
export type TradeBody = {
  /** the wallet; a `buyers` entry may leave it out (the first buyer pays the fee) */
  publicKey?: string;
  action: 'buy' | 'sell' | 'create' | 'collectCreatorFee';
  /** several wallets buying in one transaction (bundles): needs `lookupTable` */
  buyers?: Array<{ publicKey: string; amount: number }>;
  lookupTable?: string;
  mint?: string;
  amount?: number | string;
  denominatedInSol?: 'true' | 'false';
  slippage?: number;
  priorityFee?: number;
  pool?: 'pump' | 'pump-amm' | 'auto';
  tokenMetadata?: { name: string; symbol: string; uri: string };
};
export type BuiltTx = { tx: VersionedTransaction; expected: Expected; feeSol: number; action?: string; perBuyer?: Array<{ publicKey: string; tokens: number; sol: number }> };
export type WalletBalance = { wallet: string; sol: number; token?: { mint: string; balance: number; raw: string; account: string | null; program: string | null } };
export type TokenAccount = { mint: string; balance: number; raw: string; account: string; program: string };

// ── vanity shapes (apps/api/src/sol/vanity.ts) ──
export type VanityPoolStats = { targets: Record<string, number>; ready: Record<string, number>; grinding: string | null; attempts: number };
export type VanityLimits = { maxChars: number; workersPerJob: number; timeoutS: number; maxJobs: number; pool: VanityPoolStats };
/** 202 from POST /api/sol/vanity. `status` is always "running" here: poll once, a pooled key is already done. */
export type VanityJobStart = { jobId: string; status: 'running'; suffix?: string; prefix?: string; caseSensitive: boolean; expectedAttempts: number; limits: VanityLimits; poll: string };
export type VanityJobStatus = {
  jobId: string; status: 'running' | 'done' | 'failed'; pooled: boolean; suffix?: string; prefix?: string; caseSensitive: boolean;
  attempts: number; elapsedMs: number; expectedAttempts: number;
  /** done, first read only: the keypair (base58 secret), shown once */
  publicKey?: string; secretKey?: string; backup?: WalletBackupNote; warning?: string;
  /** done, later reads */
  collected?: boolean; note?: string;
  /** failed */
  reason?: string;
};
export type WalletBackupNote = { rule: string; checklist: string[]; docs: string };

// ── transfer shapes (apps/api/src/transfer/index.ts) ──
export type TransferMode = 'float' | 'fixed' | 'private';
export type TransferVenueName = 'auto' | 'random' | 'binance' | 'bybit' | 'kucoin' | 'htx' | 'mexc' | 'bitget' | 'gate';
export type TransferRoute = { route: 'direct' | 'exchange'; mode: TransferMode | null; venue: string | null; status?: 'open' | 'closed' | 'unknown'; receive: number; fee: number; networkFee?: number; etaS: number; min?: number; max?: number; note?: string };
export type TransferRoutes = { from: string; to: string; amount: number; routes: TransferRoute[]; venues?: string[]; chains?: Record<string, { name: string; native: string; source: boolean; destination: boolean }>; modes?: TransferMode[]; exchange?: 'on' | 'off' };
export type TransferVenues = { exchange: 'on' | 'off' | 'degraded'; checkedAt: string | null; venues: Record<string, { status: 'open' | 'closed' | 'unknown'; reason?: string; default?: boolean }>; note?: string };
export type DepositTx = { chain: string; encoding: 'base64' | 'evm'; transaction?: string; evm?: { chainId: number; from: string; to: string; value: string; gas: string; data: '0x'; label: 'deposit' } };
export type TransferCreateBody = { from: { chain: string; wallet: string }; to: { chain: string; address: string }; amount: number; route?: 'auto' | 'direct' | 'exchange'; mode?: TransferMode; venue?: TransferVenueName | string; refundAddress?: string };
export type TransferCreated = {
  transferId: string; status: string; route: 'direct' | 'exchange'; mode?: TransferMode; venue?: string; venueRequested?: string; venueHonoured?: boolean;
  from: { chain: string; wallet: string }; to: { chain: string; address: string }; amount: number; expected?: { receive: number; fee: number; etaS: number };
  deposit: { chain: string; address: string; amount: number; tag?: string; deadline?: string; note?: string } | null;
  transaction?: DepositTx; poll?: string; warning?: string;
};
export type TransferBatchBody =
  | { from: { chain: string; wallet: string }; to: Array<{ chain: string; address: string; amount: number }>; mode?: TransferMode; venue?: TransferVenueName | string; route?: 'auto' | 'direct' | 'exchange' }
  | { from: Array<{ chain: string; wallet: string; amount: number }>; to: { chain: string; address: string }; mode?: TransferMode; venue?: TransferVenueName | string; route?: 'auto' | 'direct' | 'exchange' };
export type TransferLegError = { error: string; code: string; leg: { from: { chain: string; wallet: string }; to: { chain: string; address: string }; amount: number } };
export type TransferBatch = { batchId: string; legs: Array<TransferCreated | TransferLegError>; venues: string[] };
export const isLegError = (l: TransferCreated | TransferLegError): l is TransferLegError => 'error' in l;
export type TransferStatus = {
  transferId: string; status: string; route: 'direct' | 'exchange'; mode: TransferMode | null; venue: string | null; batchId?: string;
  from: { chain: string; wallet: string }; to: { chain: string; address: string }; amount: number; expectedReceive: number | null;
  deposit: { chain: string; address: string; deadline?: string } | null; depositHash: string | null; payoutHash: string | null; reason?: string;
  orderId?: string; receipt?: string; help?: Record<string, unknown>; createdAt: number; updatedAt: number;
};
/** Statuses after which a transfer will not change any more ("sent" is final for direct transfers only). */
export const TRANSFER_FINAL = new Set(['completed', 'failed', 'expired', 'refunded', 'cancelled']);
export const transferDone = (t: { status: string; route: string }) => TRANSFER_FINAL.has(t.status) || (t.route === 'direct' && t.status === 'sent');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Trenchy {
  constructor(public readonly url: string, private readonly key: string) {}

  get configured(): boolean { return !!this.key; }

  /** The websocket for live trades (one connection, many subscriptions). */
  wsUrl(): string {
    return `${this.url.replace(/^http/, 'ws')}/api/sol/data?api-key=${encodeURIComponent(this.key)}`;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.key) throw new TrenchyError(`No TrenchyTools API key. Create one at ${this.url}/api/create-api-key and paste it in Settings.`, 401, 'no_key');
    const u = `${this.url}${path}${path.includes('?') ? '&' : '?'}api-key=${encodeURIComponent(this.key)}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(u, { ...init, signal: AbortSignal.timeout(45_000) });
      } catch (e) {
        if (attempt < 2) { await sleep(500 * (attempt + 1)); continue; }
        throw new TrenchyError(`TrenchyTools API unreachable at ${this.url} (${e instanceof Error ? e.message : e})`, 0, 'unreachable');
      }
      // Our own rate limit: wait as long as the API says, a few times, rather than failing a launch midway.
      if (res.status === 429 && attempt < 4) {
        await sleep((Number(res.headers.get('retry-after')) || 1) * 1000);
        continue;
      }
      const text = await res.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      if (!res.ok) throw new TrenchyError(body?.error || `TrenchyTools API ${res.status}`, res.status, body?.code, body?.hint, body?.docs);
      return body as T;
    }
  }
  private get<T>(path: string) { return this.call<T>(path); }
  private post<T>(path: string, body: unknown) {
    return this.call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  // ── building ───────────────────────────────────────────────────────────

  /** One unsigned transaction (buy, sell, create, collectCreatorFee). Sign it, then send(). */
  async tradeLocal(body: TradeBody): Promise<BuiltTx> {
    const r = await this.post<{ transaction: string; expected: Expected; feeSol: number }>('/api/sol/trade-local?format=json', body);
    return { tx: VersionedTransaction.deserialize(Buffer.from(r.transaction, 'base64')), expected: r.expected, feeSol: r.feeSol };
  }

  /**
   * Up to 5 unsigned transactions for one Jito bundle. The first entry's priorityFee is the Jito tip, paid inside
   * that transaction. Buys of a coin the first entry creates are priced on the curve as it will be in the bundle.
   */
  async bundleLocal(bodies: TradeBody[]): Promise<BuiltTx[]> {
    const r = await this.post<{ transactions: Array<{ transaction: string; expected: Expected; feeSol: number; action: string; perBuyer?: BuiltTx['perBuyer'] }> }>('/api/sol/trade-local?format=json', bodies);
    return r.transactions.map(t => ({ tx: VersionedTransaction.deserialize(bs58.decode(t.transaction)), expected: t.expected, feeSol: t.feeSol, action: t.action, perBuyer: t.perBuyer }));
  }

  // ── lookup tables (many buyers in one block) ───────────────────────────

  /** Unsigned create+extend transactions for a launch table; sign each with `authority` and send in order. */
  async lutCreate(p: { authority: string; mint: string; wallets: string[]; creator?: string }) {
    const r = await this.post<{ lookupTable: string; addresses: number; rentSol: number; transactions: string[] }>('/api/sol/lut', p);
    return { ...r, txs: r.transactions.map(b64 => VersionedTransaction.deserialize(Buffer.from(b64, 'base64'))) };
  }
  lutInfo(address: string) { return this.get<{ lookupTable: string; authority: string | null; addresses: string[]; ready: boolean; deactivated: boolean }>(`/api/sol/lut/${address}`); }
  async lutStep(address: string, step: 'deactivate' | 'close', authority: string, recipient?: string) {
    const r = await this.post<{ transaction: string }>(`/api/sol/lut/${address}/${step}`, { authority, recipient });
    return VersionedTransaction.deserialize(Buffer.from(r.transaction, 'base64'));
  }

  /** A recent blockhash, for the plain SOL transfers and account closes this launcher builds itself. */
  blockhash() { return this.get<{ blockhash: string; lastValidBlockHeight: number }>('/api/sol/blockhash'); }

  // ── sending ────────────────────────────────────────────────────────────

  send(tx: VersionedTransaction, opts: { skipPreflight?: boolean; jitoOnly?: boolean } = {}) {
    return this.post<{ signature: string; lanes: string[] }>('/api/sol/send', {
      transaction: Buffer.from(tx.serialize()).toString('base64'), skipPreflight: opts.skipPreflight ?? true, jitoOnly: opts.jitoOnly ?? false,
    });
  }
  simulate(tx: VersionedTransaction) {
    return this.post<{ ok: boolean; err: unknown; unitsConsumed: number | null; logs: string[] }>('/api/sol/simulate', { transaction: Buffer.from(tx.serialize()).toString('base64') });
  }
  bundle(txs: VersionedTransaction[]) {
    return this.post<{ bundleId: string; signatures: string[]; region: string }>('/api/sol/bundle', { transactions: txs.map(t => bs58.encode(t.serialize())) });
  }
  bundleStatus(id: string) { return this.get<{ bundleId: string; status: string; landedSlot?: number | null }>(`/api/sol/bundle/${encodeURIComponent(id)}`); }
  txStatus(sig: string) { return this.get<{ signature: string; confirmationStatus: string | null; err?: unknown }>(`/api/sol/tx/${encodeURIComponent(sig)}`); }

  /** Poll until confirmed (true), failed (throws) or timed out (false). */
  async waitConfirmed(sig: string, timeoutMs = 60_000, onProgress?: (msg: string) => void, pollMs = 1000): Promise<boolean> {
    const start = Date.now();
    let lastNote = 0;
    while (Date.now() - start < timeoutMs) {
      const s = await this.txStatus(sig).catch(() => null);
      if (s?.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return true;
      if (onProgress && Date.now() - lastNote > 4000) {
        lastNote = Date.now();
        onProgress(`Still waiting for confirmation... (${Math.round((Date.now() - start) / 1000)}s, sig ${sig.slice(0, 8)}...)`);
      }
      await sleep(pollMs);
    }
    return false;
  }

  /** Sign, send, confirm. */
  async execute(tx: VersionedTransaction, signers: Keypair[], timeoutMs = 60_000): Promise<string> {
    tx.sign(signers);
    const { signature } = await this.send(tx);
    if (!(await this.waitConfirmed(signature, timeoutMs))) throw new Error(`Transaction confirmation timeout: ${signature.slice(0, 12)}...`);
    return signature;
  }

  /**
   * A blockhash can be processed for ~150 blocks after it was issued. The API exposes no block height, but a fresh
   * blockhash's lastValidBlockHeight is the current height + 150, so the old one is dead once a fresh one sits more
   * than 150 above it. (The API caches its blockhash briefly, which only makes this check later, never early.)
   */
  private async blockhashExpired(lastValidBlockHeight: number): Promise<boolean> {
    const fresh = await this.blockhash().catch(() => null);
    return !!fresh && fresh.lastValidBlockHeight - 150 > lastValidBlockHeight;
  }

  /**
   * Build and sign a plain transaction ONCE, then send those same signed bytes until it confirms or its blockhash
   * dies. Re-sending identical bytes is safe (the chain dedupes by signature), so a transfer that landed but timed
   * out on confirmation is never paid twice. Only when GET /api/sol/tx/:signature still shows nothing after the
   * blockhash can no longer be processed is the transaction rebuilt with a fresh blockhash (up to `rebuilds` times).
   */
  async sendInstructions(payer: Keypair, ixs: TransactionInstruction[], extraSigners: Keypair[] = [], confirm = true, opts: { rebuilds?: number } = {}): Promise<string> {
    const rebuilds = opts.rebuilds ?? 0;
    const RESEND_MS = 2_000;
    const HARD_CAP_MS = 180_000;   // a blockhash dies in 60–90 s; this only guards against a stuck block-height read
    let lastSignature = '';
    for (let build = 0; build <= rebuilds; build++) {
      const { blockhash, lastValidBlockHeight } = await this.blockhash();
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
      tx.sign([payer, ...extraSigners]);
      const signature = bs58.encode(tx.signatures[0]);
      lastSignature = signature;

      // First send simulated (skipPreflight false): a transfer from an empty wallet fails here with the reason, at
      // once. A send that errors for any other reason may still have reached the chain, so the SAME bytes go again.
      let sent = false;
      for (let attempt = 0; attempt < 3 && !sent; attempt++) {
        try {
          await this.send(tx, { skipPreflight: attempt > 0 });
          sent = true;
        } catch (e) {
          if (e instanceof TrenchyError && e.code === 'simulation_failed') throw e;   // e.g. not enough SOL: retrying won't help
          if (attempt === 2 && !confirm) throw e;
          await sleep((attempt + 1) * 800);
        }
      }
      if (!confirm) return signature;

      // Poll for confirmation, re-sending the identical transaction every few seconds, until the blockhash expires.
      const started = Date.now();
      let lastResend = Date.now();
      let lastExpiryCheck = Date.now();
      let expired = false;
      while (Date.now() - started < HARD_CAP_MS) {
        const s = await this.txStatus(signature).catch(() => null);
        if (s?.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return signature;
        if (Date.now() - lastExpiryCheck >= 10_000) {
          lastExpiryCheck = Date.now();
          if (await this.blockhashExpired(lastValidBlockHeight)) { expired = true; break; }
        }
        if (Date.now() - lastResend >= RESEND_MS) {
          lastResend = Date.now();
          await this.send(tx, { skipPreflight: true }).catch(() => {});
        }
        await sleep(1000);
      }
      // One last look once the blockhash is dead: a 'processed' status means it is in a block and may still confirm.
      const final = await this.txStatus(signature).catch(() => null);
      if (final?.err) throw new Error(`Transaction failed: ${JSON.stringify(final.err)}`);
      if (final?.confirmationStatus) {
        if (await this.waitConfirmed(signature, 30_000)) return signature;
        throw new Error(`Transaction confirmation timeout: ${signature.slice(0, 12)}... (seen by the chain; check GET /api/sol/tx before retrying)`);
      }
      if (!expired) throw new Error(`Transaction confirmation timeout: ${signature.slice(0, 12)}... (blockhash still valid; check GET /api/sol/tx before retrying)`);
      // Never seen and can never land now: safe to rebuild with a new blockhash.
    }
    throw new Error(`Transaction ${lastSignature.slice(0, 12)}... expired before it reached the chain`);
  }

  /** SOL from one wallet to another, confirmed. Same signed bytes are re-sent; rebuilt only once they can no longer land. */
  async transferSol(from: Keypair, to: PublicKey, solAmount: number, opts: { lamports?: number; confirm?: boolean } = {}): Promise<string> {
    const lamports = opts.lamports ?? Math.round(solAmount * LAMPORTS_PER_SOL);
    let last: unknown = null;
    try {
      return await this.sendInstructions(from, [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })], [], opts.confirm ?? true, { rebuilds: 2 });
    } catch (e) {
      last = e;
    }
    const why = last instanceof Error ? last.message : String(last);
    if (/AccountNotFound|insufficient (funds|lamports)|InsufficientFunds/i.test(why)) {
      throw new Error(`Transfer ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL failed: ${from.publicKey.toBase58().slice(0, 8)}… does not have enough SOL. Fund it and try again.`);
    }
    throw new Error(`Transfer ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL failed: ${why}`);
  }

  // ── reading ────────────────────────────────────────────────────────────

  /** SOL (and optionally one token) for up to 100 wallets per call; batches beyond that. */
  async balances(wallets: string[], mint?: string): Promise<WalletBalance[]> {
    const out: WalletBalance[] = [];
    for (let i = 0; i < wallets.length; i += 100) {
      const chunk = wallets.slice(i, i + 100);
      const r = await this.get<{ wallets: WalletBalance[] }>(`/api/sol/balances?wallets=${chunk.join(',')}${mint ? `&mint=${mint}` : ''}`);
      out.push(...r.wallets);
    }
    return out;
  }
  async solBalance(wallet: PublicKey | string): Promise<number> {
    return (await this.balances([typeof wallet === 'string' ? wallet : wallet.toBase58()]))[0]?.sol ?? 0;
  }
  /** Every token account a wallet holds (includeEmpty: the empty ones too, to close them for rent). */
  async tokenAccounts(wallet: string, includeEmpty = false): Promise<TokenAccount[]> {
    const r = await this.get<{ tokens: TokenAccount[] }>(`/api/sol/balances?wallet=${wallet}${includeEmpty ? '&includeEmpty=true' : ''}`);
    return r.tokens;
  }
  creatorFees(wallet: string) { return this.get<{ wallet: string; lamports: string; sol: number }>(`/api/sol/creator-fees?wallet=${wallet}`); }
  quote(mint: string, action: 'buy' | 'sell', amount: number, denominatedInSol = action === 'buy') {
    return this.get<Record<string, unknown>>(`/api/sol/quote?mint=${mint}&action=${action}&amount=${amount}&denominatedInSol=${denominatedInSol}`);
  }
  token(mint: string) { return this.get<Record<string, unknown>>(`/api/sol/token/${mint}`); }
  priorityFee() { return this.get<{ suggestedPriorityFeeSol: Record<string, number>; jitoTipSol: Record<string, number> }>('/api/sol/priority-fee'); }
  me() { return this.get<Record<string, unknown>>('/api/me'); }

  // ── vanity mints (ground on the API's workers) ─────────────────────────
  //
  // POST /api/sol/vanity starts a job (suffix and/or prefix, ≤ 4 characters together). Common suffixes (`pump`,
  // `bonk`) come from the API's WARM POOL: the job is already `done` and ONE GET collects the key at once; the start
  // response's `limits.pool.ready` says how many are warm per suffix. Anything else is ground by a few workers for up
  // to `limits.timeoutS`; poll `vanityJob` until `done` (keypair, handed out exactly once) or `failed` (reason).
  // One running job per key (409 vanity_busy); longer patterns are refused (400 vanity_too_long: grind locally).

  vanityStart(p: { suffix?: string; prefix?: string; caseSensitive?: boolean }) {
    return this.post<VanityJobStart>('/api/sol/vanity', p);
  }
  vanityJob(jobId: string) { return this.get<VanityJobStatus>(`/api/sol/vanity/${encodeURIComponent(jobId)}`); }

  /**
   * Start a job and collect it: a pooled key returns immediately; otherwise polls every `pollMs` until the job ends.
   * Save the keypair to disk the moment this resolves (wallet backup rule).
   */
  async vanityGrind(p: { suffix?: string; prefix?: string; caseSensitive?: boolean }, opts: { pollMs?: number; onProgress?: (j: VanityJobStatus) => void; shouldStop?: () => boolean } = {}): Promise<VanityJobStatus> {
    const start = await this.vanityStart(p);
    for (;;) {
      const job = await this.vanityJob(start.jobId);
      if (job.status !== 'running') return job;
      opts.onProgress?.(job);
      if (opts.shouldStop?.()) return job;
      await sleep(opts.pollMs ?? 2500);
    }
  }

  // ── transfers: wallet → wallet through an exchange hop, or direct ──────
  //
  // The API opens the order and returns a one-time deposit address PLUS an unsigned deposit transaction from your
  // wallet (base64 v0 on Solana). Sign it, send it (POST /api/sol/send), tell the API the signature, then poll
  // `transferStatus` until completed (payoutHash) or a final failure. The destination is paid by the exchange, so the
  // two wallets are not linked on chain; a named venue decides WHICH exchange pays (breaks the wallet cluster).

  /** Quotes for a pair and amount: every route/mode/venue open right now with receive, fee, min, eta. */
  transferRoutes(from: string, to: string, amount: number) {
    return this.get<TransferRoutes>(`/api/transfer/routes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&amount=${amount}`);
  }
  /** Which exchange venues are open (probed every 2 minutes, nothing is created). */
  transferVenues() { return this.get<TransferVenues>('/api/transfer/venues'); }
  createTransfer(body: TransferCreateBody) { return this.post<TransferCreated>('/api/transfer', body); }
  /** Fan-out (one source → many) or consolidate (many → one). Failed legs are reported inline; the rest go ahead. */
  createTransferBatch(body: TransferBatchBody) { return this.post<TransferBatch>('/api/transfer/batch', body); }
  transferStatus(id: string) { return this.get<TransferStatus>(`/api/transfer/${encodeURIComponent(id)}`); }
  /** Record the signature of the deposit you sent, so the transfer record is complete. */
  transferSent(id: string, hash: string) { return this.post<{ ok: boolean }>(`/api/transfer/${encodeURIComponent(id)}/sent`, { hash }); }
  /** Your last 50 transfers. */
  transfers() { return this.get<{ transfers: TransferStatus[] }>('/api/transfer'); }

  /** Deserialize a Solana deposit transaction from a transfer or batch leg. */
  static depositTx(leg: { transaction?: DepositTx | null }): VersionedTransaction {
    if (!leg.transaction || leg.transaction.encoding !== 'base64' || !leg.transaction.transaction) throw new Error('transfer leg carries no Solana deposit transaction');
    return VersionedTransaction.deserialize(Buffer.from(leg.transaction.transaction, 'base64'));
  }

  // ── metadata ───────────────────────────────────────────────────────────

  async uploadMetadata(m: { image: Buffer; mime: string; fileName: string; name: string; symbol: string; description?: string; twitter?: string; telegram?: string; website?: string; backup?: string }): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(m.image)], { type: m.mime }), m.fileName);
    form.append('name', m.name);
    form.append('symbol', m.symbol);
    form.append('description', m.description ?? '');
    form.append('showName', 'true');
    if (m.twitter) form.append('twitter', m.twitter);
    if (m.telegram) form.append('telegram', m.telegram);
    if (m.website) form.append('website', m.website);
    // optional run record: forwarded by the API into the pinned metadata JSON
    if (m.backup) form.append('backup', m.backup);
    const r = await this.call<{ metadataUri: string }>('/api/ipfs', { method: 'POST', body: form });
    return r.metadataUri;
  }
}

/** The client with the current settings (settings.json over backend/.env). Cheap: build one per request. */
export function trenchy(): Trenchy {
  const { apiUrl, apiKey } = effectiveSettings();
  return new Trenchy(apiUrl, apiKey);
}
