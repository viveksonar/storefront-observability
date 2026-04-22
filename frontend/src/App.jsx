import { useState, useEffect, useCallback, useRef } from 'react'
import BackendGrid from './components/BackendGrid'
import SummaryBar from './components/SummaryBar'
import AnomalyPanel from './components/AnomalyPanel'
import IncidentPanel from './components/IncidentPanel'
import FailureControls from './components/FailureControls'
import TimelineChart from './components/TimelineChart'
import ReportModal from './components/ReportModal'
import ForecastTab from './components/ForecastTab'
import { apiUrl, fetchJsonWithRetry } from './api.js'

export default function App() {
  const [mainView, setMainView] = useState('dashboard')

  const [backends, setBackends]   = useState(null)
  const [summary, setSummary]     = useState(null)
  const [anomalies, setAnomalies] = useState(null)
  const [history, setHistory]     = useState([])
  const [mode, setMode]           = useState('normal')
  const [lastUpdated, setLastUpdated] = useState(null)
  const [error, setError]         = useState(null)

  const [incidents, setIncidents] = useState([])
  const [activeIncident, setActiveIncident] = useState(null)
  const [reportIncidentId, setReportIncidentId] = useState(null)
  const [reportMarkdown, setReportMarkdown] = useState('')

  /** Only show the red banner after repeated critical failures — avoids flicker on single bad poll. */
  const criticalFailStreakRef = useRef(0)

  const fetchAll = useCallback(async () => {
    const urls = [
      apiUrl('/metrics/backends'),
      apiUrl('/metrics/summary'),
      apiUrl('/metrics/anomalies'),
      apiUrl('/metrics/history'),
      apiUrl('/incidents'),
      apiUrl('/incidents/active'),
    ]
    const results = await Promise.allSettled(urls.map((u) => fetchJsonWithRetry(u)))

    const val = (i) => (results[i].status === 'fulfilled' ? results[i].value : null)

    const b = val(0)
    const s = val(1)
    const a = val(2)
    const h = val(3)
    const incList = val(4)
    const active = results[5].status === 'fulfilled' ? results[5].value : undefined

    if (b) setBackends(b)
    if (s) {
      setSummary(s)
      setMode(s.mode)
    }
    if (a) setAnomalies(a)
    if (h) setHistory(h.history || [])
    if (incList !== null && incList !== undefined) setIncidents(Array.isArray(incList) ? incList : [])
    if (active !== undefined) setActiveIncident(active)

    const backendsOk = results[0].status === 'fulfilled'
    const summaryOk = results[1].status === 'fulfilled'
    const criticalOk = backendsOk && summaryOk

    if (criticalOk) {
      criticalFailStreakRef.current = 0
      setError(null)
      setLastUpdated(new Date())
      return
    }

    criticalFailStreakRef.current += 1
    const rejected = results
      .map((r, i) => (r.status === 'rejected' ? `${urls[i]}: ${r.reason?.message || r.reason}` : null))
      .filter(Boolean)
    if (criticalFailStreakRef.current >= 2) {
      const hint =
        typeof window !== 'undefined' && window.location.port === '5173'
          ? ' Local dev: uvicorn on :8000 — or set frontend/.env.local → VITE_API_BASE_URL=http://127.0.0.1:8000 (bypass Vite proxy). Restart npm run dev.'
          : ' Production: check backend pods, ingress → backend routes, and nginx API regex (frontend/nginx.conf).'
      setError(`API degraded — ${rejected.slice(0, 2).join(' · ')} ${hint}`)
    }
  }, [])

  useEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, 3000)
    return () => clearInterval(interval)
  }, [fetchAll])

  const triggerMode = async (newMode) => {
    await fetch(apiUrl(`/simulate/${newMode}`), { method: 'POST' })
    setMode(newMode)
    setTimeout(fetchAll, 200)
  }

  const openReport = async (id) => {
    setReportIncidentId(id)
    setReportMarkdown('')
    try {
      const text = await fetch(apiUrl(`/incidents/${id}/report`)).then(r => r.text())
      setReportMarkdown(text)
    } catch {
      setReportMarkdown('Failed to load report.')
    }
  }

  const closeReport = () => {
    setReportIncidentId(null)
    setReportMarkdown('')
  }

  const modeLabel = {
    normal:                { label: 'NORMAL',               color: 'var(--green)' },
    dns_stickiness:        { label: 'DNS STICKINESS',        color: 'var(--red)'   },
    connection_exhaustion: { label: 'CONNECTION EXHAUSTION', color: 'var(--red)'   },
    cross_dc_throttling:   { label: 'CROSS-DC THROTTLING',  color: 'var(--amber)' },
  }

  const current = modeLabel[mode] || modeLabel.normal

  const tabBtn = (id, label) => {
    const active = mainView === id
    return (
      <button
        type="button"
        onClick={() => setMainView(id)}
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          padding: '6px 4px 10px',
          marginRight: 16,
          background: 'transparent',
          border: 'none',
          borderBottom: active ? '2px solid var(--green)' : '2px solid transparent',
          color: active ? 'var(--text)' : 'var(--text-muted)',
          cursor: 'pointer',
          transition: 'color 0.2s ease, border-color 0.2s ease, opacity 0.2s ease',
          opacity: active ? 1 : 0.9,
        }}
      >
        {label}
      </button>
    )
  }

  return (
    <div style={{ position: 'relative', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

      <div style={{ minHeight: '100vh', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          borderBottom: '0.5px solid var(--border)',
          paddingBottom: 14,
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 28, flexWrap: 'wrap', flex: '1 1 auto' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontFamily: 'var(--font-ui)', fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>
                  Storefront Observability
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500,
                  padding: '2px 8px', borderRadius: 3, border: '1px solid',
                  color: current.color, borderColor: current.color,
                  background: current.color + '15',
                  animation: mode !== 'normal' ? 'pulse-red 2s infinite' : 'none',
                  letterSpacing: '0.05em'
                }}>
                  {current.label}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                S3 load balancer health · VAST backend pool monitoring · 8 nodes
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', paddingTop: 2 }}>
              {tabBtn('dashboard', 'Live Dashboard')}
              {tabBtn('forecast', 'Forecast')}
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            {error
              ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--red)' }}>{error}</span>
              : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                  updated {lastUpdated ? lastUpdated.toLocaleTimeString() : '—'} · polling 3s
                </span>
            }
          </div>
        </div>

        {mainView === 'dashboard' && summary && <SummaryBar summary={summary} />}

        {mainView === 'dashboard' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16, flex: 1 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {backends && <BackendGrid backends={backends} />}
              <TimelineChart history={history} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {anomalies && <AnomalyPanel anomalies={anomalies} />}
              <IncidentPanel
                incidents={incidents}
                activeIncident={activeIncident}
                onViewReport={openReport}
              />
              <FailureControls currentMode={mode} onTrigger={triggerMode} />
            </div>
          </div>
        ) : (
          <ForecastTab />
        )}

      </div>

      {reportIncidentId !== null && (
        <ReportModal
          incidentId={reportIncidentId}
          markdown={reportMarkdown}
          onClose={closeReport}
        />
      )}

    </div>
  )
}
