#!/usr/bin/env bash
set -euo pipefail

: "${NDH_HUB_URL:?set NDH_HUB_URL, e.g. http://hub-host:4949}"
NDH_NAME="${NDH_NAME:-docker-$(hostname)}"
NDH_LABELS="${NDH_LABELS:-self-hosted,linux,docker}"
NDH_TOKEN="${NDH_TOKEN:-notdownhub}"

cd /home/runner/ndh

if [ ! -f .runner ]; then
  bin/Runner.Listener configure --unattended \
    --url "${NDH_HUB_URL%/}/runner/server" \
    --token "$NDH_TOKEN" \
    --name "$NDH_NAME" \
    --labels "$NDH_LABELS" \
    --work _work \
    --replace
fi

exec bin/Runner.Listener run
