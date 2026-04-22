/**
 * API base URL. Leave unset for same-origin (production nginx or Vite dev proxy).
 *
 * Local dev if proxy/port is wrong: create `frontend/.env.local`:
 *   VITE_API_BASE_URL=http://127.0.0.1:8000
 * Then restart `npm run dev`. CORS is allowed by the FastAPI app.
 */
export const API_BASE = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

/** Build request URL — relative when API_BASE empty, absolute when pointing at uvicorn. */
export function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`
  if (!API_BASE) return p
  return `${API_BASE}${p}`
}

/**
 * Fetch JSON without trusting Content-Type (FastAPI errors are often text/html or plain).
 * Parses body as JSON when it looks like JSON; surfaces HTTP errors with server detail.
 */
export async function fetchJson(url) {
  const res = await fetch(url)
  const raw = await res.text()
  const trimmed = raw.trim()

  if (!trimmed) {
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status} (empty body)`)
    return null
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`${url} → HTTP ${res.status}, not JSON. ${trimmed.slice(0, 200)}`)
  }

  if (!res.ok) {
    const msg =
      typeof data?.detail === 'string'
        ? data.detail
        : typeof data?.error === 'string'
          ? data.error
          : JSON.stringify(data)
    throw new Error(`${url} → HTTP ${res.status}: ${msg}`)
  }

  return data
}

export async function fetchJsonWithRetry(url, maxAttempts = 3) {
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

/** Forecast primary path + /forecast alias (misconfigured gateways). */
export async function fetchForecastWithFallback() {
  const primary = apiUrl('/metrics/forecast')
  try {
    return await fetchJsonWithRetry(primary)
  } catch (e) {
    const msg = e?.message || ''
    if (msg.includes('404')) {
      return fetchJsonWithRetry(apiUrl('/forecast'))
    }
    throw e
  }
}
