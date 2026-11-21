# Libre CMMS — System Requirements

Copyright © 2026 CreativeMed LLC. Libre is licensed under the GNU AGPL v3.0 or later.

Libre is a **self-hosted** web application. One computer on your network (the
*Libre server*) runs the program and stores the database. Everyone else, including
technicians on phones and tablets, uses a normal web browser. Nothing is
installed on the user devices.

```
  Phones / tablets / PCs  ──(browser, HTTPS)──►  Libre server  ──►  data\libre.db
  (on site, or remote via VPN / reverse proxy)    (Node.js 24)       data\uploads\
                                                                      data\backups\
```

---

## 1. Server software

| Item | Requirement |
|---|---|
| Runtime | **Node.js 24 LTS** or later (minimum 22.13). Download from https://nodejs.org. No other software, database server, or npm packages are required. |
| Database | Built in (SQLite, included in Node.js). Stored in a single file: `data/libre.db`. |
| Operating system | Windows 10/11 or Windows Server 2016+; Ubuntu 22.04+/Debian 12+/RHEL 9+ or any Linux supported by Node.js 24; macOS 13+. |
| Internet access | **Not required** for normal operation. Libre runs entirely on your local network. Internet is only needed to download Node.js / Libre updates, for the optional **Device Lookup** (FDA database), and, if you choose, for remote access. |

## 2. Server hardware

Libre is lightweight. Database size is driven mainly by attachments (photos, PDFs, manuals).

| Deployment size | Assets | Concurrent users | CPU | RAM | Disk (SSD recommended) |
|---|---|---|---|---|---|
| Small department / evaluation | up to 5,000 | up to 10 | 2 cores | 4 GB | 20 GB free |
| Hospital | up to 25,000 | up to 50 | 4 cores | 8 GB | 100 GB free |
| Multi-facility system / ISO | up to 150,000 | up to 200 | 8 cores | 16 GB | 250 GB+ free |

Notes:
* The program itself uses about 100–200 MB of RAM. Most of the extra RAM is OS file cache, which speeds up the database.
* Allow roughly **2 GB per 10,000 work orders with photos**. Backups need about the same space again for each copy kept (default: 14 daily copies).
* A virtual machine works well. Give it a fixed IP address or DNS name.
* Use an SSD or other reliable disk. Do not put the `data` folder on a network share (SMB/NFS), because SQLite needs local-disk locking.
* A UPS (battery backup) is strongly recommended. The database uses write-ahead logging and survives power loss, but a UPS avoids downtime.

## 3. Network

| Item | Requirement |
|---|---|
| Port | One TCP port for the web app: default **8080** (HTTP), or **443** when HTTPS is enabled. |
| Firewall | Allow inbound traffic on that port from the networks your users are on. The installer can add a Windows Firewall rule. |
| Address | Static IP or DNS name (for example `cmms.hospital.local`). |
| Bandwidth | Minimal: about 50–300 KB per page view, plus attachment sizes. Works over Wi-Fi and cellular. |
| Outbound | None required. For the optional Device Lookup, allow HTTPS (TCP 443) from the server to `api.fda.gov`. Only the model / manufacturer text typed into the lookup is sent; results are cached for 30 days. Turn it off under Settings (`device_lookup_online`). |

## 4. HTTPS (strongly recommended)

Use HTTPS whenever Libre is reachable from anything other than a trusted, isolated network.
**Remote access requires it.** Phone cameras (barcode scanning) also only work over HTTPS
or on `localhost`. There are two ways to provide it:

1. **Built-in HTTPS.** Put a certificate and key (PEM) on the server and set `https.enabled` in `config/libre.config.json`. Use a certificate from your hospital's internal CA, or a public certificate for a public DNS name.
2. **Reverse proxy** (recommended for internet-facing deployments): Caddy, nginx, IIS (ARR) or a cloud load balancer terminates TLS and forwards to Libre on `127.0.0.1:8080`. Caddy obtains and renews free Let's Encrypt certificates automatically. See `docs/REMOTE-ACCESS.md`.

## 5. Remote access ("internet server") options

Libre is designed to stay on your private network. Choose **one** way to reach it from outside:

| Option | What you need | Security | Effort |
|---|---|---|---|
| **A. Hospital VPN** (recommended) | Existing VPN (GlobalProtect, AnyConnect, WireGuard, etc.) | Best: nothing is exposed to the internet | Low |
| **B. Zero-trust tunnel** | Tailscale, Cloudflare Tunnel or similar on the server | Very good: no inbound ports, identity-based access | Low |
| **C. Reverse proxy on the internet** | Public DNS name, public IP or port forward of 443, Caddy/nginx with a TLS certificate | Good if kept patched. Add a WAF or IP allow-list where possible. | Medium |
| **D. Cloud-hosted server** | A small VM (2 vCPU / 4 GB, for example) at any cloud provider plus a DNS name, using option C on that VM | Good. Note that data then resides with the cloud provider. | Medium |

For options C and D, set `"trustProxy": true` in the config so Libre records the real client IP addresses and marks cookies Secure.

## 6. Client devices

| Device | Requirement |
|---|---|
| Desktop / laptop | Current Chrome, Edge, Firefox or Safari (released in the last 2 years). |
| Phones / tablets | iOS 16+ Safari, or Android 10+ Chrome. Libre can be added to the home screen as an app. |
| Barcode scanning | Any USB or Bluetooth "keyboard wedge" barcode scanner works everywhere. Phone camera scanning works in Chrome on Android over HTTPS. |
| Label printing | Any printer the browser can print to. Labels can carry a QR code, a Code 128 barcode, or both (selectable). Sizes: 2"×1", 2.25"×1.25" and 3"×2" thermal labels (Zebra, Brother, DYMO, etc., one label per page), or Avery 5160-style sheets on a laser printer. QR codes containing the service-request link can be scanned by any phone camera; set **Settings → Public URL** so phones can reach the server. |

## 7. Backup and recovery

* Libre makes an automatic backup every day at 02:00 (configurable) into `data/backups/` and keeps 14 copies.
* **You must copy `data/backups/` (or the whole `data/` folder) off the server regularly**, for example with your existing backup software or Windows Backup, or by syncing to a NAS or offsite storage.
* To restore, stop Libre, replace `data/libre.db` with a backup copy (rename it to `libre.db`), and start Libre.

## 8. Security and compliance considerations

* Passwords are stored with scrypt hashing. Accounts lock for 15 minutes after 5 failed sign-ins.
* All changes, logins, electronic signatures, exports and attachments are written to an append-only audit trail.
* Electronic signatures require the user to re-enter their password and record the meaning of the signature.
* Libre does **not** need, and should not be used to store, patient health information (PHI). If your workflow puts PHI into work orders or attachments, treat the server under your HIPAA security program: encrypted disk (BitLocker/LUKS), HTTPS only, restricted access and backups.
* Libre helps document compliance with The Joint Commission, CMS, DNV, NFPA 99 and similar requirements. It does not, by itself, establish compliance.
* Keep Node.js updated (LTS security releases) and apply OS patches.

## 9. Not required

* No Microsoft SQL Server, MySQL, PostgreSQL or other database server
* No IIS or Apache (only if you choose to use one as a reverse proxy)
* No internet connection (except for the optional Device Lookup)
* No per-user licenses
