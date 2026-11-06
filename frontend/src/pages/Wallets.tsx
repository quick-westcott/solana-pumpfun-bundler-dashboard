import { useCallback, useEffect, useState } from 'react'
import axios from 'axios'
import { notify } from '../components/layout/Layout'
import Tip from '../components/ui/Tip'
import { Busy, Skeleton, Status } from '../components/ui/Spinner'
import type { Wallet, FundingInfo } from '../types'
import { BADGE_COLORS, errorMessage, fmtTokens, short } from '../types'

interface VenueInfo {
  exchange: 'on' | 'off' | 'degraded'
  venues: Record<string, { status: 'open' | 'closed' | 'unknown'; reason?: string; default?: boolean }>
  explain?: string
}

interface FundLeg {
  walletId: string; publicKey: string; transferId?: string; status: string; route?: string; mode?: string | null; venue?: string | null
  deposit?: { address: string; amount: number } | null; signature?: string; receipt?: string; error?: string; code?: string; reason?: string
}
const LEG_FINAL = ['completed', 'failed', 'expired', 'refunded', 'cancelled', 'refused', 'skipped']
const legDone = (l: FundLeg) => LEG_FINAL.includes(l.status) || (l.route === 'direct' && l.status === 'sent') || (!l.transferId && !!l.error)

type StatusMsg = { kind: 'busy' | 'ok' | 'warn' | 'error'; text: string }

export default function Wallets() {
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [archived, setArchived] = useState<Wallet[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [funding, setFunding] = useState<FundingInfo | null>(null)
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [balancesLoaded, setBalancesLoaded] = useState(false)
  const [tokenMint, setTokenMint] = useState('')
  const [tokenBalances, setTokenBalances] = useState<Record<string, number>>({})
  const [backupDir, setBackupDir] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<StatusMsg | null>(null)
  const [busy, setBusy] = useState<string | null>(null)          // which action is running
  const [rowBusy, setRowBusy] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const [newFiles, setNewFiles] = useState<string[]>([])

  const [genCount, setGenCount] = useState(2)
  const [genLabel, setGenLabel] = useState('')
  const [importKey, setImportKey] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [fundAmount, setFundAmount] = useState('0.05')
  const [showExchange, setShowExchange] = useState(false)
  const [fundMode, setFundMode] = useState<'float' | 'fixed' | 'private'>('float')
  const [fundVenue, setFundVenue] = useState('random')
  const [venues, setVenues] = useState<VenueInfo | null>(null)
  const [legs, setLegs] = useState<FundLeg[]>([])

  const fail = (err: unknown, what: string) => setStatus({ kind: 'error', text: `${what} failed: ${errorMessage(err)}` })
  const busyRow = (id: string, what: string | null) => setRowBusy(prev => { const n = { ...prev }; if (what) n[id] = what; else delete n[id]; return n })
  const copy = (text: string, key: string) => { navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1500) }

  // ── loading ──
  const loadWallets = useCallback(async () => {
    const [a, f] = await Promise.all([axios.get<Wallet[]>('/api/wallets'), axios.get<FundingInfo>('/api/wallets/funding')])
    setWallets(a.data.filter(w => w.type !== 'funding'))
    setFunding(f.data)
    if (showArchived) setArchived((await axios.get<Wallet[]>('/api/wallets', { params: { status: 'archived' } })).data)
  }, [showArchived])
  useEffect(() => { loadWallets().catch(err => fail(err, 'Loading wallets')) }, [loadWallets])
  useEffect(() => { axios.get('/api/settings').then(r => setBackupDir(r.data.backupDir)).catch(() => {}) }, [])
  useEffect(() => { axios.get('/api/wallets/transfer-venues').then(r => setVenues(r.data)).catch(() => setVenues(null)) }, [])

  const refreshBalances = useCallback(async () => {
    const ids = [...wallets.map(w => w.id), ...(showArchived ? archived.map(w => w.id) : [])]
    if (!ids.length) { setBalancesLoaded(true); return }
    try {
      const r = await axios.post('/api/wallets/refresh-balances', { ids })
      setBalances(prev => { const m = { ...prev }; for (const b of r.data) m[b.id] = b.balance; return m })
      setBalancesLoaded(true)
    } catch { /* keep the last values */ }
  }, [wallets, archived, showArchived])
  useEffect(() => { refreshBalances() }, [refreshBalances])
  useEffect(() => { const t = setInterval(refreshBalances, 30_000); return () => clearInterval(t) }, [refreshBalances])

  useEffect(() => {
    const mint = tokenMint.trim()
    if (mint.length < 32) { setTokenBalances({}); return }
    axios.post('/api/wallets/balances', { mint }).then(r => {
      const m: Record<string, number> = {}
      for (const b of r.data) m[b.id] = b.tokenBalance
      setTokenBalances(m)
    }).catch(() => setTokenBalances({}))
  }, [tokenMint, wallets])

  // Follow open exchange legs until they are final.
  useEffect(() => {
    const open = legs.filter(l => l.transferId && !legDone(l))
    if (!open.length) return
    const t = setInterval(async () => {
      const updates = await Promise.all(open.map(async l => { try { return { id: l.transferId!, s: (await axios.get(`/api/wallets/transfers/${l.transferId}`)).data } } catch { return null } }))
      let landed = false
      setLegs(prev => prev.map(l => {
        const u = updates.find(x => x && x.id === l.transferId)
        if (!u) return l
        if (u.s.status === 'completed' && l.status !== 'completed') landed = true
        return { ...l, status: u.s.status, receipt: u.s.receipt ?? l.receipt, venue: u.s.venue ?? l.venue, reason: u.s.reason }
      }))
      if (landed) refreshBalances()
    }, 6000)
    return () => clearInterval(t)
  }, [legs, refreshBalances])

  const afterChange = async () => { await loadWallets(); notify('funding-changed') }

  // ── funding wallet ──
  const createFunding = async () => {
    setBusy('funding'); setStatus({ kind: 'busy', text: 'Creating the funding wallet…' })
    try {
      const r = await axios.post('/api/wallets/generate', { type: 'funding', label: 'Funding' })
      setNewFiles(r.data.backups ?? [])
      setStatus({ kind: 'ok', text: `Funding wallet created and backed up. Send it SOL to start.` })
      await afterChange()
    } catch (err) { fail(err, 'Create funding wallet') } finally { setBusy(null) }
  }
  const doImport = async (asFunding: boolean) => {
    const key = importKey.trim()
    if (!key) return
    setBusy('import'); setStatus({ kind: 'busy', text: 'Importing…' })
    try {
      const r = await axios.post('/api/wallets/import', { privateKey: key, type: asFunding ? 'funding' : 'manual', label: asFunding ? 'Funding' : 'Imported' })
      setImportKey(''); setShowImport(false)
      setNewFiles(r.data.backup ? [r.data.backup] : [])
      setStatus({ kind: 'ok', text: `Imported ${short(r.data.publicKey)}${r.data.funding ? ' as the funding wallet' : ''} and backed up.` })
      await afterChange()
    } catch (err) { fail(err, 'Import') } finally { setBusy(null) }
  }
  const makeFunding = async (id: string) => {
    if (!confirm('Use this wallet as the funding wallet? It pays for every launch and receives gathers.')) return
    busyRow(id, 'Switching…')
    try { await axios.post(`/api/wallets/${id}/make-funding`); setStatus({ kind: 'ok', text: 'Funding wallet switched' }); await afterChange() }
    catch (err) { fail(err, 'Make funding') } finally { busyRow(id, null) }
  }

  // ── generate ──
  const generate = async () => {
    setBusy('generate'); setStatus({ kind: 'busy', text: `Generating ${genCount} wallet(s)…` })
    try {
      const r = await axios.post('/api/wallets/generate', { count: genCount, type: 'manual', label: genLabel.trim() || 'Wallet' })
      setNewFiles(r.data.backups ?? [])
      setStatus({ kind: 'ok', text: `${r.data.wallets.length} wallet(s) generated; keys written to ${r.data.dir}` })
      await loadWallets()
    } catch (err) { fail(err, 'Generate') } finally { setBusy(null) }
  }

  // ── actions on the selection ──
  const ids = [...selected]
  const amt = Number(fundAmount)

  const fundDirect = async () => {
    if (!ids.length || !(amt > 0)) return
    if (!confirm(`Send ${amt} SOL from the funding wallet to ${ids.length} wallet(s)? They will be linked to the funding wallet on chain.`)) return
    setBusy('fund')
    let ok = 0
    for (const id of ids) {
      busyRow(id, 'Funding…')
      try { await axios.post(`/api/wallets/${id}/fund`, { amount: amt }); ok++ }
      catch (err) { fail(err, 'Fund directly') }
      finally { busyRow(id, null) }
    }
    if (ok) setStatus({ kind: ok === ids.length ? 'ok' : 'warn', text: `Funded ${ok}/${ids.length} wallet(s) from the funding wallet` })
    setBusy(null); setSelected(new Set()); refreshBalances(); notify('funding-changed')
  }

  const fundViaExchange = async () => {
    if (!ids.length || !(amt > 0)) return
    if (!confirm(`Fund ${ids.length} wallet(s) with ${amt} SOL each through an exchange (${fundMode}, venue ${fundVenue})? About ${(amt * ids.length).toFixed(4)} SOL plus exchange fees leaves the funding wallet; each wallet is paid a few minutes later.`)) return
    setBusy('exchange'); setStatus({ kind: 'busy', text: 'Opening the exchange orders and sending the deposits…' })
    try {
      const r = await axios.post('/api/wallets/fund-via-exchange', { walletIds: ids, amountSol: amt, mode: fundMode, venue: fundVenue })
      const got = r.data.legs as FundLeg[]
      setLegs(prev => [...got, ...prev])
      const sent = got.filter(l => l.transferId && l.signature).length
      setStatus({ kind: sent ? 'ok' : 'error', text: sent ? `${sent}/${got.length} deposit(s) sent; the exchange pays each wallet in a few minutes.` : `No deposit sent: ${got[0]?.error ?? 'see the list'}` })
      setSelected(new Set()); notify('funding-changed')
    } catch (err) {
      const e = err as { response?: { data?: { legs?: FundLeg[] } } }
      if (Array.isArray(e.response?.data?.legs)) setLegs(prev => [...e.response!.data!.legs!, ...prev])
      fail(err, 'Fund via exchange')
    } finally { setBusy(null) }
  }

  const gather = async () => {
    const scope = ids.length ? `${ids.length} selected wallet(s)` : 'every active wallet'
    if (!confirm(`Send all SOL from ${scope} back to the funding wallet? Tokens are not sold.`)) return
    setBusy('gather'); setStatus({ kind: 'busy', text: `Gathering SOL from ${scope}…` })
    try {
      const r = await axios.post('/api/wallets/gather', ids.length ? { walletIds: ids } : {})
      const errs = (r.data.wallets as { error?: string }[]).filter(w => w.error)
      setStatus({ kind: errs.length ? 'warn' : 'ok', text: `Recovered ${Number(r.data.totalRecovered).toFixed(6)} SOL${errs.length ? ` (${errs.length} failed: ${errs[0].error})` : ''}` })
      setSelected(new Set()); refreshBalances(); notify('funding-changed')
    } catch (err) { fail(err, 'Gather') } finally { setBusy(null) }
  }

  const closeAccounts = async () => {
    const scope = ids.length ? `${ids.length} selected wallet(s)` : 'the archived wallets'
    if (!confirm(`Close empty token accounts in ${scope}? The rent (~0.002 SOL each) goes to the funding wallet.`)) return
    setBusy('close'); setStatus({ kind: 'busy', text: `Closing empty token accounts in ${scope}…` })
    try {
      const r = await axios.post('/api/wallets/close-token-accounts', ids.length ? { walletIds: ids } : {})
      setStatus({ kind: 'ok', text: `Closed ${r.data.totalClosed} account(s), ~${Number(r.data.totalRecoveredSol).toFixed(4)} SOL back to funding` })
      refreshBalances(); notify('funding-changed')
    } catch (err) { fail(err, 'Close token accounts') } finally { setBusy(null) }
  }

  const exportBackup = async () => {
    setBusy('export')
    try {
      const r = await axios.post('/api/wallets/export-backup')
      setStatus({ kind: 'ok', text: `${r.data.count} wallet(s) backed up in ${r.data.dir} (${r.data.written} new file(s))` })
      await loadWallets()
    } catch (err) { fail(err, 'Export backup') } finally { setBusy(null) }
  }

  const copyKey = async (id: string) => {
    busyRow(id, 'Reading…')
    try { copy((await axios.get(`/api/wallets/${id}/private-key`)).data.privateKey, `pk-${id}`) }
    catch (err) { fail(err, 'Copy key') } finally { busyRow(id, null) }
  }
  const archive = async (w: Wallet, on: boolean) => {
    busyRow(w.id, on ? 'Archiving…' : 'Restoring…')
    try { await axios.patch(`/api/wallets/${w.id}/${on ? 'archive' : 'unarchive'}`); await loadWallets() }
    catch (err) { fail(err, on ? 'Archive' : 'Restore') } finally { busyRow(w.id, null) }
  }
  const remove = async (w: Wallet) => {
    if (!confirm(`Delete ${w.label} (${short(w.publicKey)}) from the vault? Its backup file in the backup folder is kept.`)) return
    busyRow(w.id, 'Deleting…')
    try { await axios.delete(`/api/wallets/${w.id}`); await loadWallets() }
    catch (err) { fail(err, 'Delete') } finally { busyRow(w.id, null) }
  }

  // ── rendering ──
  const toggle = (id: string) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const showTokens = tokenMint.trim().length >= 32
  const colBal = (id: string) => (
    <div className="font-mono" style={{ width: 100, textAlign: 'right', fontSize: 12 }}>
      {balances[id] !== undefined ? `${balances[id].toFixed(4)}` : balancesLoaded ? '0.0000' : <Skeleton width={60} />}
    </div>
  )

  const row = (w: Wallet, isArchived: boolean) => {
    const empty = (balances[w.id] ?? 0) < 0.00001 && !(tokenBalances[w.id] > 0)
    return (
      <div key={w.id} className="table-row" style={{ opacity: isArchived ? 0.7 : 1, gap: 8 }}>
        <div style={{ width: 24 }}><input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} /></div>
        <div style={{ width: 150, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: BADGE_COLORS[w.type] || '#94a3b8' }}>{w.type}</span>
          <span style={{ fontSize: 12, color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={w.label}>{w.label}</span>
        </div>
        <div className="font-mono" style={{ flex: 1, fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span title={w.publicKey} style={{ cursor: 'pointer' }} onClick={() => copy(w.publicKey, w.id)}>{short(w.publicKey, 6)}</span>
          {copied === w.id && <span style={{ fontSize: 10, color: '#34d399' }}>copied</span>}
          {!w.backedUp && <span title={`No backup file in ${backupDir}: this wallet cannot be funded. Click Export backup.`} style={{ fontSize: 9, fontWeight: 700, color: '#fb7185', border: '1px solid rgba(251,113,133,0.4)', borderRadius: 4, padding: '0 4px' }}>NO BACKUP</span>}
        </div>
        {colBal(w.id)}
        {showTokens && <div className="font-mono" style={{ width: 90, textAlign: 'right', fontSize: 12, color: tokenBalances[w.id] > 0 ? '#fbbf24' : '#475569' }}>{fmtTokens(tokenBalances[w.id] ?? 0)}</div>}
        <div style={{ width: 230, display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
          {rowBusy[w.id] ? <span style={{ fontSize: 11, color: '#94a3b8' }}><Busy busy>{rowBusy[w.id]}</Busy></span> : (<>
            <button className="btn-ghost" style={{ fontSize: 11 }} onClick={() => copyKey(w.id)}>{copied === `pk-${w.id}` ? 'Copied!' : 'Copy key'}</button>
            {!isArchived && <button className="btn-ghost" style={{ fontSize: 11, color: '#60a5fa' }} onClick={() => makeFunding(w.id)}>Make funding</button>}
            {isArchived
              ? <button className="btn-ghost" style={{ fontSize: 11, color: '#34d399' }} onClick={() => archive(w, false)}>Restore</button>
              : <button className="btn-ghost" style={{ fontSize: 11, color: '#fbbf24' }} onClick={() => archive(w, true)}>Archive</button>}
            <button className="btn-ghost" style={{ fontSize: 11, color: empty ? '#fb7185' : '#475569' }} disabled={!empty} title={empty ? 'Delete from the vault (backup file kept)' : 'Only an empty wallet can be deleted'} onClick={() => remove(w)}>Delete</button>
          </>)}
        </div>
      </div>
    )
  }

  const header = (
    <div className="table-header" style={{ gap: 8 }}>
      <div style={{ width: 24 }}>
        <input type="checkbox" checked={wallets.length > 0 && wallets.every(w => selected.has(w.id))} disabled={!wallets.length}
          onChange={e => setSelected(e.target.checked ? new Set(wallets.map(w => w.id)) : new Set())} />
      </div>
      <div style={{ width: 150 }}>Wallet</div>
      <div style={{ flex: 1 }}>Address</div>
      <div style={{ width: 100, textAlign: 'right' }}>SOL</div>
      {showTokens && <div style={{ width: 90, textAlign: 'right' }}>Tokens</div>}
      <div style={{ width: 230, textAlign: 'right' }}>Actions</div>
    </div>
  )

  const act = (label: string, key: string, onClick: () => void, opts: { danger?: boolean; disabled?: boolean; tip?: string } = {}) => (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <button className={opts.danger ? 'btn-danger' : 'btn-secondary'} style={{ fontSize: 12, padding: '8px 14px' }} disabled={!!busy || opts.disabled} onClick={onClick}>
        <Busy busy={busy === key}>{label}</Busy>
      </button>
      {opts.tip && <Tip text={opts.tip} />}
    </span>
  )

  return (
    <div className="fade-up">
      <div style={{ marginBottom: 16 }}>
        <h1 className="page-title">Wallets</h1>
        <p className="page-subtitle">Every key lives in the encrypted vault and, in plain text, in your backup folder. Nothing is funded without a backup file.</p>
      </div>

      {/* backup banner */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderRadius: 8, marginBottom: 16, background: 'rgba(20,184,166,0.06)', border: '1px solid rgba(20,184,166,0.2)', fontSize: 12 }}>
        <span style={{ color: '#64748b' }}>Keys are saved to</span>
        <span className="font-mono" style={{ color: '#e2e8f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={backupDir}>{backupDir || '…'}</span>
        <button className="btn-ghost" style={{ fontSize: 11 }} onClick={() => copy(backupDir, 'dir')}>{copied === 'dir' ? 'Copied!' : 'Copy path'}</button>
        <span style={{ color: '#475569' }}>·</span>
        <button className="btn-ghost" style={{ fontSize: 11, color: '#14b8a6' }} disabled={!!busy} onClick={exportBackup}><Busy busy={busy === 'export'}>Export backup</Busy></button>
      </div>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        {/* funding wallet card */}
        <div className="card">
          <h3 className="section-title" style={{ display: 'flex', alignItems: 'center' }}>Funding wallet<Tip text="Pays for every launch, direct fund and exchange deposit; receives gathers and creator fee sweeps. One at a time: 'Make funding' on any wallet switches." /></h3>
          {funding == null ? <Skeleton width={200} /> : funding.configured ? (
            <div style={{ fontSize: 12 }}>
              <div className="font-mono" style={{ color: '#e2e8f0', wordBreak: 'break-all', cursor: 'pointer' }} title="Click to copy" onClick={() => copy(funding.publicKey!, 'funding')}>{funding.publicKey} {copied === 'funding' && <span style={{ color: '#34d399' }}>copied</span>}</div>
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="font-mono" style={{ fontSize: 16, fontWeight: 700, color: '#14b8a6' }}>{funding.balance == null ? '—' : `${funding.balance.toFixed(4)} SOL`}</span>
                {funding.error && <span style={{ color: '#fbbf24', fontSize: 11 }}>balance unavailable: {funding.error}</span>}
                {funding.backedUp === false && <span style={{ fontSize: 10, fontWeight: 700, color: '#fb7185' }}>NO BACKUP FILE: click Export backup</span>}
                <div style={{ flex: 1 }} />
                <button className="btn-ghost" style={{ fontSize: 11 }} onClick={() => funding.id && copyKey(funding.id)}>{copied === `pk-${funding.id}` ? 'Copied!' : 'Copy key'}</button>
                <button className="btn-ghost" style={{ fontSize: 11 }} onClick={() => setShowImport(s => !s)}>Import another</button>
              </div>
              {showImport && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <input className="input font-mono" style={{ fontSize: 12 }} placeholder="Base58 private key" value={importKey} onChange={e => setImportKey(e.target.value)} />
                  <button className="btn-secondary" style={{ fontSize: 12 }} disabled={!!busy || !importKey.trim()} onClick={() => doImport(false)}>Import as wallet</button>
                  <button className="btn-secondary" style={{ fontSize: 12 }} disabled={!!busy || !importKey.trim()} onClick={() => doImport(true)}>Import as funding</button>
                </div>
              )}
            </div>
          ) : (
            <div>
              <p style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>No funding wallet yet. Create one (its key is written to the backup folder first) or import one you already have.</p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn-primary" style={{ fontSize: 13 }} disabled={!!busy} onClick={createFunding}><Busy busy={busy === 'funding'}>Create funding wallet</Busy></button>
                <input className="input font-mono" style={{ fontSize: 12 }} placeholder="or paste a base58 private key" value={importKey} onChange={e => setImportKey(e.target.value)} />
                <button className="btn-secondary" style={{ fontSize: 12 }} disabled={!!busy || !importKey.trim()} onClick={() => doImport(true)}><Busy busy={busy === 'import'}>Import</Busy></button>
              </div>
            </div>
          )}
        </div>

        {/* generate */}
        <div className="card">
          <h3 className="section-title">Generate wallets</h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
            <div><label className="label">Count</label><input type="number" className="input" style={{ width: 70 }} min={1} max={50} value={genCount} onChange={e => setGenCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} /></div>
            <div style={{ flex: 1 }}><label className="label">Label</label><input className="input" placeholder="Wallet" value={genLabel} onChange={e => setGenLabel(e.target.value)} /></div>
            <button className="btn-primary" style={{ fontSize: 13 }} disabled={!!busy} onClick={generate}><Busy busy={busy === 'generate'}>Generate</Busy></button>
          </div>
          <p style={{ fontSize: 11, color: '#64748b', marginTop: 8, marginBottom: 0 }}>Each key is written to the backup folder before the wallet exists in the vault. Fund them below, then pick them on the Launch page.</p>
        </div>
      </div>

      {newFiles.length > 0 && (
        <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 12, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', fontSize: 11 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#34d399', fontWeight: 600 }}>Backup files written</span><button className="btn-ghost" style={{ fontSize: 10 }} onClick={() => setNewFiles([])}>Dismiss</button></div>
          {newFiles.map(f => <div key={f} className="font-mono" style={{ color: '#cbd5e1', wordBreak: 'break-all' }}>{f}</div>)}
        </div>
      )}

      {/* actions row */}
      <div className="card" style={{ marginBottom: 12, padding: '12px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 90 }}>{selected.size} selected</span>
          <input type="number" className="input" style={{ width: 90, padding: '7px 10px', fontSize: 12 }} min={0.001} step={0.01} value={fundAmount} onChange={e => setFundAmount(e.target.value)} title="SOL per wallet" />
          <span style={{ fontSize: 11, color: '#64748b' }}>SOL each</span>
          {act('Fund directly', 'fund', fundDirect, { disabled: !selected.size || !(amt > 0), tip: 'One plain transfer per wallet from the funding wallet (0.001–1 SOL). The wallets are linked to the funding wallet on chain. Refused for a wallet with no backup file.' })}
          <span style={{ display: 'inline-flex', alignItems: 'center' }}>
            <button className="btn-secondary" style={{ fontSize: 12, padding: '8px 14px' }} disabled={!!busy} onClick={() => setShowExchange(s => !s)}>Fund via exchange {showExchange ? '▴' : '▾'}</button>
            <Tip text={venues?.explain ?? 'Each wallet is paid by an exchange hot wallet instead of by your funding wallet (POST /api/transfer/batch). Reduces on-chain linkability.'} />
          </span>
          <div style={{ flex: 1 }} />
          {act('Gather to funding', 'gather', gather, { tip: 'All SOL from the selected wallets (or every active wallet) back to the funding wallet. Tokens are not sold.' })}
          {act('Close empty token accounts', 'close', closeAccounts, { tip: 'Closes zero-balance token accounts in the selected (or archived) wallets; the rent goes to the funding wallet.' })}
          <button className="btn-ghost" style={{ fontSize: 11 }} onClick={() => setShowArchived(s => !s)}>{showArchived ? 'Hide archived' : 'Show archived'}</button>
        </div>
        {showExchange && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(37,51,70,0.5)', display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
            <div><label className="label">Mode</label>
              <select className="input" style={{ fontSize: 12, padding: '7px 28px 7px 10px' }} value={fundMode} onChange={e => setFundMode(e.target.value as 'float' | 'fixed' | 'private')}>
                <option value="float">float · market rate, fastest</option><option value="fixed">fixed · locked output</option><option value="private">private · privacy-coin leg, slower</option>
              </select></div>
            <div style={{ flex: 1, minWidth: 220 }}><label className="label">Venue</label>
              <select className="input" style={{ fontSize: 12, padding: '7px 28px 7px 10px' }} value={fundVenue} onChange={e => setFundVenue(e.target.value)}>
                <option value="auto">auto · best execution</option><option value="random">random · an open venue per wallet</option>
                {Object.entries(venues?.venues ?? {}).map(([name, v]) => <option key={name} value={name} disabled={v.status === 'closed'}>{name}{v.status === 'closed' ? ` · closed` : v.status === 'unknown' ? ' · unknown' : ' · open'}</option>)}
              </select></div>
            <button className="btn-primary" style={{ fontSize: 12 }} disabled={!!busy || !selected.size || !(amt > 0) || venues?.exchange === 'off'} onClick={fundViaExchange}><Busy busy={busy === 'exchange'}>Send via exchange</Busy></button>
            {venues?.exchange === 'off' && <span style={{ fontSize: 11, color: '#fbbf24' }}>Exchange routes are off on this API server right now.</span>}
          </div>
        )}
        {legs.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 11 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#64748b', marginBottom: 4 }}><span>Exchange transfers</span><button className="btn-ghost" style={{ fontSize: 10 }} onClick={() => setLegs(prev => prev.filter(l => !legDone(l)))}>Clear done</button></div>
            {legs.map((l, i) => (
              <div key={`${l.transferId ?? l.walletId}-${i}`} style={{ display: 'flex', gap: 10, padding: '3px 0', borderTop: '1px solid rgba(37,51,70,0.2)' }}>
                <span className="font-mono" style={{ color: '#94a3b8', width: 130 }}>{l.publicKey ? short(l.publicKey, 6) : l.walletId.slice(0, 8)}</span>
                <span style={{ width: 80, color: '#94a3b8' }}>{l.venue ?? '—'}</span>
                <span style={{ width: 150, fontWeight: 600, color: l.error || ['failed', 'expired', 'refunded', 'cancelled', 'refused'].includes(l.status) ? '#fb7185' : l.status === 'completed' ? '#34d399' : '#fbbf24' }} title={l.error ?? l.reason ?? ''}>{l.error ? `${l.status}${l.code ? ` · ${l.code}` : ''}` : l.status.replace(/_/g, ' ')}</span>
                <span className="font-mono">{l.signature ? <a href={`https://solscan.io/tx/${l.signature}`} target="_blank" rel="noreferrer" style={{ color: '#60a5fa' }}>deposit {l.signature.slice(0, 8)}…</a> : ''}</span>
                {l.receipt && <a href={l.receipt} target="_blank" rel="noreferrer" style={{ color: '#60a5fa' }}>receipt</a>}
                {l.error && <span style={{ color: '#fb7185', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.error}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {status && <div style={{ marginBottom: 12, marginTop: -4 }}><Status kind={status.kind} onDismiss={() => setStatus(null)}>{status.text}</Status></div>}

      {/* the table */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: '#64748b' }}>Token balance for mint</span>
        <input className="input font-mono" style={{ width: 420, fontSize: 11, padding: '5px 10px' }} placeholder="paste a mint to add a Tokens column" value={tokenMint} onChange={e => setTokenMint(e.target.value)} />
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" style={{ fontSize: 11 }} onClick={refreshBalances}>Refresh balances</button>
      </div>
      <div className="card-flat">
        {header}
        {wallets.length === 0 ? <div style={{ padding: 28, textAlign: 'center', color: '#64748b', fontSize: 13 }}>No wallets yet. Generate some above.</div> : wallets.map(w => row(w, false))}
      </div>

      {showArchived && (
        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', margin: 0 }}>Archived ({archived.length})</h3>
            {archived.length > 0 && <button className="btn-ghost" style={{ fontSize: 11, color: '#fb7185' }} onClick={async () => {
              if (!confirm(`Delete all ${archived.length} archived wallet(s) from the vault? Their backup files are kept.`)) return
              try { await axios.delete('/api/wallets', { params: { status: 'archived' } }); await loadWallets() } catch (err) { fail(err, 'Delete archived') }
            }}>Delete all archived</button>}
          </div>
          <div className="card-flat">
            {header}
            {archived.length === 0 ? <div style={{ padding: 20, textAlign: 'center', color: '#475569', fontSize: 12 }}>No archived wallets</div> : archived.map(w => row(w, true))}
          </div>
        </div>
      )}
    </div>
  )
}
