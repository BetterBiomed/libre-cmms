# Remote access to Libre

Copyright © 2026 CreativeMed LLC — AGPL-3.0-or-later

Libre runs on a server inside your network. To use it from home, from another
facility, or from field-service vehicles, choose one of the options below, listed
from most to least secure. **Always use HTTPS for anything beyond the local network.**

## Option A — Hospital VPN (recommended)

No changes to Libre are needed. Users connect to the VPN and then browse to
`https://cmms.hospital.local` (or `http://server:8080`). Ask IT to allow the Libre port through the VPN.

## Option B — Zero-trust tunnel (Tailscale, Cloudflare Tunnel, etc.)

Install the tunnel agent on the Libre server. Nothing needs to be opened on the firewall.

* **Tailscale:** install it on the server and on users' devices. Users browse to `http://<server-tailnet-name>:8080`. Turn on Tailscale HTTPS certificates if you want camera scanning on phones.
* **Cloudflare Tunnel:** `cloudflared tunnel --url http://localhost:8080`, then protect the hostname with Cloudflare Access (SSO / one-time PIN). Set `"trustProxy": true`.

## Option C — Internet-facing reverse proxy with automatic HTTPS (Caddy)

Requirements: a DNS name (e.g. `cmms.example.org`) pointing to your public IP, and
ports 80/443 forwarded to the server.

1. Configure Libre to listen only locally. In `config/libre.config.json`:
   ```json
   { "host": "127.0.0.1", "port": 8080, "trustProxy": true }
   ```
2. Install Caddy (https://caddyserver.com) and create a `Caddyfile`:
   ```
   cmms.example.org {
       encode gzip
       reverse_proxy 127.0.0.1:8080
   }
   ```
3. Start Caddy. It obtains and renews a Let's Encrypt certificate automatically.

nginx equivalent:
```nginx
server {
    listen 443 ssl http2;
    server_name cmms.example.org;
    ssl_certificate     /etc/letsencrypt/live/cmms.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cmms.example.org/privkey.pem;
    client_max_body_size 60m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Hardening checklist for internet exposure:
* Keep Node.js, Caddy/nginx and the OS patched.
* Restrict by source IP or put a web application firewall (WAF) in front where possible.
* Disable the public service-request portal in **Settings** if it should only be used internally.
* Enforce strong passwords. Libre locks accounts after 5 failed sign-ins.
* Monitor the **Audit Trail** for `login-failed` events.

## Option D — Cloud-hosted server

Run Libre on a small cloud VM (2 vCPU / 4 GB RAM / 40 GB SSD is plenty for most hospitals)
and follow option C on that VM. Take provider-level disk snapshots in addition to Libre's own backups.

## Built-in HTTPS (no proxy)

If you have a certificate from your organization's CA:
```json
{
  "port": 443,
  "https": { "enabled": true, "certFile": "config/cert.pem", "keyFile": "config/key.pem", "redirectHttpPort": 80 }
}
```

## Settings → Public URL

Set **Settings → Public URL** to the address users actually use (for example `https://cmms.example.org`).
Printed asset labels include `<Public URL>/portal?asset=<tag>` so staff can request service for that device.
