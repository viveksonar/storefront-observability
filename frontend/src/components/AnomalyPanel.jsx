const SEVERITY_STYLE = {
  critical: { color: 'var(--red)',   bg: 'var(--red-dim)',   label: 'CRIT' },
  warning:  { color: 'var(--amber)', bg: 'var(--amber-dim)', label: 'WARN' },
}

const TYPE_ICON = {
  dns_stickiness:        '⬡',
  connection_exhaustion: '⬡',
  cross_dc_throttling:   '⬡',
  cross_dc_collateral:   '⬡',
}

export default function AnomalyPanel({ anomalies }) {
  const hasAlerts = anomalies.count > 0

  return (
    <div style={{
      background: 'var(--surface)',
      border: `0.5px solid ${hasAlerts ? 'var(--red)40' : 'var(--border)'}`,
      borderRadius: 6,
      overflow: 'hidden',
      transition: 'border-color 0.4s ease',
    }}>
      {/* Panel header */}
      <div style={{
        padding: '10px 14px',
        borderBottom: '0.5px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: hasAlerts ? 'var(--red-dim)' : 'transparent',
        transition: 'background 0.4s ease',
      }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Active Anomalies
        </span>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500,
          color: hasAlerts ? 'var(--red)' : 'var(--green)',
        }}>
          {anomalies.count === 0 ? 'all clear' : `${anomalies.count} active`}
        </span>
      </div>

      {/* Alerts */}
      <div style={{ padding: hasAlerts ? 0 : 14 }}>
        {!hasAlerts ? (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green)', marginBottom: 4 }}>
              ✓ No anomalies detected
            </div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>
              Load balanced · Connections nominal · Latency within SLO
            </div>
          </div>
        ) : (
          anomalies.alerts.map((alert, i) => {
            const s = SEVERITY_STYLE[alert.severity] || SEVERITY_STYLE.warning
            return (
              <div key={i} className="animate-in" style={{
                padding: '12px 14px',
                borderBottom: i < anomalies.alerts.length - 1 ? '0.5px solid var(--border)' : 'none',
                background: i % 2 === 0 ? 'transparent' : 'var(--surface-2)',
                animationDelay: `${i * 60}ms`,
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600,
                    padding: '2px 5px', borderRadius: 3,
                    color: s.color, background: s.bg,
                    letterSpacing: '0.04em', flexShrink: 0, marginTop: 1,
                  }}>
                    {s.label}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: s.color, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {alert.type.replace(/_/g, ' ')}
                  </span>
                </div>

                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text)', lineHeight: 1.5, marginBottom: 6 }}>
                  {alert.message}
                </div>

                {/* Article citation — this is the key differentiator */}
                <div style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)',
                  borderLeft: `2px solid ${s.color}40`, paddingLeft: 8, lineHeight: 1.4,
                  fontStyle: 'italic',
                }}>
                  {alert.article_ref}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
