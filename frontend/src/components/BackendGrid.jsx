import InfoTip from './InfoTip.jsx'

const STATUS_DOT_TIP = {
  healthy: 'Healthy. Connections and latency within normal range.',
  warning: 'Warning. Connections at 65–85% of the 500 limit.',
  critical: 'Critical. Above 85% capacity. VAST node availability at risk.',
}

/** Only vast-01 shows (i) help — demo focal node; avoids clutter and stacking issues on the rest of the grid. */
const TIP_NODE_ID = 'vast-01'

function ConnectionBar({ pct, status }) {
  const color = status === 'critical' ? 'var(--red)' : status === 'warning' ? 'var(--amber)' : 'var(--green)'
  return (
    <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginTop: 4 }}>
      <div style={{
        height: '100%', width: `${Math.min(pct, 100)}%`,
        background: color, borderRadius: 2,
        transition: 'width 0.8s ease',
      }} />
    </div>
  )
}

function Metric({ label, value, unit, color, small, tooltip }) {
  const inner = (
    <>
      <div style={{
        fontFamily: 'var(--font-ui)', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase',
        letterSpacing: '0.05em', marginBottom: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, minWidth: 0,
      }}>
        {tooltip ? (
          <InfoTip content={tooltip}>
            <span>{label}</span>
          </InfoTip>
        ) : (
          <span>{label}</span>
        )}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: small ? 10 : 12, color, fontWeight: 500 }}>
        {value}{unit && <span style={{ color: 'var(--text-muted)', fontSize: 10, marginLeft: 2 }}>{unit}</span>}
      </div>
    </>
  )
  return <div>{inner}</div>
}

function BackendCard({ b, showTooltips }) {
  const statusColor = {
    healthy:  'var(--green)',
    warning:  'var(--amber)',
    critical: 'var(--red)',
  }[b.status]

  const borderColor = b.status !== 'healthy'
    ? statusColor + '80'
    : b.is_cross_dc ? 'var(--blue)40' : 'var(--border)'

  return (
    <div
      className="animate-in"
      style={{
        background: 'var(--surface)',
        border: `0.5px solid ${borderColor}`,
        borderRadius: 6,
        padding: '12px 14px',
        position: 'relative',
        transition: 'border-color 0.5s ease',
        overflow: 'visible',
        /** Lift focal card above siblings so popovers aren’t painted under vast-02 / vast-03 (grid DOM order). */
        zIndex: showTooltips ? 40 : undefined,
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginBottom: 10,
      }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>
          {b.id}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: statusColor,
            boxShadow: b.status === 'critical' ? `0 0 8px ${statusColor}` : 'none',
            animation: b.status === 'critical' ? 'pulse-red 1.5s infinite' : 'none',
          }} />
          {showTooltips ? (
            <InfoTip iconOnly content={STATUS_DOT_TIP[b.status] || STATUS_DOT_TIP.healthy} />
          ) : null}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {b.is_cross_dc && (
          showTooltips ? (
            <InfoTip content="Dedicated replication pool. Isolated from same-DC traffic to contain blast radius.">
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 500,
                padding: '1px 5px', borderRadius: 3,
                color: 'var(--blue)', background: 'var(--blue-dim)',
                border: '0.5px solid var(--blue)40',
                letterSpacing: '0.04em',
              }}>
                CROSS-DC
              </span>
            </InfoTip>
          ) : (
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 500,
              padding: '1px 5px', borderRadius: 3,
              color: 'var(--blue)', background: 'var(--blue-dim)',
              border: '0.5px solid var(--blue)40',
              letterSpacing: '0.04em',
            }}>
              CROSS-DC
            </span>
          )
        )}
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          {showTooltips ? (
            <InfoTip content="Active connections. 500 is the per-node ceiling before availability fails. The bar shows utilisation toward that hard limit.">
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Connections
              </span>
            </InfoTip>
          ) : (
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Connections
            </span>
          )}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: statusColor, flexShrink: 0 }}>
            {b.connections} <span style={{ color: 'var(--text-muted)' }}>/ 500</span>
          </span>
        </div>
        <ConnectionBar pct={b.connection_utilisation_pct} status={b.status} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <Metric
          label="RPS"
          value={b.rps.toFixed(0)}
          unit=""
          color={b.rps > 8000 ? 'var(--red)' : 'var(--text)'}
          tooltip={showTooltips ? 'Requests per second on this backend. Normal: ~1,500. DNS stickiness: one backend hits 9,000+.' : undefined}
        />
        <Metric
          label="P99"
          value={b.latency_p99_ms.toFixed(0)}
          unit="ms"
          color={b.latency_p99_ms > 100 ? 'var(--red)' : b.latency_p99_ms > 20 ? 'var(--amber)' : 'var(--text)'}
          tooltip={showTooltips ? 'Response time for 99% of requests. Same-DC normal: 3–5ms. Cross-DC normal: 55–65ms.' : undefined}
        />
        <Metric
          label="IO Timeouts"
          value={b.io_timeouts_per_min.toFixed(1)}
          unit="/min"
          color={b.io_timeouts_per_min > 8 ? 'var(--red)' : b.io_timeouts_per_min > 3 ? 'var(--amber)' : 'var(--text-muted)'}
          tooltip={showTooltips ? 'Stale connections from clients not reading responses. Above 5/min signals connection exhaustion.' : undefined}
        />
        <Metric
          label="IP"
          value={b.ip}
          unit=""
          color="var(--text-muted)"
          small
          tooltip={showTooltips ? 'VAST virtual IP. DNS caching causes apps to stick to one IP — the problem Storefront fixes.' : undefined}
        />
      </div>
    </div>
  )
}

export default function BackendGrid({ backends }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          VAST Backend Pool
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
          {backends.backends.filter(b => b.healthy).length} / {backends.backends.length} healthy
        </span>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 10,
      }}
      >
        {backends.backends.map(b => (
          <BackendCard
            key={b.id}
            b={b}
            showTooltips={b.id === TIP_NODE_ID}
          />
        ))}
      </div>
    </div>
  )
}
