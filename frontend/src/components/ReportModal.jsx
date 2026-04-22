import { useEffect } from 'react'

/**
 * Markdown incident brief — overlay uses absolute positioning (iframe-safe).
 */

function renderInlineBold(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) => {
    const m = p.match(/^\*\*([^*]+)\*\*$/)
    if (m) {
      return (
        <strong key={i} style={{ color: 'var(--text)', fontWeight: 600 }}>
          {m[1]}
        </strong>
      )
    }
    return <span key={i}>{p}</span>
  })
}

function renderMarkdownBody(md) {
  const lines = md.split('\n')
  const blocks = []
  let i = 0
  let tableRows = null

  const flushTable = () => {
    if (!tableRows || !tableRows.length) return null
    const header = tableRows[0]
    const body = tableRows.slice(2)
    const key = blocks.length
    return (
      <div key={`tbl-${key}`} style={{ overflowX: 'auto', marginBottom: 12 }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            border: '1px solid var(--border)',
            borderRadius: 4,
          }}
        >
          <thead>
            <tr>
              {header.map((c, j) => (
                <th
                  key={j}
                  style={{
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderBottom: '1px solid var(--border)',
                    color: 'var(--text-muted)',
                    fontWeight: 600,
                  }}
                >
                  {c.trim()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri}>
                {row.map((c, j) => (
                  <td
                    key={j}
                    style={{
                      padding: '8px 10px',
                      borderTop: '1px solid var(--border)',
                      color: 'var(--text)',
                    }}
                  >
                    {c.trim()}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim().startsWith('|') && line.includes('|')) {
      tableRows = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i]
          .split('|')
          .filter((c) => c.trim().length > 0)
          .map((c) => c.trim())
        if (cells.length && !/^[-:]+$/.test(cells.join(''))) {
          tableRows.push(cells)
        }
        i += 1
      }
      const tbl = flushTable()
      tableRows = null
      if (tbl) blocks.push(tbl)
      continue
    }

    if (line.startsWith('## ')) {
      blocks.push(
        <h3
          key={`h-${i}`}
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--text)',
            margin: '16px 0 8px',
          }}
        >
          {line.slice(3)}
        </h3>
      )
      i += 1
      continue
    }

    if (line.startsWith('# ')) {
      blocks.push(
        <h2
          key={`h1-${i}`}
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--text)',
            margin: '0 0 12px',
          }}
        >
          {line.slice(2)}
        </h2>
      )
      i += 1
      continue
    }

    if (line.startsWith('- ')) {
      const items = []
      while (i < lines.length && lines[i].startsWith('- ')) {
        items.push(
          <li key={i} style={{ marginBottom: 6, color: 'var(--text)' }}>
            {renderInlineBold(lines[i].slice(2))}
          </li>
        )
        i += 1
      }
      blocks.push(
        <ul key={`ul-${i}`} style={{ margin: '0 0 12px 18px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          {items}
        </ul>
      )
      continue
    }

    if (line.trim() === '---') {
      blocks.push(
        <hr
          key={`hr-${i}`}
          style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' }}
        />
      )
      i += 1
      continue
    }

    if (line.trim() === '') {
      i += 1
      continue
    }

    blocks.push(
      <p
        key={`p-${i}`}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          lineHeight: 1.55,
          color: 'var(--text-muted)',
          marginBottom: 10,
        }}
      >
        {renderInlineBold(line)}
      </p>
    )
    i += 1
  }

  return blocks
}

export default function ReportModal({ incidentId, markdown, onClose }) {
  useEffect(() => {
    const esc = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const copyMd = async () => {
    try {
      await navigator.clipboard.writeText(markdown || '')
    } catch {
      /* ignore */
    }
  }

  const downloadMd = () => {
    const blob = new Blob([markdown || ''], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `incident-${incidentId}-report.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-title"
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10050,
        background: 'rgba(8, 13, 24, 0.92)',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 720,
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface)',
          }}
        >
          <span id="report-title" style={{ fontFamily: 'var(--font-ui)', fontWeight: 700, fontSize: 14 }}>
            Incident report
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={copyMd}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                padding: '6px 10px',
                borderRadius: 4,
                border: '1px solid var(--border)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                cursor: 'pointer',
              }}
            >
              Copy to Clipboard
            </button>
            <button
              type="button"
              onClick={downloadMd}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                padding: '6px 10px',
                borderRadius: 4,
                border: '1px solid var(--green)',
                background: 'var(--green-dim)',
                color: 'var(--green)',
                cursor: 'pointer',
              }}
            >
              Download .md
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                padding: '6px 10px',
                borderRadius: 4,
                border: '1px solid var(--red)',
                background: 'var(--red-dim)',
                color: 'var(--red)',
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: 20,
            background: 'var(--bg)',
          }}
        >
          {markdown ? renderMarkdownBody(markdown) : (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>
              Loading…
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
