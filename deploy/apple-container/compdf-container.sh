#!/bin/bash
# Apple container 1.5.0 reference implementation; compatible with macOS Bash 3.2.
set -euo pipefail

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  echo 'Usage: bash compdf-container.sh {plan|up|status|stop} --config /absolute/path/.env'
}
ACTION=${1:-}
case "$ACTION" in plan|up|status|stop) shift ;; *) usage; exit 2 ;; esac
[[ $# == 2 && $1 == --config ]] || { usage; exit 2; }
CONFIG=$2
[[ -f "$CONFIG" ]] || die "Config file not found: $CONFIG"

# Parse literal KEY=value, never execute configuration as shell code.
while IFS= read -r line || [[ -n "$line" ]]; do
  line=${line%$'\r'}
  case "$line" in ''|\#*) continue ;; esac
  [[ "$line" == *=* ]] || die 'Expected KEY=value in config'
  key=${line%%=*}; value=${line#*=}
  case "$key" in
    PROJECT|ARCH|CONFIG_DIR|FONT_DIR|STORAGE_DIR|COMPDF_LICENSE_KEY|INFRA_IMAGE|APP_IMAGE|SERVER_IMAGE|HOST_PORT|INFRA_MEMORY|APP_MEMORY|SERVER_MEMORY|CPUS|HEALTH_ATTEMPTS|COMPDF_VERSION|COMPDF_DB_SCHEMA_VERSION) printf -v "$key" '%s' "$value" ;;
    *) die "Unknown config key: $key" ;;
  esac
done < "$CONFIG"

PROJECT=${PROJECT:-compdf-apple}
ARCH=${ARCH:-amd64}
INFRA_IMAGE=${INFRA_IMAGE:-compdfkit/compdf-infra:1.0.0}
APP_IMAGE=${APP_IMAGE:-compdfkit/compdf-app:1.0.0}
SERVER_IMAGE=${SERVER_IMAGE:-compdfkit/compdf-server:1.1.0}
HOST_PORT=${HOST_PORT:-8080}
INFRA_MEMORY=${INFRA_MEMORY:-3G}
APP_MEMORY=${APP_MEMORY:-16G}
SERVER_MEMORY=${SERVER_MEMORY:-2G}
CPUS=${CPUS:-2}
HEALTH_ATTEMPTS=${HEALTH_ATTEMPTS:-60}
COMPDF_VERSION=${COMPDF_VERSION:-1.1.0}
COMPDF_DB_SCHEMA_VERSION=${COMPDF_DB_SCHEMA_VERSION:-1.1.0}
COMPDF_LICENSE_KEY=${COMPDF_LICENSE_KEY:-}
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || die 'Invalid PROJECT'
[[ "$ARCH" == amd64 || "$ARCH" == arm64 ]] || die 'ARCH must be amd64 or arm64'
[[ "$HOST_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && (( HOST_PORT <= 65535 )) || die 'Invalid HOST_PORT'
[[ "$CPUS" =~ ^[1-9][0-9]?$ ]] || die 'Invalid CPUS'
[[ "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]{0,2}$ ]] || die 'Invalid HEALTH_ATTEMPTS'
for memory in "$INFRA_MEMORY" "$APP_MEMORY" "$SERVER_MEMORY"; do
  [[ "$memory" =~ ^[1-9][0-9]*[MG]$ ]] || die 'Memory must use integer M or G units'
done
for image in "$INFRA_IMAGE" "$APP_IMAGE" "$SERVER_IMAGE"; do
  [[ "$image" != *[[:space:]]* && "$image" != -* && "$image" == *:* && "$image" != *:latest ]] || die 'Use a versioned image or digest'
done
NETWORK="$PROJECT-net"
INFRA="$PROJECT-infra"; APP="$PROJECT-app"; SERVER="$PROJECT-server"

run() {
  if [[ "$ACTION" == plan ]]; then
    printf 'container'
    printf ' %q' "$@"
    printf '\n'
  else
    container "$@"
  fi
}

if [[ "$ACTION" != plan ]]; then
  [[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || die 'Requires a native Apple Silicon macOS shell'
  mac_version=$(sw_vers -productVersion)
  (( ${mac_version%%.*} >= 26 )) || die 'Requires macOS 26 or later'
  command -v container >/dev/null || die 'Install Apple container first'
  command -v jq >/dev/null || die 'Install jq first'
  container system status >/dev/null || die 'Run container system start first'
fi

if [[ "$ACTION" == status ]]; then
  # Do not dump inspect JSON: it can include license environment values.
  container list --all --format json | jq --arg p "$PROJECT-" \
    '[.[] | select(.configuration.id == ($p+"infra") or .configuration.id == ($p+"app") or .configuration.id == ($p+"server")) | {name: .configuration.id, state: .status.state, networks: .status.networks}]'
  exit
fi
if [[ "$ACTION" == stop ]]; then
  for name in "$SERVER" "$APP" "$INFRA"; do
    if container inspect "$name" >/dev/null 2>&1; then run stop --time 30 "$name"; fi
  done
  echo 'Containers stopped. Containers, volumes and bind-mounted files retained.'
  exit
fi

for path in "${CONFIG_DIR:-}" "${FONT_DIR:-}" "${STORAGE_DIR:-}"; do
  [[ "$path" == /* && "$path" != / && "$path" != *','* && "$path" != *':'* ]] || die 'Use absolute directory paths without comma/colon'
  [[ -d "$path" ]] || die "Required directory missing: $path"
done
[[ -s "$CONFIG_DIR/settings.yml" ]] || die 'settings.yml missing from CONFIG_DIR'
[[ -d "$CONFIG_DIR/app-license" ]] || die 'Supply CONFIG_DIR/app-license for SDK license files'
[[ -s "$CONFIG_DIR/app-license/license.xml" || -n "$COMPDF_LICENSE_KEY" ]] || die 'Place the issued license at CONFIG_DIR/app-license/license.xml'

if [[ "$ACTION" == up ]]; then
  # A fresh container set avoids stale downstream IPs after VM recreation.
  for name in "$INFRA" "$APP" "$SERVER"; do
    if container inspect "$name" >/dev/null 2>&1; then
      die "$name exists. See the manual for stop/recreate; existing data is never deleted automatically."
    fi
  done
  # Require local, matching images before creating resources. Online: pull; offline: load.
  for image in "$INFRA_IMAGE" "$APP_IMAGE" "$SERVER_IMAGE"; do
    container image inspect "$image" | jq -e --arg arch "$ARCH" \
      '.[0].variants | any(.platform.os == "linux" and .platform.architecture == $arch)' >/dev/null \
      || die "Image missing or architecture unavailable: $image ($ARCH)"
  done
fi

if [[ "$ACTION" == plan ]] || ! container network inspect "$NETWORK" >/dev/null 2>&1; then
  run network create "$NETWORK"
fi
for volume in mysql redis rustfs output pdf; do
  if [[ "$ACTION" == plan ]] || ! container volume inspect "$PROJECT-$volume" >/dev/null 2>&1; then
    run volume create "$PROJECT-$volume"
  fi
done
COMMON=(--detach --arch "$ARCH" --cpus "$CPUS" --network "$NETWORK")
if [[ "$ARCH" == amd64 ]]; then COMMON+=(--rosetta); fi

wait_health() {
  local name=$1 attempt=0
  shift
  if [[ "$ACTION" == plan ]]; then echo "# Wait for $name health (up to $HEALTH_ATTEMPTS attempts)"; return; fi
  until container exec "$name" "$@" >/dev/null 2>&1; do
    attempt=$((attempt+1))
    (( attempt < HEALTH_ATTEMPTS )) || die "$name health failed. Inspect container logs; downstream startup blocked."
    sleep 5
  done
}
get_ip() {
  if [[ "$ACTION" == plan ]]; then printf '<%s-IP>' "$1"; return; fi
  container inspect "$1" | jq -er --arg net "$NETWORK" \
    '.[0].status.networks[] | select(.network == $net) | .ipv4Address | split("/")[0] | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$"))'
}

run run "${COMMON[@]}" --name "$INFRA" --memory "$INFRA_MEMORY" \
  --env RUSTFS_ACCESS_KEY=compdfkit-ak --env RUSTFS_SECRET_KEY=compdfkit-sk-2026 \
  --mount "type=volume,source=$PROJECT-mysql,target=/var/lib/mysql" \
  --mount "type=volume,source=$PROJECT-rustfs,target=/data" \
  --mount "type=volume,source=$PROJECT-redis,target=/data/redis" "$INFRA_IMAGE"
wait_health "$INFRA" sh -c 'mysqladmin ping -h 127.0.0.1 -u compdfkit -pcompdfkit-pass-2026 --silent && redis-cli ping | grep -q PONG && curl --max-time 5 -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9000/ | grep -qE "^[2-4]"'
INFRA_IP=$(get_ip "$INFRA")

# Inherit secrets by variable name; do not put license values in the command/plan.
export COMPDF_LICENSE_KEY
export COMPDFKIT_LICENSE="$COMPDF_LICENSE_KEY"
run run "${COMMON[@]}" --name "$APP" --memory "$APP_MEMORY" \
  --env "REDIS_URL=redis://$INFRA_IP:6379/0" --env "MYSQL_HOST=$INFRA_IP" \
  --env "S3_ENDPOINT=http://$INFRA_IP:9000" --env COMPDF_LICENSE_KEY --env COMPDFKIT_LICENSE \
  --mount "type=bind,source=$FONT_DIR,target=/opt/compdf_sdk/fonts/windows,readonly" \
  --mount "type=bind,source=$CONFIG_DIR/app-license,target=/opt/compdf_sdk/license,readonly" \
  --mount "type=volume,source=$PROJECT-output,target=/tmp/compdf_output" \
  --mount "type=volume,source=$PROJECT-pdf,target=/data" "$APP_IMAGE"
wait_health "$APP" python -c "import urllib.request; assert urllib.request.urlopen('http://127.0.0.1:7000/health',timeout=3).status == 200"
APP_IP=$(get_ip "$APP")

run run "${COMMON[@]}" --name "$SERVER" --memory "$SERVER_MEMORY" \
  --publish "127.0.0.1:$HOST_PORT:8080" \
  --env "DATABASE_HOST=$INFRA_IP" --env "REDIS_HOST=$INFRA_IP" \
  --env "CONVERSION_BASE_URL=http://$APP_IP:7000" --env "PDF_SDK_BASE_URL=http://$APP_IP:7001" \
  --env "COMPDF_VERSION=$COMPDF_VERSION" --env "COMPDF_DB_SCHEMA_VERSION=$COMPDF_DB_SCHEMA_VERSION" \
  --env LICENSE_TOKEN_PATH=/app/configs/license.jwt --env MCP_ENABLED=true \
  --env "MCP_PUBLIC_URL=http://localhost:$HOST_PORT/mcp" \
  --mount "type=bind,source=$CONFIG_DIR,target=/app/configs" \
  --mount "type=bind,source=$STORAGE_DIR,target=/app/storage" \
  "$SERVER_IMAGE" sh -c 'npm run init:db && npm run start'
wait_health "$SERVER" node -e "fetch('http://127.0.0.1:8080/api/v1/status',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
if [[ "$ACTION" == up ]]; then
  echo "Health checks passed. Open http://localhost:$HOST_PORT; real PDF acceptance still required."
else
  echo '# Plan only: no container commands executed. IP placeholders resolved during up.'
fi
