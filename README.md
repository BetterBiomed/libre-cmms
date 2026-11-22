# Libre CMMS

**Open-source Computerized Maintenance Management System for hospitals and medical equipment service.**

Copyright © 2026 **CreativeMed LLC**. Licensed under the [GNU AGPL v3.0 or later](LICENSE). See [NOTICE](NOTICE).

Libre manages the full lifecycle of medical equipment: inventory, work orders, preventive
maintenance, guided test procedures with automatic pass/fail, calibration traceability,
recalls, parts, vendors and contracts, compliance evidence and reporting. It runs on **one
server in your facility** and everyone uses it through a web browser, on site or remotely.

* **Zero dependencies:** Node.js 24 and nothing else. No database server, no npm packages. The database is one SQLite file.
* **Traceable:** every test record ties together the asset, the approved procedure version, the technician, the test equipment and its calibration status, every measurement against its limits, and electronic signatures, in one auditable record.
* **Simple to own:** daily automatic backups, automatic database upgrades, one folder to back up.

## Quick start

```bash
# Requires Node.js 24 LTS - https://nodejs.org
node server/server.js
```
Open http://localhost:8080, create the administrator, and optionally load the demonstration data.

On Windows you can double-click `start-libre.cmd`. To install as a service, see [docs/INSTALL.md](docs/INSTALL.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Hardware, OS, network, HTTPS, remote-access ("internet server") options, client devices, backup |
| [docs/INSTALL.md](docs/INSTALL.md) | Windows and Linux installation, configuration, upgrades, backup/restore, troubleshooting |
| [docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md) | VPN, tunnels, reverse proxy (Caddy/nginx), built-in HTTPS |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | Day-to-day use by role |
| [docs/FEATURES.md](docs/FEATURES.md) | Feature coverage and roadmap |
| [docs/API.md](docs/API.md) | REST API for integrations |

## Highlights

* Device Lookup: type a model number and Libre fills in manufacturer, device type, FDA class, product code, criticality and a suggested PM interval from the FDA device databases and its maintenance reference, plus recalls and links to ECRI, AAMI and OEM resources; add several of the same device quickly with "Add similar"
* Inventory Mode: department scanning with red/yellow flags (recalls, open repairs, previous Unable To Locate, end-of-life, PMs due), current-location updates, and Unable To Locate tracking and reports
* Asset management: models, locations, parent/child components, warranty, lifecycle, network/cybersecurity data, QR code and/or barcode labels, CSV import with duplicate detection
* Work orders: 11 types, labor and parts costing, failure/cause/action codes, warranty/contract coverage check, technician and supervisor e-signatures, SLA escalation, filter-and-bulk-assign to technicians or team queues
* Preventive maintenance: schedules, AEM programs, automatic WO generation, deferral approvals, compliance tracking, and a **PM Planner** to forecast and load-balance PM work month by month
* Guided procedures: measurement limits and tolerances, conditional troubleshooting steps, version control and approval, automatic corrective WO on failure
* Test equipment calibration checks, recalls with serial-number matching, incidents
* Parts inventory, purchase orders, vendors, contracts
* Public service-request portal with status tracking and satisfaction surveys
* Dashboard plus 15 reports (PM compliance, MTBF/MTTR, cost, replacement priority, cybersecurity, and more) exporting to CSV/Excel and PDF
* Roles: admin, supervisor, technician, requester, viewer. Full audit trail.

## Building a release

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
```
This produces `dist/libre-<version>.zip` (ready to install), `dist/libre-<version>-source.zip`, `dist/libre-demo-<version>.zip` (ready-to-run demo with fictional data), and SHA-256 checksums.

## Development

```bash
node --test        # end-to-end API tests
```
See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions require agreeing to the CreativeMed LLC contributor license terms.

---
*Libre supports regulatory documentation but does not by itself establish compliance with any standard. It is not a medical device.*
