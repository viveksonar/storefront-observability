import InfoTip from './InfoTip.jsx'

const SEVERITY_STYLE = {
  critical: { color: 'var(--red)',   bg: 'var(--red-dim)',   label: 'CRIT', tip: 'Immediate action required.' },
  warning:  { color: 'var(--amber)', bg: 'var(--amber-dim)', label: 'WARN', tip: 'Elevated. Monitor for escalation.' },
}

const TYPE_TOOLTIP = {
  dns_stickiness:
    "One backend handling 50%+ of RPS. DNS cache bypassing Storefront's load balancing.",
  connection_exhaustion: 'Backend above 85% capacity. Bad S3 client holding connections open.',
  cross_dc_throttling:
    'Cross-DC backend P99 above 200ms. Replication job saturating the dedicated pool.',
  cross_dc_collateral:
    '3+ same-DC backends showing elevated latency. Shared VAST resources affected by cross-DC load.',
}

export default function AnomalyPanel({ anomalies }) {
  const hasAlerts = anomalies.count > 0

  return (
    <div style={{
      background: 'var(--surface)',
      border: `0.5px solid ${hasAlerts ? 'var(--red)40' : 'var(--border)'}`,
      borderRadius: 6,
      overflow: 'visible',
      transition: 'border-color 0.4s ease',
    }}>
      <div style={{
        padding: '10px 14px',
        borderBottom: '0.5px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: hasAlerts ? 'var(--red-dim)' : 'transparent',
        transition: 'background 0.4s ease',
      }}>
        <InfoTip content="Anomalies currently firing. Zero is the only acceptable number.">
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Active Anomalies
          </span>
        </InfoTip>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500,
          color: hasAlerts ? 'var(--red)' : 'var(--green)',
        }}>
          {anomalies.count === 0 ? 'all clear' : `${anomalies.count} active`}
        </span>
      </div>

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
            const typeTip = TYPE_TOOLTIP[alert.type] || alert.type.replace(/_/g, ' ')
            return (
              <div key={i} className="animate-in" style={{
                padding: '12px 14px',
                borderBottom: i < anomalies.alerts.length - 1 ? '0.5px solid var(--border)' : 'none',
                background: i % 2 === 0 ? 'transparent' : 'var(--surface-2)',
                animationDelay: `${i * 60}ms`,
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                  <InfoTip content={s.tip}>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600,
                      padding: '2px 5px', borderRadius: 3,
                      color: s.color, background: s.bg,
                      letterSpacing: '0.04em',
                    }}>
                      {s.label}
                    </span>
                  </InfoTip>
                  <InfoTip content={typeTip}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: s.color, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {alert.type.replace(/_/g, ' ')}
                    </span>
                  </InfoTip>
                </div>

                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text)', lineHeight: 1.5, marginBottom: 6 }}>
                  {alert.message}
                </div>

                <div style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)',
                  borderLeft: `2px solid ${s.color}40`, paddingLeft: 8, lineHeight: 1.4,
                  fontStyle: 'italic',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>{alert.article_ref}</div>
                  <InfoTip iconOnly content="Source passage from Agoda's engineering blog. Every threshold has a citation." />
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
