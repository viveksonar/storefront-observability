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

function BackendCard({ b }) {
  const statusColor = {
    healthy:  'var(--green)',
    warning:  'var(--amber)',
    critical: 'var(--red)',
  }[b.status]

  const borderColor = b.status !== 'healthy'
    ? statusColor + '80'
    : b.is_cross_dc ? 'var(--blue)40' : 'var(--border)'

  return (
    <div className="animate-in" style={{
      background: 'var(--surface)',
      border: `0.5px solid ${borderColor}`,
      borderRadius: 6,
      padding: '12px 14px',
      position: 'relative',
      transition: 'border-color 0.5s ease',
    }}>
      {/* Status dot */}
      <div style={{
        position: 'absolute', top: 10, right: 10,
        width: 7, height: 7, borderRadius: '50%',
        background: statusColor,
        boxShadow: b.status === 'critical' ? `0 0 8px ${statusColor}` : 'none',
        animation: b.status === 'critical' ? 'pulse-red 1.5s infinite' : 'none',
      }} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>
          {b.id}
        </span>
        {b.is_cross_dc && (
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 500,
            padding: '1px 5px', borderRadius: 3,
            color: 'var(--blue)', background: 'var(--blue-dim)',
            border: '0.5px solid var(--blue)40',
            letterSpacing: '0.04em',
          }}>
            CROSS-DC
          </span>
        )}
      </div>

      {/* Connection utilisation */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Connections
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: statusColor }}>
            {b.connections} <span style={{ color: 'var(--text-muted)' }}>/ 500</span>
          </span>
        </div>
        <ConnectionBar pct={b.connection_utilisation_pct} status={b.status} />
      </div>

      {/* Metrics row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <Metric label="RPS" value={b.rps.toFixed(0)} unit="" color={b.rps > 8000 ? 'var(--red)' : 'var(--text)'} />
        <Metric label="P99" value={b.latency_p99_ms.toFixed(0)} unit="ms"
          color={b.latency_p99_ms > 100 ? 'var(--red)' : b.latency_p99_ms > 20 ? 'var(--amber)' : 'var(--text)'} />
        <Metric label="IO Timeouts" value={b.io_timeouts_per_min.toFixed(1)} unit="/min"
          color={b.io_timeouts_per_min > 8 ? 'var(--red)' : b.io_timeouts_per_min > 3 ? 'var(--amber)' : 'var(--text-muted)'} />
        <Metric label="IP" value={b.ip} unit="" color="var(--text-muted)" small />
      </div>
    </div>
  )
}

function Metric({ label, value, unit, color, small }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 1 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: small ? 10 : 12, color, fontWeight: 500 }}>
        {value}{unit && <span style={{ color: 'var(--text-muted)', fontSize: 10, marginLeft: 2 }}>{unit}</span>}
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
      }}>
        {backends.backends.map(b => (
          <BackendCard key={b.id} b={b} />
        ))}
      </div>
    </div>
  )
}
