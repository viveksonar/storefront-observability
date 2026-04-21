import { useState, useEffect, useCallback } from 'react'
import BackendGrid from './components/BackendGrid'
import SummaryBar from './components/SummaryBar'
import AnomalyPanel from './components/AnomalyPanel'
import FailureControls from './components/FailureControls'
import TimelineChart from './components/TimelineChart'

const API = ''  // proxied via vite — empty = same origin

export default function App() {
  const [backends, setBackends]   = useState(null)
  const [summary, setSummary]     = useState(null)
  const [anomalies, setAnomalies] = useState(null)
  const [history, setHistory]     = useState([])
  const [mode, setMode]           = useState('normal')
  const [lastUpdated, setLastUpdated] = useState(null)
  const [error, setError]         = useState(null)

  const fetchAll = useCallback(async () => {
    try {
      const [b, s, a, h] = await Promise.all([
        fetch(`${API}/metrics/backends`).then(r => r.json()),
        fetch(`${API}/metrics/summary`).then(r => r.json()),
        fetch(`${API}/metrics/anomalies`).then(r => r.json()),
        fetch(`${API}/metrics/history`).then(r => r.json()),
      ])
      setBackends(b)
      setSummary(s)
      setAnomalies(a)
      setHistory(h.history || [])
      setMode(s.mode)
      setLastUpdated(new Date())
      setError(null)
    } catch (e) {
      setError('Cannot reach backend — is the API running? (Vite proxies to 127.0.0.1:8000 by default; set VITE_PROXY_TARGET if needed.)')
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

  const modeLabel = {
    normal:                { label: 'NORMAL',               color: 'var(--green)' },
    dns_stickiness:        { label: 'DNS STICKINESS',        color: 'var(--red)'   },
    connection_exhaustion: { label: 'CONNECTION EXHAUSTION', color: 'var(--red)'   },
    cross_dc_throttling:   { label: 'CROSS-DC THROTTLING',  color: 'var(--amber)' },
  }

  const current = modeLabel[mode] || modeLabel.normal

  return (
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

        {/* Right: anomalies + controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {anomalies && <AnomalyPanel anomalies={anomalies} />}
          <FailureControls currentMode={mode} onTrigger={triggerMode} />
        </div>
      </div>

    </div>
  )
}
