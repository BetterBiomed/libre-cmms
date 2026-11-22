# Libre user guide

Copyright © 2026 CreativeMed LLC — AGPL-3.0-or-later

## Roles

| Role | Can do |
|---|---|
| **Administrator** | Everything, plus users, passwords, settings, code lists and backups |
| **Supervisor** | Everything except administration: approve procedures and PM deferrals, sign off and close work orders, delete records, import CSV |
| **Technician** | Create and edit assets, work orders, PM schedules, parts, documents. Perform tests and sign their own work. |
| **Viewer** | Read-only access to everything except administration |
| **Requester** | Submit and follow their own service requests (anyone can also use the public portal without an account) |

## First steps for a new site (administrator)

1. **Organization:** add Facilities and Departments (with cost centers).
2. **Users:** add users and set each initial password (Users → open user → Set Password). Users must change it at first sign-in.
3. **Equipment models:** add manufacturer, model and device type (or use **Device Lookup**), the PM interval and expected life. Or import assets by CSV, using `Manufacturer|Model` in the Model column to create models automatically.
4. **Assets:** add or import inventory. Print labels (Assets → Print labels): choose **QR code, barcode, or both**, what the QR code contains, and the label size. Set the defaults under Settings → Asset labels.
5. **Test equipment:** create assets for your analyzers and simulators, tick *This is test equipment*, and enter the calibration due date.
6. **Procedures:** create a procedure, add steps (Pass/Fail, Measurement with limits, Instruction, Text Entry), then have a supervisor **Approve** it.
7. **PM schedules:** on a model use **Bulk PM Schedules**, or add schedules per asset. Libre creates PM work orders automatically before they are due (checked hourly).
8. **Settings:** set the Public URL and portal options, and review failure/cause/action codes.

## Technician workflow

1. Open **Dashboard → My open work**, or scan an asset (Scan / Find Asset).
2. Open the work order and select **Start Work**.
3. On the **Testing** tab, choose **Start Test / Checklist**. Pick the approved procedure and the test equipment you are using. Libre blocks test equipment with overdue calibration.
4. Enter results. Measurements are evaluated against the limits immediately. If a step fails, any conditional troubleshooting steps appear.
5. **Complete & Sign** the test record. If anything failed, Libre creates a follow-up corrective work order and marks the asset Out of Service.
6. Add **Labor** and **Parts Used** (parts are deducted from stock automatically) and attach photos.
7. **Complete & Sign** the work order: describe the work and confirm return to service.
8. A supervisor reviews it and selects **Supervisor Sign-off**, which closes and locks the work order.

## PM Planner (load balancing)

**Maintenance -> PM Planner** (or the **PM Planner** button on PM Schedules) forecasts your preventive maintenance workload month by month, so you can spread it evenly.

* **Chart:** one bar per month, side by side, for the next 12, 18 or 24 months. It counts every due date of every active PM schedule, not just the next one. Switch between **PM work orders** and **Labor hours** (estimated from each model's actual PM labor history). The dashed line is the even-distribution average. Bars more than 15% above it are red, within 15% green, and more than 15% below it blue. The current month includes PMs already completed this month. Overdue PMs are shown separately.
* **Balance score:** the variation between months (0% = perfectly even). Under 15% is *Even*, under 30% *Somewhat uneven*, otherwise *Uneven*.
* **Filters:** facility, owning department, device type, team, technician and program. For example, balance one team's or one department's workload.
* **Click a month** to list the PMs due in it. Other tabs list all PM schedules, overdue PMs, and **assets without a PM schedule**.
* **Mass select** PMs (or *Select all N matching*) and choose **Move to month...**:
  * pick the target month (the lightest month is suggested; each option shows its current count),
  * choose how to place them: spread evenly across the month's working days, keep each PM's day of the month, or one specific date,
  * a **before / after** chart and balance score preview the result before you confirm.
* Moving a PM shifts its schedule's whole cycle, so later PMs follow. For 3- or 6-month schedules, Libre shifts the cycle's phase so a PM lands in the chosen month without putting the next PM in the past. An open PM work order already generated for the old date moves with it.
* **Deferrals:** moving a PM later than its due date plus grace period requires a **supervisor** and a **reason**. Both are recorded on the schedule and in the audit trail. Moving PMs earlier is always allowed.
* **Assets without a PM schedule:** select them and choose **Schedule into a month...** to create PM schedules first due in that month, using each model's PM interval (or one you enter) and its approved procedure.

## Device Lookup

Use Device Lookup to fill in equipment details from a model number instead of typing them.

* Open it from **Device Lookup** in the left menu, the **Device Lookup** button on the Assets and Equipment Models lists, **Look up device** on the Add/Edit Asset and Equipment Model forms, or **Look Up / Refresh** on a model's page.
* Type the **model or model number** (the REF / catalog number on the device label works best) and optionally the **manufacturer**.
* Libre searches:
  1. your own equipment catalog
  2. the **FDA GUDID** (Unique Device Identification) database, for manufacturer, brand / common name, model, GMDN term and UDI-DI
  3. **FDA 510(k) clearances**, which cover older and discontinued models that predate UDI labeling (for example the LIFEPAK 12). These are marked *Older model - 510(k)*.
  4. **FDA Product Classification**, for FDA device class, product code, regulation, medical specialty and the life-sustaining flag
  5. its built-in **maintenance reference**, which suggests device type, **PM interval**, expected service life and criticality
* The manufacturer is matched loosely: punctuation and spacing don't matter ("physiocontrol" finds Physio-Control), and common parent companies are understood (Stryker / Physio-Control, BD / CareFusion, Medtronic / Covidien, Philips / Respironics, Baxter / Hill-Rom / Welch Allyn, GE / Datex-Ohmeda, and others). Model spacing doesn't matter either ("Lifepak12" = "LIFEPAK 12").
* **Select** a match to review every field, with the source shown under each. Then **Save to equipment models**, **Save & add asset**, or (from a form) **Use for this asset**. Saving never overwrites values you already entered on an existing model unless you tick *Overwrite*.
* **Check FDA recalls** lists FDA recalls that mention the model. **Import** creates the recall in Libre (classification, affected lots/serials, reason); then use *Find Affected Assets* on it.
* **More references** links to ECRI (UMDNS / Device Evaluations, membership required), AAMI maintenance standards (EQ56 / EQ89), FDA databases, and a web search for the OEM service manual and PM interval.
* Suggested PM intervals and service lives are typical starting points, not manufacturer requirements. Confirm them against the OEM service manual and your AEM / risk-based program. Results marked **Verify type** or **Accessory / consumable?** need a closer look. FDA data is provided "as is" by openFDA.

## Adding several of the same device

After you save a new asset, Libre asks whether to:

* **Create a PM schedule** using the model's PM interval (choose the first due date and the approved procedure for the model), and
* **Add another similar** asset. The next form copies the model (manufacturer and device class), description, criticality, lifecycle and purchase details. You enter the **asset tag** and **serial number** and choose the **owning account** (facility and department) for each unit; those fields are highlighted.

You can also select **+ Add Similar** on any asset's page.

## Inventory Mode

Use Inventory Mode to walk a department and confirm where every asset is.

1. **Inventory Mode** (left menu, or the Dashboard button): pick the **facility** and **department**, then **Start inventory**. If an inventory of that department is already in progress, Libre resumes it, so several people can continue it.
2. Optionally type the **current room**, then scan each asset tag with a USB/Bluetooth scanner, the phone camera, or by typing it and pressing Enter. QR codes printed by Libre work too. Each scan shows a coloured result and plays a tone:
   * **Red**: previously Unable To Locate, **open recall** (an alert pops up that must be acknowledged), open repair work order, marked out of service, retired/disposed asset found in use, or **not in the inventory**.
   * **Yellow**: end-of-life / end-of-support letter on file (document type *End of Life / End of Support Letter*, or an end-of-support date), or PM due this month or overdue.
   * **Info**: the asset is owned by a different department.
3. **Not in inventory:** Libre offers to add the asset immediately, with the facility, department and room already filled in.
4. The **Not yet scanned** list shows what is still expected, with red and yellow items at the top so you know what to look for.
5. **Complete inventory:** Libre updates every scanned asset's **Current Location** (facility, department, room, last seen). The **Owning Department** (account) is never changed. Unscanned assets are listed, and checked items are marked **Unable To Locate**.
6. The summary page links to the **Red & Yellow flag report** for that inventory and the department's **Unable To Locate report**. Print either to present to the department.

## Unable To Locate (UTL)

* On a **PM (or any) work order**, select **Unable To Locate** and describe where you searched. The work order goes **On Hold** and the asset is flagged UTL.
* An asset can also be marked UTL from its own page, or automatically by an inventory.
* When the asset turns up (scanned in any inventory, **Asset Located** on the work order, **Mark Located** on the asset, or any work completed on it), Libre resolves the UTL, releases on-hold work orders and notifies the technician.
* Reports: **Unable To Locate (UTL) Assets** (by department, source, open/resolved, days missing), **Unable To Locate Metrics by Department** (UTL rate, located, average days to locate, last inventory), **Inventory Red & Yellow Flags**. **PM Compliance** also shows a UTL column.

## Assigning work in bulk and to teams

1. **People → Teams:** create teams (for example *Imaging*, *Infusion & Monitoring*, *Night Shift*) and add members on the **Members** tab. A person can belong to several teams.
2. **Work Orders:** use the filter panel (status, type, priority, technician, team, facility, department, device type, model, due dates, search). Filters are remembered while you work.
3. Tick work orders, or tick the header box and then **Select all N matching this filter** to include every result, not just the visible page.
4. From the action bar:
   * **Assign technician**: pick from a list showing each person's open, overdue and urgent work.
   * **Assign team**: the work goes to that team's queue. Optionally remove the individual technician so any member can claim it.
   * **Priority**, **Due date**, **Status** (Open, Assigned, In Progress, Awaiting Parts, On Hold), or **Cancel** (supervisors, reason required).
5. Libre reports any work orders it skipped (for example, already closed). Every change is recorded in the audit trail, and each technician or team member gets one summary notification.

Team queue work also appears on each member's **Dashboard → My open work** and in the **My teams' queue** filter. PM schedules can have a default team so generated PMs land in the right queue.

## Service requests

Clinical staff go to `http://<server>/portal`, or scan the URL printed on the asset label. They
describe the problem and receive a request number and status link. Staff see new requests under
**Help Desk → Service Requests** and select **Convert to Work Order**. When the work order is
completed, the request closes automatically and the requester can rate the service.

## Recalls

Create the recall under **Compliance → Recalls & Alerts** with the manufacturer, model (or model
names) and affected serial numbers (lists, `START..END` ranges, or wildcards like `SN12*`). Select
**Find Affected Assets**, then **Generate Work Orders**. Completing each work order marks that asset's
recall action complete.

## Reports

**Reports & KPIs** lists all reports. Set filters, select **Run**, then **Export CSV / Excel** or **Print / PDF**.
Every list screen also has **Export CSV**.

## Electronic signatures

Signing requires your password. The signature records your name, username, date/time and meaning
("Completed work and verified results", "Reviewed and approved") and is written to the audit trail.
Closed work orders and completed test records cannot be edited. A supervisor can reopen a work
order with a documented reason.
