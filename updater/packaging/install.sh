#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: install.sh <compdfctl> <compdf-updater> <config.json>" >&2
  exit 2
fi

for source in "$1" "$2" "$3"; do
  if [ ! -f "$source" ]; then
    echo "required file not found: $source" >&2
    exit 1
  fi
done

install -d -m 0750 -o root -g root /etc/compdf-updater
install -d -m 0700 -o root -g root /var/lib/compdf-updater
install -m 0755 "$1" /usr/local/sbin/compdfctl
install -m 0755 "$2" /usr/local/sbin/compdf-updater
install -m 0600 "$3" /etc/compdf-updater/config.json
install -m 0644 "$(dirname "$0")/compdf-updater.service" /etc/systemd/system/compdf-updater.service

if ! getent group compdf-updater >/dev/null 2>&1; then
  groupadd --system compdf-updater
fi

/usr/local/sbin/compdfctl config validate --file /etc/compdf-updater/config.json
systemctl daemon-reload
systemctl enable --now compdf-updater.service
systemctl --no-pager --full status compdf-updater.service
