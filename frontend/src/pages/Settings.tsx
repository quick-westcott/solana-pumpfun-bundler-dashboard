import { useEffect, useState } from 'react'
import axios from 'axios'
import { notify } from '../components/layout/Layout'
import { Busy } from '../components/ui/Spinner'
import type { ApiStatus } from '../types'
import { errorMessage } from '../types'

interface SettingsView {
  apiUrl: string
  apiKeySet: boolean
  apiKeyFrom: 'settings' | 'env' | 'none'
  jitoTipLamports: number | null
  effective: { apiUrl: string; jitoTipLamports: number }
  defaults: { apiUrl: string; apiKeySet: boolean; jitoTipLamports: number }
  backupDir: string
  createKeyUrl: string
}

const CREATE_KEY_URL = 'https://api.trenchy.tools/api/create-api-key'

export default function Settings() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [status, setStatus] = useState<ApiStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [tipSol, setTipSol] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = () => {
    axios.get<SettingsView>('/api/settings').then(r => {
      setView(r.data)
      setApiUrl(r.data.apiUrl)
      setTipSol(r.data.jitoTipLamports != null ? String(r.data.jitoTipLamports / 1e9) : '')
    }).catch(() => {})
  }
  const check = () => {
    setStatus(null)
    axios.get<ApiStatus>('/api/settings/status').then(r => setStatus(r.data)).catch(() => setStatus({ url: '', configured: false, ok: false, error: 'backend unreachable' }))
  }
  useEffect(() => { load(); check() }, [])

  const save = async (patch: Record<string, unknown>, done: string) => {
    setSaving(true); setMsg(null)
    try {
      await axios.put('/api/settings', patch)
      setMsg({ ok: true, text: done })
      load(); check(); notify('settings-changed')
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) })
    } finally { setSaving(false) }
  }

  const saveKey = () => { if (apiKey.trim()) save({ apiKey: apiKey.trim() }, 'API key saved to backend/keys/settings.json').then(() => setApiKey('')) }
  const clearKey = () => save({ apiKey: null }, view?.defaults.apiKeySet ? 'Saved key removed; using the key from backend/.env' : 'Saved key removed')
  const saveUrl = () => save({ apiUrl: apiUrl.trim() || null }, apiUrl.trim() ? 'API URL saved' : 'API URL back to the default')
  const saveTip = () => {
    const s = tipSol.trim()
    if (!s) return save({ jitoTipLamports: null }, 'Jito tip back to the .env default')
    const n = Number(s)
    if (isNaN(n) || n < 0) return setMsg({ ok: false, text: 'Jito tip must be a SOL amount, e.g. 0.005' })
    return save({ jitoTipLamports: Math.round(n * 1e9) }, `Jito tip saved: ${n} SOL`)
  }

  const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center' }

  return (
    <div className="fade-up" style={{ maxWidth: 720 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Saved to backend/keys/settings.json; backend/.env holds the defaults.</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">TrenchyTools API key</h3>
        <div style={{
          marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
          background: status?.ok ? 'rgba(52,211,153,0.08)' : 'rgba(245,158,11,0.08)', border: `1px solid ${status?.ok ? 'rgba(52,211,153,0.35)' : 'rgba(245,158,11,0.35)'}`,
        }}>
          <span style={{ color: status?.ok ? '#34d399' : '#fbbf24' }}>
            {status == null ? 'Checking…'
              : status.ok ? <>Connected to {status.url} · key <span className="font-mono">{status.keyPrefix}…</span> · {status.calls30d ?? 0} calls in 30 days</>
              : status.configured ? `Not connected: ${status.error}` : 'No API key yet'}
          </span>
          <button className="btn-ghost" style={{ fontSize: 11, flexShrink: 0 }} onClick={check}>Re-check</button>
        </div>
        <div style={row}>
          <input className="input font-mono" type="password" style={{ fontSize: 13 }} value={apiKey} onChange={e => setApiKey(e.target.value)}
            placeholder={view?.apiKeyFrom === 'settings' ? 'A key is saved. Paste a new one to replace it.' : view?.apiKeyFrom === 'env' ? 'Using TRENCHY_API_KEY from backend/.env. Paste one here to use it instead.' : 'Paste your API key'} />
          <button className="btn-primary" style={{ padding: '10px 16px', fontSize: 13 }} disabled={saving || !apiKey.trim()} onClick={saveKey}><Busy busy={saving}>Save</Busy></button>
          {view?.apiKeyFrom === 'settings' && <button className="btn-secondary" style={{ padding: '10px 14px', fontSize: 12 }} disabled={saving} onClick={clearKey}>Remove</button>}
        </div>
        <p style={{ fontSize: 11, color: '#64748b', marginTop: 8 }}>
          No key yet? <a href={view?.createKeyUrl || CREATE_KEY_URL} target="_blank" rel="noreferrer" style={{ color: '#14b8a6' }}>Create a key</a> (one call, free, shown once) and paste it here.
          Every chain call goes through it: building and sending transactions, Jito bundles, balances, metadata uploads, live trades, vanity mints.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Jito tip default</h3>
        <div style={row}>
          <input className="input font-mono" style={{ width: 160, fontSize: 13 }} value={tipSol} onChange={e => setTipSol(e.target.value)} placeholder={view ? String(view.defaults.jitoTipLamports / 1e9) : '0.005'} />
          <span style={{ fontSize: 12, color: '#64748b' }}>SOL per launch bundle · in use: <span className="font-mono">{view ? view.effective.jitoTipLamports / 1e9 : '…'} SOL</span></span>
          <div style={{ flex: 1 }} />
          <button className="btn-secondary" style={{ padding: '8px 14px', fontSize: 12 }} disabled={saving} onClick={saveTip}>Save</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Wallet backup folder</h3>
        <div className="font-mono" style={{ fontSize: 12, color: '#e2e8f0', wordBreak: 'break-all', padding: '8px 10px', background: 'rgba(15,23,42,0.5)', borderRadius: 8 }}>{view?.backupDir ?? '…'}</div>
        <p style={{ fontSize: 11, color: '#64748b', marginTop: 8, marginBottom: 0 }}>
          Every wallet is written here (one JSON per wallet plus wallets.csv) before it can be funded. Change it with <span className="font-mono">WALLET_BACKUP_DIR</span> in backend/.env and restart.
        </p>
      </div>

      <details className="card" style={{ marginBottom: 16 }}>
        <summary style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', cursor: 'pointer' }}>Advanced</summary>
        <div style={{ marginTop: 12 }}>
          <label className="label">API URL</label>
          <div style={row}>
            <input className="input font-mono" style={{ fontSize: 13 }} value={apiUrl} onChange={e => setApiUrl(e.target.value)} placeholder={`${view?.defaults.apiUrl ?? 'https://api.trenchy.tools'} (default)`} />
            <button className="btn-secondary" style={{ padding: '8px 14px', fontSize: 12 }} disabled={saving} onClick={saveUrl}>Save</button>
          </div>
          <p style={{ fontSize: 11, color: '#64748b', marginTop: 6, marginBottom: 0 }}>Only for running the API yourself (apps/api → http://localhost:4810). Leave empty for the hosted API.</p>
        </div>
      </details>

      {msg && <div style={{ fontSize: 12, color: msg.ok ? '#34d399' : '#fb7185' }}>{msg.text}</div>}
    </div>
  )
}
