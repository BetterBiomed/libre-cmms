# Libre REST API

Copyright © 2026 CreativeMed LLC — AGPL-3.0-or-later

All endpoints are JSON over HTTP(S) under `/api`. Authentication uses the session cookie set by
`POST /api/auth/login`. **Every non-GET request must include the header `X-Libre: 1`** (CSRF protection).
Permissions follow the signed-in user's role.

## Authentication
| Method | Path | Body |
|---|---|---|
| POST | `/api/auth/login` | `{ "username", "password" }` |
| POST | `/api/auth/logout` | |
| GET | `/api/auth/me` | |
| POST | `/api/auth/password` | `{ "current", "password" }` |

## Generic records
Entities: `facilities, departments, customers, models, assets, asset_moves, work_orders, wo_labor, wo_parts, pm_schedules, procedures, procedure_steps, test_runs, parts, part_transactions, purchase_orders, po_lines, vendors, contracts, service_requests, recalls, recall_assets, incidents, documents, users, teams, team_members, certifications, inventories, inventory_scans, utl_events`.
Field definitions: `GET /api/meta` or `server/schema.js`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/e/{entity}` | Query: `q` (search), `view` (named filter), `f_{field}=value` (exact match, `null` for empty), `fin_{field}=a,b` (any of), `from_{field}` / `to_{field}` (range), and for asset-linked records `asset_facility`, `asset_department`, `asset_model`, `asset_category` (device type), `sort`, `dir`, `limit` (≤1000), `offset`, `format=csv` |
| GET | `/api/e/{entity}/{id}` | Returns `{ row, coverage? }`. Reference fields have display text in `row._labels`. |
| POST | `/api/e/{entity}` | Create |
| PUT | `/api/e/{entity}/{id}` | Partial update |
| DELETE | `/api/e/{entity}/{id}` | Refused if other records reference it |
| POST | `/api/import/{entity}` | Body: CSV text (supervisor) |

## Workflows
| Method | Path | Body |
|---|---|---|
| POST | `/api/wo/{id}/start` · `complete` · `supervisor_sign` · `reopen` · `cancel` · `followup` | `complete`: `{ work_performed, return_to_service, password }`. `supervisor_sign`: `{ password }`. `reopen`/`cancel`: `{ reason }`. `followup`: `{ problem, priority }`. |
| POST | `/api/wo/bulk` | `{ ids: [..] }` or `{ filter: {list query} }`, plus `changes: { assigned_to, team_id, priority, due_date, status }`, `clear_technician`, or `cancel_reason`. Returns `{ updated, skipped: [{ wo_number, reason }] }`. |
| GET | `/api/workload` | Open/overdue/urgent counts per technician and team queue sizes |
| POST | `/api/pm/generate` | Create due PM work orders now |
| POST | `/api/pm/bulk` | `{ model_id, procedure_id?, interval_months?, next_due?, program? }` |
| POST | `/api/pm/{id}/defer` | `{ until, reason }` (supervisor) |
| POST | `/api/procedures/{id}/approve` · `revise` · `retire` | |
| POST | `/api/runs` | `{ work_order_id, procedure_id, test_equipment_ids: [], override_cal? }` → `{ run, results }` |
| GET | `/api/runs/{id}` | |
| PUT | `/api/runs/{id}/results` | `{ results: [ { id or seq, value, as_found?, note? } ] }`. **Instrument integration point:** send measurements by step `seq`. |
| POST | `/api/runs/{id}/complete` | `{ password }` |
| POST | `/api/recalls/{id}/match` · `workorders` | |
| POST | `/api/requests/{id}/convert` | `{ asset_id?, assigned_to? }` |
| POST | `/api/parts/{id}/stock` | `{ type: Receive/Adjust/Return/Count, quantity, unit_cost?, note? }` |
| POST | `/api/po/{id}/receive` | |

## Inventory Mode & Unable To Locate
| Method | Path | Body |
|---|---|---|
| POST | `/api/inventories` | `{ facility_id, department_id }` → `{ id, resumed }` |
| GET | `/api/inventories/{id}/session` | expected assets with flags, and scans |
| POST | `/api/inventories/{id}/scan` | `{ code, room? }` → `{ scan (flag_level, flags), asset, notFound, duplicate }` |
| POST | `/api/inventories/{id}/scans/{scanId}/link` | `{ asset_id }` after adding an unknown asset |
| DELETE | `/api/inventories/{id}/scans/{scanId}` | remove a mistaken scan |
| POST | `/api/inventories/{id}/complete` | `{ utl_asset_ids: [] }` |
| POST | `/api/inventories/{id}/cancel` | |
| GET | `/api/assets/{id}/flags` | current red/yellow flags |
| POST | `/api/assets/{id}/utl` · `located` | `{ notes }` |
| POST | `/api/wo/{id}/utl` · `located` | `{ notes }` |

## Other
`GET /api/dashboard`, `GET /api/reports/{name}?format=csv`, `GET /api/search?q=`, `GET /api/lookup/asset?code=`,
`GET/POST /api/files?entity=&id=&name=` (POST body = raw file bytes), `GET/DELETE /api/files/{id}`,
`GET /api/audit`, `GET /api/notifications`, admin-only: `GET/PUT /api/settings`, `PUT /api/lookups/{list}`, `GET/POST /api/backups`.

## Public (no login)
`GET /api/public/info`, `GET /api/public/asset/{tag}`, `POST /api/public/requests`,
`GET /api/public/requests/{number}?token=`, `POST /api/public/requests/{number}/feedback?token=`.
