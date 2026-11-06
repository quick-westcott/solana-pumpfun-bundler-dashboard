import type { CSSProperties, ReactNode } from 'react'

/** A small rotating ring, inline with text. */
export function Spinner({ size = 12, color = 'currentColor', style }: { size?: number; color?: string; style?: CSSProperties }) {
  return (
    <span aria-hidden className="spinner" style={{ width: size, height: size, borderColor: `${color}33`, borderTopColor: color, ...style }} />
  )
}

/** Button content that swaps to a spinner + "doing…" label while busy. */
export function Busy({ busy, children, busyLabel }: { busy: boolean; children: ReactNode; busyLabel?: ReactNode }) {
  if (!busy) return <>{children}</>
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Spinner />
      {busyLabel ?? children}
    </span>
  )
}

/** A shimmering placeholder for a value that is still loading. */
export function Skeleton({ width = 64, height = 12 }: { width?: number | string; height?: number }) {
  return <span className="skel" style={{ width, height }} />
}

/** One line of status under an action: what is happening now, or what just happened. */
export function Status({ kind, children, onDismiss }: { kind: 'busy' | 'ok' | 'warn' | 'error'; children: ReactNode; onDismiss?: () => void }) {
  const color = kind === 'ok' ? '#34d399' : kind === 'warn' ? '#fbbf24' : kind === 'error' ? '#fb7185' : '#94a3b8'
  const bg = kind === 'ok' ? 'rgba(16,185,129,0.08)' : kind === 'warn' ? 'rgba(251,191,36,0.08)' : kind === 'error' ? 'rgba(244,63,94,0.08)' : 'rgba(99,102,241,0.08)'
  const border = kind === 'ok' ? 'rgba(16,185,129,0.2)' : kind === 'warn' ? 'rgba(251,191,36,0.25)' : kind === 'error' ? 'rgba(244,63,94,0.2)' : 'rgba(99,102,241,0.2)'
  return (
    <div className="fade-up" style={{ padding: '8px 12px', borderRadius: 8, marginTop: 10, background: bg, border: `1px solid ${border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12, color }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {kind === 'busy' && <Spinner />}
        {children}
      </span>
      {onDismiss && kind !== 'busy' && <button className="btn-ghost" style={{ fontSize: 10 }} onClick={onDismiss}>Dismiss</button>}
    </div>
  )
}
