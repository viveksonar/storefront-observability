/**
 * Incident registry — SQLite-backed incidents surface here so TPMs see
 * durable evidence instead of reconstructing outages from memory.
 */

function fmtDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return '—'
  const s = Math.floor(sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m === 0) return `${r}s`
  return `${m}m ${r}s`
}

function fmtTime(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString()
}

function badgeColor(mode) {
  switch (mode) {
    case 'dns_stickiness':
      return 'var(--red)'
    case 'connection_exhaustion':
      return 'var(--red)'
    case 'cross_dc_throttling':
      return 'var(--amber)'
    default:
      return 'var(--text-muted)'
  }
}

export default function IncidentPanel({ incidents, activeIncident, onViewReport }) {
  const topFive = (incidents || []).slice(0, 5)

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>
          Incident timeline
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
          SQLite · last 5
        </span>
      </div>

      {activeIncident && (
        <div
          style={{
            borderRadius: 4,
            border: '1px solid var(--red)',
            background: 'var(--red-dim)',
            padding: '10px 12px',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--red)',
            animation: 'pulse-red 2s infinite',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ letterSpacing: '0.06em' }}>ACTIVE INCIDENT</strong>
          </div>
          <div style={{ marginTop: 6, color: 'var(--text)', fontSize: 11 }}>
            INC-{activeIncident.id} · {activeIncident.failure_type.replace(/_/g, ' ')}
          </div>
        </div>
      )}

      {!topFive.length && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', padding: '8px 0' }}>
          No incidents recorded yet — trigger a failure mode to open an incident row.
        </div>
      )}

      {topFive.map((inc) => (
        <div
          key={inc.id}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            background: 'var(--surface-2)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                INC-{inc.id}
              </span>
              <span
                style={{
                  marginLeft: 8,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  padding: '2px 6px',
                  borderRadius: 3,
                  border: `1px solid ${badgeColor(inc.failure_type)}`,
                  color: badgeColor(inc.failure_type),
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {inc.failure_type.replace(/_/g, ' ')}
              </span>
            </div>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: inc.status === 'active' ? 'var(--red)' : 'var(--green)',
                animation: inc.status === 'active' ? 'pulse-red 2s infinite' : 'none',
              }}
            >
              {inc.status === 'active' ? '● active' : '● resolved'}
            </span>
          </div>

          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
            {fmtTime(inc.start_time)}
            <span style={{ margin: '0 6px', color: 'var(--border-bright)' }}>|</span>
            duration {inc.status === 'active' ? 'ongoing' : fmtDuration(inc.duration_seconds)}
          </div>

          <button
            type="button"
            onClick={() => onViewReport(inc.id)}
            style={{
              alignSelf: 'flex-start',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              padding: '6px 12px',
              borderRadius: 4,
              border: '1px solid var(--blue)',
              background: 'var(--blue-dim)',
              color: 'var(--blue)',
              cursor: 'pointer',
              letterSpacing: '0.04em',
            }}
          >
            View Report
          </button>
        </div>
      ))}
    </div>
  )
}
