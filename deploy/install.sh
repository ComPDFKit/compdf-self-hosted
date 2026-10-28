#!/bin/bash
# Standalone installer: download this file or pipe it to bash; no Git/Node required.
# Keep execution inside main so an interrupted script download cannot run half a file.
set -euo pipefail

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: bash install.sh [install|status|logs|stop] [options]
  --runtime docker|apple   Default: docker (Docker Compose v2)
  --dir PATH               Default: ./compdf-self-hosted
  --ref REF                GitHub branch/tag/commit for fresh installs (default: main)
  --prepare-only           Download/configure only; do not pull or start containers
  --dry-run                Print plan only; no downloads, files or runtime changes
  --env-file PATH          Use your Compose-style .env instead of the repository template
  --license-file PATH      Supply Server license.jwt
  --sdk-license-dir PATH   Copy the directory containing the issued license.xml
  --fonts-dir PATH         Copy licensed fonts from this directory
  -h, --help
Fresh installs use the repository template; supply issued trial/production licenses.
Existing installs
are reused without overwriting config/data or downloading updates. Runtime must be
installed separately. This installer is not an upgrade or database rollback tool.
HELP
}

main() {
  ACTION=install; RUNTIME=docker; TARGET="$PWD/compdf-self-hosted"; REF=main
  PREPARE=0; DRY=0; ENV_INPUT=; LICENSE_INPUT=; SDK_INPUT=; FONTS_INPUT=
  if [[ $# -gt 0 && $1 != -* ]]; then ACTION=$1; shift; fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --runtime|--dir|--ref|--env-file|--license-file|--sdk-license-dir|--fonts-dir)
        [[ $# -ge 2 && -n "$2" ]] || die "Missing value for $1"
        case "$1" in
          --runtime) RUNTIME=$2 ;; --dir) TARGET=$2 ;; --ref) REF=$2 ;;
          --env-file) ENV_INPUT=$2 ;; --license-file) LICENSE_INPUT=$2 ;;
          --sdk-license-dir) SDK_INPUT=$2 ;; --fonts-dir) FONTS_INPUT=$2 ;;
        esac
        shift 2 ;;
      --prepare-only) PREPARE=1; shift ;;
      --dry-run) DRY=1; shift ;;
      -h|--help) usage; return ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  case "$ACTION" in install|status|logs|stop) ;; *) die "Unknown action: $ACTION" ;; esac
  [[ "$ACTION" == install || $PREPARE == 0 ]] || die '--prepare-only is valid only for install'
  [[ "$RUNTIME" == docker || "$RUNTIME" == apple ]] || die 'Runtime must be docker or apple'
  [[ "$REF" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]*$ && "$REF" != *..* ]] || die 'Invalid source ref'
  [[ "$TARGET" == /* ]] || TARGET="$PWD/$TARGET"
  [[ "$TARGET" != *$'\n'* && "$TARGET" != *','* && "$TARGET" != *':'* ]] || die 'Invalid installation path'
  [[ "$TARGET" != */ && "$TARGET" != */. && "$TARGET" != */.. ]] || die 'Use a dedicated directory path without trailing slash/dot'
  SOURCE="https://raw.githubusercontent.com/ComPDFKit/compdf-self-hosted/$REF"
  for file in "$ENV_INPUT" "$LICENSE_INPUT"; do
    [[ -z "$file" || -s "$file" ]] || die "Missing input file: $file"
  done
  for directory in "$SDK_INPUT" "$FONTS_INPUT"; do
    [[ -z "$directory" || -d "$directory" ]] || die "Missing input directory: $directory"
  done
  if [[ $DRY == 1 ]]; then
    printf 'Plan: action=%s runtime=%s directory=%s source=%s\n' "$ACTION" "$RUNTIME" "$TARGET" "$SOURCE"
    echo 'Fresh install: download minimal assets, prepare config/data/fonts, then pull and start (unless --prepare-only).'
    echo 'Existing install: preserve files; use the saved configuration. No commands executed.'
    return
  fi
  case "$(uname -s)" in Linux|Darwin) ;; *) die 'Run in Linux/WSL or macOS Bash; native Windows Git Bash is not a deployment host' ;; esac
  if [[ $PREPARE == 0 ]]; then check_runtime; fi
  if [[ -e "$TARGET" || -L "$TARGET" ]]; then
    [[ -d "$TARGET" && ! -L "$TARGET" && -f "$TARGET/.compdf-install" ]] || die 'Directory exists and is not managed by this installer; choose another --dir'
    [[ $(sed -n '1p' "$TARGET/.compdf-install") == "$RUNTIME" ]] || die 'Runtime differs from the existing installation'
    [[ -z "$ENV_INPUT$LICENSE_INPUT$SDK_INPUT$FONTS_INPUT" ]] || die 'Existing configuration is preserved. Edit it in place; input-copy options apply only to a fresh install'
    echo "Using existing installation: $TARGET (no files overwritten; --ref applies only to fresh installs)"
  else
    [[ "$ACTION" == install ]] || die 'No installation found at --dir'
    prepare_install
  fi
  [[ $PREPARE == 0 ]] || { echo "Files ready: $TARGET. No images pulled or services started."; return; }
  cd "$TARGET"
  if [[ "$RUNTIME" == docker ]]; then
    [[ -s .env && -s docker-compose.yml ]] || die 'Installation is incomplete: .env or docker-compose.yml missing'
    project=$(sed -n '3p' .compdf-install)
    [[ "$project" =~ ^compdf-[0-9]+$ ]] || die 'Invalid saved Compose project identity'
    compose=(docker compose --project-name "$project" --project-directory "$TARGET" --env-file "$TARGET/.env" -f "$TARGET/docker-compose.yml")
    "${compose[@]}" config --quiet
    case "$ACTION" in
      install)
        "${compose[@]}" pull
        "${compose[@]}" up -d --wait --wait-timeout 600
        ;;
      status) "${compose[@]}" ps ;;
      logs) "${compose[@]}" logs --tail 100 ;;
      stop) "${compose[@]}" stop ;;
    esac
  else
    [[ -s .apple.env && -s compdf-container.sh ]] || die 'Installation is incomplete: Apple assets missing'
    project=$(env_value PROJECT .apple.env)
    [[ "$project" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || die 'Invalid Apple PROJECT'
    case "$ACTION" in
      install)
        # Apple helper refuses existing containers before any image downloads.
        for name in "$project-infra" "$project-app" "$project-server"; do
          if container inspect "$name" >/dev/null 2>&1; then
            die "$name exists; follow the Apple manual's stop/recreate procedure to refresh dependency IPs"
          fi
        done
        for key in INFRA_IMAGE APP_IMAGE SERVER_IMAGE; do
          image=$(env_value "$key" .apple.env)
          container image pull --arch "$(env_value ARCH .apple.env)" "$image"
        done
        bash ./compdf-container.sh up --config "$TARGET/.apple.env"
        ;;
      status|stop) bash ./compdf-container.sh "$ACTION" --config "$TARGET/.apple.env" ;;
      logs) for name in "$project-infra" "$project-app" "$project-server"; do container logs -n 100 "$name"; done ;;
    esac
  fi
  if [[ "$ACTION" == install ]]; then
    echo "Services passed startup health checks. Web: http://localhost:8080/  Dashboard: http://localhost:8080/admin"
    echo "Configuration/data: $TARGET. Issued licenses and real PDF processing still require verification."
  fi
}

check_runtime() {
  if [[ "$RUNTIME" == docker ]]; then
    command -v docker >/dev/null || die 'Install Docker Engine/Desktop and Compose v2 first'
    docker info >/dev/null 2>&1 || die 'Docker daemon unavailable or permission denied'
    docker compose version >/dev/null || die 'Docker Compose v2 is required'
    docker compose up --help | grep -- '--wait-timeout' >/dev/null || die 'Update Compose v2: --wait-timeout support is required'
  else
    [[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || die 'Apple mode requires Apple Silicon macOS'
    local version
    version=$(sw_vers -productVersion)
    (( ${version%%.*} >= 26 )) || die 'Apple mode requires macOS 26+'
    command -v container >/dev/null || die 'Install Apple container 1.5.0 first'
    command -v jq >/dev/null || die 'Install jq first'
    container system start
    container system status >/dev/null
  fi
}

fetch_asset() {
  local source=$1 destination=$2
  mkdir -p "$(dirname "$destination")"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    --retry 3 --connect-timeout 15 --max-time 180 "$SOURCE/$source" --output "$destination"
  [[ -s "$destination" ]] || die "Empty download: $source"
}

# Only literal KEY=value is accepted here; never source or eval downloaded .env.
env_value() {
  local wanted=$1 file=$2 line value= found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    if [[ "$line" == "$wanted="* ]]; then value=${line#*=}; found=$((found+1)); fi
  done < "$file"
  (( found <= 1 )) || die "Duplicate variable: $wanted"
  # Accept simple outer quotes for Docker .env -> Apple literal configuration.
  if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value=${value:1:${#value}-2}; fi
  printf '%s' "$value"
}

prepare_install() {
  command -v curl >/dev/null || die 'curl is required to download installation assets'
  umask 077
  local parent stage key value resolved project
  parent=$(dirname "$TARGET")
  mkdir -p "$parent"
  parent=$(cd "$parent" && pwd -P)
  TARGET="$parent/$(basename "$TARGET")"
  stage=$(mktemp -d "$parent/.compdf-install.XXXXXX")
  # Only this freshly created temporary directory is removed on download failure.
  STAGE=$stage
  trap 'if [[ -n "${STAGE:-}" && -d "$STAGE" ]]; then rm -rf -- "$STAGE"; fi' EXIT
  if [[ "$REF" =~ ^[a-fA-F0-9]{40}$ ]]; then
    resolved=$REF
  else
    resolved=$(curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      --retry 3 --connect-timeout 15 --max-time 60 -H 'Accept: application/vnd.github.sha' \
      "https://api.github.com/repos/ComPDFKit/compdf-self-hosted/commits/$REF")
    [[ "$resolved" =~ ^[a-fA-F0-9]{40}$ ]] || die 'Could not resolve source ref to a commit SHA; try --ref with a full commit SHA'
  fi
  SOURCE="https://raw.githubusercontent.com/ComPDFKit/compdf-self-hosted/$resolved"
  project=$(printf '%s' "$TARGET" | cksum | awk '{print "compdf-" $1}')
  fetch_asset docker-compose.yml "$stage/docker-compose.yml"
  fetch_asset .env.example "$stage/.env.example"
  fetch_asset configs/settings.yml "$stage/configs/settings.yml"
  fetch_asset deploy/install.sh "$stage/install.sh"
  if [[ -n "$ENV_INPUT" ]]; then cp "$ENV_INPUT" "$stage/.env"; else cp "$stage/.env.example" "$stage/.env"; fi
  if [[ -n "$LICENSE_INPUT" ]]; then
    cp "$LICENSE_INPUT" "$stage/configs/license.jwt"
  else
    fetch_asset configs/license.jwt "$stage/configs/license.jwt"
  fi
  mkdir -p "$stage/configs/app-license" "$stage/fonts/windows" "$stage/data/server-storage"
  [[ -z "$SDK_INPUT" ]] || cp -R "$SDK_INPUT/." "$stage/configs/app-license/"
  [[ -z "$FONTS_INPUT" ]] || cp -R "$FONTS_INPUT/." "$stage/fonts/windows/"
  if [[ "$RUNTIME" == apple ]]; then
    fetch_asset deploy/apple-container/compdf-container.sh "$stage/compdf-container.sh"
    {
      printf 'PROJECT=%s\nARCH=amd64\n' "$project"
      for key in INFRA APP SERVER; do
        value=$(env_value "COMPDF_${key}_IMAGE" "$stage/.env")
        [[ -n "$value" ]] || die "COMPDF_${key}_IMAGE is required in .env for Apple mode"
        printf '%s_IMAGE=%s\n' "$key" "$value"
      done
      value=$(env_value COMPDF_LICENSE_KEY "$stage/.env")
      # Preserve explicitly supplied legacy configuration without adding it to new templates.
      if [[ -n "$value" ]]; then printf 'COMPDF_LICENSE_KEY=%s\n' "$value"; fi
      printf 'CONFIG_DIR=%s/configs\nFONT_DIR=%s/fonts/windows\nSTORAGE_DIR=%s/data/server-storage\n' "$TARGET" "$TARGET" "$TARGET"
      for key in COMPDF_VERSION COMPDF_DB_SCHEMA_VERSION; do
        value=$(env_value "$key" "$stage/.env")
        printf '%s=%s\n' "$key" "${value:-1.1.0}"
      done
    } > "$stage/.apple.env"
  fi
  chmod 600 "$stage/.env" "$stage/configs/license.jwt"
  printf '%s\n%s\n%s\n' "$RUNTIME" "$resolved" "$project" > "$stage/.compdf-install"
  # Refuse an installation created by another process while we downloaded.
  [[ ! -e "$TARGET" && ! -L "$TARGET" ]] || die 'Installation directory appeared during preparation; refusing to overwrite'
  mv "$stage" "$TARGET"
  STAGE=
  echo "Installation files prepared: $TARGET (source ref: $REF)"
}

main "$@"
