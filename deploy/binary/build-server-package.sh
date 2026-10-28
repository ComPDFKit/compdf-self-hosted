#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
OUTPUT_DIR="${1:-${REPO_ROOT}/output}"
VERSION="$(node -p "require('${REPO_ROOT}/release/version.json').productVersion")"
PACKAGE="${OUTPUT_DIR}/compdf-server-${VERSION}-linux-$(uname -m).tar.gz"
BUILD_ROOT="$(mktemp -d)"

cleanup() { rm -rf -- "$BUILD_ROOT"; }
trap cleanup EXIT

command -v node >/dev/null
command -v npm >/dev/null
command -v tar >/dev/null
mkdir -p "$OUTPUT_DIR" "$BUILD_ROOT/frontend" "$BUILD_ROOT/server" "$BUILD_ROOT/package/server/public"

tar -C "${REPO_ROOT}/frontend/compdf-web" --exclude=node_modules --exclude=dist -cf - . \
  | tar -C "$BUILD_ROOT/frontend" -xf -
tar -C "${REPO_ROOT}/server" --exclude=node_modules --exclude=dist -cf - . \
  | tar -C "$BUILD_ROOT/server" -xf -

npm ci --prefix "$BUILD_ROOT/frontend"
npm run --prefix "$BUILD_ROOT/frontend" build
npm ci --prefix "$BUILD_ROOT/server"
npm run --prefix "$BUILD_ROOT/server" build
npm prune --prefix "$BUILD_ROOT/server" --omit=dev

cp -a "$BUILD_ROOT/server/dist" "$BUILD_ROOT/package/server/"
cp -a "$BUILD_ROOT/server/node_modules" "$BUILD_ROOT/package/server/"
cp "$BUILD_ROOT/server/package.json" "$BUILD_ROOT/server/package-lock.json" "$BUILD_ROOT/package/server/"
mkdir -p "$BUILD_ROOT/package/server/public/compdf-web" "$BUILD_ROOT/package/server/release/migrations" "$BUILD_ROOT/package/server/defaults"
cp -a "$BUILD_ROOT/frontend/dist/." "$BUILD_ROOT/package/server/public/compdf-web/"
cp "${REPO_ROOT}/configs/init.sql" "$BUILD_ROOT/package/server/release/init.sql"
cp -a "${REPO_ROOT}/migrations/." "$BUILD_ROOT/package/server/release/migrations/"
cp "${REPO_ROOT}/configs/settings.yml" "$BUILD_ROOT/package/server/defaults/settings.yml"
cp "${REPO_ROOT}/release/version.json" "$BUILD_ROOT/package/server/release/version.json"

[[ ! -e "$PACKAGE" ]] || { echo "Package already exists: $PACKAGE" >&2; exit 1; }
tar --numeric-owner --owner=0 --group=0 -C "$BUILD_ROOT/package" -czf "$PACKAGE" server
sha256sum "$PACKAGE" >"${PACKAGE}.sha256"
echo "$PACKAGE"
