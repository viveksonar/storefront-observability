import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import InfoTip from './InfoTip.jsx'

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--surface-2)', border: '0.5px solid var(--border)',
      borderRadius: 5, padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 11,
    }}>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: <strong>{typeof p.value === 'number' ? p.value.toFixed(1) : p.value}</strong>
        </div>
      ))}
    </div>
  )
}

export default function TimelineChart({ history }) {
  if (!history || history.length < 2) {
    return (
      <div style={{
        background: 'var(--surface)', border: '0.5px solid var(--border)',
        borderRadius: 6, padding: 20, textAlign: 'center',
      }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
          Collecting timeline data...
        </span>
      </div>
    )
  }

  const data = history.map((h, i) => ({
    tick: i,
    score: h.distribution_score,
    latency: h.avg_latency_p99_ms,
    mode: h.mode,
  }))

  return (
    <div style={{
      background: 'var(--surface)', border: '0.5px solid var(--border)',
      borderRadius: 6, padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          60-Tick Rolling Window
        </span>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <LegendItem
            color="var(--green)"
            label="Distribution Score"
            tooltip="Distribution score. Collapses instantly on DNS stickiness. Stays high during connection exhaustion — that's the point."
          />
          <LegendItem
            color="var(--amber)"
            label="Avg P99 Latency (ms)"
            tooltip="Average P99 across all backends. Gradual climb = connection exhaustion. Spike = cross-DC throttling."
          />
        </div>
      </div>

      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <XAxis dataKey="tick" hide />
          <YAxis yAxisId="score" domain={[0, 100]} hide />
          <YAxis yAxisId="latency" orientation="right" hide />
          <Tooltip content={<CustomTooltip />} />

          <ReferenceLine yAxisId="score" y={80} stroke="var(--green)" strokeDasharray="4 4" strokeOpacity={0.3} />

          <Line
            yAxisId="score"
            type="monotone"
            dataKey="score"
            name="Distribution Score"
            stroke="var(--green)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="latency"
            type="monotone"
            dataKey="latency"
            name="Avg P99 (ms)"
            stroke="var(--amber)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>

      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 6, textAlign: 'right' }}>
        Connection exhaustion mode shows gradual score degradation — the hardest failure to catch without continuous monitoring
      </div>
    </div>
  )
}

function LegendItem({ color, label, tooltip }) {
  const line = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div
        style={{
          width: 20,
          height: 2,
          background: color,
          borderRadius: 1,
        }}
      />
      <InfoTip content={tooltip}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>{label}</span>
      </InfoTip>
    </div>
  )
  return line
}
