#!/usr/bin/env sh
set -eu

nginx -t >/dev/null 2>&1
curl --fail --silent --show-error --max-time 2 \
  http://127.0.0.1:8081/api/v1/status >/dev/null
