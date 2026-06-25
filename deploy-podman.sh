#!/bin/bash
# Podman pod redeploy (production).
#
# Why this exists: the host runs the stack as a single podman pod (shared
# network namespace; all ports are published on the pod's infra container, so
# services reach each other over 127.0.0.1). `docker compose` is NOT usable
# here (no docker daemon permission), so redeploy.sh / redeploy-clean.sh do not
# work on this server. Run THIS script instead, on the server:
#
#   cd ~/terminal-wa-bot && git pull && bash deploy-podman.sh
#
# It rebuilds the backend+frontend images and recreates only those two
# containers inside the existing pod. db/redis (and their volumes) are left
# untouched. Secrets are read from ~/terminal-wa-bot/.env — never hardcoded.
# Previous images are kept as :backup for rollback.
set -euo pipefail
cd "$(dirname "$0")"

POD=07a6f6dc773a
B=localhost/terminal-wa-bot-backend
F=localhost/terminal-wa-bot-frontend

# Load secrets from .env (DB_PASSWORD, JWT_SECRET, SUPER_ADMIN_PASSWORD, ...)
set -a
. ./.env
set +a

echo "== [1/5] build images (:new) =="
podman build -t "$B:new" ./backend
podman build -t "$F:new" ./frontend

echo "== [2/5] backup current :latest -> :backup =="
podman tag "$B:latest" "$B:backup"
podman tag "$F:latest" "$F:backup"

echo "== [3/5] promote :new -> :latest =="
podman tag "$B:new" "$B:latest"
podman tag "$F:new" "$F:latest"

echo "== [4/5] recreate backend in pod =="
podman rm -f terminal-wa-bot-backend
podman run -d --pod "$POD" --name terminal-wa-bot-backend --restart unless-stopped \
  -e NODE_ENV=production -e DB_HOST=127.0.0.1 -e DB_PORT=5431 -e DB_NAME=wabot \
  -e DB_USER=wabot -e "DB_PASSWORD=${DB_PASSWORD}" \
  -e "JWT_SECRET=${JWT_SECRET}" \
  -e "SUPER_ADMIN_USER=${SUPER_ADMIN_USER:-admin}" -e "SUPER_ADMIN_PASSWORD=${SUPER_ADMIN_PASSWORD}" \
  -e REDIS_URL=redis://127.0.0.1:6379 \
  -e "USAGE_COST_CURRENCY=${USAGE_COST_CURRENCY:-IDR}" \
  -e "USAGE_COST_CURRENT_RATE_IDR=${USAGE_COST_CURRENT_RATE_IDR:-0}" \
  -e "USAGE_COST_META_UTILITY_RATE_IDR=${USAGE_COST_META_UTILITY_RATE_IDR:-285.32}" \
  -e "USAGE_COST_META_MARKETING_RATE_IDR=${USAGE_COST_META_MARKETING_RATE_IDR:-586.33}" \
  -e "USAGE_COST_USD_TO_IDR=${USAGE_COST_USD_TO_IDR:-16000}" \
  -e "USAGE_COST_TWILIO_PLATFORM_FEE_USD=${USAGE_COST_TWILIO_PLATFORM_FEE_USD:-0.005}" \
  -e "USAGE_COST_BIRD_PLATFORM_FEE_USD=${USAGE_COST_BIRD_PLATFORM_FEE_USD:-0.005}" \
  -e "USAGE_COST_VONAGE_PLATFORM_FEE_USD=${USAGE_COST_VONAGE_PLATFORM_FEE_USD:-0.00764}" \
  -e "USAGE_COST_BENCHMARK_PROVIDER_ID=${USAGE_COST_BENCHMARK_PROVIDER_ID:-meta_official_utility}" \
  -v ~/terminal-wa-bot/backend/logs:/app/logs \
  -v ~/terminal-wa-bot/backend/uploads:/app/uploads \
  "$B:latest"

echo "== [5/5] recreate frontend in pod =="
podman rm -f terminal-wa-bot-frontend
podman run -d --pod "$POD" --name terminal-wa-bot-frontend --restart unless-stopped "$F:latest"

echo "== done =="
sleep 4
podman ps --filter "pod=$POD" --format "{{.Names}} | {{.Status}}"

# Rollback: podman tag $B:backup $B:latest && podman tag $F:backup $F:latest
#           then re-run steps [4] and [5].
