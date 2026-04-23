import { useState, useEffect, useRef } from 'react'

/**
 * Trailing "i" — click to open help (not hover on surrounding text).
 * Use iconOnly when there is no label sibling (e.g. next to a chart legend line).
 */
export default function InfoTip({ content, children, iconOnly = false, className = '', style }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!content) return children ?? null

  return (
    <span
      ref={wrapRef}
      className={`info-tip-wrap ${className}`.trim()}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...style }}
    >
      {!iconOnly && children}
      <span className="info-tip-anchor">
        <span
          role="button"
          tabIndex={0}
          className="info-tip-btn"
          aria-label="Explanation"
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation()
            setOpen((v) => !v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              setOpen((v) => !v)
            }
          }}
        >
          i
        </span>
        {open ? (
          <div className="info-tip-popover" role="tooltip">
            {content}
          </div>
        ) : null}
      </span>
    </span>
  )
}
