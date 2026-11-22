# Libre CMMS - Demo System Guide

Copyright © 2026 CreativeMed LLC. Libre is open-source software (GNU AGPL v3.0 or later).

This folder is a **complete, self-contained demonstration copy of Libre CMMS** with a fully
populated database, for showing Libre's capabilities to others.

> **All data is fictional.** Organizations, people, manufacturers, models, recalls, incidents
> and events were generated for demonstration. Nothing refers to real patients, products or
> organizations. Device Lookup is the exception: it queries the real FDA databases live.

## Start the demo

1. Requires **Node.js 24** (https://nodejs.org).
2. Double-click **`start-demo.cmd`**. It opens **http://localhost:8090** in your browser.
   (Linux / macOS: `./start-demo.sh`.)
3. Sign in with one of the demo accounts below.

To show it from another computer or a tablet on the same network, browse to `http://<this-PC-name>:8090`
(allow port 8090 through the Windows firewall if prompted).

**Reset / refresh:** **`rebuild-demo.cmd`** deletes the demo database and builds a new one. Dates are
regenerated relative to today, so the dashboard and PM schedule always look current. Run it before
each presentation if the demo has been sitting for a while, or after people have clicked around.
Rebuilding always produces the same equipment and histories (fixed random seed); only the dates move.

## Demo accounts

All accounts use the password **`LibreDemo2026`**.

| Username | Name | Role | Use it to show |
|---|---|---|---|
| `demo` | Demo Administrator | Admin | Everything, including Settings, users, backups |
| `jreyes` | Jordan Reyes | Supervisor | Manager view: approvals, sign-offs, bulk assignment, audit trail |
| `pnguyen` | Priya Nguyen | Supervisor | Lakeside Community Hospital supervisor |
| `mtorres` | Morgan Torres | Technician | A technician's "My open work", guided PM tests, e-signatures |
| `achen`, `sokafor`, `rpatel` | | Technician | Critical care, imaging and lab/SPD specialists (Riverside) |
| `tbrooks`, `dkim` | | Technician | Lakeside technicians (an inventory is in progress at Lakeside ED) |
| `cwhite`, `lgarcia` | | Technician | Northgate Surgery Center technicians |
| `nurse.ed` | Avery Lopez RN | Requester | A clinician's limited view: submit and track service requests |
| `cfo` | Quinn Harper | Viewer | Read-only executive view of dashboards and reports |

The public service-request portal needs no login: **http://localhost:8090/portal**

## What's in the demo

| Area | Contents |
|---|---|
| **Facilities** | Riverside Regional Medical Center (13 departments), Lakeside Community Hospital (7), Northgate Surgery & Outpatient Center (6) |
| **Departments** | ED, ICU, OR, PACU, Med-Surg, Labor & Delivery, NICU, Cardiology & Cath Lab, Radiology & Imaging, Laboratory, Dialysis, Sterile Processing, Clinical Engineering, Pre-Op/PACU, Endoscopy, Infusion Center. Each has 50+ assets typical for that department. |
| **Equipment** | About 2,500 assets across 69 models: infusion/syringe/PCA pumps, monitors and central stations, telemetry, defibrillators and AEDs, ventilators, anesthesia machines, ESUs, OR lights and tables, imaging (DR, mobile X-ray, C-arm, CT, ultrasound), lab analyzers, incubators and warmers, fetal monitors, dialysis, beds, sterilizers, and SafeTest test equipment. Network and cybersecurity details are on connected devices. |
| **PM program** | About 2,500 PM schedules (manufacturer, AEM and risk-based) with 12 months of completed PMs, current open PMs, some overdue, and vendor-performed imaging, lab and sterilizer PMs |
| **Testing** | 6 approved procedures (infusion, defibrillator, monitor, ventilator, ESU, general electrical safety), 1 draft revision awaiting approval, and about 450 guided test records with measurements. A few failed a step and generated follow-up repairs automatically. |
| **Repairs** | About 700 corrective work orders over 12 months with failure/cause/action codes, labor, parts, downtime and vendor service. Current open repairs at every priority. |
| **People** | 13 users, 6 teams, technician certifications (some expiring soon) |
| **Other** | Vendors and service contracts, parts with stock levels and reorder alerts, purchase orders, 3 recalls (open, in progress, completed), incidents, service requests with satisfaction ratings, 7 department inventories (1 in progress), Unable To Locate items, manuals, knowledge articles and end-of-life notices |

## Suggested 15-minute demo

1. **Dashboard** (sign in as `jreyes`): PM completion trend, open and overdue work, MTTR, equipment out of service, recalls, Unable To Locate, contracts and certifications expiring. Every tile drills down.
2. **Work Orders**: filter by facility, department, device type or priority. Tick several work orders and use **Assign team** or **Assign technician**; the dialog shows each technician's workload.
3. **PM Planner** (Maintenance -> PM Planner): the 12-month workload chart shows one month running hot. Click it, select some PMs, choose **Move to month...**, and show the before/after preview evening out the workload.
4. **A PM with a guided test**: open an open Preventive work order (sign in as `mtorres` and use *My open work*), select **Start Test / Checklist**, pick the test equipment (calibration is checked), enter measurements and watch pass/fail evaluate live. Failing a step reveals the troubleshooting step and, when signed, creates a corrective work order automatically.
5. **Asset record**: open any infusion pump to show the history, PM schedule, test records, open recall, coverage banner, and owning department versus current location. Print a QR label.
6. **Device Lookup**: type `LIFEPAK 12` or `8015`. Libre pulls manufacturer, FDA class, device type and a suggested PM interval from the FDA databases (needs internet).
7. **Inventory Mode**: open the in-progress Lakeside ED inventory, scan a few tags (type them, for example `LCH-00040`), and show red/yellow flags and the recall alert. Complete it to show current-location updates and Unable To Locate.
8. **Recalls**: the MV-300 door latch recall shows affected assets, generated work orders and completion progress.
9. **Reports**: PM Compliance by Department, Reliability (MTBF/MTTR), Replacement Priority, Cost by Department, Unable To Locate Metrics, Cybersecurity inventory. Each exports to CSV/Excel and prints to PDF.
10. **Service portal**: open `/portal` on a phone, submit a request, then show it arriving under Help Desk and converting to a work order.
11. **Audit trail** and **e-signatures**: every change, signature and login is recorded.

## Notes

* The demo runs on port **8090**, so it can run alongside a real Libre server (8080).
* While the demo server runs, Libre's scheduler works as normal: it generates new PM work orders as they come due and sends notifications.
* Automatic backups are turned off for the demo.
* To build the demo from the Libre source code: `node scripts/build-demo.js DEMO`.
