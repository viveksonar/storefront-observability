const MODES = [
  {
    id: 'normal',
    label: 'Reset to Normal',
    description: 'Storefront active · Least-inflight-requests routing · All backends healthy',
    color: 'var(--green)',
    border: 'var(--green)',
  },
  {
    id: 'dns_stickiness',
    label: 'DNS Stickiness',
    description: 'Microsoft DNS TTL=1s · One backend absorbs 76% RPS · Pre-Storefront failure',
    color: 'var(--red)',
    border: 'var(--red)',
    article: 'Storefront article Feb 2026 — original problem that motivated the build',
  },
  {
    id: 'connection_exhaustion',
    label: 'Connection Exhaustion',
    description: 'Bad S3 client not reading responses · Connections accumulate over 80s · IO stream timeouts firing',
    color: 'var(--red)',
    border: 'var(--red)',
    article: 'Storefront article Feb 2026 — IO stream timeout fix',
  },
  {
    id: 'cross_dc_throttling',
    label: 'Cross-DC Throttling',
    description: 'Backup replication saturates cross-DC pool · Collateral latency on same-DC backends',
    color: 'var(--amber)',
    border: 'var(--amber)',
    article: 'Storefront article Feb 2026 — distinct upstream pools fix',
  },
]

export default function FailureControls({ currentMode, onTrigger }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '0.5px solid var(--border)',
      borderRadius: 6,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 14px',
        borderBottom: '0.5px solid var(--border)',
      }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Failure Mode Simulator
        </span>
      </div>

      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {MODES.map(m => {
          const isActive = currentMode === m.id
          return (
            <button
              key={m.id}
              onClick={() => onTrigger(m.id)}
              style={{
                background: isActive ? m.color + '18' : 'var(--surface-2)',
                border: `0.5px solid ${isActive ? m.border + 'aa' : 'var(--border)'}`,
                borderRadius: 5,
                padding: '10px 12px',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.2s ease',
                outline: 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500,
                  color: isActive ? m.color : 'var(--text)',
                }}>
                  {m.label}
                </span>
                {isActive && (
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 9,
                    color: m.color, letterSpacing: '0.06em',
                  }}>
                    ACTIVE
                  </span>
                )}
              </div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                {m.description}
              </div>
              {m.article && (
                <div style={{
                  marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 9,
                  color: isActive ? m.color + 'aa' : 'var(--text-dim)',
                  fontStyle: 'italic',
                }}>
                  {m.article}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
