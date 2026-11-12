#!/usr/bin/env sh
# Libre CMMS - Copyright (C) 2026 CreativeMed LLC - AGPL-3.0-or-later
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js 24 or later is required: https://nodejs.org"; exit 1; }
exec node server/server.js
