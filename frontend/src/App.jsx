import { useState, useEffect, useCallback, useRef } from 'react'
import BackendGrid from './components/BackendGrid'
import SummaryBar from './components/SummaryBar'
import AnomalyPanel from './components/AnomalyPanel'
import IncidentPanel from './components/IncidentPanel'
import FailureControls from './components/FailureControls'
import TimelineChart from './components/TimelineChart'
import ReportModal from './components/ReportModal'

const API = ''  // same origin; dev: Vite proxy, prod: nginx → backend

/** Safer than raw .json() — HTML 502/404 pages from nginx break JSON.parse */
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

/** Retries transient prod failures (LB/nginx cold 502/503, brief connection drops). */
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

export default function App() {
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
      `${API}/metrics/backends`,
      `${API}/metrics/summary`,
      `${API}/metrics/anomalies`,
      `${API}/metrics/history`,
      `${API}/incidents`,
      `${API}/incidents/active`,
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
          ? ' Local dev: run uvicorn on :8000; Vite must proxy /metrics, /simulate, /incidents.'
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
    await fetch(`${API}/simulate/${newMode}`, { method: 'POST' })
    setMode(newMode)
    setTimeout(fetchAll, 200)
  }

  const openReport = async (id) => {
    setReportIncidentId(id)
    setReportMarkdown('')
    try {
      const text = await fetch(`${API}/incidents/${id}/report`).then(r => r.text())
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

  return (
    <div style={{ position: 'relative', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

      <div style={{ minHeight: '100vh', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '0.5px solid var(--border)', paddingBottom: 14 }}>
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
          <div style={{ textAlign: 'right' }}>
            {error
              ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--red)' }}>{error}</span>
              : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                  updated {lastUpdated ? lastUpdated.toLocaleTimeString() : '—'} · polling 3s
                </span>
            }
          </div>
        </div>

        {/* Summary bar */}
        {summary && <SummaryBar summary={summary} />}

        {/* Main content */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16, flex: 1 }}>

          {/* Left: backend grid */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {backends && <BackendGrid backends={backends} />}
            <TimelineChart history={history} />
          </div>

          {/* Right: anomalies, incidents, controls */}
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
