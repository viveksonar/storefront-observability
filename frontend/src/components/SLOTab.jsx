/**
 * SLO burn rate view — error budget, burn multipliers, heatmap.
 * Styling: dark ops palette, Syne + IBM Plex Mono (see index.css / index.html).
 */

function statusAccent(status) {
  if (status === 'critical') return 'var(--red)'
  if (status === 'at_risk') return 'var(--amber)'
  return 'var(--green)'
}

function barColorForSeverity(sev) {
  if (sev === 'high') return 'var(--red)'
  if (sev === 'medium') return 'var(--amber)'
  return 'var(--blue)'
}

function formatBurnSubtext(b1h) {
  if (b1h < 1) {
    return { text: 'Within budget rate', color: 'var(--green)' }
  }
  if (b1h < 2) {
    return { text: 'Approaching budget stress', color: 'var(--amber)' }
  }
  if (b1h < 5) {
    return { text: `Burning ${b1h.toFixed(1)}× faster than budget allows`, color: 'var(--amber)' }
  }
  return { text: `CRITICAL — burn ${b1h.toFixed(1)}× over sustainable rate`, color: 'var(--red)' }
}

function exhaustionColor(hours) {
  if (hours === null || hours === undefined) return 'var(--green)'
  if (hours < 48) return 'var(--red)'
  if (hours < 168) return 'var(--amber)'
  return 'var(--green)'
}

export default function SLOTab({ data }) {
  if (!data) {
    return (
      <div style={{ padding: 24, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)' }}>
        Loading SLO metrics…
      </div>
    )
  }

  const accent = statusAccent(data.status)
  const simMode = data.simulator_mode ?? 'normal'
  const pctRem = Number(data.budget_pct_remaining) || 0
  const pctConsumed = Math.min(100, Math.max(0, 100 - pctRem))
  const b1h = Number(data.burn_rate_1h) || 0
  const b6h = Number(data.burn_rate_6h) || 0
  const burn1 = formatBurnSubtext(b1h)
  const hexh = data.hours_to_exhaustion

  const heatMax = Math.max(
    0.2,
    ...((data.window_data || []).map((d) => Number(d.minutes_consumed) || 0)),
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, flex: 1, minHeight: 0 }}>
      {/* SECTION A — Definition banner */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '12px 28px',
          padding: '10px 14px',
          background: 'var(--surface)',
          border: '0.5px solid var(--border)',
          borderRadius: 6,
          fontSize: 11,
        }}
      >
        <span style={{ fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--text-muted)' }}>
          SLO{' '}
          <span style={{ color: 'var(--text)', fontWeight: 700 }}>{data.slo_target}%</span> —{' '}
          <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>{data.slo_definition}</span>
        </span>
        <span style={{ color: 'var(--border-bright)', userSelect: 'none' }}>|</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
          Monthly budget <span style={{ color: 'var(--text)' }}>{data.budget_minutes_total}m</span> (0.5% of 30 days)
        </span>
        <span style={{ color: 'var(--border-bright)', userSelect: 'none' }}>|</span>
        <span style={{ fontFamily: 'var(--font-ui)', color: 'var(--text-muted)' }}>
          Window: <span style={{ color: 'var(--text)' }}>Rolling 30 days</span>
        </span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-ui)', fontSize: 10, fontStyle: 'italic', color: 'var(--text-dim)' }}>
          Google SRE workbook standard
        </span>
      </div>

      {/* SECTION B — Metric cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)',
          gap: 14,
        }}
      >
        {/* Card 1 — Budget remaining (wider) */}
        <div
          style={{
            background: 'var(--surface)',
            border: '0.5px solid var(--border)',
            borderRadius: 6,
            padding: '16px 18px',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 4,
              background: accent,
              borderRadius: '6px 0 0 6px',
            }}
          />
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Error budget remaining
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 36, fontWeight: 700, color: accent, marginTop: 8, lineHeight: 1 }}>
            {pctRem.toFixed(0)}%
          </div>
          <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, marginTop: 12, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${pctConsumed}%`,
                background: accent,
                borderRadius: 3,
                transition: 'width 0.6s ease',
              }}
            />
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.45 }}>
            <span style={{ color: 'var(--amber)' }}>{data.budget_minutes_used.toFixed(1)}m</span> consumed ·{' '}
            <span style={{ color: 'var(--green)' }}>{data.budget_minutes_remaining.toFixed(1)}m</span> pending{' '}
            <span style={{ color: 'var(--text-dim)' }}>({data.budget_minutes_total.toFixed(1)}m monthly cap)</span>
          </div>
        </div>

        {/* Card 2 — Burn 1h */}
        <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 6, padding: '16px 14px' }}>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Burn rate (1h)
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 32, fontWeight: 700, color: burn1.color, marginTop: 8 }}>
            {b1h.toFixed(1)}×
          </div>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: burn1.color, marginTop: 10, lineHeight: 1.35 }}>
            {burn1.text}
          </div>
        </div>

        {/* Card 3 — Burn 6h */}
        <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 6, padding: '16px 14px' }}>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Burn rate (6h)
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 28, fontWeight: 700, color: 'var(--amber)', marginTop: 8 }}>
            {b6h.toFixed(1)}×
          </div>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--blue)', marginTop: 10 }}>
            Slow burn window
          </div>
        </div>

        {/* Card 4 — Exhaustion */}
        <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 6, padding: '16px 14px' }}>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Budget exhaustion
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 32,
              fontWeight: 700,
              color: exhaustionColor(hexh),
              marginTop: 8,
            }}
          >
            {hexh !== null && hexh !== undefined ? `${Math.round(hexh)}h` : '∞'}
          </div>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--blue)', marginTop: 10 }}>
            {simMode === 'normal' ? 'steady baseline — no active burn trajectory' : 'at current burn rate'}
          </div>
        </div>
      </div>

      {simMode === 'normal' ? (
        <div
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 11,
            color: 'var(--text-muted)',
            padding: '10px 14px',
            background: 'var(--surface-2)',
            border: '0.5px solid var(--border)',
            borderRadius: 6,
            lineHeight: 1.5,
          }}
        >
          <span style={{ color: 'var(--blue)', fontWeight: 600 }}>Baseline simulation:</span> Burn-rate cards show steady traffic (0×).{' '}
          <span style={{ color: 'var(--text)' }}>Consumed</span> and <span style={{ color: 'var(--text)' }}>pending</span> budget in the card above are unchanged — cumulative burn is{' '}
          <em>not</em> cleared when you return to normal (only <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>POST /metrics/slo/reset</span> clears it).
        </div>
      ) : null}

      {/* SECTION C — Heatmap + impact */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 14, alignItems: 'stretch' }}>
        <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 6, padding: '12px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              30-day budget consumption
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)' }}>
              {data.heatmap_minutes_total != null ? `${data.heatmap_minutes_total.toFixed(1)}m` : '—'} used
            </span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(10, 1fr)',
              gap: 5,
            }}
          >
            {(data.window_data || []).map((cell) => {
              const m = Number(cell.minutes_consumed) || 0
              const intensity = Math.min(1, m / heatMax)
              const bg = `rgba(${30 + intensity * 225}, ${45 + intensity * 14}, ${74 + intensity * 185}, ${0.35 + intensity * 0.55})`
              return (
                <div
                  key={cell.day}
                  title={`${cell.date_label}: ${m.toFixed(2)} min${cell.had_incident ? ' · incident' : ''}`}
                  style={{
                    aspectRatio: '1.6',
                    background: bg,
                    borderRadius: 3,
                    border: '0.5px solid var(--border)',
                    position: 'relative',
                    minHeight: 22,
                  }}
                >
                  {cell.had_incident ? (
                    <span
                      style={{
                        position: 'absolute',
                        top: 3,
                        left: 3,
                        width: 5,
                        height: 5,
                        borderRadius: 1,
                        background: 'var(--red)',
                      }}
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)' }}>
            <span>
              <span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--red)', marginRight: 6, verticalAlign: 'middle', borderRadius: 1 }} />
              Incident day
            </span>
            <span>
              <span
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  background: 'rgba(30,45,74,0.55)',
                  marginRight: 6,
                  verticalAlign: 'middle',
                  borderRadius: 1,
                  border: '0.5px solid var(--border)',
                }}
              />
              Normal
            </span>
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 6, padding: '12px 14px' }}>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Incidents by budget impact
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(data.incident_budget_impact || []).map((row) => (
              <div key={row.incident_id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)' }}>
                    {row.date} — {row.type}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{row.pct_of_budget.toFixed(1)}%</span>
                </div>
                <div style={{ height: 5, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(100, row.pct_of_budget)}%`,
                      background: barColorForSeverity(row.severity),
                      borderRadius: 2,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <p
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 10,
          fontStyle: 'italic',
          color: 'var(--text-dim)',
          lineHeight: 1.5,
          maxWidth: 960,
        }}
      >
        {data.sre_note}
      </p>
    </div>
  )
}
