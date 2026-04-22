/** Failure mode simulator options — POST /simulate/{id} */

export const FAILURE_MODES = [
  {
    id: 'normal',
    label: 'Reset to Normal',
    shortLabel: 'Normal',
    description: 'Storefront active · Least-inflight-requests routing · All backends healthy',
    color: 'var(--green)',
    border: 'var(--green)',
  },
  {
    id: 'dns_stickiness',
    label: 'DNS Stickiness',
    shortLabel: 'DNS',
    description: 'Microsoft DNS TTL=1s · One backend absorbs ~76% RPS · Pre-Storefront failure',
    color: 'var(--red)',
    border: 'var(--red)',
    article: 'Storefront article Feb 2026 — original problem that motivated the build',
  },
  {
    id: 'connection_exhaustion',
    label: 'Connection Exhaustion',
    shortLabel: 'Conn exhaustion',
    description: 'Bad S3 client not reading responses · Connections accumulate · IO stream timeouts firing',
    color: 'var(--red)',
    border: 'var(--red)',
    article: 'Storefront article Feb 2026 — IO stream timeout fix',
  },
  {
    id: 'cross_dc_throttling',
    label: 'Cross-DC Throttling',
    shortLabel: 'Cross-DC',
    description: 'Backup replication saturates cross-DC pool · Collateral latency on same-DC backends',
    color: 'var(--amber)',
    border: 'var(--amber)',
    article: 'Storefront article Feb 2026 — distinct upstream pools fix',
  },
]
