# Farmstead

A working first release of the farm management platform described in [the requirements](docs/PRODUCT_REQUIREMENTS.md). See [phase status and limitations](docs/PHASE_STATUS.md) before treating any module as complete or ready for production.

## Develop locally

Requirements: Node 24, npm 11, Python 3.12+, Docker with PostgreSQL 17 support, Linux system Chromium for browser tests.

```sh
npm ci --cache /workspace/.npm-cache
python -m venv /workspace/.farmstead-venv
/workspace/.farmstead-venv/bin/pip install --cache-dir /workspace/.pip-cache -r requirements.lock.txt
npm run db:setup
export FARM_PYTHON=/workspace/.farmstead-venv/bin/python
npm run dev
```

Use the existing checkout in the isolated task; do not create a worktree unless explicitly requested. The app listens on port 3000. `db:setup` is repeatable: it preserves the database, generates local random credentials once, applies pending migrations and configures a restricted application login. It never seeds fictional farms. Register in the application, create an organization, then add a farm. In Feed studio → Workbook import, preview the three supplied files and explicitly confirm importing unverified references. In Source catalog, preview normalized requirements, stage limits and recipe mappings with their original cells and review notes. Confirmed imports stage these unverified candidates; older imports can be staged without duplication. In Ingredients, use Revise reference for new quotes or scientific corrections and show history to inspect previous versions. Revisions preserve saved recipe prices and never inherit approval. Review or create ingredients, formulate and save draft recipes. In Production, stock a flock/batch/pond and add dated daily records. In Projections, calculate and save scenarios separately from actuals.

Local database data lives in ignored `.local/pgdata`; credentials are in ignored `.local/` and `.env.local`. Do not delete those files to “reset” setup. Preserve them together. Only local development credentials are generated, never production credentials. A stopped Docker daemon/container must restart for the app to use PostgreSQL. No external account, paid subscription or API key is required for the verified local workflow.

## Validate

```sh
export FARM_PYTHON=/workspace/.farmstead-venv/bin/python
npm test
/workspace/.farmstead-venv/bin/python -m pytest tests/python -q
npm run lint
npm run typecheck
npm run build
E2E_START_COMMAND='npm run start' npm run test:e2e
```

Playwright uses `/usr/bin/chromium`; set `CHROMIUM_PATH` to a system installation elsewhere. The test runner starts the app if port 3000 is unused; stop only a server you started if you need to test a different mode. Browser and integration tests create isolated fixture organizations and clean them up. Integration tests refuse an unrelated database unless an explicit test-only admin connection is supplied. Never point these tests at production. Tests use a local administrator fixture helper; application code does not import it.

## Data and calculation evidence

The seven requested documents are in `docs/`. [Workbook analysis](docs/WORKBOOK_ANALYSIS.md) explains defects and migration mappings; [the full cell inventory](docs/WORKBOOK_CELL_INVENTORY.md) preserves every nonempty cell, formula, cached result and workbook hash. Source originals remain in `data/source/`. Reproduce with:

```sh
/workspace/.farmstead-venv/bin/python scripts/inspect_workbooks.py
```

Imported scientific values stay unverified. Zero/blank prices and missing nutrients are distinct. Only assigned nutritionists can register reviewed profiles or approve scientifically complete formulas. Ingredients carry species/stage eligibility, nutrient bases, inclusion limits and quotation dates. The solver uses SciPy HiGHS; it does not fabricate infeasible solutions or relax constraints. Catfish formulation is blocked until dedicated digestible nutrient definitions and constraints exist. Numerical optimization is not permission to manufacture feed.

## Architecture and deployment

For the prepared two-project Vercel/Neon preview workflow, see [Vercel preview setup](docs/VERCEL_PREVIEW.md). It includes the authenticated Python worker required by solver/uploads/Excel features and the restricted Neon runtime role. Provider deployment must be verified separately from the local checks.

Next.js App Router + strict TypeScript, Zod, PostgreSQL RLS, Decimal.js, Recharts and a bounded Python/HiGHS worker. Local identities use scrypt and hashed opaque sessions. The application login `farm_server` is not a superuser and cannot directly query tenant tables; each operational transaction switches to a non-bypass RLS role and sets a transaction-local user context. Migrations run with a separate administrative connection. [Database architecture](docs/DATABASE_ARCHITECTURE.md) records the design and Supabase migration boundary.

This build needs a Node server, Python/SciPy and PostgreSQL. It is not a static export. For deployment, run reviewed migrations with `MIGRATION_DATABASE_URL`, provision a restricted `farm_server` login securely, set `DATABASE_URL`, set `APP_ORIGIN` to the canonical HTTPS application origin and set `FARM_PYTHON` to the installed worker interpreter. `npm run build` followed by `npm run start` runs the app. Do not deploy local administrator credentials. Managed Supabase Auth/Storage integration, password reset/email verification, distributed rate limiting, account recovery, monitoring, backups/restore drills, upload hardening and independent security review remain production gates. No hosted deployment or cloud publication is performed by the setup scripts.


## Formulation autosave

Feed studio keeps a private working draft for your account in each organization. Wait for **Draft saved** before closing the tab. Navigation within the app flushes pending edits; tab-local recovery can restore a failed save after returning or reloading. Incomplete drafts still need validation before creating an approved recipe version. Other users' private drafts are not shared with organization administrators.

If another tab saves first, autosave pauses and keeps your local edits. Use **Download local draft** to preserve a JSON copy, then **Load saved draft** to explicitly replace this tab's edits. Failed saves offer retry; an unavailable initial draft disables editing until it can be loaded. Tab recovery is not a full offline mode and disappears when the tab is closed. Browser account changes require reloading before further saves.


## Upload ingredient spreadsheets

In Feed studio → Workbook import, upload an .xlsx file (2 MiB maximum), select the ingredient sheet, map the name/price/nutrient columns and choose explicit units. Preview the rows, use the error filter and resolve every row error, then confirm importing the unverified references. Header/column suggestions are editable; missing data stays unknown. Percentage-formatted Excel cells require fraction units. Concentration units apply to all mapped concentration columns; standardize mixed-unit data first. Prices are currently NGN.

Original files and mapping/report snapshots are retained by organization. Use the upload history to download the original or a CSV audit report. Identical bytes reuse the same upload; retrying confirmation does not duplicate ingredients. Names are not merged into existing ingredients. This importer handles ingredient tables; use the supplied workbook workflow for the existing source catalog and projection baselines. Uploaded formulas are retained but never evaluated or accepted as numeric values.

The parser requires the locked Python dependencies, including defusedxml, and Linux process resource limits. After updating dependencies, run `/workspace/.farmstead-venv/bin/pip install --cache-dir /workspace/.pip-cache -r requirements.lock.txt` and `npm run db:setup`. Keep `FARM_PYTHON` set as above. Server tracing includes the inspection worker. See PHASE_STATUS.md for all size/resource limits and the remaining scientific review and deployment gates.


## Review stage-specific specifications

In Feed studio → Specifications, assigned nutritionists register nutrient requirements and optional ingredient rules with source evidence. Positive minima require an ingredient, equal minima/maxima fix its inclusion and a maximum of zero excludes it. Once rules are present, list every permitted ingredient reference; unlisted references are refused. Rules use exact ingredient versions, so a revised quotation needs explicit review in a new profile revision. Ingredient limits, scenario bounds and availability can only tighten profile limits.

Use **Revise specification** to append a reviewed version. History and JSON downloads preserve source evidence; existing recipe approvals and solver inputs retain the old version. Historical references required by a selected profile remain selectable in the formulator. Manual rule violations prevent approval, and optimizer conflicts never relax reviewed bounds. Profiles without rules retain the existing reviewed-ingredient selection checks. These limits do not replace qualified scientific review or stock reservations.


## Compare saved recipes and download mixing sheets

Feed studio → Recipe library lists the latest 100 saved versions. Select two to four, choose a baseline and a common comparison batch, then **Compare saved versions**. Common-batch costs multiply the saved four-decimal NGN/kg result, so rounding may differ from the original saved batch total; nutrient deltas appear only for matching recorded species/stage/bases. Each compliance result belongs to its own saved specification. Unknown values stay unknown, and incomplete totals are not normalized. A resized comparison batch does not inherit stock availability or approval. Download **Comparison CSV** to retain the comparison.

The CSV/XLSX buttons on each saved recipe download its original batch, exact reference IDs, status, saved nutrients/costs, source evidence, bounds and specification. Excel has four worksheets and stores monetary values as decimal text to preserve precision. Unknowns are blank, zeros are retained and formula-like names remain text. A snapshot-data SHA-256 identifies the report evidence. Later quotations or profile revisions do not update these exports. New versions record the saving actor; older versions may lack that metadata. Reports are available only to current organization members, including auditors.

Draft/pending/rejected reports are marked NOT APPROVED. Approved reports describe a historical review, not a stock reservation or manufacturing release. Use the pinned Python environment for Excel exports; CSV requires only the Node application. Integrated manufacturing remains future work.


## Inspect optimizer diagnostics and past runs

After **Find least-cost formula**, review **Optimization evidence** for effective bounds, source limits, individual attainable nutrient ranges and any conflict explanations. Ranges use the unchanged ingredient bounds and 100% total; they do not prove that all nutrient targets are feasible together. Optimal runs also show binding constraints and independent primal/objective checks. No constraint is relaxed automatically.

In Feed studio → Optimizer history, search/filter the latest 100 runs, inspect original requests/reference snapshots and download run JSON. Costs and quotations remain historical. Legacy records explicitly identify absent evidence. Current organization members can read history; auditors cannot execute new runs.

Use **Load scenario as draft** to deliberately replace your working formulation with a historical scenario. Download your current local draft first if you need both. Original scenario bounds/availability are preserved; valid saved optimal percentages may be restored, but status resets to Draft and fresh calculation/review is required. Viewing or restoring a run does not save an approved recipe or reserve stock.


## Source alias review

In Feed studio → Source catalog, select **Ingredient inclusion limits** or **Broiler recipe mappings** and open a source row. Assigned nutritionists use **Review mapping** to select an exact ingredient reference, reject a mapping, or leave it unresolved, with evidence and explicit confirmation. Other members can view history and download the latest 100 decisions as JSON. A stale tab must reload the latest review before saving.

Decisions apply to that row/context only. They preserve original warnings and do not approve nutrition, apply source inclusion limits or change saved recipes. A new ingredient/quotation revision requires explicit new review. Expanded nutrients and qualified catalog reconciliation remain outstanding.


## Expanded nutrient measurements

Ingredients and Specifications now support **crude fat, crude fibre, moisture and ash**, alongside the original seven measurements. Leave unavailable values blank. Moisture is measured as-fed only and is never calculated from dry matter. The additional measurements are assessed only when the selected reviewed specification sets limits; unknown assessed values block approval and optimization.

Custom workbook mapping supports explicit columns and the existing percent/g/kg/fraction units. No new data is inferred for the supplied workbooks. Saved recipe reports retain their recorded values; earlier seven-field reports keep their original rows and digest. Additional amino acids, fibre methods and catfish digestibility remain future work.


## Reference provenance and source recipe drafts

Use **Ingredients → Revise reference** to record category, supplier/manufacturer, laboratory analysis date, certificate/document reference and quality/processing notes. Blank evidence stays unknown; saving appends a version and preserves older recipe evidence. Notes do not automatically create optimizer constraints.

In **Source catalog → Broiler recipe mappings**, review mappings for each populated source row, then use **Preview recipe import**. Each original recipe has four supplied percentages and 30 unspecified inclusions. Check the preview and explicitly acknowledge omitting those blanks before **Import reviewed source as draft**. The import preserves the exact percentages, warnings and mapping/reference evidence; repeated confirmation creates no duplicate. Changed reviews require a new preview.

Open **Recipe library** to inspect or clone the resulting draft. CSV/Excel include provenance, and imported versions have a fifth Source recipe audit worksheet with all original rows. Importing does not approve nutrition or manufacture feed; select and validate a reviewed specification before saving a new reviewed version.


### Reviewed processing constraints

Record a **Processing method** and supporting evidence together in Ingredients; leave both blank when unknown. Specifications can add up to twenty groups of exact allowed ingredient revisions, with explicit combined min/max percentages, optional required methods and source evidence. Only nutritionists may review these specifications. Unknown or mismatched methods block applicable groups; notes are never parsed into qualifications. Manual calculations, approval and genuine optimization enforce the combined bounds. Saved runs and CSV/XLSX retain their original groups/method evidence after revisions. These records do not certify an actual treatment or create a manufacturing event.


## Compare optimizer scenarios

In **Feed studio → Optimizer history**, select two to four saved runs, choose **Baseline optimizer run** and a common planning batch, then **Compare selected runs**. Compare historical costs, original candidate bounds/availability, exact-reference solutions, each run's reviewed limits and diagnostic evidence. Infeasible runs show no solution or cost; missing historical evidence stays unavailable. Nutrient deltas require matching recorded scientific contexts and definitions. A smaller historical cost does not establish scientific suitability or approval.

Changing the comparison weight scales saved costs/quantities for planning and does not rerun stock constraints. Use **Load scenario as draft** and a fresh solve separately when changing the actual scenario. Comparison controls are temporary; saved runs remain immutable and selectable after reload. JSON, CSV and five-sheet Excel exports include the baseline, batch, exact IDs, historical evidence and deterministic comparison SHA-256. Auditors may compare/export; tenant access is checked for every selected run.


## Download saved mixing PDFs

Use **Feed studio → Recipe library → PDF** on a saved version. The PDF uses its original batch and historical quantities, prices, nutrient/specification checks, source/provenance and processing evidence. Status, version ID, page count and snapshot SHA-256 repeat on every page. Draft/pending/rejected reports say **NOT APPROVED**; an approved historical report does not reserve stock or release manufacturing.

PDFs are generated by the Node app with bundled fonts and support pagination for long evidence. Unknown values are labeled; unsupported glyphs/invisible controls use `[U+XXXX]` notation. Use CSV/XLSX for original cell text or if a report exceeds the bounded PDF limits. PDF access uses the same current organization permissions as other reports, including auditor reads. No Python, new database migration or provider setting is needed for PDF generation.


## Understand infeasible optimizer runs

**Optimization evidence → Verified irreducible conflict** shows one set of conflicting nutrient, effective ingredient/stock or processing limits for the exact saved candidates. Removing any one listed member makes that subset feasible within solver tolerances, while the 100% total and nonnegative 0–100% inclusion domain stay fixed. Other conflicts may exist and the fewest possible members are not guaranteed. This explanation never changes the original limits or supplies a replacement formula.

The analysis allows at most 48 diagnostic checks within the worker's shared eight-second solve budget. Incomplete searches are labeled explicitly; expired or unverified searches make no irreducibility claim. History and comparison JSON/CSV/XLSX preserve the recorded result and active bound sources. Old runs remain unchanged without newly invented analysis. Review the underlying scientific evidence and inputs, then deliberately create and solve a new draft scenario when appropriate.

Very large conflict comparisons can exceed the Excel cell limit; CSV/JSON retain the complete evidence without truncation.


## Layer hen-day reports

In **Production**, select a layer flock and use **Hen-day report and forecast reconciliation**. Choose a date window (up to 366 days), reporting tray size and optional saved egg forecast. Reports use opening-of-day hens and weighted hen-days. Missing records remain unknown; an earlier gap prevents later population denominators from being established. Recorded subtotals remain visible while incomplete-window totals/variances are withheld.

A calendar baseline keeps its original monthly opening-stock assumptions. Population alignment must be known and match the recorded flock at the scenario start; different/unknown populations and out-of-range dates withhold variances. Legacy 28-day baselines are retained as source evidence without calendar-day interpolation. The chart leaves gaps for missing observations. No forecast is posted to actual records or stock.

Download **layer report JSON** to preserve the exact records/forecast, generation time and evidence SHA-256, or **CSV** for the daily report and source audit. Reports are read-only and refreshing includes later saved observations; they are not stored as new report versions in the app. Daily-record correction/census recovery, egg stock and sales remain separate workflows.


## Review layer observations and recover flock counts

In **Production → Layer record recovery**, owners, administrators and managers can review a complete daily replacement, fill a genuinely observed missing date, or enter a physical opening-flock census with dated evidence. Review the full values and acknowledge them before saving. Originals and earlier reviews remain in history; download the private recovery JSON for traceability. Other members/auditors can read history.

Daily replacements change effective recorded totals without adding duplicate collections. A census restores population knowledge only from its date forward; earlier missing feed, eggs and deaths stay unknown. Count differences remain unattributed. Generate a fresh layer report to see reviewed values and source evidence. A failed save response offers a safe receipt retry; a stale review requires reloading history. This workflow posts no physical egg inventory, sale or financial event. Apply migration 017 before deploying this app update; the Python worker is unchanged.


## Receive eggs, reconcile stock and record sales

Open **Egg inventory** and add a store for a farm. Receive actual layer collections explicitly; only gross less cracked eggs enters ungraded stock. If using existing opening stock, enter all initial batches as an opening-of-day baseline before other store operations; older collections cannot be received again into that store. Grade eggs, record losses and sell by whole eggs or explicit tray/remainder pricing. Managers can review physical counts and full reversals with evidence. Collections corrected in Production appear for explicit receipt reconciliation rather than silently changing stock.

Original sources, movements, prices, currencies, reviewers and reversals remain in JSON/CSV history. An unconfirmed posting is retained in the current tab for explicit retry after reload; do not close the tab before confirmation. Recorded sale values are separate from cash, receivables, costs and profit. Grade labels do not certify food safety. Store transfers, partial returns and larger/historical exports remain future work. Apply migration 018 before deploying this app update; the Python worker is unchanged.


## Transfer eggs and review partial customer returns

In **Egg inventory**, select a batch and **Transfer eggs** to confirm delivery to another store in your organization. Both sides post together, keeping grade and parent-batch lineage. To review a partial customer return, select the original sale, its returned pricing categories and the inspected saleable quantity. Credit uses original prices/currency; non-saleable eggs stay outside stock. Broken-tray credits use cumulative four-decimal half-up rounding so the original price is allocated exactly.

Only managers/owners/administrators review returns and reversals. Correct returns in latest-first order; sales with active partial returns use the remaining-return workflow. Completed transfer reversals require the eggs to remain available at the destination. Posting receipts survive reload in the current tab for an explicit retry. Apply migration 019 before publishing this app update. Payments, disposal and in-transit delivery tracking remain separate workflows.


In **Production → a broiler batch → Broiler lifecycle**, managers can record observed health, actual treatments, reviewed culls and weighed live harvests. Enter the daily feed/death/sample record first. Unknown or unexpired recorded medication withdrawal dates block harvest. Explicit bird/kg prices retain original currencies; unpriced harvests remain unknown. Source JSON/CSV preserve immutable evidence, and pending receipt retries prevent duplicate withdrawals after a lost response. Cohort FCR includes measured withdrawals only when feed and biomass evidence are complete; cash, costs, processed yields and profitability remain separate.


**Broiler record recovery** in the same Production screen adds evidence-backed withdrawal-guidance versions for genuine administrations and complete daily replacements/backfills. Original treatment/daily records remain unchanged. Revised deaths/samples must fit the full withdrawal history; later guidance flags conflicting earlier harvests without changing their original stock or prices. Current-source JSON/CSV include original/effective daily evidence and complete review chains.


In **Production → a broiler batch → Broiler batch planning**, enter cited age-based feed/brooding stages and growth targets, optional housing/strain/hatch/supplier details and explicit planning prices. Preview and save immutable versions, compare guide weights/feed with date-matched observations and export exact saved JSON/CSV. Missing assumptions stay unknown; original placement anchors the forecast. Saved recipe links are references only. Plans do not post actual feed, birds, sales, approvals or cash, and feed/chick estimates are not total cost/profit.


## Broiler cost and yield planning

In Production, save a sourced broiler batch plan first, then use **Broiler cost and yield planning** (reload its history after saving a new plan). Select the exact plan version; its historical currency, feed and chick prices remain attached. Enter eight additional batch cost totals with source/allocation evidence, documenting zeros explicitly. The complete-budget confirmation plus known costs enables total cost, projected margin and break-even; missing amounts remain unknown. Choose one live-bird, live-kg or explicitly sourced processed-kg sale basis. The model assumes all expected survivors are sold at the linked plan's harvest date, with no partial/by-product revenue allocation.

Save immutable scenario versions, compare two to four in the same original currency with a chosen baseline, and download private complete-source JSON/CSV. Working copies can be downloaded before reload; pending save receipts must be retried exactly. These forecasts do not post actual stock, processing, costs, sales or cash. Actual costing/profit still requires inventory valuation and financial ledgers.


## Measured broiler loss biomass

In **Production → Broiler lifecycle → Measured broiler loss biomass**, select existing daily deaths or an active cull. Record the measured whole-bird kg total for every bird in that loss, with the original measurement record and review reason, or explicitly withdraw the weight to unknown. No sample/forecast estimate supplies missing mass. Daily corrections make earlier weight evidence stale; load the selected source and review its current count before confirming again. A corrected zero count or voided erroneous cull keeps its old weight history inactive.

When feed, current loss weights and closing biomass evidence are complete, cohort FCR includes measured deaths/culls and live harvests once. It measures cohort biomass gain, including lost birds, rather than saleable-product conversion. Unknown/stale weights withhold FCR. JSON/CSV retain full original sources and review chains under the v3 model. Pending receipts offer exact retry after reload; stale working inputs can be downloaded before explicit source reload. Weight reviews never post extra bird losses, feed use, sales, cash or forecast changes.


## Broiler processing and measured yields

In **Production → Broiler lifecycle → Broiler processing and measured yields**, select one active weighed unpriced harvest and explicitly confirm that the whole group was owned and unsold when processed. Missing price does not prove that status; a priced live sale cannot also supply processed products. Enter the observed processing date, distinct primary/by-product/other output weights/use classifications and separately measured residual, or leave missing measurements unknown. The initial scope excludes partial processing, added mass and mixed harvests. Do not count both whole carcasses and their cuts or repeat outputs in residual.

Preview measured yields, save immutable full versions, inspect original measurements, withdraw erroneous evidence and re-record through the same source chain. Unknown mass/use keeps dependent totals unknown. A positive mass difference is unreconciled, never automatic waste. Current processing evidence protects its source harvest from void until erroneous evidence is withdrawn. These measurements do not return animals, replace live biomass in FCR or post product stock, sales, costs or cash. Private JSON/CSV contain current full source/history/metrics with a digest; they are bounded to 1 MiB normalized evidence. Pending receipts support exact retry after reload; stale working inputs can be downloaded and explicitly rebound to the current source before fresh acknowledgement.


## Broiler product stock and sales

In **Production → Broiler lifecycle → Broiler product stock and sales**, explicitly receive one whole measured intended output from the current processing version. Confirm ownership and physical availability on the recorded receipt date, and that no earlier receipt, sale, loss or other disposition occurred outside this ledger. A measurement or intended-use label alone creates no stock. The exact full measured kg and immutable source version are attached to a location label; unknown/unassessed/not-intended outputs cannot supply lots. Location labels are not a warehouse/transfer system.

Record partial sales by measured kg at an explicit price per kg (including evidenced zero), measured losses, or reversals of erroneous entries whose physical movement never occurred. Product kg retain six places; sale values use four-place half-up rounding in the currency captured at posting. Reversing an erroneous receipt requires every dependent sale/loss to be corrected first. Customer returns, physical transfers and count adjustments require later workflows; a void must never stand in for them. Processing measurements remain protected while any dependent receipt is active. Current guidance conflicts with the original harvest hold new receipts/sales for source review without rewriting historical observations or granting release certification.

Complete private JSON/CSV preserve original measurements, immutable movements, prices/currencies, reviewers, receipts and a reproducible digest. Pending receipts survive reload in the same tab for exact retry; keep the tab open until confirmation. Stale inputs can be downloaded and explicitly rebound to fresh source state, requiring fresh acknowledgement. Apply migrations **026 and 027** before deploying; the Python worker is unchanged. The initial limit is 1,000 movements per batch and 1 MiB normalized full-source report evidence; a write that would exceed its required report bound rolls back with its audit.

This is a physical kg ledger and recorded sale-value workflow. It does not change live-bird records, feed, FCR, saved plans/budgets, cash, receivables, inventory valuation, cost of goods sold or profit. Explicit actual-cost allocation and financial-ledger policies remain subsequent work.


## Reviewed broiler incurred costs and lot allocations

Open **Production → Broiler lifecycle → Broiler actual costs and allocations**. Enter the original cost currency and ten actual batch-attributed category totals through the loaded operational evidence. Blank amounts are unknown; every known amount, including zero, requires source/valuation evidence. For feed, enter the cost of feed actually consumed from issue/consumption valuation records, not feed purchases, recipe prices or forecast totals. Keep overlapping purchase/consumption costs out of the category totals. The complete-cost confirmation is your assertion about that stated boundary, not an independent audit.

Choose receipt lots and supply explicit cost allocations, including evidenced zero shares for by-products. Fully dispatched lots remain selectable. Allocations cannot exceed the known subtotal. The app divides each explicit allocation uniformly over that lot's original received kg, and reconciles the cost attributed to sold, lost and remaining kg using cumulative four-place half-up rounding. Unallocated known batch cost remains visible without being guessed into live birds, mortality, live sales or other products.

Preview without saving, then confirm and save an immutable review. Each version freezes the original/effective production, clinical, processing and product movement evidence, reviewer, actual category totals and supplied allocation policy. Exact-version private JSON/CSV retain their bytes after later operations, settings or cost reviews; current-source status is shown separately. A historical review is not automatically current valuation. Stale working inputs remain downloadable and require explicit reload/fresh confirmation; pending exact receipts survive same-tab reload for safe retry. Auditors can read/export without editing.

Apply migrations **028_broiler_actual_cost_reviews.sql** and **029_cost_snapshot_search_path.sql** before deploying this phase. Limits: 100 review versions per batch, 40 explicit lot allocations per review, 64,000 input JSON bytes, 512 KiB frozen actual-source snapshot and 1 MiB normalized saved report. Older exact-version downloads remain available even if current batch history exceeds the snapshot bound. No Python worker redeployment is needed.

These are managerial reviews of supplied incurred cost totals and explicit lot allocations. They do not post expenses, purchases, feed inventory valuation, financial COGS, cash, journals or profit. Original-currency live/product sales stay separate from the cost schedule. Balanced financial ledgers and explicit inventory/expense recognition remain prerequisites for realized profitability reporting.


### Financial journal and trial balance

Open **Finance** as an owner, administrator, manager or auditor. Managers can preview and confirm balanced, evidenced manual entries; explicitly recognize an active priced live/processed broiler sale in its original currency as a receivable or evidenced cash/bank receipt; and append exact accounting reversals. Auditors can read/export; workers cannot access financial records. Recognition freezes the actual sale evidence and prevents operational void until its recognition is reversed. Reversal alone never changes stock or transfers money.

Reports show currency-separated movements and net balances. Select both an accounting date and append-position cutoff for stable JSON/CSV evidence, including after later backdated entries. Pending exact receipts survive same-tab reload; stale working inputs remain downloadable and require explicit reload/fresh confirmation. Cash, costs and valuations are supplied evidence, not automatic bank reconciliation or proof of complete books. Cost reviews and forecasts never auto-post; procurement/feed valuation, customer payment matching, period controls and reconciled profitability remain outstanding.

Apply migrations **030_financial_journal.sql** and **031_financial_source_consistency.sql** before deploying this phase. Bound: 1,000 entries/org, 2–20 distinct account lines/manual entry, 20,000 input JSONB bytes, 32 KiB source snapshot, 1 MiB normalized JSON evidence and 3 MiB CSV. No worker or environment/secret change is needed.
