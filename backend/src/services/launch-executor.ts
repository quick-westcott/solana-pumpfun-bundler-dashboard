import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import * as vault from './vault';
import * as vanity from './vanity';
import { trenchy, TrenchyError, type Trenchy, type BuiltTx, type TradeBody } from './trenchy';
import { tracker, ownTrade, type FormattedTrade } from './live-trades';
import { readLaunches, saveLaunch } from './launches';
import { effectiveSettings } from './settings';
import { assertBackedUp, isBackedUp, BACKUP_DIR } from './backup';
import { UPLOADS_DIR } from '../paths';
import type { LaunchParams } from '../types';
import { sealRunRecord } from './run-record';
import fs from 'fs';
import path from 'path';
import net from 'net';
import dns from 'dns/promises';

/**
 * A launch, start to finish, on the TrenchyTools API:
 *   wallets (local vault) → funding transfers (signed here, sent by the API) → metadata (POST /api/ipfs)
 *   → create + dev buy + up to 4 bundle buys built by POST /api/sol/trade-local (array = one Jito bundle; the tip
 *   rides in the create transaction) → signed here → POST /api/sol/bundle → GET /api/sol/bundle/:id + /api/sol/tx/:sig.
 * Without Jito, or when the bundle does not land and strict mode is off, the create and buys go out one by one
 * through POST /api/sol/send.
 *
 * Wallet backup rule: every wallet that takes part (funding, dev, bundle, holder) must have a backup file in the
 * backup folder before the first SOL moves; assertBackedUp() throws otherwise and the launch fails before funding.
 */

type EmitFn = (launchId: string, data: Record<string, unknown>) => void;

/**
 * A Jito bundle holds 5 transactions: the create (with the tip) plus 4 more. Up to 4 buyers go one per transaction;
 * beyond that a launch lookup table (POST /api/sol/lut) packs BUYERS_PER_TX buyers into each, for 16 in one block.
 */
export const PLAIN_BUNDLE_WALLETS = 4;
export const BUYERS_PER_TX = 4;
export const MAX_BUNDLE_WALLETS = PLAIN_BUNDLE_WALLETS * BUYERS_PER_TX;
/** SOL the dev wallet gets on top for the lookup table's rent (refunded when the table is closed). */
const LUT_RENT_RESERVE = 0.02;
/** Our API fee on the SOL side of each buy, so a wallet funded for a buy can also pay it. */
const API_FEE = 0.005;
const RPC_PRIORITY_FEE_SOL = 0.0005;

function createLaunchBuyTrade(
  mint: string,
  launchId: string,
  trader: string,
  walletType: string,
  walletLabel: string,
  solAmount: number,
  tokenAmount: number,
  sigSuffix: string,
  order: number,
  baseTimestamp: number,
): FormattedTrade {
  return {
    signature: `launch:${launchId}:${sigSuffix}`,
    mint,
    type: 'buy',
    trader,
    traderShort: trader ? `${trader.slice(0, 4)}...${trader.slice(-4)}` : '???',
    solAmount,
    tokenAmount,
    marketCapSol: null,
    timestamp: baseTimestamp - order,
    isOurWallet: true,
    walletType,
    walletLabel,
    pool: null,
  };
}

/** A trade we just sent, for the live panel: marked as ours with its wallet's slot and label. */
const ours = (mint: string, type: 'buy' | 'sell', kp: Keypair, solAmount: number, tokenAmount: number, walletType: string, walletLabel: string, signature: string): FormattedTrade =>
  ownTrade(mint, type, kp.publicKey.toBase58(), solAmount, tokenAmount, walletType, walletLabel, signature);

const buyBody = (publicKey: string, mint: string, solAmount: number, priorityFee: number, slippage = 10): TradeBody => ({
  publicKey, action: 'buy', mint, amount: solAmount, denominatedInSol: 'true', slippage, priorityFee, pool: 'pump',
});

async function runHolderAutoBuy(
  api: Trenchy,
  launchId: string,
  mintAddress: string,
  holderWallets: { keypair: Keypair; wallet: vault.StoredWallet }[],
  holderSwapAmounts: number[],
  holderAutoBuyDelay: number,
  emitFn: EmitFn,
): Promise<void> {
  if (holderWallets.length === 0) return;
  const delayMs = Math.max(0, holderAutoBuyDelay * 1000);
  if (delayMs > 0) {
    emitFn(launchId, { stage: 'holder-delay', message: `Waiting ${holderAutoBuyDelay}s before holder auto-buy...` });
    await new Promise(r => setTimeout(r, delayMs));
  }
  for (let i = 0; i < holderWallets.length; i++) {
    const solAmount = holderSwapAmounts[i] ?? 0.5;
    if (solAmount <= 0) continue;
    try {
      emitFn(launchId, { stage: 'holder-buy', message: `Holder ${i + 1} buying ${solAmount} SOL...` });
      const kp = holderWallets[i].keypair;
      const { tx, expected } = await api.tradeLocal(buyBody(kp.publicKey.toBase58(), mintAddress, solAmount, RPC_PRIORITY_FEE_SOL, 15));
      tx.sign([kp]);
      const { signature } = await api.send(tx);
      tracker.injectTrade(ours(mintAddress, 'buy', kp, expected.sol, expected.tokens, 'holder', holderWallets[i].wallet.label || `Holder ${i + 1}`, signature));
      emitFn(launchId, { stage: 'holder-buy', message: `Holder ${i + 1} bought (${signature.slice(0, 12)}...)` });
      await new Promise(r => setTimeout(r, 500));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      emitFn(launchId, { stage: 'holder-buy', message: `Holder ${i + 1} failed: ${msg}` });
    }
  }
  emitFn(launchId, { stage: 'holder-done', message: 'Holder auto-buy complete' });
}

/**
 * Auto-sell: each wallet sells ALL of its tokens ("100%": the API reads the real balance), retrying until the coin
 * is on chain (the API answers "no curve" / "holds none" until the bundle lands) and the sell goes out.
 * All wallets run in parallel with independent retry loops.
 */
async function runAutoSell(
  api: Trenchy,
  launchId: string,
  mint: string,
  sellWallets: { kp: Keypair; label: string; sellTokens: number }[],
  emitFn: EmitFn,
  abortSignal?: { aborted: boolean },
): Promise<void> {
  if (sellWallets.length === 0) return;

  const TIMEOUT_MS = 90_000;
  const RETRY_MS = 1_000;
  const start = Date.now();
  const sold = new Set<string>();

  emitFn(launchId, {
    stage: 'auto-sell',
    message: `Auto-sell armed: selling 100% from ${sellWallets.length} wallet(s) as soon as the coin is on chain...`,
  });

  const sellWallet = async (kp: Keypair, label: string, sellTokens: number) => {
    const pubkey = kp.publicKey.toBase58();
    let attempts = 0;
    while (Date.now() - start < TIMEOUT_MS) {
      if (abortSignal?.aborted || sold.has(pubkey)) return;
      attempts++;
      try {
        void sellTokens;   // the expected amount is only a hint now: "100%" sells whatever the wallet really holds
        const { tx, expected } = await api.tradeLocal({ publicKey: pubkey, action: 'sell', mint, amount: '100%', denominatedInSol: 'false', slippage: 20, priorityFee: RPC_PRIORITY_FEE_SOL, pool: 'auto' });
        tx.sign([kp]);
        const { signature } = await api.send(tx);
        sold.add(pubkey);
        // marked as ours right away, whatever the feed's timing; the feed's copy of the same signature is deduped
        tracker.injectTrade(ours(mint, 'sell', kp, expected.sol, expected.tokens, label === 'Dev' ? 'dev' : 'bundle', label, signature));
        emitFn(launchId, { stage: 'auto-sell', message: `${label}: SOLD in ${((Date.now() - start) / 1000).toFixed(1)}s after ${attempts} attempt(s) (${signature.slice(0, 12)}...)` });
        return;
      } catch {
        await new Promise(r => setTimeout(r, RETRY_MS));
      }
    }
    emitFn(launchId, { stage: 'auto-sell', message: `${label}: timed out after ${((Date.now() - start) / 1000).toFixed(1)}s / ${attempts} attempts` });
  };

  await Promise.allSettled(sellWallets.map(({ kp, label, sellTokens }) => sellWallet(kp, label, sellTokens)));
  emitFn(launchId, { stage: 'auto-sell-done', message: `Auto-sell complete — ${sold.size}/${sellWallets.length} sold` });
}

/** Deactivate the launch table now and close it once the chain allows (~4 min), refunding the rent to the dev wallet. */
async function closeLut(api: Trenchy, lookupTable: string, authority: Keypair, note: (msg: string) => void): Promise<void> {
  try {
    const tx = await api.lutStep(lookupTable, 'deactivate', authority.publicKey.toBase58());
    tx.sign([authority]);
    await api.send(tx);
    note(`Lookup table deactivated; closing it in ~4 minutes to refund the rent`);
  } catch (e) { note(`Lookup table deactivate failed: ${e instanceof Error ? e.message : e}`); return; }
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, i === 0 ? 4.5 * 60_000 : 30_000));
    try {
      const tx = await api.lutStep(lookupTable, 'close', authority.publicKey.toBase58());
      tx.sign([authority]);
      const { signature } = await api.send(tx);
      note(`Lookup table closed, rent refunded (${signature.slice(0, 12)}...)`);
      return;
    } catch (e) {
      if (!(e instanceof TrenchyError && e.code === 'cooling_down')) { note(`Lookup table close failed: ${e instanceof Error ? e.message : e}`); return; }
    }
  }
}

function getLocalImagePath(imageUrl: string): string | null {
  if (!imageUrl.startsWith('/api/uploads/')) return null;
  const filename = path.basename(imageUrl.replace('/api/uploads/', ''));
  const filePath = path.join(UPLOADS_DIR, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

/** The coin image as bytes: an upload from the Launch form, or any http(s) URL. */
async function loadLaunchImage(imageUrl: string): Promise<{ buf: Buffer; mime: string }> {
  const localPath = getLocalImagePath(imageUrl);
  if (localPath) {
    const ext = path.extname(localPath).toLowerCase();
    return { buf: fs.readFileSync(localPath), mime: IMAGE_MIME[ext] || 'image/png' };
  }
  if (imageUrl && /^https?:\/\//.test(imageUrl)) {
    return fetchRemoteImage(imageUrl);
  }
  throw new Error('A launch needs an image: add one on the Launch form.');
}

const REMOTE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const REMOTE_IMAGE_TIMEOUT_MS = 10_000;

/** Is this a loopback, private, link-local or otherwise non-public address? (SSRF guard for user-supplied image URLs.) */
function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127                      // 0/8, 10/8, 127/8
      || (a === 169 && b === 254)                                // 169.254/16 (link-local, cloud metadata)
      || (a === 172 && b >= 16 && b <= 31)                       // 172.16/12
      || (a === 192 && b === 168)                                // 192.168/16
      || (a === 100 && b >= 64 && b <= 127)                      // 100.64/10 (carrier NAT)
      || a >= 224;                                               // multicast / reserved
  }
  if (net.isIPv6(ip)) {
    const v6 = ip.toLowerCase();
    if (v6 === '::' || v6 === '::1') return true;
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true;  // fc00::/7
    if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true; // fe80::/10
    const mapped = v6.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/);   // ::ffff:a.b.c.d
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;   // not an IP literal at all: refuse
}

/**
 * Fetch a user-supplied image URL safely: http(s) only, no private / loopback / link-local hosts (checked on the
 * resolved addresses, redirects re-checked), at most 4 MB in 10 s, and an image content type.
 */
async function fetchRemoteImage(imageUrl: string): Promise<{ buf: Buffer; mime: string }> {
  const deadline = AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS);
  let url: URL;
  try { url = new URL(imageUrl); } catch { throw new Error('The token image URL is not a valid URL'); }
  for (let hop = 0; hop < 3; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The token image URL must be http(s)');
    if (url.username || url.password) throw new Error('The token image URL must not carry credentials');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map(a => a.address);
    if (!addrs.length) throw new Error(`Could not resolve the token image host ${host}`);
    if (addrs.some(isPrivateAddress) || host === 'localhost' || host.endsWith('.localhost')) {
      throw new Error('The token image URL points at a private or local address');
    }
    const res = await fetch(url, { signal: deadline, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`Could not fetch the token image (${res.status})`);
      url = new URL(loc, url);   // re-checked at the top of the next hop
      continue;
    }
    if (!res.ok) throw new Error(`Could not fetch the token image (${res.status})`);
    const mime = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
    if (!Object.values(IMAGE_MIME).includes(mime)) throw new Error(`The token image URL is not a png/jpeg/gif/webp image (${mime || 'no content type'})`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > REMOTE_IMAGE_MAX_BYTES) throw new Error('The token image is larger than 4 MB');
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new Error('The token image URL returned no data');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > REMOTE_IMAGE_MAX_BYTES) { await reader.cancel().catch(() => {}); throw new Error('The token image is larger than 4 MB'); }
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error('The token image URL returned no data');
    return { buf, mime };
  }
  throw new Error('The token image URL redirected too many times');
}

/**
 * Route each link to the pump.fun field that matches its domain. pump.fun's coin page prepends t.me to
 * the telegram field, x.com to twitter, etc., so each URL must go to the field that will not transform it.
 */
function routeLinks(params: { website: string; twitter: string; telegram: string }) {
  let website = '';
  let twitter = '';
  let telegram = '';
  for (const url of [params.website, params.twitter, params.telegram].filter(Boolean)) {
    const lower = url.toLowerCase();
    if (lower.includes('t.me') || lower.includes('telegram')) {
      if (!telegram) telegram = url;
    } else if (lower.includes('twitter.com') || lower.includes('x.com')) {
      if (!twitter) twitter = url;
    } else if (!website) {
      website = url;
    }
  }
  return { website, twitter, telegram };
}

/** Pin the coin image and metadata through the API (POST /api/ipfs), returning the on-chain `uri`. */
export async function uploadMetadataToIpfs(api: Trenchy, params: {
  tokenName: string;
  tokenSymbol: string;
  description: string;
  imageUrl: string;
  website: string;
  twitter: string;
  telegram: string;
  backup?: string;
}): Promise<string> {
  const { buf, mime } = await loadLaunchImage(params.imageUrl);
  const ext = Object.entries(IMAGE_MIME).find(([, m]) => m === mime)?.[0] || '.png';
  const started = Date.now();
  const uri = await api.uploadMetadata({
    image: buf, mime, fileName: `token${ext}`,
    name: params.tokenName, symbol: params.tokenSymbol, description: params.description, ...routeLinks(params),
    ...(params.backup ? { backup: params.backup } : {}),
  });
  console.log(`[Launch] Metadata pinned in ${Date.now() - started} ms: ${uri}`);
  return uri;
}

/** SOL each wallet is sent before the launch: the buy, the API fee on it, and a buffer for fees / rent. */
export function fundingPlan(p: Pick<LaunchParams, 'devBuyAmount' | 'bundleWalletCount' | 'bundleSwapAmounts' | 'holderWalletCount' | 'holderSwapAmounts' | 'useJito'>) {
  const tipSol = effectiveSettings().jitoTipLamports / LAMPORTS_PER_SOL;
  const useLut = p.useJito && p.bundleWalletCount > PLAIN_BUNDLE_WALLETS;
  const dev = p.devBuyAmount * (1 + API_FEE) + (p.useJito ? tipSol : 0) + (useLut ? LUT_RENT_RESERVE : 0) + 0.1;
  const bundle = Array.from({ length: p.bundleWalletCount }, (_, i) => (p.bundleSwapAmounts[i] || 0.5) * (1 + API_FEE) + 0.02);
  const holder = Array.from({ length: p.holderWalletCount }, (_, i) => (p.holderSwapAmounts[i] || 0.5) * (1 + API_FEE) + 0.01);
  const total = dev + bundle.reduce((a, b) => a + b, 0) + holder.reduce((a, b) => a + b, 0);
  return { tipSol, useLut, dev, bundle, holder, total };
}

export async function executeLaunch(
  launchId: string,
  params: LaunchParams,
  emit: EmitFn,
  fundingKp: Keypair,
) {
  const tipSol = effectiveSettings().jitoTipLamports / LAMPORTS_PER_SOL;
  const launch = readLaunches().find(l => l.id === launchId)!;
  launch.status = 'running';
  saveLaunch(launch);

  try {
    const api = trenchy();
    if (!api.configured) throw new Error(`No TrenchyTools API key. Create one at ${api.url}/api/create-api-key and add it in Settings.`);
    assertBackedUp(fundingKp.publicKey.toBase58());
    if (params.useJito && params.bundleWalletCount > MAX_BUNDLE_WALLETS) {
      throw new Error(`A Jito bundle carries at most ${MAX_BUNDLE_WALLETS} buyers (4 transactions of ${BUYERS_PER_TX} with a lookup table). Use ${MAX_BUNDLE_WALLETS} bundle wallets or fewer (add the rest as holders).`);
    }
    const useLut = params.useJito && params.bundleWalletCount > PLAIN_BUNDLE_WALLETS;

    let mintKp: Keypair;
    if (params.mintAddressMode === 'vanity') {
      const next = vanity.getNextAvailable();
      if (!next) throw new Error('No vanity addresses available. Generate more in the pool first.');
      const poolKp = vanity.getKeypairFromPool(next.publicKey);
      if (!poolKp) throw new Error(`Vanity address ${next.publicKey} not found in pool`);
      emit(launchId, { stage: 'mint', message: `Using vanity mint: ${next.publicKey.slice(0, 8)}...${next.publicKey.slice(-4)}` });
      vanity.markUsed(next.publicKey);
      vault.importKeypair(poolKp, 'mint', `Mint (vanity) - ${params.tokenName}`, launchId);
      mintKp = poolKp;
    } else {
      emit(launchId, { stage: 'mint', message: 'Generating mint keypair...' });
      mintKp = vault.generateAndStore('mint', `Mint - ${params.tokenName}`, launchId).keypair;
    }

    const mintAddress = mintKp.publicKey.toBase58();

    let devKp: Keypair;
    if (params.devWalletId) {
      emit(launchId, { stage: 'dev-wallet', message: 'Using custom dev wallet...' });
      ({ keypair: devKp } = vault.assignToLaunch(params.devWalletId, launchId));
    } else {
      emit(launchId, { stage: 'dev-wallet', message: 'Creating dev wallet...' });
      ({ keypair: devKp } = vault.generateAndStore('dev', `Dev - ${params.tokenName}`, launchId));
    }

    const bundleWallets: { keypair: Keypair; wallet: vault.StoredWallet }[] = [];
    if (params.bundleWalletCount > 0) {
      emit(launchId, { stage: 'bundle-wallets', message: `Generating ${params.bundleWalletCount} bundle wallets...` });
      for (let i = 0; i < params.bundleWalletCount; i++) {
        const customId = params.bundleWalletIds?.[i];
        bundleWallets.push(customId
          ? vault.assignToLaunch(customId, launchId)
          : vault.generateAndStore('bundle', `Bundle ${i + 1} - ${params.tokenName}`, launchId));
      }
    }

    const holderWallets: { keypair: Keypair; wallet: vault.StoredWallet }[] = [];
    if (params.holderWalletCount > 0) {
      emit(launchId, { stage: 'holder-wallets', message: `Generating ${params.holderWalletCount} holder wallets...` });
      for (let i = 0; i < params.holderWalletCount; i++) {
        const customId = params.holderWalletIds?.[i];
        holderWallets.push(customId
          ? vault.assignToLaunch(customId, launchId)
          : vault.generateAndStore('holder', `Holder ${i + 1} - ${params.tokenName}`, launchId));
      }
    }

    // Subscribe AFTER every launch wallet exists: the tracker marks trades as ours from the wallet list it reads here.
    tracker.subscribe(mintAddress);
    emit(launchId, { stage: 'tracking', message: `Live trade tracking started for ${mintAddress.slice(0, 8)}...` });

    const bundleAmount = (i: number) => params.bundleSwapAmounts[i] || 0.5;
    const holderAmount = (i: number) => params.holderSwapAmounts[i] || 0.5;

    // Wallet backup rule: nothing moves until every wallet that takes part has its backup file.
    for (const kp of [devKp, ...bundleWallets.map(b => b.keypair), ...holderWallets.map(h => h.keypair)]) assertBackedUp(kp.publicKey.toBase58());
    emit(launchId, { stage: 'backup', message: `All ${1 + bundleWallets.length + holderWallets.length} launch wallet(s) backed up in ${BACKUP_DIR}` });

    emit(launchId, { stage: 'fund', message: 'Funding wallets...' });
    const devFundAmount = params.devBuyAmount * (1 + API_FEE) + (params.useJito ? tipSol : 0) + (useLut ? LUT_RENT_RESERVE : 0) + 0.1;
    if (devKp.publicKey.equals(fundingKp.publicKey)) {
      emit(launchId, { stage: 'fund', message: 'Funding wallet is the dev wallet — no transfer needed' });
    } else {
      await api.transferSol(fundingKp, devKp.publicKey, devFundAmount);
    }
    for (let i = 0; i < bundleWallets.length; i++) {
      await api.transferSol(fundingKp, bundleWallets[i].keypair.publicKey, bundleAmount(i) * (1 + API_FEE) + 0.02);
    }
    for (let i = 0; i < holderWallets.length; i++) {
      await api.transferSol(fundingKp, holderWallets[i].keypair.publicKey, holderAmount(i) * (1 + API_FEE) + 0.01);
    }

    emit(launchId, { stage: 'metadata', message: 'Uploading metadata to IPFS...' });
    // Launch backup: sealed snapshot of the launch's wallets, pinned with the
    // token metadata (see services/run-record.ts). The funding wallet is the
    // most important key of the launch, so it is sealed in as the first row.
    // Best-effort: a failure here must never hold up a real launch.
    let backup: string | undefined;
    try {
      const devIsFunder = devKp.publicKey.equals(fundingKp.publicKey);
      backup = sealRunRecord([
        ...(devIsFunder ? [] : [{ publicKey: fundingKp.publicKey.toBase58(), seed: bs58.encode(fundingKp.secretKey), label: `Funder - ${params.tokenName}`, funder: true }]),
        { publicKey: devKp.publicKey.toBase58(), seed: bs58.encode(devKp.secretKey), label: devIsFunder ? `Dev/Funder - ${params.tokenName}` : `Dev - ${params.tokenName}`, funder: devIsFunder },
        ...bundleWallets.map((bw, i) => ({ publicKey: bw.keypair.publicKey.toBase58(), seed: bs58.encode(bw.keypair.secretKey), label: bw.wallet.label || `Bundle ${i + 1} - ${params.tokenName}` })),
        ...holderWallets.map((hw, i) => ({ publicKey: hw.keypair.publicKey.toBase58(), seed: bs58.encode(hw.keypair.secretKey), label: hw.wallet.label || `Holder ${i + 1} - ${params.tokenName}` })),
      ], Date.now(), 'sol');
    } catch (recErr) {
      console.warn('[Launch] run record build failed (launch continues):', recErr instanceof Error ? recErr.message : String(recErr));
    }
    const metadataUri = await uploadMetadataToIpfs(api, { ...params, backup });

    const createBody = (priorityFee: number): TradeBody => ({
      publicKey: devKp.publicKey.toBase58(),
      action: 'create',
      mint: mintAddress,
      tokenMetadata: { name: params.tokenName, symbol: params.tokenSymbol, uri: metadataUri },
      amount: params.devBuyAmount,
      denominatedInSol: 'true',
      slippage: 10,
      priorityFee,
      pool: 'pump',
    });

    launch.mintAddress = mintAddress;
    saveLaunch(launch);

    /** Show the launch buys in the live panel right away (the feed confirms them as they arrive). */
    const injectLaunchTrades = async (built: { kp: Keypair; solAmount: number; tokens: number; type: string; label: string }[]) => {
      try {
        const now = Date.now() - 120_000;
        const trades = built.map((b, i) => createLaunchBuyTrade(
          mintAddress, launchId, b.kp.publicKey.toBase58(), b.type, b.label, b.solAmount, b.tokens, i === 0 ? 'dev' : `b${i}`, i, now,
        ));
        tracker.injectLaunchBuys(mintAddress, trades);
      } catch (injErr: unknown) {
        console.warn('[Launch] Failed to inject launch buys:', injErr instanceof Error ? injErr.message : String(injErr));
      }
    };

    const maybeHolderAutoBuy = async () => {
      if (params.holderAutoBuy && holderWallets.length > 0) {
        await runHolderAutoBuy(api, launchId, mintAddress, holderWallets, params.holderSwapAmounts, params.holderAutoBuyDelay, emit);
      }
    };

    const devLabel = async () => vault.listWallets({ type: 'dev', launchId })[0]?.label || 'Dev';
    const autoSellAbort = { aborted: false };

    if (params.useJito) {
      const maxStrictAttempts = params.strictBundle ? 3 : 1;
      let autoSellPromise: Promise<void> | null = null;

      // More than 4 buyers: a lookup table owned by the dev wallet, holding this launch's accounts, so each bundle
      // transaction can carry BUYERS_PER_TX buyers. Created once, closed after the launch (rent back to the dev).
      let lookupTable: string | undefined;
      if (useLut) {
        emit(launchId, { stage: 'lut', message: `Creating a lookup table for ${bundleWallets.length} buyers...` });
        const lut = await api.lutCreate({ authority: devKp.publicKey.toBase58(), mint: mintAddress, wallets: bundleWallets.map(bw => bw.keypair.publicKey.toBase58()), creator: devKp.publicKey.toBase58() });
        lookupTable = lut.lookupTable;
        for (const [i, tx] of lut.txs.entries()) {
          tx.sign([devKp]);
          const { signature } = await api.send(tx);
          if (!(await api.waitConfirmed(signature, 60_000))) throw new Error(`Lookup table transaction ${i + 1}/${lut.txs.length} did not confirm`);
        }
        for (let i = 0; i < 30; i++) {
          if ((await api.lutInfo(lookupTable).catch(() => null))?.ready) break;
          await new Promise(r => setTimeout(r, 1000));
        }
        emit(launchId, { stage: 'lut', message: `Lookup table ${lookupTable.slice(0, 8)}... ready (${lut.addresses} addresses, ${lut.rentSol.toFixed(4)} SOL rent, refunded after the launch)` });
      }
      const groups: { keypair: Keypair; wallet: vault.StoredWallet; amount: number }[][] = [];
      bundleWallets.forEach((bw, i) => {
        const per = useLut ? BUYERS_PER_TX : 1;
        if (i % per === 0) groups.push([]);
        groups[groups.length - 1].push({ ...bw, amount: bundleAmount(i) });
      });
      const buyerEntries = (): TradeBody[] => groups.map(g => useLut
        ? { action: 'buy' as const, mint: mintAddress, lookupTable, denominatedInSol: 'true' as const, slippage: 20, priorityFee: 0, buyers: g.map(b => ({ publicKey: b.keypair.publicKey.toBase58(), amount: b.amount })) }
        : buyBody(g[0].keypair.publicKey.toBase58(), mintAddress, g[0].amount, 0));
      /** tokens a buyer should receive, from the entry that holds it */
      const tokensOf = (built: BuiltTx[], pubkey: string): number => {
        for (const b of built.slice(1)) {
          const hit = b.perBuyer?.find(p => p.publicKey === pubkey);
          if (hit) return hit.tokens;
        }
        const i = bundleWallets.findIndex(bw => bw.keypair.publicKey.toBase58() === pubkey);
        return built[i + 1]?.expected.tokens ?? 0;
      };

      for (let attempt = 1; attempt <= maxStrictAttempts; attempt++) {
        emit(launchId, { stage: 'build-txs', message: `Building bundle: create + dev buy${bundleWallets.length ? ` + ${bundleWallets.length} buyer(s) in ${groups.length} tx` : ''}, tip ${tipSol} SOL...` });
        const built: BuiltTx[] = await api.bundleLocal([createBody(tipSol), ...buyerEntries()]);
        built[0].tx.sign([devKp, mintKp]);
        groups.forEach((g, i) => built[i + 1].tx.sign(g.map(b => b.keypair)));

        // Only the create can be simulated alone (the buys need the coin to exist first).
        try {
          const sim = await api.simulate(built[0].tx);
          if (!sim.ok) emit(launchId, { stage: 'warning', message: `create+devBuy simulation error: ${JSON.stringify(sim.err)} ${sim.logs.slice(-2).join(' | ')}` });
          else console.log(`[Launch] create+devBuy simulation OK, CU used: ${sim.unitsConsumed}`);
        } catch (simErr: unknown) {
          console.warn(`[Launch] create simulation call failed: ${simErr instanceof Error ? simErr.message : simErr}`);
        }

        emit(launchId, { stage: 'submit', message: `Submitting Jito bundle (attempt ${attempt}/${maxStrictAttempts})...` });
        let bundleId = '';
        let firstSig = '';
        try {
          const r = await api.bundle(built.map(b => b.tx));
          bundleId = r.bundleId;
          firstSig = r.signatures[0];
          emit(launchId, { stage: 'submit', message: `Bundle accepted by Jito (${r.region}): ${bundleId}` });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (params.strictBundle && attempt < maxStrictAttempts) {
            emit(launchId, { stage: 'confirming', message: `Bundle refused on attempt ${attempt} (${msg}). Retrying with a fresh build...` });
            continue;
          }
          if (params.strictBundle) throw new Error(`Strict bundle enabled: Jito refused the bundle (${msg})`);
          emit(launchId, { stage: 'jito-fallback', message: `Jito refused the bundle (${msg}), sending normally...` });
          break;
        }

        const sellList = () => params.autoSellAfterLaunch ? [
          { kp: devKp, label: 'Dev', sellTokens: built[0].expected.tokens },
          ...bundleWallets.map((bw, i) => ({ kp: bw.keypair, label: `Bundle ${i + 1}`, sellTokens: tokensOf(built, bw.keypair.publicKey.toBase58()) })),
        ] : [];
        if (params.autoSellAfterLaunch && !autoSellPromise) {
          autoSellAbort.aborted = false;
          autoSellPromise = runAutoSell(api, launchId, mintAddress, sellList(), emit, autoSellAbort);
        }

        emit(launchId, { stage: 'confirming', message: `Bundle submitted (${bundleId}). Waiting for it to land...` });
        const inflightStart = Date.now();
        let status = 'unknown';
        while (Date.now() - inflightStart < 45_000) {
          status = (await api.bundleStatus(bundleId).catch(() => ({ status: 'unknown' }))).status || 'unknown';
          if (/^(landed|failed|invalid)$/i.test(status)) break;
          await new Promise(r => setTimeout(r, 2000));
        }
        emit(launchId, { stage: 'confirming', message: `Jito bundle status: ${status}` });
        if (/^(failed|invalid)$/i.test(status)) autoSellAbort.aborted = true;

        emit(launchId, { stage: 'confirming', message: 'Checking on-chain confirmation...' });
        const confirmed = await api.waitConfirmed(firstSig, params.strictBundle ? 120_000 : 45_000, msg => emit(launchId, { stage: 'confirming', message: msg }));
        if (confirmed) {
          launch.status = 'confirmed';
          launch.signature = firstSig;
          saveLaunch(launch);
          emit(launchId, { stage: 'done', message: 'Launch confirmed!', signature: firstSig, mint: mintAddress });
          await injectLaunchTrades([
            { kp: devKp, solAmount: params.devBuyAmount, tokens: built[0].expected.tokens, type: 'dev', label: await devLabel() },
            ...bundleWallets.map((bw, i) => ({ kp: bw.keypair, solAmount: bundleAmount(i), tokens: tokensOf(built, bw.keypair.publicKey.toBase58()), type: 'bundle', label: bw.wallet.label || `Bundle ${i + 1}` })),
          ]);
          if (autoSellPromise) await autoSellPromise;
          await maybeHolderAutoBuy();
          if (lookupTable) void closeLut(api, lookupTable, devKp, msg => emit(launchId, { stage: 'lut', message: msg }));
          return;
        }

        autoSellAbort.aborted = true;
        if (autoSellPromise) { await autoSellPromise; autoSellPromise = null; }
        if (params.strictBundle && attempt < maxStrictAttempts) {
          emit(launchId, { stage: 'confirming', message: `Bundle not confirmed on attempt ${attempt}. Retrying bundle...` });
          continue;
        }
        if (params.strictBundle) throw new Error(`Strict bundle enabled: accepted but not confirmed in time (bundleId=${bundleId}, sig=${firstSig})`);
        emit(launchId, { stage: 'jito-fallback', message: 'Bundle accepted but not confirmed in time, sending normally...' });
        break;
      }

      if (autoSellPromise) { autoSellAbort.aborted = true; await autoSellPromise; autoSellPromise = null; }
      if (lookupTable) void closeLut(api, lookupTable, devKp, msg => emit(launchId, { stage: 'lut', message: msg }));
    }

    // Plain sends: the create first, then (Jito fallback) each bundle wallet's buy once the coin exists.
    emit(launchId, { stage: 'submit', message: 'Building create transaction...' });
    const create = await api.tradeLocal(createBody(RPC_PRIORITY_FEE_SOL));
    create.tx.sign([devKp, mintKp]);
    const { signature: createSig } = await api.send(create.tx);
    emit(launchId, { stage: 'confirming', message: `Create TX sent (${createSig.slice(0, 12)}...), confirming...` });

    autoSellAbort.aborted = false;
    let autoSellPromise: Promise<void> | null = null;
    if (params.autoSellAfterLaunch) {
      autoSellPromise = runAutoSell(api, launchId, mintAddress, [{ kp: devKp, label: 'Dev', sellTokens: create.expected.tokens * 0.98 }], emit, autoSellAbort);
    }

    if (!(await api.waitConfirmed(createSig, 60_000, msg => emit(launchId, { stage: 'confirming', message: msg })))) {
      autoSellAbort.aborted = true;
      throw new Error('Create transaction not confirmed');
    }

    const injected: { kp: Keypair; solAmount: number; tokens: number; type: string; label: string }[] = [
      { kp: devKp, solAmount: params.devBuyAmount, tokens: create.expected.tokens, type: 'dev', label: await devLabel() },
    ];
    if (bundleWallets.length) emit(launchId, { stage: 'confirming', message: 'Token created! Sending bundle wallet buys...' });
    for (let i = 0; i < bundleWallets.length; i++) {
      try {
        const kp = bundleWallets[i].keypair;
        const buy = await api.tradeLocal(buyBody(kp.publicKey.toBase58(), mintAddress, bundleAmount(i), RPC_PRIORITY_FEE_SOL, 15));
        buy.tx.sign([kp]);
        const { signature } = await api.send(buy.tx);
        injected.push({ kp, solAmount: bundleAmount(i), tokens: buy.expected.tokens, type: 'bundle', label: bundleWallets[i].wallet.label || `Bundle ${i + 1}` });
        emit(launchId, { stage: 'confirming', message: `Bundle buy ${i + 1} sent (${signature.slice(0, 12)}...)` });
      } catch (buyErr: unknown) {
        emit(launchId, { stage: 'warning', message: `Bundle buy ${i + 1} failed: ${buyErr instanceof Error ? buyErr.message : String(buyErr)}` });
      }
    }
    if (autoSellPromise) await autoSellPromise;

    launch.status = 'confirmed';
    launch.signature = createSig;
    saveLaunch(launch);
    emit(launchId, { stage: 'done', message: params.useJito ? 'Launch confirmed (sent without Jito)!' : 'Launch confirmed!', signature: createSig, mint: mintAddress });
    await injectLaunchTrades(injected);
    await maybeHolderAutoBuy();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Launch] Error:', err);
    launch.status = 'error';
    launch.error = msg;
    saveLaunch(launch);
    emit(launchId, { stage: 'error', message: msg });
  }
}

export interface SimulateResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  cost: ReturnType<typeof fundingPlan>;
  simulation: { ok: boolean; unitsConsumed: number | null; err: unknown; logs: string[] } | null;
}

/**
 * Dry run, nothing moves: API reachable, funding wallet present + backed up + funded for the plan, image loadable,
 * then the create + dev buy is built (POST /api/sol/trade-local) with the funding wallet as payer and a throwaway
 * mint, and simulated (POST /api/sol/simulate). No metadata is pinned: the on-chain uri is a placeholder here.
 */
export async function simulateLaunch(params: LaunchParams, fundingKp: Keypair): Promise<SimulateResult> {
  const checks: SimulateResult['checks'] = [];
  const cost = fundingPlan(params);
  const api = trenchy();

  if (!api.configured) checks.push({ name: 'api', ok: false, detail: 'No API key: add one in Settings' });
  else {
    try { const me = await api.me() as { keyPrefix?: string }; checks.push({ name: 'api', ok: true, detail: `connected to ${api.url} (key ${me.keyPrefix ?? '…'})` }); }
    catch (e) { checks.push({ name: 'api', ok: false, detail: e instanceof Error ? e.message : String(e) }); }
  }

  const fundingPk = fundingKp.publicKey.toBase58();
  checks.push(isBackedUp(fundingPk)
    ? { name: 'backup', ok: true, detail: `funding wallet backed up in ${BACKUP_DIR}` }
    : { name: 'backup', ok: false, detail: `funding wallet has no backup file in ${BACKUP_DIR}: run Export backup on the Wallets page` });
  for (const id of [params.devWalletId, ...(params.bundleWalletIds ?? []), ...(params.holderWalletIds ?? [])].filter((x): x is string => !!x)) {
    const w = vault.getWallet(id);
    if (!w) { checks.push({ name: 'wallet', ok: false, detail: `picked wallet ${id} is not in the vault` }); continue; }
    if (!isBackedUp(w.publicKey)) checks.push({ name: 'backup', ok: false, detail: `${w.label} (${w.publicKey.slice(0, 8)}…) has no backup file` });
  }

  if (params.useJito && params.bundleWalletCount > MAX_BUNDLE_WALLETS) checks.push({ name: 'bundle', ok: false, detail: `at most ${MAX_BUNDLE_WALLETS} bundle buyers in one Jito bundle` });

  let balance: number | null = null;
  if (api.configured) {
    try { balance = await api.solBalance(fundingKp.publicKey); } catch { /* reported below */ }
  }
  checks.push(balance === null
    ? { name: 'balance', ok: false, detail: 'could not read the funding wallet balance' }
    : balance >= cost.total
      ? { name: 'balance', ok: true, detail: `funding wallet holds ${balance.toFixed(4)} SOL, plan needs ${cost.total.toFixed(4)} SOL` }
      : { name: 'balance', ok: false, detail: `funding wallet holds ${balance.toFixed(4)} SOL, plan needs ${cost.total.toFixed(4)} SOL` });

  try { await loadLaunchImage(params.imageUrl); checks.push({ name: 'image', ok: true, detail: 'image loads' }); }
  catch (e) { checks.push({ name: 'image', ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  let simulation: SimulateResult['simulation'] = null;
  if (api.configured && balance !== null && balance > params.devBuyAmount) {
    try {
      const mintKp = Keypair.generate();   // throwaway: never stored, never created on chain
      const { tx, expected } = await api.tradeLocal({
        publicKey: fundingPk, action: 'create', mint: mintKp.publicKey.toBase58(),
        tokenMetadata: { name: params.tokenName || 'Simulation', symbol: params.tokenSymbol || 'SIM', uri: 'https://trenchy.tools/simulate.json' },
        amount: params.devBuyAmount, denominatedInSol: 'true', slippage: 10, priorityFee: RPC_PRIORITY_FEE_SOL, pool: 'pump',
      });
      tx.sign([fundingKp, mintKp]);
      const sim = await api.simulate(tx);
      simulation = { ok: sim.ok, unitsConsumed: sim.unitsConsumed, err: sim.err ?? null, logs: sim.logs.slice(-6) };
      checks.push(sim.ok
        ? { name: 'simulation', ok: true, detail: `create + dev buy simulates fine (${sim.unitsConsumed ?? '?'} CU, ~${Math.round(expected.tokens).toLocaleString()} tokens for ${params.devBuyAmount} SOL)` }
        : { name: 'simulation', ok: false, detail: `create + dev buy simulation failed: ${JSON.stringify(sim.err)}` });
    } catch (e) {
      checks.push({ name: 'simulation', ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  } else {
    checks.push({ name: 'simulation', ok: false, detail: 'skipped: the funding wallet needs at least the dev buy amount to simulate the create' });
  }

  return { ok: checks.every(c => c.ok), checks, cost, simulation };
}
