#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 3 ]]; then
  echo 'Usage: prepare-images.sh <working-directory> <app-tag@sha256> <server-tag@sha256>' >&2
  exit 2
fi
WORK="$(mkdir -p "$1" && cd -- "$1" && pwd)"
APP_IMAGE="$2"
SERVER_IMAGE="$3"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

[[ "$APP_IMAGE" =~ @sha256:[0-9a-fA-F]{64}$ ]] || { echo 'App image must be an immutable tag@sha256 reference.' >&2; exit 2; }
[[ "$SERVER_IMAGE" =~ @sha256:[0-9a-fA-F]{64}$ ]] || { echo 'Server image must be an immutable tag@sha256 reference.' >&2; exit 2; }
command -v docker >/dev/null || { echo 'docker is required.' >&2; exit 2; }
mkdir -p "$WORK/artifacts"

docker pull "$APP_IMAGE"
docker pull "$SERVER_IMAGE"
docker image save --output "$WORK/artifacts/compdf-app.docker.tar" "$APP_IMAGE"
docker image save --output "$WORK/artifacts/compdf-server.docker.tar" "$SERVER_IMAGE"
cp "$REPO_ROOT/docker-compose.yml" "$WORK/artifacts/compose.release.yml"
[[ -f "$WORK/release-spec.json" ]] || cp "$SCRIPT_DIR/release-spec.example.json" "$WORK/release-spec.json"
sha256sum "$WORK"/artifacts/*
echo "Edit $WORK/release-spec.json with the exact image tags, digests, dates, and release notes before signing."
