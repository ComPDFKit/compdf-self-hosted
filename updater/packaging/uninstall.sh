#!/bin/sh
set -eu

systemctl disable --now compdf-updater.service 2>/dev/null || true
rm -f /etc/systemd/system/compdf-updater.service
rm -f /usr/local/sbin/compdfctl /usr/local/sbin/compdf-updater
systemctl daemon-reload

echo "Updater binaries and service removed. Protected config, state, releases, and backups were preserved."
echo "Remove /etc/compdf-updater and /var/lib/compdf-updater manually only after confirming retention requirements."
