/**
 * Live trades for the coin on screen, from the TrenchyTools websocket (wss …/api/sol/data, `subscribeTokenTrade`).
 * One connection; subscriptions are swapped on it. Trades are kept in memory (200 per coin) and persisted to
 * backend/data/live-trades/<mint>.json so a page reload still shows them.
 */
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import * as vault from './vault';
import { trenchy } from './trenchy';
import { LIVE_TRADES_DIR } from '../paths';

const RECONNECT_DELAY = 3000;
const MAX_TRADES = 200;

export interface FormattedTrade {
  signature: string;
  mint: string;
  type: string;
  trader: string;
  traderShort: string;
  solAmount: number;
  tokenAmount: number;
  marketCapSol: number | null;
  timestamp: number;
  isOurWallet: boolean;
  walletType: string | null;
  walletLabel: string | null;
  pool: string | null;
}

type TradeListener = (trade: FormattedTrade) => void;

const tradesFile = (mint: string) => path.join(LIVE_TRADES_DIR, `${mint}.json`);

function loadPersistedTrades(mint: string): FormattedTrade[] {
  const file = tradesFile(mint);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function persistTrades(mint: string, trades: FormattedTrade[]) {
  try {
    fs.mkdirSync(LIVE_TRADES_DIR, { recursive: true });
    fs.writeFileSync(tradesFile(mint), JSON.stringify(trades.slice(0, MAX_TRADES)));
  } catch { /* best effort */ }
}

/** A trade this app just sent, for the panel: marked as ours with its wallet's slot and label. */
export function ownTrade(mint: string, type: 'buy' | 'sell', trader: string, solAmount: number, tokenAmount: number, walletType: string | null, walletLabel: string | null, signature: string): FormattedTrade {
  return { signature, mint, type, trader, traderShort: trader ? `${trader.slice(0, 4)}...${trader.slice(-4)}` : '???', solAmount, tokenAmount, marketCapSol: null, timestamp: Date.now(), isOurWallet: true, walletType, walletLabel, pool: null };
}

class TradeTracker {
  private ws: WebSocket | null = null;
  private subscribedMint: string | null = null;
  private trades: FormattedTrade[] = [];
  private listeners = new Set<TradeListener>();
  private seenSigs = new Set<string>();
  private ourWallets = new Map<string, { type: string; label: string }>();
  private injectedWallets = new Map<string, Set<string>>();
  private alive = false;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private wsUrl: string | null = null;

  private refreshWallets() {
    this.ourWallets.clear();
    try {
      for (const w of vault.listWallets()) this.ourWallets.set(w.publicKey, { type: w.type, label: w.label });
    } catch { /* vault unreadable: trades show as not ours */ }
  }

  private formatTrade(raw: any): { trade: FormattedTrade; replacesInjected: boolean } | null {
    if (!raw.txType || raw.txType === 'create' || raw.txType === 'migrate') return null;
    const sig = raw.signature;
    if (!sig || this.seenSigs.has(sig)) return null;

    const trader = raw.traderPublicKey || '';
    const mint = raw.mint || '';
    let replacesInjected = false;
    if (raw.txType === 'buy') {
      const injectedSet = this.injectedWallets.get(mint);
      if (injectedSet?.has(trader)) {
        replacesInjected = true;
        injectedSet.delete(trader);
        if (injectedSet.size === 0) this.injectedWallets.delete(mint);
      }
    }
    this.seenSigs.add(sig);
    const walletInfo = this.ourWallets.get(trader);
    return {
      trade: {
        signature: sig, mint, type: raw.txType, trader,
        traderShort: trader ? `${trader.slice(0, 4)}...${trader.slice(-4)}` : '???',
        solAmount: raw.solAmount || raw.sol_amount || raw.amount || raw.sol || 0,
        tokenAmount: raw.txType === 'buy' ? (raw.buy || raw.tokenAmount || 0) : (raw.sell || raw.tokenAmount || 0),
        marketCapSol: raw.marketCapSol || null,
        timestamp: raw.timestamp || Date.now(),
        isOurWallet: !!walletInfo,
        walletType: walletInfo?.type || null,
        walletLabel: walletInfo?.label || null,
        pool: raw.pool || null,
      },
      replacesInjected,
    };
  }

  private connect() {
    if (this.ws) { try { this.ws.close(); } catch { /* closing */ } }
    if (!this.wsUrl) { console.warn('[feed] no TrenchyTools API key: live trades off'); return; }
    console.log('[feed] connecting to', this.wsUrl.replace(/api-key=[^&]+/, 'api-key=…'));
    this.ws = new WebSocket(this.wsUrl);
    this.alive = true;

    this.ws.on('open', () => {
      console.log('[feed] connected');
      if (this.subscribedMint) this.sendSubscribe(this.subscribedMint);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!msg.txType) return;
        const result = this.formatTrade(msg);
        if (!result || result.trade.mint !== this.subscribedMint) return;
        const { trade, replacesInjected } = result;
        if (replacesInjected) {
          const idx = this.trades.findIndex(t => t.trader === trade.trader && t.mint === trade.mint && t.type === 'buy' && t.isOurWallet);
          if (idx !== -1) {
            trade.walletType = this.trades[idx].walletType;
            trade.walletLabel = this.trades[idx].walletLabel;
            trade.isOurWallet = true;
            this.trades[idx] = trade;
          } else {
            this.trades.unshift(trade);
          }
        } else {
          this.trades.unshift(trade);
        }
        if (this.trades.length > MAX_TRADES) this.trades.length = MAX_TRADES;
        for (const cb of this.listeners) cb(trade);
      } catch { /* not a trade */ }
    });

    this.ws.on('close', () => {
      console.log('[feed] disconnected');
      if (this.alive && this.subscribedMint) setTimeout(() => this.connect(), RECONNECT_DELAY);
    });
    this.ws.on('error', (err) => console.error('[feed] websocket error:', err.message));
  }

  private sendSubscribe(mint: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
      console.log(`[feed] subscribed to ${mint.slice(0, 8)}...`);
    }
  }

  private sendUnsubscribe(mint: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] }));
  }

  private startPersistTimer() {
    this.stopPersistTimer();
    this.persistTimer = setInterval(() => {
      if (this.subscribedMint && this.trades.length > 0) persistTrades(this.subscribedMint, this.trades);
    }, 10_000);
  }

  private stopPersistTimer() {
    if (this.persistTimer) { clearInterval(this.persistTimer); this.persistTimer = null; }
  }

  /** Follow one coin (the previous one is unsubscribed). Reconnects when the API key or URL changed. */
  subscribe(mint: string) {
    const api = trenchy();
    const url = api.configured ? api.wsUrl() : null;
    if (url !== this.wsUrl) {
      this.wsUrl = url;
      if (this.ws) { try { this.ws.close(); } catch { /* closing */ } this.ws = null; }
    }
    this.refreshWallets();
    if (this.subscribedMint && this.subscribedMint !== mint) {
      if (this.trades.length > 0) persistTrades(this.subscribedMint, this.trades);
      this.injectedWallets.delete(this.subscribedMint);
      this.sendUnsubscribe(this.subscribedMint);
    }
    this.subscribedMint = mint;

    // Persisted trades for this mint merged with any in memory.
    const persisted = loadPersistedTrades(mint);
    const merged = [...this.trades.filter(t => t.mint === mint)];
    const sigs = new Set(merged.map(t => t.signature));
    for (const t of persisted) if (!sigs.has(t.signature)) { merged.push(t); sigs.add(t.signature); }
    merged.sort((a, b) => b.timestamp - a.timestamp);
    this.trades = merged.slice(0, MAX_TRADES);
    this.seenSigs = new Set(this.trades.map(t => t.signature));
    this.startPersistTimer();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) this.connect();
    else this.sendSubscribe(mint);
  }

  addListener(cb: TradeListener) { this.listeners.add(cb); }
  removeListener(cb: TradeListener) { this.listeners.delete(cb); }
  getTrades(): FormattedTrade[] { return [...this.trades]; }

  /** A trade this app sent (manual buy/sell, auto-sell): shown at once; the feed's copy of the same signature is deduped. */
  injectTrade(trade: FormattedTrade) {
    if (trade.isOurWallet && trade.trader) this.ourWallets.set(trade.trader, { type: trade.walletType ?? 'manual', label: trade.walletLabel ?? '' });
    if (this.seenSigs.has(trade.signature)) {
      const ex = this.trades.find(t => t.signature === trade.signature);
      if (ex && !ex.isOurWallet && trade.isOurWallet) {
        ex.isOurWallet = true; ex.walletType = trade.walletType; ex.walletLabel = trade.walletLabel;
        for (const cb of this.listeners) cb(ex);
        if (this.subscribedMint === trade.mint) persistTrades(trade.mint, this.trades);
      }
      return;
    }
    this.seenSigs.add(trade.signature);
    this.trades.unshift(trade);
    if (this.trades.length > MAX_TRADES) this.trades.length = MAX_TRADES;
    for (const cb of this.listeners) cb(trade);
    if (this.subscribedMint === trade.mint) persistTrades(trade.mint, this.trades);
  }

  /**
   * The launch buys (dev + bundle) with synthetic signatures, so the panel shows them even when the feed misses a
   * Jito bundle. The first real buy by the same wallet replaces its synthetic row.
   */
  injectLaunchBuys(mint: string, trades: FormattedTrade[]) {
    this.refreshWallets();
    if (!this.injectedWallets.has(mint)) this.injectedWallets.set(mint, new Set());
    const injectedSet = this.injectedWallets.get(mint)!;
    for (const t of trades) {
      if (t.mint !== mint || this.seenSigs.has(t.signature)) continue;
      const existingIdx = this.trades.findIndex(ex => ex.trader === t.trader && ex.mint === mint && ex.type === 'buy');
      if (existingIdx !== -1) {
        this.trades[existingIdx].walletType = t.walletType;
        this.trades[existingIdx].walletLabel = t.walletLabel;
        this.trades[existingIdx].isOurWallet = true;
        continue;
      }
      injectedSet.add(t.trader);
      this.seenSigs.add(t.signature);
      this.trades.unshift(t);
      if (this.trades.length > MAX_TRADES) this.trades.length = MAX_TRADES;
      for (const cb of this.listeners) cb(t);
    }
    if (this.subscribedMint === mint && trades.length > 0) persistTrades(mint, this.trades);
  }
}

export const tracker = new TradeTracker();
