import { useState, useEffect, useCallback } from 'react'

const API = ''

async function fetchJson(url) {
  const res = await fetch(url)
  const ct = (res.headers.get('content-type') || '').toLowerCase()
  if (!ct.includes('application/json')) {
    const snippet = (await res.text()).slice(0, 120)
    throw new Error(`${url} → HTTP ${res.status}, expected JSON. ${snippet}`)
  }
  const data = await res.json()
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return data
}

async function fetchJsonWithRetry(url, maxAttempts = 3) {
  let lastErr
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fetchJson(url)
    } catch (e) {
      lastErr = e
      const msg = e?.message || String(e)
      const retryable =
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504') ||
        msg.includes('Failed to fetch') ||
        e?.name === 'TypeError'
      if (!retryable || attempt === maxAttempts - 1) throw e
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)))
    }
  }
  throw lastErr
}

function fleetMinForScenario(summary, scenario) {
  if (!summary) return null
  if (scenario === 'normal') return summary.min_hours_to_critical_normal
  if (scenario === 'spike_2x') return summary.min_hours_to_critical_spike_2x
  return summary.min_hours_to_critical_spike_3x
}

function formatHoursLarge(h) {
  if (h === null || h === undefined) return 'stable'
  if (h === 0) return 'now'
  if (h < 1) return '<1h'
  if (h >= 100) return `${Math.round(h)}h`
  const rounded = Number.isInteger(h) ? `${h}` : `${h.toFixed(1)}`
  return `${rounded}h`
}

function formatHoursCell(h) {
  if (h === null || h === undefined) return '—'
  if (h === 0) return 'now'
  if (h < 1) return '<1'
  return h >= 100 ? `${Math.round(h)}` : (Number.isInteger(h) ? `${h}` : `${h.toFixed(1)}`)
}

function hourRiskColor(h) {
  if (h === null || h === undefined) return 'var(--green)'
  if (h === 0) return 'var(--red)'
  if (h < 24) return 'var(--red)'
  if (h <= 72) return 'var(--amber)'
  return 'var(--green)'
}

function growthRateColor(rate, isGrowing) {
  if (!isGrowing) return 'var(--green)'
  const absr = Math.abs(rate)
  if (absr < 10) return 'var(--green)'
  if (absr <= 50) return 'var(--amber)'
  return 'var(--red)'
}

function confidenceDotStyle(conf) {
  if (conf === 'high') return { bg: 'var(--green)', label: 'high' }
  if (conf === 'medium') return { bg: 'var(--amber)', label: 'medium' }
  if (conf === 'low') return { bg: 'var(--text-muted)', label: 'low' }
  return { bg: 'var(--text-dim)', label: 'insufficient' }
}

function scenarioKeyToLabel(s) {
  if (s === 'normal') return 'Normal'
  if (s === 'spike_2x') return '2× Spike'
  return '3× Spike'
}

function miniBar(pct) {
  const p = Math.min(Math.max(pct, 0), 100)
  let fill = 'var(--green)'
  if (p >= 85) fill = 'var(--red)'
  else if (p >= 65) fill = 'var(--amber)'
  return (
    <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginTop: 4 }}>
      <div
        style={{
          height: '100%',
          width: `${p}%`,
          background: fill,
          borderRadius: 2,
          opacity: 0.95,
          transition: 'width 0.6s ease, opacity 0.25s ease',
        }}
      />
    </div>
  )
}

function sortForecastsMostAtRisk(forecasts) {
  const score = (f) => {
    const hs = [f.hours_to_critical.normal, f.hours_to_critical.spike_2x, f.hours_to_critical.spike_3x].filter(
      (x) => x !== null && x !== undefined
    )
    if (!hs.length) return Infinity
    return Math.min(...hs)
  }
  return [...forecasts].sort((a, b) => score(a) - score(b))
}

export default function ForecastTab() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [scenario, setScenario] = useState('normal')

  const load = useCallback(async () => {
    try {
      const j = await fetchJsonWithRetry(`${API}/metrics/forecast`)
      setData(j)
      setError(null)
    } catch (e) {
      setError(e?.message || String(e))
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [load])

  const insufficient = data?.data_confidence === 'insufficient'

  const bannerHours = data ? fleetMinForScenario(data.fleet_summary, scenario) : null
  const bannerColor = hourRiskColor(bannerHours)

  const hcFor = (f) => {
    if (!f?.hours_to_critical) return null
    return f.hours_to_critical[scenario]
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, flex: 1, minHeight: 0 }}>
      {/* SECTION A — Fleet risk */}
      <div
        style={{
          background: 'var(--surface)',
          border: '0.5px solid var(--border)',
          borderRadius: 6,
          padding: '18px 20px',
          transition: 'opacity 0.25s ease',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ flex: '1 1 280px' }}>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              Fleet risk (leading indicator)
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 42, fontWeight: 600, color: bannerColor, letterSpacing: '-0.03em', lineHeight: 1 }}>
                {insufficient ? '—' : formatHoursLarge(bannerHours)}
              </span>
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text-muted)', maxWidth: 380 }}>
                until first backend hits critical threshold{' '}
                {scenario === 'normal'
                  ? '(normal traffic)'
                  : scenario === 'spike_2x'
                    ? '(2× promotional spike)'
                    : '(major event — 3× spike)'}
              </span>
            </div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', marginTop: 10, fontStyle: 'italic', maxWidth: 720, opacity: 0.95, transition: 'opacity 0.25s ease' }}>
              {data?.vulcan_note}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Scenario
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              {[
                { id: 'normal', label: 'Normal', fill: 'var(--blue)' },
                { id: 'spike_2x', label: '2× Spike', fill: 'var(--amber)' },
                { id: 'spike_3x', label: '3× Spike', fill: 'var(--red)' },
              ].map((p) => {
                const active = scenario === p.id
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setScenario(p.id)}
                    style={{
                      fontFamily: 'var(--font-ui)',
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '6px 12px',
                      borderRadius: 4,
                      border: '0.5px solid var(--border)',
                      cursor: 'pointer',
                      background: active ? p.fill + '35' : 'transparent',
                      color: active ? 'var(--text)' : 'var(--text-muted)',
                      transition: 'background 0.2s ease, color 0.2s ease, opacity 0.2s ease',
                      opacity: active ? 1 : 0.85,
                    }}
                  >
                    {p.label}
                  </button>
                )
              })}
            </div>
            {data && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                data: {data.data_confidence} · ticks {data.ticks_available}
              </span>
            )}
          </div>
        </div>

        {insufficient && data?.message && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '0.5px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--amber)' }}>
            {data.message}
          </div>
        )}
        {error && (
          <div style={{ marginTop: 12, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--red)' }}>{error}</div>
        )}
      </div>

      {/* SECTION B — Cards */}
      {!insufficient && data?.forecasts?.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Per-backend projection · {scenarioKeyToLabel(scenario)}
            </span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 10,
            }}
          >
            {data.forecasts.map((f) => {
              const hc = hcFor(f)
              const rate = f.growth_rate_per_hour
              const conf = confidenceDotStyle(f.confidence)
              const atRisk = f.already_at_risk
              const hoursColor = hourRiskColor(hc)

              return (
                <div
                  key={f.backend_id}
                  className="animate-in"
                  style={{
                    background: 'var(--surface)',
                    border: '0.5px solid var(--border)',
                    borderRadius: 6,
                    padding: '12px 14px',
                    position: 'relative',
                    transition: 'opacity 0.25s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{f.backend_id}</span>
                      {f.is_cross_dc && (
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 9,
                            fontWeight: 500,
                            padding: '1px 5px',
                            borderRadius: 3,
                            color: 'var(--blue)',
                            background: 'var(--blue-dim)',
                            border: '0.5px solid var(--blue)40',
                            letterSpacing: '0.04em',
                          }}
                        >
                          CROSS-DC
                        </span>
                      )}
                    </div>
                    <div title={`confidence: ${conf.label}`} style={{ width: 8, height: 8, borderRadius: '50%', background: conf.bg, opacity: 0.95 }} />
                  </div>

                  {atRisk ? (
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '0.06em',
                        color: f.already_at_risk_level === 'critical' ? 'var(--red)' : 'var(--amber)',
                        marginBottom: 8,
                      }}
                    >
                      ALREADY AT RISK
                    </div>
                  ) : null}

                  <div style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Connections
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)' }}>
                        {f.current_connections} <span style={{ color: 'var(--text-muted)' }}>/ 500</span>
                      </span>
                    </div>
                    {miniBar(f.connection_utilisation_pct)}
                  </div>

                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontFamily: 'var(--font-ui)', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
                      Growth
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500, color: growthRateColor(rate, f.is_growing) }}>
                      {f.is_growing ? `${rate >= 0 ? '+' : ''}${rate.toFixed(1)} conn/hr` : <span style={{ color: 'var(--green)' }}>stable</span>}
                    </div>
                  </div>

                  {!atRisk && (
                    <div>
                      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
                        Hours to critical ({scenarioKeyToLabel(scenario)})
                      </div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: hoursColor, letterSpacing: '-0.02em' }}>
                        {f.is_growing ? (
                          formatHoursLarge(hc)
                        ) : (
                          <span style={{ color: 'var(--green)', fontSize: 18 }}>stable</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* SECTION C — Table */}
      {!insufficient && data?.forecasts?.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: '0.5px solid var(--border)' }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Scenario comparison — hours to critical
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', borderBottom: '0.5px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '10px 14px', fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Backend
                  </th>
                  <th style={{ textAlign: 'right', padding: '10px 14px', fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Current %
                  </th>
                  <th style={{ textAlign: 'right', padding: '10px 14px', fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Normal → crit
                  </th>
                  <th style={{ textAlign: 'right', padding: '10px 14px', fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    2× spike
                  </th>
                  <th style={{ textAlign: 'right', padding: '10px 14px', fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    3× spike
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortForecastsMostAtRisk(data.forecasts).map((f) => (
                  <tr key={f.backend_id} style={{ borderBottom: '0.5px solid var(--border)' }}>
                    <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{f.backend_id}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                      {f.connection_utilisation_pct.toFixed(1)}%
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: hourRiskColor(f.hours_to_critical.normal) }}>
                      {formatHoursCell(f.hours_to_critical.normal)}
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: hourRiskColor(f.hours_to_critical.spike_2x) }}>
                      {formatHoursCell(f.hours_to_critical.spike_2x)}
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: hourRiskColor(f.hours_to_critical.spike_3x) }}>
                      {formatHoursCell(f.hours_to_critical.spike_3x)}
                    </td>
                  </tr>
                ))}
                <tr style={{ background: 'var(--surface-2)' }}>
                  <td style={{ padding: '10px 14px', fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11 }}>
                    Fleet minimum
                  </td>
                  <td style={{ padding: '10px 14px' }} />
                  <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: hourRiskColor(data.fleet_summary.min_hours_to_critical_normal) }}>
                    {formatHoursCell(data.fleet_summary.min_hours_to_critical_normal)}
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: hourRiskColor(data.fleet_summary.min_hours_to_critical_spike_2x) }}>
                    {formatHoursCell(data.fleet_summary.min_hours_to_critical_spike_2x)}
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: hourRiskColor(data.fleet_summary.min_hours_to_critical_spike_3x) }}>
                    {formatHoursCell(data.fleet_summary.min_hours_to_critical_spike_3x)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {data.fleet_summary?.recommendation && (
            <div style={{ padding: '12px 14px', borderTop: '0.5px solid var(--border)', fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
              {data.fleet_summary.recommendation}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
