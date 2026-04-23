/** Client-level S3 traffic attribution — FINUDP-style “whose client?” (Jan 2026 narrative). */

import InfoTip from './InfoTip.jsx'

function abbrevTeam(team) {
  const m = {
    Checkout: 'Checkout',
    Search: 'Search',
    Supply: 'Supply',
    'Data Platform': 'DataPlat',
    'Data Infra': 'DataInfra',
    'ML Platform': 'ML',
    Marketing: 'Mktg',
  }
  return m[team] || team.slice(0, 10)
}

function healthDot(health) {
  const color =
    health === 'exhausting'
      ? 'var(--red)'
      : health === 'warning'
        ? 'var(--amber)'
        : 'var(--green)'
  return (
    <span
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }}
    />
  )
}

export default function ClientAttributionPanel({ data }) {
  if (!data?.clients?.length) return null

  const flaggedId = data.flagged_client?.client_id
  const flaggedClient = data.clients.find((c) => c.client_id === flaggedId)
  const showAttribution =
    flaggedClient?.anomaly &&
    (flaggedClient.anomaly.severity === 'critical' ||
      flaggedClient.anomaly.severity === 'warning')

  const borderAlert =
    flaggedClient?.anomaly?.severity === 'critical' ? 'var(--red)' : 'var(--amber)'

  const sorted = [...data.clients].sort((a, b) => b.connections - a.connections)
  const fleetClear = !data.flagged_client

  return (
    <div
      className="client-attribution-panel"
      style={{
        background: 'var(--surface)',
        border: '0.5px solid var(--border)',
        borderRadius: 6,
        overflow: 'visible',
      }}
    >
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '0.5px solid var(--border)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <InfoTip content="Which service is causing backend degradation. Tells you who to call, not just what broke.">
            <span
              style={{
                fontFamily: 'var(--font-ui)',
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Client attribution
            </span>
          </InfoTip>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 9, color: 'var(--text-dim)', marginTop: 3, lineHeight: 1.35 }}>
            S3 traffic by service
          </div>
        </div>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: '0.04em',
            color: fleetClear ? 'var(--green)' : 'var(--amber)',
            flexShrink: 0,
            padding: '2px 6px',
            borderRadius: 3,
            border: `0.5px solid ${fleetClear ? 'var(--green)' : 'var(--amber)'}`,
            background: fleetClear ? 'var(--green-dim)' : 'var(--amber-dim)',
          }}
        >
          {fleetClear ? 'ALL CLEAR' : 'FLAGGED'}
        </span>
      </div>

      <div className="client-attribution-panel__table-wrap">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
          <thead>
            <tr style={{ borderBottom: '0.5px solid var(--border)', background: 'var(--surface-2)' }}>
              <th style={{ textAlign: 'left', padding: '5px 8px', fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--text-muted)', overflow: 'visible', verticalAlign: 'middle' }}>
                <InfoTip content="Owning service identifier for S3 client traffic (demo registry).">
                  <span>Service</span>
                </InfoTip>
              </th>
              <th style={{ textAlign: 'left', padding: '5px 6px', fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--text-muted)', overflow: 'visible', verticalAlign: 'middle' }}>
                <InfoTip content="Owning team for escalation when this row is flagged.">
                  <span>Team</span>
                </InfoTip>
              </th>
              <th style={{ textAlign: 'right', padding: '5px 6px', fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--text-muted)', overflow: 'visible', verticalAlign: 'middle' }}>
                <InfoTip content="This service's share of total S3 traffic.">
                  <span>RPS%</span>
                </InfoTip>
              </th>
              <th style={{ textAlign: 'right', padding: '5px 6px', fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--text-muted)', overflow: 'visible', verticalAlign: 'middle' }}>
                <InfoTip content="Connections attributed to this service. Climbing = likely culprit.">
                  <span>Conn</span>
                </InfoTip>
              </th>
              <th style={{ textAlign: 'right', padding: '5px 6px', fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--text-muted)', overflow: 'visible', verticalAlign: 'middle' }}>
                <InfoTip content="IO timeouts from this service. Above 5/min = not reading HTTP responses correctly.">
                  <span>IO/m</span>
                </InfoTip>
              </th>
              <th style={{ textAlign: 'center', padding: '5px 6px', fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--text-muted)', overflow: 'visible', verticalAlign: 'middle' }}>
                ●
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, idx) => {
              const isFlagged = flaggedId && row.client_id === flaggedId && row.connection_health !== 'ok'
              const bg = isFlagged
                ? 'var(--red-dim)'
                : idx % 2 === 0
                  ? 'var(--surface)'
                  : 'var(--surface-2)'
              return (
                <tr key={row.client_id} style={{ background: bg, transition: 'background 0.2s ease' }}>
                  <td style={{ padding: '5px 8px', fontFamily: 'var(--font-mono)', color: 'var(--text)', fontWeight: 500, maxWidth: 118, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.client_id}>
                    {row.client_id}
                  </td>
                  <td style={{ padding: '5px 6px', fontFamily: 'var(--font-ui)', fontSize: 9, color: 'var(--text-muted)' }}>
                    {abbrevTeam(row.team_owner)}
                  </td>
                  <td style={{ padding: '5px 6px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                    {row.rps_pct.toFixed(1)}
                  </td>
                  <td style={{ padding: '5px 6px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                    {row.connections}
                  </td>
                  <td style={{ padding: '5px 6px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: row.io_timeout_rate > 8 ? 'var(--red)' : row.io_timeout_rate > 2 ? 'var(--amber)' : 'var(--text-muted)' }}>
                    {row.io_timeout_rate.toFixed(1)}
                  </td>
                  <td style={{ padding: '5px 6px', textAlign: 'center', verticalAlign: 'middle' }}>
                    {healthDot(row.connection_health)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {showAttribution && flaggedClient && (
        <div
          style={{
            margin: 8,
            padding: '10px 12px',
            borderRadius: 4,
            border: `0.5px solid ${borderAlert}`,
            background: flaggedClient.anomaly.severity === 'critical' ? 'var(--red-dim)' : 'var(--amber-dim)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
            <InfoTip content="Active issue — service, pattern, owning team, and fix recommendation.">
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 700, color: borderAlert }}>
                Anomaly attribution — {flaggedClient.client_id}
              </span>
            </InfoTip>
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text)', lineHeight: 1.45, marginBottom: 8 }}>
            {flaggedClient.anomaly.message}
          </div>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.45, marginBottom: 8 }}>
            {flaggedClient.anomaly.recommendation}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.4 }}>
            Pattern: {flaggedClient.traffic_pattern}
            {flaggedClient.primary_backends?.length ? (
              <> · Primary backends: {flaggedClient.primary_backends.join(', ')}</>
            ) : null}
          </div>
          {flaggedClient.anomaly.article_ref && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--blue)', fontStyle: 'italic', flex: 1, minWidth: 0, lineHeight: 1.4 }}>
                {flaggedClient.anomaly.article_ref}
              </div>
              <InfoTip iconOnly content="Source passage from Agoda's engineering blog. Every threshold has a citation." />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
