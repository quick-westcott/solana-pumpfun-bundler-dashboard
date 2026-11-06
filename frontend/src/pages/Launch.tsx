import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { PhotoIcon } from '@heroicons/react/24/outline'
import Tip from '../components/ui/Tip'
import { Busy } from '../components/ui/Spinner'
import type { Wallet } from '../types'
import { errorMessage, links, short } from '../types'

interface Form {
  tokenName: string; tokenSymbol: string; description: string; imageUrl: string
  twitter: string; telegram: string; website: string
  devBuyAmount: number
  bundleWalletCount: number; bundleSwapAmounts: number[]; bundleWalletIds: (string | null)[]
  holderWalletCount: number; holderSwapAmounts: number[]; holderWalletIds: (string | null)[]
  holderAutoBuy: boolean; holderAutoBuyDelay: number
  useJito: boolean; strictBundle: boolean; autoSellAfterLaunch: boolean
  mintAddressMode: 'random' | 'vanity'
}

interface Plan { tipSol: number; useLut: boolean; dev: number; bundle: number[]; holder: number[]; total: number }

interface VanityPool {
  available: number; total: number; generating: boolean; collecting?: boolean
  stats?: { attempts: number; expectedAttempts: number; progress: number; found: number; rate: number; suffix: string; lastError: string | null } | null
}

interface Stage { stage: string; message: string; at: number }
interface SimResult { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }>; cost: Plan; simulation: { ok: boolean; unitsConsumed: number | null; err: unknown; logs: string[] } | null }

const BUNDLE_COUNTS = [0, 1, 2, 3, 4, 6, 8, 12, 16]
const fmtNum = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))
const resize = (arr: number[], n: number, fill: number) => Array.from({ length: n }, (_, i) => arr[i] ?? fill)
const resizeIds = (arr: (string | null)[], n: number) => Array.from({ length: n }, (_, i) => arr[i] ?? null)

export default function Launch() {
  const [form, setForm] = useState<Form>({
    tokenName: '', tokenSymbol: '', description: '', imageUrl: '', twitter: '', telegram: '', website: '',
    devBuyAmount: 0.5,
    bundleWalletCount: 2, bundleSwapAmounts: [0.1, 0.1], bundleWalletIds: [null, null],
    holderWalletCount: 0, holderSwapAmounts: [], holderWalletIds: [],
    holderAutoBuy: false, holderAutoBuyDelay: 5,
    useJito: true, strictBundle: true, autoSellAfterLaunch: false,
    mintAddressMode: 'random',
  })
  const set = (patch: Partial<Form>) => setForm(f => ({ ...f, ...patch }))

  const [plan, setPlan] = useState<Plan | null>(null)
  const [funding, setFunding] = useState<{ configured: boolean; balance?: number | null } | null>(null)
  const [available, setAvailable] = useState<Wallet[]>([])
  const [vanity, setVanity] = useState<VanityPool>({ available: 0, total: 0, generating: false })
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const [sim, setSim] = useState<SimResult | null>(null)
  const [simulating, setSimulating] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [launchId, setLaunchId] = useState<string | null>(null)
  const [stages, setStages] = useState<Stage[]>([])
  const [result, setResult] = useState<{ mint: string; signature: string } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)

  // ── data ──
  useEffect(() => {
    const load = () => { axios.get('/api/wallets/funding').then(r => setFunding(r.data)).catch(() => {}) }
    load(); const t = setInterval(load, 15_000)
    axios.get<Wallet[]>('/api/wallets/available').then(r => setAvailable(r.data)).catch(() => {})
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      axios.post<Plan>('/api/launch/plan', form).then(r => setPlan(r.data)).catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [form])

  const loadVanity = useCallback(() => { axios.get('/api/vanity/pool-status').then(r => setVanity(r.data)).catch(() => {}) }, [])
  useEffect(() => {
    loadVanity()
    const t = setInterval(loadVanity, vanity.generating || vanity.collecting ? 2000 : 15_000)
    return () => clearInterval(t)
  }, [loadVanity, vanity.generating, vanity.collecting])

  // ── image ──
  const upload = async (file: File) => {
    setUploading(true); setError(null)
    try {
      const fd = new FormData(); fd.append('image', file)
      const r = await axios.post('/api/upload/image', fd)
      set({ imageUrl: r.data.url })
    } catch (err) { setError(errorMessage(err)) } finally { setUploading(false) }
  }

  // ── wallet pickers ──
  const picked = new Set([...form.bundleWalletIds, ...form.holderWalletIds].filter(Boolean))
  const WalletPick = ({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) => {
    if (!available.length) return null
    return (
      <select className="input font-mono" style={{ padding: '3px 24px 3px 6px', fontSize: 10, maxWidth: 150, color: value ? '#a78bfa' : '#64748b' }} value={value || ''} onChange={e => onChange(e.target.value || null)}>
        <option value="">new wallet</option>
        {available.filter(w => w.id === value || !picked.has(w.id)).map(w => <option key={w.id} value={w.id}>{w.label.slice(0, 12)} ({short(w.publicKey)})</option>)}
      </select>
    )
  }

  // ── simulate / launch ──
  const payload = () => ({ ...form, bundleWalletIds: form.bundleWalletIds.some(Boolean) ? form.bundleWalletIds : undefined, holderWalletIds: form.holderWalletIds.some(Boolean) ? form.holderWalletIds : undefined })
  const ready = !!form.tokenName && !!form.tokenSymbol && !!form.imageUrl
  const insufficient = plan != null && funding?.balance != null && funding.balance < plan.total

  const simulate = async () => {
    setSimulating(true); setSim(null); setError(null)
    try { setSim((await axios.post<SimResult>('/api/launch/simulate', payload())).data) }
    catch (err) { setError(errorMessage(err)) } finally { setSimulating(false) }
  }

  const launch = async () => {
    if (!ready) return
    if (!confirm(`Launch ${form.tokenName} ($${form.tokenSymbol})? About ${plan?.total.toFixed(3)} SOL leaves the funding wallet.`)) return
    setLaunching(true); setError(null); setSim(null); setStages([]); setResult(null); setFailed(null)
    try {
      const r = await axios.post('/api/launch', payload())
      setLaunchId(r.data.launchId)
    } catch (err) { setError(errorMessage(err)); setLaunching(false) }
  }

  useEffect(() => {
    if (!launchId) return
    esRef.current?.close()
    const es = new EventSource(`/api/launch/${launchId}/stream`)
    esRef.current = es
    es.onmessage = ev => {
      const d = JSON.parse(ev.data) as { stage: string; message: string; mint?: string; signature?: string }
      if (d.stage === 'replay-start') { setStages([]); return }
      setStages(prev => [...prev, { stage: d.stage, message: d.message, at: Date.now() }])
      if (d.stage === 'done') { setResult({ mint: d.mint || '', signature: d.signature || '' }); setLaunching(false); window.dispatchEvent(new Event('funding-changed')) }
      if (d.stage === 'error') { setFailed(d.message); setLaunching(false); es.close() }
      if (d.stage === 'auto-sell-done' || d.stage === 'holder-done') es.close()
    }
    es.onerror = () => { /* EventSource reconnects and the server replays */ }
    return () => es.close()
  }, [launchId])

  // ── pieces ──
  const num = (v: number, onChange: (n: number) => void, w = 80) => (
    <input type="number" className="input font-mono" style={{ width: w, padding: '5px 8px', fontSize: 12 }} value={v} step={0.01} min={0} onChange={e => onChange(Number(e.target.value))} />
  )
  const toggle = (on: boolean, onClick: () => void, label: React.ReactNode, sub?: string, color?: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={onClick}>
      <div className={`toggle-track${on ? ' on' : ''}`} style={on && color ? { background: color } : undefined}><div className="toggle-knob" /></div>
      <div><div style={{ fontSize: 13, color: '#e2e8f0', display: 'flex', alignItems: 'center' }}>{label}</div>{sub && <div style={{ fontSize: 11, color: '#64748b' }}>{sub}</div>}</div>
    </div>
  )
  const stageColor = (s: string) => (s === 'done' ? '#34d399' : s === 'error' ? '#fb7185' : s === 'warning' ? '#fbbf24' : '#94a3b8')

  return (
    <div className="fade-up">
      <div style={{ marginBottom: 16 }}>
        <h1 className="page-title">Launch</h1>
        <p className="page-subtitle">Create a pump.fun coin with a dev buy and bundled buyers in one Jito bundle. Everything runs through the TrenchyTools API; your keys stay here.</p>
      </div>

      <div className="grid-form">
        {/* ── the form ── */}
        <div className="space-y">
          <div className="card">
            <h3 className="section-title">Token</h3>
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) upload(f) }}
                onClick={() => fileRef.current?.click()}
                style={{ width: 96, height: 96, flexShrink: 0, borderRadius: 12, border: `2px dashed ${dragOver ? '#14b8a6' : '#253346'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', overflow: 'hidden', background: dragOver ? 'rgba(20,184,166,0.05)' : 'transparent' }}
                title="Click or drop an image (png, jpg, gif, webp, 5 MB)"
              >
                {form.imageUrl ? <img src={form.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : uploading ? <span style={{ fontSize: 11, color: '#14b8a6' }}>uploading…</span>
                  : <div style={{ textAlign: 'center', color: '#475569', fontSize: 10 }}><PhotoIcon style={{ width: 22, height: 22, display: 'inline-block' }} /><div>image</div></div>}
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) upload(f) }} />
              </div>
              <div style={{ flex: 1 }}>
                <div className="grid-2" style={{ gap: 10 }}>
                  <div><label className="label">Name</label><input className="input" style={{ padding: '7px 10px', fontSize: 13 }} placeholder="My Coin" value={form.tokenName} onChange={e => set({ tokenName: e.target.value })} /></div>
                  <div><label className="label">Symbol</label><input className="input" style={{ padding: '7px 10px', fontSize: 13 }} placeholder="COIN" value={form.tokenSymbol} onChange={e => set({ tokenSymbol: e.target.value.toUpperCase() })} /></div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <label className="label">Description</label>
                  <textarea className="input" style={{ padding: '7px 10px', fontSize: 12, minHeight: 56 }} placeholder="What is it?" value={form.description} onChange={e => set({ description: e.target.value })} />
                </div>
              </div>
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input className="input" style={{ flex: 1, minWidth: 140, fontSize: 11, padding: '6px 10px' }} placeholder="Twitter / X URL" value={form.twitter} onChange={e => set({ twitter: e.target.value })} />
              <input className="input" style={{ flex: 1, minWidth: 140, fontSize: 11, padding: '6px 10px' }} placeholder="Telegram URL" value={form.telegram} onChange={e => set({ telegram: e.target.value })} />
              <input className="input" style={{ flex: 1, minWidth: 140, fontSize: 11, padding: '6px 10px' }} placeholder="Website URL" value={form.website} onChange={e => set({ website: e.target.value })} />
            </div>
            {form.imageUrl && <div style={{ marginTop: 8 }}><button className="btn-ghost" style={{ fontSize: 11, color: '#fb7185' }} onClick={() => set({ imageUrl: '' })}>Remove image</button></div>}
          </div>

          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h3 className="section-title" style={{ margin: 0, display: 'flex', alignItems: 'center' }}>Mint address<Tip text="A vanity mint ends in …pump. The TrenchyTools API grinds it (POST /api/sol/vanity); every key it hands back is saved to backend/data/vanity-pool.json before a launch uses it." /></h3>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className={`chip${form.mintAddressMode === 'random' ? ' active' : ''}`} onClick={() => set({ mintAddressMode: 'random' })}>Random</button>
                <button className={`chip${form.mintAddressMode === 'vanity' ? ' active' : ''}`} onClick={() => set({ mintAddressMode: 'vanity' })}>Vanity …pump</button>
              </div>
              {form.mintAddressMode === 'vanity' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, flex: 1, flexWrap: 'wrap' }}>
                  <span style={{ color: vanity.available > 0 ? '#34d399' : '#fb7185', fontWeight: 600 }}>{vanity.available} ready</span>
                  {(vanity.generating || vanity.collecting) && vanity.stats && (
                    <span className="font-mono" style={{ color: '#fbbf24', animation: 'pulse 2s ease-in-out infinite' }}>
                      API {vanity.collecting ? 'finishing' : 'grinding'} …{vanity.stats.suffix}: {fmtNum(vanity.stats.attempts)} / ~{fmtNum(vanity.stats.expectedAttempts)} ({Math.round(vanity.stats.progress * 100)} %) · {vanity.stats.found} found
                    </span>
                  )}
                  {!vanity.generating && vanity.stats?.lastError && <span style={{ color: '#fb7185' }} title={vanity.stats.lastError}>{vanity.stats.lastError.slice(0, 80)}</span>}
                  <div style={{ flex: 1 }} />
                  {vanity.generating
                    ? <button className="btn-ghost" style={{ fontSize: 11, color: '#fb7185' }} onClick={() => axios.post('/api/vanity/stop').then(loadVanity)}>Stop</button>
                    : <button className="btn-ghost" style={{ fontSize: 11, color: '#14b8a6' }} onClick={() => axios.post('/api/vanity/start', { suffix: 'pump' }).then(loadVanity).catch(err => setError(errorMessage(err)))}>Generate more</button>}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <h3 className="section-title">Buys</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <label className="label" style={{ margin: 0, display: 'flex', alignItems: 'center' }}>Dev buy<Tip text="The dev wallet creates the coin and buys this much SOL of it in the same transaction. The dev wallet is created for this launch (and backed up) unless you pick one." /></label>
              {num(form.devBuyAmount, n => set({ devBuyAmount: n }))}
              <span style={{ fontSize: 11, color: '#64748b' }}>SOL</span>
              {[0.1, 0.25, 0.5, 1, 2].map(p => <button key={p} className={`chip${form.devBuyAmount === p ? ' active' : ''}`} style={{ padding: '3px 8px' }} onClick={() => set({ devBuyAmount: p })}>{p}</button>)}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
              <div style={{ padding: 12, borderRadius: 8, border: '1px solid rgba(37,51,70,0.6)', background: 'rgba(15,23,42,0.3)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#34d399', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, display: 'flex', alignItems: 'center' }}>Bundle buyers<Tip text="Buy in the same Jito bundle as the create, all in one block. Up to 4 go one per transaction; 5 to 16 use a lookup table (created automatically, ~0.01 SOL rent refunded after the launch). Each wallet is created and backed up before it is funded." /></div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                  {BUNDLE_COUNTS.map(n => <button key={n} className={`chip${form.bundleWalletCount === n ? ' active' : ''}`} style={{ width: 30, padding: '3px 0' }} onClick={() => set({ bundleWalletCount: n, bundleSwapAmounts: resize(form.bundleSwapAmounts, n, 0.1), bundleWalletIds: resizeIds(form.bundleWalletIds, n) })}>{n}</button>)}
                </div>
                {form.bundleWalletCount > 0 && (<>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 6, fontSize: 10, color: '#64748b' }}>all: {[0.05, 0.1, 0.25, 0.5, 1].map(p => <button key={p} className="chip" style={{ padding: '1px 6px' }} onClick={() => set({ bundleSwapAmounts: form.bundleSwapAmounts.map(() => p) })}>{p}</button>)}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {form.bundleSwapAmounts.map((a, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, color: '#64748b', width: 22 }}>B{i + 1}</span>
                        {num(a, n => set({ bundleSwapAmounts: form.bundleSwapAmounts.map((x, j) => (j === i ? n : x)) }), 70)}
                        <span style={{ fontSize: 10, color: '#64748b' }}>SOL</span>
                        <WalletPick value={form.bundleWalletIds[i] ?? null} onChange={id => set({ bundleWalletIds: form.bundleWalletIds.map((x, j) => (j === i ? id : x)) })} />
                      </div>
                    ))}
                  </div>
                </>)}
              </div>

              <div style={{ padding: 12, borderRadius: 8, border: '1px solid rgba(37,51,70,0.6)', background: 'rgba(15,23,42,0.3)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, display: 'flex', alignItems: 'center' }}>Holder wallets (optional)<Tip text="Funded at launch, buy AFTER the bundle lands (auto-buy with a delay, or by hand on the Trading page)." /></div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                  {[0, 1, 2, 3, 4, 5, 6, 8, 10].map(n => <button key={n} className={`chip${form.holderWalletCount === n ? ' active' : ''}`} style={{ width: 30, padding: '3px 0' }} onClick={() => set({ holderWalletCount: n, holderSwapAmounts: resize(form.holderSwapAmounts, n, 0.1), holderWalletIds: resizeIds(form.holderWalletIds, n) })}>{n}</button>)}
                </div>
                {form.holderWalletCount > 0 && (<>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                    {form.holderSwapAmounts.map((a, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, color: '#64748b', width: 22 }}>H{i + 1}</span>
                        {num(a, n => set({ holderSwapAmounts: form.holderSwapAmounts.map((x, j) => (j === i ? n : x)) }), 70)}
                        <span style={{ fontSize: 10, color: '#64748b' }}>SOL</span>
                        <WalletPick value={form.holderWalletIds[i] ?? null} onChange={id => set({ holderWalletIds: form.holderWalletIds.map((x, j) => (j === i ? id : x)) })} />
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {toggle(form.holderAutoBuy, () => set({ holderAutoBuy: !form.holderAutoBuy }), <span style={{ fontSize: 11 }}>Auto-buy after launch</span>)}
                    {form.holderAutoBuy && <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#64748b' }}>{num(form.holderAutoBuyDelay, n => set({ holderAutoBuyDelay: n }), 56)} s delay</span>}
                  </div>
                </>)}
              </div>
            </div>
          </div>

          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h3 className="section-title" style={{ margin: 0 }}>Options</h3>
            {toggle(form.useJito, () => set({ useJito: !form.useJito }), <>Jito bundle<Tip text="Create + dev buy + bundle buys as one atomic bundle (POST /api/sol/bundle): all land in the same block or not at all. Off: the create and the buys are sent one by one." /></>, `Tip ${plan ? plan.tipSol : '…'} SOL, set in Settings`)}
            {form.useJito && toggle(form.strictBundle, () => set({ strictBundle: !form.strictBundle }), <>Strict bundle<Tip text="On: three bundle attempts, then fail. Off: if the bundle does not land, the create and buys go out one by one." /></>, 'Never fall back to plain sends')}
            {toggle(form.autoSellAfterLaunch, () => set({ autoSellAfterLaunch: !form.autoSellAfterLaunch }), <span style={{ color: form.autoSellAfterLaunch ? '#fb7185' : undefined }}>Sell all at launch</span>, 'Dev + bundle wallets sell 100 % the moment the coin is on chain', '#ef4444')}
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-secondary" style={{ flex: 1, padding: '13px 0', fontSize: 14 }} disabled={simulating || launching || !funding?.configured} onClick={simulate}>
              <Busy busy={simulating} busyLabel="Simulating…">Simulate</Busy>
            </button>
            <button className="btn-primary" style={{ flex: 2, padding: '13px 0', fontSize: 15, ...(insufficient ? { background: '#991b1b' } : {}) }} disabled={launching || !ready || !funding?.configured || insufficient} onClick={launch}>
              {launching ? <Busy busy>Launching…</Busy>
                : !funding?.configured ? 'Create a funding wallet first (Wallets)'
                : !ready ? 'Name, symbol and an image are needed'
                : insufficient ? `Not enough SOL (need ${plan?.total.toFixed(3)}, have ${funding.balance?.toFixed(3)})`
                : `Launch (${plan ? plan.total.toFixed(3) : '…'} SOL)`}
            </button>
          </div>
          {error && <div style={{ fontSize: 12, color: '#fb7185' }}>{error}</div>}
        </div>

        {/* ── right: cost + simulation ── */}
        <div className="space-y">
          <div className="card">
            <h3 className="section-title">Cost</h3>
            {plan ? (<>
              <div className="summary-row"><span className="label-side">Dev wallet (buy {form.devBuyAmount} SOL + fees{plan.useLut ? ' + table rent' : ''})</span><span className="value-side accent">{plan.dev.toFixed(3)}</span></div>
              {plan.bundle.map((b, i) => <div key={i} className="summary-row"><span className="label-side">Bundle {i + 1} (buy {form.bundleSwapAmounts[i]} SOL)</span><span className="value-side">{b.toFixed(3)}</span></div>)}
              {plan.holder.map((h, i) => <div key={i} className="summary-row"><span className="label-side">Holder {i + 1} (buy {form.holderSwapAmounts[i]} SOL)</span><span className="value-side">{h.toFixed(3)}</span></div>)}
              {form.useJito && <div className="summary-row"><span className="label-side">Jito tip (inside the dev amount)</span><span className="value-side">{plan.tipSol.toFixed(3)}</span></div>}
              <div className="summary-row total"><span className="label-side">Leaves the funding wallet</span><span className="value-side" style={insufficient ? { color: '#ef4444' } : undefined}>{plan.total.toFixed(3)} SOL</span></div>
              <p style={{ fontSize: 10, color: '#64748b', marginTop: 8, lineHeight: 1.5 }}>
                The buys become tokens; the API fee is 0.5 % of each buy; the rest is a buffer each wallet keeps for fees and rent and comes back with Gather on the Wallets page. Funding wallet: {funding?.balance == null ? '…' : `${funding.balance.toFixed(4)} SOL`}.
              </p>
            </>) : <span style={{ fontSize: 12, color: '#64748b' }}>…</span>}
          </div>

          {sim && (
            <div className="card" style={{ borderColor: sim.ok ? 'rgba(52,211,153,0.3)' : 'rgba(251,191,36,0.3)' }}>
              <h3 className="section-title" style={{ color: sim.ok ? '#34d399' : '#fbbf24' }}>{sim.ok ? 'Dry run passed' : 'Dry run: fix these first'}</h3>
              {sim.checks.map((c, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11, padding: '3px 0', color: c.ok ? '#94a3b8' : '#fbbf24' }}>
                  <span style={{ color: c.ok ? '#34d399' : '#fb7185', width: 12 }}>{c.ok ? '✓' : '✗'}</span>
                  <span style={{ width: 70, color: '#64748b' }}>{c.name}</span>
                  <span style={{ flex: 1 }}>{c.detail}</span>
                </div>
              ))}
              {sim.simulation && !sim.simulation.ok && sim.simulation.logs.length > 0 && (
                <pre style={{ fontSize: 9, color: '#64748b', marginTop: 8, whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>{sim.simulation.logs.join('\n')}</pre>
              )}
            </div>
          )}

          {(stages.length > 0 || result || failed) && (
            <div className="card" style={{ borderColor: failed ? 'rgba(251,113,133,0.3)' : result ? 'rgba(52,211,153,0.3)' : 'rgba(129,140,248,0.3)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <h3 className="section-title" style={{ margin: 0, color: failed ? '#fb7185' : result ? '#34d399' : '#818cf8' }}>{failed ? 'Launch failed' : result ? 'Launched' : 'Launching…'}</h3>
                {launching && <Busy busy><span /></Busy>}
                {result && <div style={{ flex: 1 }} />}
                {result && (<>
                  <Link to={`/trading?mint=${result.mint}`} className="btn-primary" style={{ padding: '5px 10px', fontSize: 11 }}>Open in Trading</Link>
                  <a className="btn-secondary" style={{ padding: '5px 10px', fontSize: 11 }} href={links(result.mint).pumpfun} target="_blank" rel="noreferrer">pump.fun</a>
                  <a className="btn-secondary" style={{ padding: '5px 10px', fontSize: 11 }} href={links(result.mint).dexscreener} target="_blank" rel="noreferrer">dexscreener</a>
                </>)}
              </div>
              {result && <div className="font-mono" style={{ fontSize: 11, color: '#e2e8f0', marginBottom: 8, wordBreak: 'break-all' }}>{result.mint}</div>}
              <div style={{ maxHeight: 320, overflowY: 'auto', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {stages.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, color: stageColor(s.stage) }}>
                    <span className="font-mono" style={{ color: '#475569', width: 90, flexShrink: 0 }}>{s.stage}</span>
                    <span style={{ wordBreak: 'break-word' }}>{s.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
