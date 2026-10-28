#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $EUID -ne 0 ]]; then
  echo 'Run this installer as root.' >&2
  exit 2
fi
if [[ $# -ne 4 ]]; then
  echo 'Usage: install-server.sh <package.tar.gz> <version> <environment-file> <license.jwt>' >&2
  exit 2
fi

PACKAGE="$(realpath "$1")"
VERSION="$2"
ENV_FILE="$(realpath "$3")"
LICENSE_FILE="$(realpath "$4")"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="/opt/compdf/releases/${VERSION}"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Version must be semantic x.y.z.' >&2; exit 2; }
[[ -f "$PACKAGE" && -f "$ENV_FILE" && -f "$LICENSE_FILE" ]] || { echo 'Package, environment file, or license file is missing.' >&2; exit 2; }
[[ ! -e "$RELEASE_DIR" ]] || { echo "Release already exists: $RELEASE_DIR" >&2; exit 1; }
command -v node >/dev/null || { echo 'Node.js 24 is required.' >&2; exit 2; }

if ! id compdf >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/compdf --shell /usr/sbin/nologin compdf
fi
install -d -m 0755 /opt/compdf/releases "$RELEASE_DIR"
install -d -o compdf -g compdf -m 0750 /etc/compdf /var/lib/compdf/server-storage
tar -xzf "$PACKAGE" -C "$RELEASE_DIR" --no-same-owner
[[ -f "$RELEASE_DIR/server/dist/src/main.js" ]] || { echo 'Invalid package: Server entrypoint is missing.' >&2; exit 1; }

install -o compdf -g compdf -m 0600 "$ENV_FILE" /etc/compdf/compdf-server.env
install -o compdf -g compdf -m 0600 "$LICENSE_FILE" /etc/compdf/license.jwt
if [[ ! -f /etc/compdf/settings.yml ]]; then
  install -o compdf -g compdf -m 0640 "$RELEASE_DIR/server/defaults/settings.yml" /etc/compdf/settings.yml
fi
chown -R root:root "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" /opt/compdf/current
install -m 0644 "$SCRIPT_DIR/compdf-server.service" /etc/systemd/system/compdf-server.service
systemctl daemon-reload
systemctl enable --now compdf-server
systemctl --no-pager --full status compdf-server
