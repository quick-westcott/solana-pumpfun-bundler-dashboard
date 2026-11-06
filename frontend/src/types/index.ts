export interface Wallet {
  id: string
  publicKey: string
  type: string
  label: string
  status: 'active' | 'archived'
  createdAt: string
  launchId?: string
  source: 'generated' | 'imported'
  backedUp: boolean
}

export interface Launch {
  id: string
  tokenName: string
  tokenSymbol: string
  mintAddress?: string
  imageUrl?: string
  status: string
  createdAt: string
  signature?: string
  error?: string
}

export interface WalletBalance {
  id: string
  publicKey: string
  type: string
  label: string
  solBalance: number
  tokenBalance: number
  tokenRaw: string
}

export interface LiveTrade {
  signature: string
  mint: string
  type: string
  trader: string
  traderShort: string
  solAmount: number
  tokenAmount: number
  timestamp: number
  isOurWallet: boolean
  walletType: string | null
  walletLabel: string | null
}

export interface ApiStatus { url: string; configured: boolean; ok: boolean; keyPrefix?: string; calls30d?: number; error?: string }

export interface FundingInfo { configured: boolean; id?: string; publicKey?: string; label?: string; balance?: number | null; backedUp?: boolean; error?: string }

export const TOTAL_SUPPLY = 1_000_000_000

export const fmtSol = (n: number) => (n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(4))
export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toFixed(0))
export const fmtPct = (tokens: number) => {
  const pct = (tokens / TOTAL_SUPPLY) * 100
  return pct >= 10 ? pct.toFixed(1) : pct >= 0.01 ? pct.toFixed(2) : pct > 0 ? pct.toFixed(3) : '0'
}
export const short = (addr: string, n = 4) => (addr ? `${addr.slice(0, n)}…${addr.slice(-n)}` : '')

/** The message of an axios error (the API's { error, hint }) or of anything else. */
export function errorMessage(err: unknown): string {
  const e = err as { response?: { data?: { error?: string; hint?: string } }; message?: string }
  const d = e?.response?.data
  if (d?.error) return d.hint ? `${d.error} (${d.hint})` : d.error
  return e?.message || String(err)
}

export const BADGE_COLORS: Record<string, string> = {
  funding: '#60a5fa',
  dev: '#818cf8',
  bundle: '#34d399',
  holder: '#fbbf24',
  manual: '#94a3b8',
}

export const links = (mint: string) => ({
  pumpfun: `https://pump.fun/coin/${mint}`,
  dexscreener: `https://dexscreener.com/solana/${mint}`,
  solscan: `https://solscan.io/token/${mint}`,
})
