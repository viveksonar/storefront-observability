import { useState, useEffect, useRef } from 'react'
import { FAILURE_MODES } from '../data/failureModes.js'
import InfoTip from './InfoTip.jsx'

const GITHUB_REPO_URL = 'https://github.com/viveksonar/storefront-observability'

function GithubMark({ size = 20 }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
      />
    </svg>
  )
}

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
      <a
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="github-repo-link"
        aria-label="View storefront-observability on GitHub"
        title="Source on GitHub"
      >
        <GithubMark size={20} />
      </a>
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

      <div className="failure-mode-dropdown-nudge" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
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
              const modeTip = m.tooltip || m.description
              return (
                <div
                  key={m.id}
                  style={{
                    position: 'relative',
                    borderRadius: 6,
                  }}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onTrigger(m.id)
                      setOpen(false)
                    }}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '10px 40px 10px 12px',
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
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: m.color }}>
                          ACTIVE
                        </span>
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
                  <div
                    style={{
                      position: 'absolute',
                      top: 10,
                      right: 10,
                      pointerEvents: 'auto',
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <InfoTip
                      iconOnly
                      content={
                        active
                          ? `Currently simulating this failure mode. ${modeTip}`
                          : modeTip
                      }
                    />
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
