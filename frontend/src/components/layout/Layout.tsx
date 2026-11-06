import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import axios from 'axios'
import { RocketLaunchIcon, WalletIcon, ChartBarIcon, Cog6ToothIcon } from '@heroicons/react/24/outline'
import type { ApiStatus, FundingInfo } from '../../types'
import { short } from '../../types'

const NAV = [
  { to: '/', label: 'Launch', Icon: RocketLaunchIcon },
  { to: '/wallets', label: 'Wallets', Icon: WalletIcon },
  { to: '/trading', label: 'Trading', Icon: ChartBarIcon },
  { to: '/settings', label: 'Settings', Icon: Cog6ToothIcon },
]

/** Pages fire these when something the strip shows changed. */
export const notify = (what: 'funding-changed' | 'settings-changed') => window.dispatchEvent(new Event(what))

function StatusStrip() {
  const [api, setApi] = useState<ApiStatus | null>(null)
  const [funding, setFunding] = useState<FundingInfo | null>(null)
  const [backupDir, setBackupDir] = useState('')

  const loadApi = useCallback(() => {
    axios.get('/api/settings/status').then(r => setApi(r.data)).catch(() => setApi({ url: '', configured: false, ok: false, error: 'backend unreachable' }))
    axios.get('/api/settings').then(r => setBackupDir(r.data.backupDir ?? '')).catch(() => {})
  }, [])
  const loadFunding = useCallback(() => {
    axios.get('/api/wallets/funding').then(r => setFunding(r.data)).catch(() => {})
  }, [])

  useEffect(() => {
    loadApi(); loadFunding()
    const t = setInterval(loadFunding, 30_000)
    window.addEventListener('funding-changed', loadFunding)
    window.addEventListener('settings-changed', loadApi)
    return () => { clearInterval(t); window.removeEventListener('funding-changed', loadFunding); window.removeEventListener('settings-changed', loadApi) }
  }, [loadApi, loadFunding])

  const dot = (ok: boolean | null) => <span style={{ width: 7, height: 7, borderRadius: '50%', background: ok === null ? '#475569' : ok ? '#34d399' : '#fbbf24', flexShrink: 0 }} />
  const item = (children: React.ReactNode) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>{children}</span>
  const sep = <span style={{ width: 1, height: 14, background: 'rgba(37,51,70,0.6)' }} />

  return (
    <header className="top-header" style={{ gap: 14, fontSize: 11, color: '#94a3b8', justifyContent: 'flex-start', overflow: 'hidden' }}>
      {item(<>
        {dot(api ? api.ok : null)}
        <span style={{ color: '#64748b' }}>API:</span>
        {api == null ? 'checking…' : api.ok ? <>connected · key <span className="font-mono">{api.keyPrefix}…</span></> : api.configured ? <span style={{ color: '#fbbf24' }}>not connected · {api.error}</span> : <NavLink to="/settings" style={{ color: '#fbbf24' }}>add your key in Settings</NavLink>}
      </>)}
      {sep}
      {item(<>
        {dot(funding ? funding.configured : null)}
        <span style={{ color: '#64748b' }}>Funding:</span>
        {funding == null ? '…' : funding.configured
          ? <><span className="font-mono" title={funding.publicKey} style={{ cursor: 'pointer' }} onClick={() => navigator.clipboard.writeText(funding.publicKey || '')}>{short(funding.publicKey || '')}</span> · <span className="font-mono" style={{ color: '#14b8a6', fontWeight: 700 }}>{funding.balance == null ? '—' : `${funding.balance.toFixed(4)} SOL`}</span></>
          : <NavLink to="/wallets" style={{ color: '#fbbf24' }}>create one in Wallets</NavLink>}
      </>)}
      {sep}
      {item(<>
        <span style={{ color: '#64748b' }}>Backups:</span>
        <span className="font-mono" title={backupDir} style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 420 }}>{backupDir || '…'}</span>
      </>)}
    </header>
  )
}

export default function Layout() {
  return (
    <div className="layout-root">
      <div className="noise-bg" />
      <div className="ambient-glow" />
      <aside className="sidebar">
        <a href="https://trenchy.tools" target="_blank" rel="noopener noreferrer" className="sidebar-logo">
          <img src="/image/trenchy_toolz_wide_transparent.png" alt="TrenchyTools" style={{ height: 36, width: 'auto', objectFit: 'contain' }} />
        </a>
        <nav style={{ flex: 1, padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <n.Icon style={{ width: 18, height: 18, flexShrink: 0 }} />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ padding: '12px 18px', borderTop: '1px solid rgba(37,51,70,0.5)', fontSize: 10, color: '#475569', lineHeight: 1.6 }}>
          pump.fun launcher on the <a href="https://api.trenchy.tools" target="_blank" rel="noreferrer" style={{ color: '#64748b' }}>TrenchyTools API</a>.
          No RPC, Jito or IPFS keys here; your wallet keys never leave this machine.
        </div>
      </aside>
      <div className="main-area">
        <StatusStrip />
        <main style={{ padding: 24 }}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
