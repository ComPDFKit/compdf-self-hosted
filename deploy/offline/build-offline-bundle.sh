#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 5 ]]; then
  echo 'Usage: build-offline-bundle.sh <spec.json> <private-key> <key-id> <output-directory> <package.tar.zst>' >&2
  exit 2
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
SPEC="$(realpath "$1")"
KEY="$(realpath "$2")"
KEY_ID="$3"
OUTPUT="$(realpath -m "$4")"
PACKAGE="$(realpath -m "$5")"

command -v go >/dev/null || { echo 'go is required.' >&2; exit 2; }
[[ ! -e "$OUTPUT" ]] || { echo "Output directory already exists: $OUTPUT" >&2; exit 1; }
[[ ! -e "$PACKAGE" ]] || { echo "Offline package already exists: $PACKAGE" >&2; exit 1; }

cd "$REPO_ROOT/updater"
go run ./cmd/compdf-release \
  --spec "$SPEC" \
  --private-key "$KEY" \
  --key-id "$KEY_ID" \
  --output "$OUTPUT" \
  --offline-package "$PACKAGE" \
  --approve
sha256sum "$PACKAGE"
