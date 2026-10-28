#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
ACTION="install"
ENV_FILE=".env"
BUILD=0
DRY_RUN=0
ALLOW_INSECURE_DEFAULTS=0

usage() {
  cat <<'EOF'
Usage: compdf-compose.sh [action] [options]

Actions: validate, install, status, logs, smoke, restart, stop, uninstall
Options:
  --env-file PATH
  --build
  --dry-run
  --allow-insecure-defaults
EOF
}

if [[ $# -gt 0 && "$1" != --* ]]; then
  ACTION="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?missing path after --env-file}"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-insecure-defaults) ALLOW_INSECURE_DEFAULTS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$ACTION" in
  validate|install|status|logs|smoke|restart|stop|uninstall) ;;
  *) echo "Unknown action: $ACTION" >&2; usage >&2; exit 2 ;;
esac

if [[ "$ENV_FILE" != /* ]]; then
  ENV_FILE="${REPO_ROOT}/${ENV_FILE}"
fi
[[ -f "$ENV_FILE" ]] || { echo "Environment file does not exist: $ENV_FILE" >&2; exit 2; }
command -v docker >/dev/null || { echo 'Required command is not available: docker' >&2; exit 2; }
command -v node >/dev/null || { echo 'Required command is not available: node' >&2; exit 2; }

if [[ $ALLOW_INSECURE_DEFAULTS -eq 0 ]] && grep -Eq '^CORS_ORIGINS[[:space:]]*=[[:space:]]*\*[[:space:]]*$' "$ENV_FILE"; then
  echo 'CORS_ORIGINS=* is blocked. Set explicit HTTPS origins or pass --allow-insecure-defaults for a non-production environment.' >&2
  exit 2
fi

compose=(docker compose --env-file "$ENV_FILE" -f "${REPO_ROOT}/docker-compose.yml")
if [[ $BUILD -eq 1 ]]; then
  compose+=(-f "${REPO_ROOT}/docker-compose.build.yml")
fi

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

smoke() {
  local url='http://127.0.0.1:8080/api/v1/status'
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] GET $url"
    return
  fi
  for _ in {1..30}; do
    if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null; then
      echo "Smoke check passed: $url"
      return
    fi
    sleep 2
  done
  echo "Smoke check failed: $url" >&2
  return 1
}

cd "$REPO_ROOT"
if [[ $DRY_RUN -eq 0 ]]; then
  docker compose version
  node scripts/validate-compose.mjs "$ENV_FILE"
else
  echo "[dry-run] node scripts/validate-compose.mjs $ENV_FILE"
fi

case "$ACTION" in
  validate) run "${compose[@]}" config --quiet ;;
  install)
    run "${compose[@]}" pull --ignore-buildable
    up=(up -d --remove-orphans)
    [[ $BUILD -eq 1 ]] && up+=(--build)
    run "${compose[@]}" "${up[@]}"
    smoke
    ;;
  status) run "${compose[@]}" ps ;;
  logs) run "${compose[@]}" logs --tail 200 ;;
  smoke) smoke ;;
  restart) run "${compose[@]}" restart; smoke ;;
  stop) run "${compose[@]}" stop ;;
  uninstall) run "${compose[@]}" down --remove-orphans ;;
esac
