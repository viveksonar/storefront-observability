import InfoTip from './InfoTip.jsx'

export default function SummaryBar({ summary }) {
  const score = summary.load_distribution_score
  const scoreColor = score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)'

  const metrics = [
    {
      label: 'Distribution Score',
      value: score.toFixed(0),
      unit: '/ 100',
      color: scoreColor,
      tooltip:
        'Load balance health. 100 = even across all 8 backends. 0 = one backend absorbing everything.',
      big: true,
    },
    {
      label: 'Total RPS',
      value: summary.total_rps.toLocaleString(),
      unit: 'req/s',
      color: 'var(--text)',
      tooltip: 'S3 requests hitting the VAST pool per second.',
    },
    {
      label: 'Active Connections',
      value: summary.total_connections.toLocaleString(),
      unit: 'total',
      color: 'var(--text)',
      tooltip: 'Open connections across all 8 backends. Hard limit: 500 per backend.',
    },
    {
      label: 'Cross-DC Traffic',
      value: summary.cross_dc_traffic_pct.toFixed(1),
      unit: '%',
      color: summary.cross_dc_traffic_pct > 35 ? 'var(--amber)' : 'var(--blue)',
      tooltip: 'Share of traffic on replication backends. Above 35% signals an active backup job.',
    },
    {
      label: 'IO Timeouts',
      value: summary.io_timeouts_per_min.toFixed(1),
      unit: '/min',
      color: summary.io_timeouts_per_min > 5 ? 'var(--red)' : summary.io_timeouts_per_min > 2 ? 'var(--amber)' : 'var(--green)',
      tooltip:
        'Stale connections from clients not reading responses. Above 5/min signals connection exhaustion.',
    },
    {
      label: 'Unhealthy Backends',
      value: summary.unhealthy_backends,
      unit: '/ 8',
      color: summary.unhealthy_backends > 0 ? 'var(--red)' : 'var(--green)',
      tooltip: 'Backends above 85% connection utilisation. At risk of availability failure.',
    },
  ]

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1.4fr repeat(5, 1fr)',
      gap: 10,
    }}>
      {metrics.map((m, i) => (
        <div key={i} style={{
          background: 'var(--surface)',
          border: `0.5px solid ${m.big && m.color !== 'var(--text)' ? m.color + '60' : 'var(--border)'}`,
          borderRadius: 6,
          padding: m.big ? '14px 16px' : '10px 14px',
          position: 'relative',
          overflow: 'visible',
          height: '100%',
        }}>
          {m.big && (
            <div style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: 3, background: m.color, borderRadius: '6px 0 0 6px'
            }} />
          )}
          <div style={{
            fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 500,
            color: 'var(--text-muted)', letterSpacing: '0.06em',
            textTransform: 'uppercase', marginBottom: m.big ? 8 : 4,
            paddingLeft: m.big ? 8 : 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
            minWidth: 0,
          }}>
            <InfoTip content={m.tooltip} popoverBefore={i === metrics.length - 1}>
              <span style={{ lineHeight: 1.3 }}>{m.label}</span>
            </InfoTip>
          </div>
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 4,
            paddingLeft: m.big ? 8 : 0,
          }}>
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: m.big ? 28 : 20,
              fontWeight: 500,
              color: m.color,
              lineHeight: 1,
            }}>
              {m.value}
            </span>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 11,
              color: 'var(--text-muted)',
            }}>
              {m.unit}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
