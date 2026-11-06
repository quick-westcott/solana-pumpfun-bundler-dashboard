import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { Busy, Status } from '../components/ui/Spinner'
import Tip from '../components/ui/Tip'
import type { Launch, WalletBalance, LiveTrade } from '../types'
import { BADGE_COLORS, errorMessage, fmtPct, fmtSol, fmtTokens, links, short } from '../types'

const PCTS = [25, 50, 75, 100]
const timeAgo = (ts: number) => { const s = Math.floor((Date.now() - ts) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h` }

export default function Trading() {
  const [params, setParams] = useSearchParams()
  const [launches, setLaunches] = useState<Launch[]>([])
  const [mint, setMint] = useState(params.get('mint') ?? '')
  const [mintInput, setMintInput] = useState('')
  const [wallets, setWallets] = useState<WalletBalance[]>([])
  const [loading, setLoading] = useState(false)
  const [rowBusy, setRowBusy] = useState<Record<string, string>>({})
  const [bulkBusy, setBulkBusy] = useState(false)
  const [sellPct, setSellPct] = useState(100)
  const [devPct, setDevPct] = useState(100)
  const [othersPct, setOthersPct] = useState(100)
  const [fees, setFees] = useState<{ availableSol: number; creator: string } | null>(null)
  const [feesBusy, setFeesBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'busy' | 'ok' | 'warn' | 'error'; text: string } | null>(null)
  const [trades, setTrades] = useState<LiveTrade[]>([])
  const [liveError, setLiveError] = useState('')
  const esRef = useRef<EventSource | null>(null)

  const launch = launches.find(l => l.mintAddress === mint)
  const fail = (err: unknown, what: string) => setStatus({ kind: 'error', text: `${what} failed: ${errorMessage(err)}` })

  // launches, newest first; pick the newest when nothing is selected
  useEffect(() => {
    axios.get<Launch[]>('/api/launch').then(r => {
      const confirmed = r.data.filter(l => l.status === 'confirmed' && l.mintAddress)
      setLaunches(confirmed)
      if (!mint && confirmed[0]?.mintAddress) setMint(confirmed[0].mintAddress)
    }).catch(() => {})
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (mint) setParams({ mint }, { replace: true }) }, [mint, setParams])

  const loadWallets = useCallback(async () => {
    if (!mint || mint.length < 32) { setWallets([]); return }
    setLoading(true)
    try { setWallets((await axios.post('/api/wallets/balances', { mint, launchId: launch?.id })).data) }
    catch { setWallets([]) } finally { setLoading(false) }
  }, [mint, launch?.id])
  useEffect(() => { loadWallets() }, [loadWallets])
  useEffect(() => { const t = setInterval(loadWallets, 30_000); return () => clearInterval(t) }, [loadWallets])

  const loadFees = useCallback(() => {
    if (!launch?.id) { setFees(null); return }
    // 404 = this launch's dev wallet is not in the vault (nothing to claim from here): shown as "-"
    axios.get('/api/trading/creator-fees', { params: { launchId: launch.id } }).then(r => setFees(r.data)).catch(() => setFees({ availableSol: -1, creator: '' }))
  }, [launch?.id])
  useEffect(() => { loadFees(); const t = setInterval(loadFees, 30_000); return () => clearInterval(t) }, [loadFees])

  // live trades over the backend's SSE (which rides the API websocket)
  useEffect(() => {
    esRef.current?.close(); esRef.current = null
    setTrades([]); setLiveError('')
    if (!mint || mint.length < 32) return
    const es = new EventSource(`/api/live-trades?mint=${encodeURIComponent(mint)}`)
    esRef.current = es
    es.onmessage = ev => {
      const d = JSON.parse(ev.data)
      if (d.type === 'initial') setTrades((d.trades as LiveTrade[]).sort((a, b) => b.timestamp - a.timestamp))
      else if (d.type === 'trade') setTrades(prev => [d.trade as LiveTrade, ...prev.filter(t => t.signature !== d.trade.signature)].sort((a, b) => b.timestamp - a.timestamp).slice(0, 100))
      setLiveError('')
    }
    es.onerror = () => setLiveError('live trades reconnecting…')
    return () => es.close()
  }, [mint])

  const sell = async (walletIds: string[] | null, pct: number) => {
    if (!mint) return
    if (walletIds) walletIds.forEach(id => setRowBusy(p => ({ ...p, [id]: `Selling ${pct} %…` })))
    else { if (!confirm(`Sell ${pct} % from every wallet of this launch?`)) return; setBulkBusy(true) }
    try {
      const r = await axios.post('/api/trading/rapid-sell', { mint, percentage: pct, launchId: launch?.id, ...(walletIds ? { walletIds } : {}) })
      const s = r.data.summary
      const errs = (r.data.results as { status: string; error?: string; wallet: string }[]).filter(x => x.status === 'error')
      setStatus({ kind: errs.length ? 'warn' : 'ok', text: `Sold from ${s.confirmed + s.sent}/${s.totalWallets} wallet(s)${s.skipped ? `, ${s.skipped} empty` : ''}${errs.length ? `; failed: ${errs.map(e => `${short(e.wallet)} ${e.error}`).join('; ')}` : ''}` })
      loadWallets(); loadFees()
    } catch (err) { fail(err, 'Sell') } finally {
      if (walletIds) setRowBusy(p => { const n = { ...p }; walletIds.forEach(id => delete n[id]); return n })
      setBulkBusy(false)
    }
  }

  const claimFees = async () => {
    if (!launch?.id) return
    setFeesBusy(true)
    try {
      const r = await axios.post('/api/trading/collect-creator-fees', { launchId: launch.id })
      setStatus(r.data.status === 'confirmed'
        ? { kind: 'ok', text: `Claimed ${Number(r.data.collectedSol).toFixed(6)} SOL${r.data.sweptSol ? `, ${Number(r.data.sweptSol).toFixed(6)} SOL swept to the funding wallet` : ''}` }
        : { kind: 'warn', text: r.data.reason || r.data.error || 'Nothing to claim' })
      loadFees(); window.dispatchEvent(new Event('funding-changed'))
    } catch (err) { fail(err, 'Claim creator fees') } finally { setFeesBusy(false) }
  }

  const totals = useMemo(() => ({ sol: wallets.reduce((s, w) => s + w.solBalance, 0), tokens: wallets.reduce((s, w) => s + w.tokenBalance, 0), holding: wallets.filter(w => w.tokenBalance > 0).length }), [wallets])
  const ORDER: Record<string, number> = { dev: 0, bundle: 1, holder: 2 }
  const sorted = useMemo(() => [...wallets].sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9)), [wallets])
  // The dev and everything else, each with its own share, a row button, and a group button.
  const devWallets = useMemo(() => sorted.filter(w => w.type === 'dev'), [sorted])
  const otherWallets = useMemo(() => sorted.filter(w => w.type !== 'dev'), [sorted])
  const holdingOf = (list: WalletBalance[]) => list.filter(w => w.tokenBalance > 0).length
  const L = mint ? links(mint) : null

  return (
    <div className="fade-up">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <h1 className="page-title" style={{ marginRight: 8 }}>Trading</h1>
        <select className="input" style={{ width: 280, fontSize: 12, padding: '7px 28px 7px 10px' }} value={launch ? mint : ''} onChange={e => { if (e.target.value) { setMint(e.target.value); setMintInput('') } }}>
          <option value="">{launches.length ? 'Your launches…' : 'No launches yet'}</option>
          {launches.map(l => <option key={l.id} value={l.mintAddress}>{l.tokenName} (${l.tokenSymbol}) · {new Date(l.createdAt).toLocaleDateString()}</option>)}
        </select>
        <input className="input font-mono" style={{ flex: 1, minWidth: 260, fontSize: 11, padding: '7px 10px' }} placeholder="or paste any mint address" value={mintInput}
          onChange={e => { const v = e.target.value.trim(); setMintInput(v); if (v.length >= 32) setMint(v) }} />
        {L && (<>
          <a className="btn-secondary" style={{ padding: '6px 10px', fontSize: 11 }} href={L.pumpfun} target="_blank" rel="noreferrer">pump.fun</a>
          <a className="btn-secondary" style={{ padding: '6px 10px', fontSize: 11 }} href={L.dexscreener} target="_blank" rel="noreferrer">dexscreener</a>
          <a className="btn-secondary" style={{ padding: '6px 10px', fontSize: 11 }} href={L.solscan} target="_blank" rel="noreferrer">solscan</a>
        </>)}
      </div>

      {mint && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, fontSize: 12 }}>
          {launch?.imageUrl && <img src={launch.imageUrl} alt="" style={{ width: 32, height: 32, borderRadius: 8, objectFit: 'cover' }} />}
          <div>
            <div style={{ fontWeight: 700, color: '#e2e8f0' }}>{launch ? <>{launch.tokenName} <span style={{ color: '#64748b', fontWeight: 500 }}>${launch.tokenSymbol}</span></> : 'External coin'}</div>
            <div className="font-mono" style={{ fontSize: 10, color: '#64748b', cursor: 'pointer' }} onClick={() => navigator.clipboard.writeText(mint)} title="copy">{mint}</div>
          </div>
        </div>
      )}

      {status && <div style={{ marginBottom: 12 }}><Status kind={status.kind} onDismiss={() => setStatus(null)}>{status.text}</Status></div>}

      <div className="trading-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16 }}>
        <div>
          {/* actions */}
          <div className="card-flat" style={{ padding: '10px 14px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11 }}>
            <span style={{ color: '#94a3b8' }}>{wallets.length} wallet(s) · <span className="font-mono" style={{ color: '#34d399' }}>{fmtSol(totals.sol)} SOL</span> · <span className="font-mono" style={{ color: '#fbbf24' }}>{fmtTokens(totals.tokens)}</span> tokens{totals.tokens > 0 && <span className="font-mono" style={{ color: '#c084fc' }}> ({fmtPct(totals.tokens)} %)</span>}</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontWeight: 700, color: '#fb7185', display: 'flex', alignItems: 'center' }}>Sell all<Tip text="Each group below sells its own share. This button hits every wallet of the launch, dev included. A wallet with no SOL for the fee is topped up from the funding wallet first." /></span>
            {PCTS.map(p => <button key={p} className={`chip${sellPct === p ? ' active' : ''}`} onClick={() => setSellPct(p)}>{p} %</button>)}
            <button className="btn-danger" style={{ fontSize: 11, padding: '6px 12px' }} disabled={bulkBusy || !totals.holding || !launch} onClick={() => sell(null, sellPct)}><Busy busy={bulkBusy}>Sell {sellPct} % everywhere</Busy></button>
            <span style={{ width: 1, height: 16, background: 'rgba(37,51,70,0.6)' }} />
            <span style={{ color: '#94a3b8' }}>Creator fees: <span className="font-mono" style={{ color: fees && fees.availableSol > 0 ? '#34d399' : '#64748b' }}>{fees ? (fees.availableSol < 0 ? '-' : `${fees.availableSol.toFixed(6)} SOL`) : launch ? '…' : '-'}</span></span>
            <button className="btn-secondary" style={{ fontSize: 11, padding: '6px 12px' }} disabled={feesBusy || !launch || !fees || fees.availableSol <= 0} onClick={claimFees}><Busy busy={feesBusy}>Claim</Busy></button>
            <button className="btn-ghost" style={{ fontSize: 11 }} disabled={loading} onClick={loadWallets}><Busy busy={loading}>Refresh</Busy></button>
          </div>

          {/* wallet table, split by role: the dev on its own, then everything that bought alongside it */}
          <div className="card-flat">
            <div className="table-header" style={{ gap: 8 }}>
              <div style={{ width: 150 }}>Wallet</div>
              <div style={{ flex: 1 }}>Address</div>
              <div style={{ width: 80, textAlign: 'right' }}>SOL</div>
              <div style={{ width: 120, textAlign: 'right' }}>Tokens</div>
              <div style={{ width: 230, textAlign: 'right' }}>Sell</div>
            </div>

            {sorted.length === 0 && <div style={{ padding: 28, textAlign: 'center', color: '#64748b', fontSize: 13 }}>{!mint ? 'Pick a launch or paste a mint.' : loading ? 'Loading…' : launch ? 'No wallets hold this coin.' : 'None of your wallets hold this coin.'}</div>}

            {([['dev', 'Dev wallet', devWallets, devPct, setDevPct], ['others', 'Additional wallets', otherWallets, othersPct, setOthersPct]] as [string, string, WalletBalance[], number, (n: number) => void][]).map(([key, title, list, pct, setPct]) => {
              const rows = list as WalletBalance[]
              const holding = holdingOf(rows)
              const sol = rows.reduce((s, w) => s + w.solBalance, 0)
              const tokens = rows.reduce((s, w) => s + w.tokenBalance, 0)
              return (
                <div key={key as string}>
                  <div className="wallet-group">
                    <div className="wallet-group-head">
                      <span className="wallet-group-title">{title as string}<span className="wallet-group-count">{rows.length}</span></span>
                      <span className="wallet-group-stats">
                        <span className="font-mono" style={{ color: '#34d399' }}>{fmtSol(sol)} SOL</span>
                        <span style={{ color: '#334155' }}>·</span>
                        <span className="font-mono" style={{ color: tokens > 0 ? '#fbbf24' : '#475569' }}>{fmtTokens(tokens)} tokens</span>
                      </span>
                      <div style={{ flex: 1 }} />
                      {PCTS.map(p => <button key={p} className={`chip${pct === p ? ' active' : ''}`} onClick={() => setPct(p)}>{p} %</button>)}
                      <button className="btn-danger" style={{ fontSize: 11, padding: '5px 10px' }} disabled={bulkBusy || !holding || !launch}
                        onClick={() => sell(rows.map(w => w.id), pct as number)}>
                        <Busy busy={bulkBusy}>Sell {pct as number} %</Busy>
                      </button>
                    </div>
                    {rows.length === 0
                      ? <div className="wallet-group-empty">{key === 'dev' ? 'No dev wallet holds this coin.' : 'No other wallet holds this coin.'}</div>
                      : rows.map(w => (
                        <div key={w.id} className="table-row" style={{ gap: 8, opacity: rowBusy[w.id] ? 0.6 : 1 }}>
                          <div style={{ width: 150, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                            <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: BADGE_COLORS[w.type] || '#94a3b8' }}>{w.type}</span>
                            <span style={{ fontSize: 12, color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={w.label}>{w.label}</span>
                          </div>
                          <div className="font-mono" style={{ flex: 1, fontSize: 12, color: '#94a3b8', cursor: 'pointer' }} title={w.publicKey} onClick={() => navigator.clipboard.writeText(w.publicKey)}>{short(w.publicKey, 6)}</div>
                          <div className="font-mono" style={{ width: 80, textAlign: 'right', fontSize: 12, color: '#34d399' }}>{fmtSol(w.solBalance)}</div>
                          <div className="font-mono" style={{ width: 120, textAlign: 'right', fontSize: 12, color: w.tokenBalance > 0 ? '#fbbf24' : '#475569' }}>{fmtTokens(w.tokenBalance)}{w.tokenBalance > 0 && <span style={{ fontSize: 9, color: '#c084fc', marginLeft: 4 }}>{fmtPct(w.tokenBalance)} %</span>}</div>
                          <div style={{ width: 230, display: 'flex', justifyContent: 'flex-end', gap: 3 }}>
                            {rowBusy[w.id] ? <span style={{ fontSize: 11, color: '#94a3b8' }}><Busy busy>{rowBusy[w.id]}</Busy></span>
                              : w.tokenBalance > 0 ? PCTS.map(p => (
                                <button key={p} onClick={() => sell([w.id], p)} style={{ padding: '3px 8px', fontSize: 10, fontWeight: 700, borderRadius: 4, border: 'none', cursor: 'pointer', background: p === 100 ? 'rgba(244,63,94,0.2)' : 'rgba(244,63,94,0.1)', color: '#fb7185' }}>{p} %</button>
                              )) : <span style={{ fontSize: 10, color: '#475569' }}>no tokens</span>}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* live trades */}
        <div className="card-flat" style={{ display: 'flex', flexDirection: 'column', maxHeight: 560 }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(37,51,70,0.5)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <div className="pulse-dot" style={{ width: 5, height: 5 }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: '#fff' }}>Live trades</span>
            <span style={{ fontSize: 10, color: '#475569' }}>{trades.length}</span>
            <Tip text="The TrenchyTools websocket (wss …/api/sol/data, subscribeTokenTrade), relayed by the backend. Rows marked D / B / H are this app's wallets." />
            {liveError && <span style={{ fontSize: 10, color: '#fbbf24', marginLeft: 'auto' }}>{liveError}</span>}
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {trades.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: '#475569', fontSize: 12 }}>{mint ? 'Waiting for trades…' : 'Pick a coin'}</div>}
            {trades.map((t, i) => (
              <div key={t.signature + i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', fontSize: 11, borderBottom: '1px solid rgba(37,51,70,0.25)', background: t.isOurWallet ? 'rgba(99,102,241,0.06)' : 'transparent' }}>
                <span style={{ padding: '1px 5px', borderRadius: 4, fontSize: 9, fontWeight: 700, minWidth: 28, textAlign: 'center', textTransform: 'uppercase', background: t.type === 'buy' ? 'rgba(16,185,129,0.15)' : 'rgba(244,63,94,0.15)', color: t.type === 'buy' ? '#34d399' : '#fb7185' }}>{t.type}</span>
                {t.isOurWallet && <span style={{ padding: '1px 4px', borderRadius: 3, fontSize: 8, fontWeight: 700, background: 'rgba(129,140,248,0.15)', color: BADGE_COLORS[t.walletType ?? ''] || '#818cf8', minWidth: 14, textAlign: 'center' }}>{(t.walletType ?? 'us').charAt(0).toUpperCase()}</span>}
                <span className="font-mono" style={{ fontWeight: 600, color: '#e2e8f0', minWidth: 52, textAlign: 'right' }}>{fmtSol(t.solAmount)}</span>
                <span style={{ color: '#475569', fontSize: 9 }}>SOL</span>
                <span className="font-mono" style={{ color: '#64748b', flex: 1, textAlign: 'right', fontSize: 10 }}>{fmtTokens(t.tokenAmount)}</span>
                <span className="font-mono" style={{ color: '#475569', fontSize: 9 }}>{t.traderShort}</span>
                <span style={{ color: '#334155', fontSize: 9, minWidth: 20, textAlign: 'right' }}>{timeAgo(t.timestamp)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
