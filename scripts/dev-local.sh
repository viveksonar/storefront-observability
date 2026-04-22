#!/usr/bin/env bash
# Start FastAPI locally (default http://127.0.0.1:8000).
# Terminal 2: cd frontend && npm run dev   → UI at http://localhost:5173 (proxies /metrics → this port).
#
# Port in use?  PORT=8001 ./scripts/dev-local.sh
# Match Vite:   VITE_PROXY_TARGET=http://127.0.0.1:8001 npm run dev

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8000}"

cd "$ROOT/backend"
export PYTHONPATH=.
exec python3 -m uvicorn main:app --host 127.0.0.1 --port "${PORT}"
