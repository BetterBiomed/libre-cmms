#!/usr/bin/env bash
# Libre CMMS - Copyright (C) 2026 CreativeMed LLC - AGPL-3.0-or-later
# Installs Libre as a systemd service. Run from the unzipped Libre folder:
#   sudo bash scripts/install-linux.sh [--port 8080]
set -euo pipefail
PORT=""
while [ $# -gt 0 ]; do case "$1" in --port) PORT="$2"; shift 2;; *) echo "Unknown option $1"; exit 1;; esac; done

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js 24 is required: https://nodejs.org"; exit 1; }
MAJOR="$($NODE -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 22 ] || { echo "Node.js $($NODE -v) is too old; install Node.js 24 LTS."; exit 1; }

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/libre
DATA=/var/lib/libre

id libre >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin libre
mkdir -p "$APP" "$DATA"
# Copy program files (never overwrite an existing config).
for d in server public scripts docs; do rm -rf "${APP:?}/$d"; cp -r "$SRC/$d" "$APP/"; done
cp "$SRC"/package.json "$SRC"/README.md "$SRC"/LICENSE "$SRC"/NOTICE "$APP"/ 2>/dev/null || true
mkdir -p "$APP/config"
cp "$SRC/config/libre.config.example.json" "$APP/config/"
if [ ! -f "$APP/config/libre.config.json" ]; then
  sed "s#\"dataDir\": \"data\"#\"dataDir\": \"$DATA\"#" "$SRC/config/libre.config.example.json" > "$APP/config/libre.config.json"
fi
if [ -n "$PORT" ]; then sed -i "s/\"port\": [0-9]*/\"port\": $PORT/" "$APP/config/libre.config.json"; fi
chown -R root:root "$APP"; chown -R libre:libre "$DATA"

cat > /etc/systemd/system/libre.service <<EOF
[Unit]
Description=Libre CMMS (Copyright CreativeMed LLC, AGPL-3.0)
After=network.target

[Service]
Type=simple
User=libre
WorkingDirectory=$APP
ExecStart=$NODE $APP/server/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA
PrivateTmp=true
# Allow binding to ports below 1024 (e.g. 443) without root:
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now libre
sleep 2
systemctl --no-pager status libre | head -5
P="$(grep -o '"port": [0-9]*' "$APP/config/libre.config.json" | grep -o '[0-9]*')"
echo
echo "Libre is running. Open http://$(hostname -f 2>/dev/null || hostname):$P"
echo "Config: $APP/config/libre.config.json   Data: $DATA   Logs: journalctl -u libre -f"
echo "If a firewall is active, allow the port, e.g.: sudo ufw allow $P/tcp"
