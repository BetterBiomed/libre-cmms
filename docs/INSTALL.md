# Installing Libre CMMS

Copyright © 2026 CreativeMed LLC — AGPL-3.0-or-later

Check [REQUIREMENTS.md](REQUIREMENTS.md) first. Installation takes about 10 minutes.

## Windows (Windows 10/11, Windows Server 2016+)

1. **Install Node.js 24 LTS** from https://nodejs.org (Windows Installer `.msi`, default options).
2. **Unzip** `libre-<version>.zip` to a permanent folder, for example `C:\Libre`.
3. **Run the installer** in an *Administrator* PowerShell window:
   ```powershell
   cd C:\Libre
   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
   ```
   The script:
   * checks the Node.js version
   * creates `config\libre.config.json` (port 8080) if it does not exist
   * adds a Windows Firewall rule for the port
   * registers a **"Libre CMMS"** scheduled task that starts Libre when the computer boots (runs as SYSTEM and restarts on failure)
   * starts Libre

   Options: `-Port 8443`, `-NoService` (only create config and firewall rule), `-NoFirewall`.
4. Open **http://localhost:8080** on the server, or `http://<server-name>:8080` from another PC.
5. Complete **first-time setup**: create the administrator account. Optionally load the demonstration data to explore, then start a fresh database for production by deleting the `data` folder.

To run Libre manually instead (for evaluation), double-click `start-libre.cmd`.

**Uninstall:** `scripts\install-windows.ps1 -Uninstall` removes the scheduled task and firewall rule. Your `data` folder is not touched.

## Linux (Ubuntu / Debian / RHEL)

```bash
# 1. Node.js 24 (example for Ubuntu/Debian using NodeSource; or use your distro / nvm)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Unzip and install as a systemd service (installs to /opt/libre, runs as user 'libre')
unzip libre-<version>.zip -d /tmp/libre
cd /tmp/libre
sudo bash scripts/install-linux.sh
```

The script creates the `libre` system user, copies the files to `/opt/libre`, keeps data in
`/var/lib/libre`, and enables `libre.service`. Use `sudo systemctl status libre` and
`journalctl -u libre -f` to check the service.

## macOS / manual

```bash
cd libre
node server/server.js
```

## Configuration

Copy `config/libre.config.example.json` to `config/libre.config.json` and edit it. Restart Libre after any change.

| Setting | Default | Meaning |
|---|---|---|
| `host` | `0.0.0.0` | Listen address. Use `127.0.0.1` when behind a reverse proxy on the same machine. |
| `port` | `8080` | TCP port. |
| `dataDir` | `data` | Database, uploads and backups. Relative paths are resolved from the Libre folder. |
| `https.enabled` | `false` | Built-in HTTPS. Set `certFile` and `keyFile` to PEM files. |
| `https.redirectHttpPort` | `0` | Optionally listen on this port (e.g. 80) and redirect to HTTPS. |
| `trustProxy` | `false` | Set `true` behind a reverse proxy, to use `X-Forwarded-For` and Secure cookies. |
| `sessionHours` | `12` | How long users stay signed in. |
| `maxUploadMB` | `50` | Largest attachment allowed. |
| `backup.enabled` / `hour` / `keep` / `dir` | `true` / `2` / `14` / `data/backups` | Automatic daily backup. |

Environment variables `LIBRE_PORT`, `LIBRE_HOST`, `LIBRE_DATA_DIR` and `LIBRE_CONFIG` override the file.

## Upgrading

1. In Libre go to **Settings → Back up now** (or copy the `data` folder).
2. Stop Libre (Windows: `Stop-ScheduledTask "Libre CMMS"`; Linux: `sudo systemctl stop libre`).
3. Replace the program files (everything **except** `data/` and `config/libre.config.json`) with the new version.
4. Start Libre. Database changes are applied automatically on start.

## Backup and restore

* Automatic: daily into `data/backups/` (14 kept). Manual: **Settings → Back up now**, which also offers downloads.
* **Copy backups off the server** with your normal backup system.
* Restore: stop Libre, copy a backup over `data/libre.db` (and delete any `libre.db-wal` / `libre.db-shm` files next to it), then start Libre.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node is not recognized` | Install Node.js 24 and open a new terminal. |
| `EADDRINUSE` | Another program uses the port. Change `port` in the config. |
| Other PCs cannot connect | Check the firewall rule and that `host` is `0.0.0.0`. Use the server's IP address or DNS name. |
| Camera scanning does not work on phones | Phones require HTTPS for camera access. Enable HTTPS or use a barcode scanner. |
| Forgot the admin password | Another admin can use **Users → Set Password**. If no admin can sign in, stop Libre and run `node scripts/reset-password.js <username> <new-password>`. |
