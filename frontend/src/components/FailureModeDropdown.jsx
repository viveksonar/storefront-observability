import { useState, useEffect, useRef } from 'react'
import { FAILURE_MODES } from '../data/failureModes.js'

export default function FailureModeDropdown({ currentMode, onTrigger }) {
  const [open, setOpen] = useState(false)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false)
        setTooltipOpen(false)
      }
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setTooltipOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  const current = FAILURE_MODES.find((m) => m.id === currentMode) || FAILURE_MODES[0]

  return (
    <div
      ref={wrapRef}
      style={{
        position: 'relative',
        zIndex: 100,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
      }}
    >
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <button
          type="button"
          className="failure-mode-info-btn"
          aria-label="How scenario simulation works"
          aria-expanded={tooltipOpen}
          aria-controls="failure-mode-sim-hint"
          title="Click for a short explanation"
          onClick={(e) => {
            e.stopPropagation()
            setTooltipOpen((v) => !v)
          }}
        >
          i
        </button>
        {tooltipOpen ? (
          <div
            className="failure-mode-hint-popover animate-in"
            id="failure-mode-sim-hint"
            role="tooltip"
          >
            Use the menu to simulate a scenario — choose normal traffic or a Storefront failure mode (DNS stickiness,
            connection exhaustion, cross-DC throttling) to drive the demo.
          </div>
        ) : null}
      </div>

      <div className="failure-mode-dropdown-nudge" style={{ position: 'relative', display: 'inline-block' }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-describedby={tooltipOpen ? 'failure-mode-sim-hint' : undefined}
          title="Open scenario simulator"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 500,
            padding: '6px 12px',
            borderRadius: 5,
            border: `1px solid ${current.border + '99'}`,
            background: current.color + '14',
            color: current.color,
            cursor: 'pointer',
            letterSpacing: '0.03em',
            outline: 'none',
            transition: 'border-color 0.2s ease',
          }}
        >
          <span>{current.shortLabel || current.label}</span>
          <span style={{ opacity: 0.75, fontSize: 9 }}>▼</span>
        </button>

        {open ? (
          <div
            role="listbox"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              right: 0,
              minWidth: Math.min(340, typeof window !== 'undefined' ? window.innerWidth - 48 : 340),
              background: 'var(--surface)',
              border: '0.5px solid var(--border-bright)',
              borderRadius: 8,
              boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {FAILURE_MODES.map((m) => {
              const active = currentMode === m.id
              return (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onTrigger(m.id)
                    setOpen(false)
                  }}
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    borderRadius: 6,
                    border: `0.5px solid ${active ? m.border + 'aa' : 'transparent'}`,
                    background: active ? m.color + '18' : 'transparent',
                    cursor: 'pointer',
                    transition: 'background 0.15s ease',
                    outline: 'none',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: active ? m.color : 'var(--text)' }}>
                      {m.label}
                    </span>
                    {active ? (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: m.color }}>ACTIVE</span>
                    ) : null}
                  </div>
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>
                    {m.description}
                  </div>
                  {m.article ? (
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', marginTop: 6, fontStyle: 'italic' }}>
                      {m.article}
                    </div>
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
