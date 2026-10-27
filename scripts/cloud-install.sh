#!/usr/bin/env bash
set -euo pipefail
cd /workspace/farm-management-app
export NEXT_TELEMETRY_DISABLED=1
npm ci --cache /workspace/.npm-cache --no-audit --no-fund
if [ ! -x /workspace/.farmstead-venv/bin/python ]; then
  python -m venv /workspace/.farmstead-venv
fi
/workspace/.farmstead-venv/bin/pip install --cache-dir /workspace/.pip-cache -r requirements.lock.txt
export FARM_PYTHON=/workspace/.farmstead-venv/bin/python
npm run db:setup
npm run db:check
npm test
/workspace/.farmstead-venv/bin/python -m pytest tests/python -q
npm run lint
npm run build
