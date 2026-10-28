# Vercel + Neon preview

The preview is live at **https://farmstead-preview.vercel.app**. It uses a dedicated Neon database and a separate authenticated Python worker. Hosted checks verify registration, secure sessions, persisted farm data, tenant isolation, genuine optimization, workbook upload/mapping and CSV/Excel reports. This is a development preview; the documented production release gates remain outstanding.

## Projects and data

Use a new, dedicated Neon PostgreSQL 17 project/database for preview data, a Vercel Next.js project for this repository and a separate Vercel Python worker project. The app and worker run in US East (`iad1`). The Neon Marketplace resource reports `iad1`; the provisioned database endpoint is in AWS US East (Ohio). A direct Neon project can use `aws-us-east-1` alongside the compute projects. No existing user database, local account/session, local farm record or local password is copied into the preview.

The Next.js Node runtime does not provide the local Python interpreter. The Python project runs the existing fixed solver/inspection/export scripts in resource-limited subprocesses. App-to-worker calls require a shared secret, use HTTPS without redirects, and bound both request and response bodies. The worker has no database credentials. Unknown operations and unauthenticated requests are rejected before starting a subprocess. Existing scientific gates, independent solver checks, workbook validation and immutable report behavior still run.

## Account access

Sign in with the provider CLIs using browser authorization. Do not paste account credentials into chat or put them in Git. These CLI versions were available in the workspace: Vercel 65.4.0 and the current neonctl package. Vercel Marketplace provisioning can replace the direct Neon CLI flow when its browser authorization uses a localhost callback that cannot reach the cloud machine. Accept provider terms in the browser; never work around a credential `challenge_required` response. Store CLI configuration outside the checkout, for example under `/workspace/.deployment-auth` using Vercel's `--global-config` or XDG configuration paths and neonctl's `--config-dir`.

Required network destinations are `vercel.com`, `*.vercel.com`, `*.vercel.app`, `neon.com`, `*.neon.com`, `*.neon.tech`, and `api.github.com`; existing package-manager/Git destinations must be retained. A saved cloud-environment draft is not evidence that these destinations are reachable. Recheck authentication after the user applies it.

## Database preparation

1. Create a dedicated Neon project. A supported CLI invocation is `neonctl projects create --name farmstead-preview --database farmstead_preview --pg-version 17 --region-id aws-us-east-1 --cu 0.25 --no-secrets`. Select the user's intended organization and retain the project ID. Do not print connection credentials in tool output (`--no-secrets` is important).
2. Obtain its direct administrator connection URL securely and enter it as `PREVIEW_DATABASE_ADMIN_URL` in the cloud execution environment (or set `MIGRATION_DATABASE_URL` for the provisioning command only). The uniquely named preview variable does not affect ordinary local database setup. Use a private ignored environment file or the execution environment's secure variable entry, not a tracked file. The URL is not an app runtime credential.
3. From a workspace with direct database access, run `node scripts/provision-preview-db.mjs`. This cloud workspace supports HTTPS/WSS egress, so its verified command is `NODE_USE_ENV_PROXY=1 PREVIEW_DATABASE_TRANSPORT=neon node scripts/provision-preview-db.mjs`. The optional Neon transport uses the official serverless WebSocket client and certificate verification; the application runtime continues to use native `pg`. `MIGRATION_DATABASE_TRANSPORT` explicitly overrides the preview transport (local database tests force `tcp`). It refuses unrelated data/migration history, applies pending migrations, creates/enables the restricted `farm_server` login, checks that direct tenant reads are denied, verifies `SET LOCAL ROLE farm_app` isolation, and writes only the runtime URL to `.local/preview-runtime.env` with mode 0600. Repeated runs reuse that credential. `PREVIEW_CREDENTIALS_FILE` can select a separate ignored/private file for another database.
4. The runtime URL uses Neon's pooled host and `sslmode=verify-full`. Put this restricted URL into the **app** project's `DATABASE_URL`. Do not put `MIGRATION_DATABASE_URL`, Neon owner passwords or development database credentials in the app/worker environment.

The provisioning helper was exercised on an isolated PostgreSQL 17 cluster using a database owner with CREATEROLE but no superuser privilege, including migrations, idempotence, actual owner-visible data versus another actor, restricted runtime access, unrelated-data refusal and credential-destination checks. All nineteen migrations were applied to the dedicated hosted Neon database, and restricted-runtime/tenant checks passed there. The administrator credential was entered through secure environment settings and was never installed in either Vercel runtime. Do not run integration/browser cleanup suites against the hosted database.

## Python worker deployment

1. Run `node scripts/prepare-vercel-worker.mjs`. It copies the deployment template and the current three scripts into ignored `.local/vercel-worker`; the source workbooks and local database files are not part of that project. The staged project includes pinned scientific dependencies and Python 3.12.
2. Create/link a **new** Vercel Python project rooted in that staged directory. Run the CLI from the physical staged working directory with an explicit absolute `--local-config` path to its `vercel.json`; this avoids the native CLI inheriting the ancestor Next.js configuration. Public static output is restricted to `public/`; `workers/**` is included only inside the Python function bundle. Generate a strong random shared service secret and enter it securely as `FARM_WORKER_SECRET` in that project's Production environment. Retain it securely for the app environment; never display it or put it in Git.
3. Deploy the worker project and retain its stable HTTPS URL. A production target is appropriate for this isolated service so its stable URL can be used by app previews. This is a new worker service, not a release of the farm app.
4. Its route is `POST /api/worker?operation=optimize|inspect|export`. If Vercel Deployment Protection applies to the worker URL, obtain its supported automation bypass secret and set `FARM_WORKER_BYPASS_SECRET` only on the app. The worker's bearer secret remains required regardless of platform protection.

The worker's environment does not need `DATABASE_URL`. Root-runtime CPU limits are not applied to the reusable HTTP process; each isolated subprocess retains its own worker limits and timeout. The handler only exposes three fixed script paths and never evaluates uploaded formulas. Requests are limited to two simultaneous subprocesses per worker instance. The serverless platform provides additional execution/memory/request limits that must be checked during the first deployment.

## App deployment

Import/link `kenoyek/farm-management-app` as the Next.js project and use Node 24. `vercel.json` uses the existing locked npm install and production build. Migrations are run separately, not during every Vercel build. The runtime pool is capped at three connections per app instance, with connection and idle timeouts, and tenant operations still use transactions with local role/actor context.

For the live stable URL on this dedicated preview project, set these variables securely on both **Preview and Production** targets. The Production target publishes only this isolated preview app and its preview database; it does not change an existing customer production service. A protected generated preview alone needs only the Preview target.

| Variable | Source |
|---|---|
| `DATABASE_URL` | Restricted pooled Neon URL produced above |
| `FARM_WORKER_URL` | Stable HTTPS origin of the new Python service |
| `FARM_WORKER_SECRET` | Same shared service secret as the Python project |
| `FARM_WORKER_BYPASS_SECRET` | Only if the worker's deployment protection requires it |

Leave `APP_ORIGIN` unset for generated preview URLs: Vercel requests use HTTPS plus their exact current Host for origin checks and Secure session cookies. An explicit `APP_ORIGIN` remains available for a later canonical domain, configured only on its matching environment. Neither credentials nor worker settings use `NEXT_PUBLIC_` variables. A missing worker configuration returns a controlled unavailable response instead of pretending a local Python executable is present.

Preserve the existing development `.env.local` when linking with the CLI; do not accept an environment-pull prompt that overwrites it. `.env*`, `.local`, tests and deployment templates are excluded from the app upload. `.vercel/` is ignored. Generated preview deployments retain Vercel authentication protection. The stable preview URL is publicly reachable and uses the app's registration/sign-in and tenant permissions; create real preview accounts through the app. The native CLI can promote a project's first deployment to Production, so choose the target explicitly and configure the corresponding environment before deploying. Do not seed fictional metrics.

## Required external smoke checks

After deployment, verify the actual HTTPS URL and provider logs:

1. App shell at the stable URL (and Vercel authentication on protected generated previews); unauthenticated app API reads return 401.
2. Register a dedicated preview test account, create an organization/farm, reload persistence, and verify HTTPS Secure/HttpOnly/SameSite session cookies and same-origin write enforcement.
3. Compare two isolated test accounts/organizations to verify runtime tenant isolation with hosted PostgreSQL.
4. Preview the supplied workbook catalog, upload a real .xlsx ingredient table, and confirm authorized original downloads and unverified import state.
5. With explicitly labeled synthetic test references/profile, exercise a genuine constrained optimum and an infeasible run; verify stored history and unchanged hard constraints. Scientific test data is not production guidance.
6. Save a test recipe and round-trip its XLSX/CSV mixing reports through the hosted Python worker; unknowns and formula-like strings must retain their existing behavior.

Publish the resulting app preview URL only after these checks pass. Local tests do not establish provider deployment success. Redeploy the worker whenever its scripts/dependencies change; coordinate both projects for worker protocol changes. Git-based app deployments alone do not update the separately staged Python service. Distributed throttling, managed-auth/recovery, monitoring and the other documented production release gates remain separate work.


## Current session status

The app is deployed at **https://farmstead-preview.vercel.app** with the separate worker at `https://farmstead-python-worker.vercel.app`. Both are new projects in the user's Vercel account. Neon Free provisioning and all nineteen migrations succeeded. Only the restricted pooled `farm_server` credential is installed on the app; the worker has no database credential.

The hosted app passed HTTPS checks for registration and Secure/HttpOnly/SameSite cookies, persistence, cross-origin write rejection, outsider isolation, a real HiGHS optimum and an infeasible scenario, immutable recipe snapshots, CSV/Excel report contents, real workbook inspection, 32-row mapped preview and an exact SHA-256 source-file download round trip. Chromium also verified the saved recipe in the library, responsive mobile rendering after reload and no uncaught client errors; all 22 hosted checks passed. Synthetic validation fixtures are labeled and private to their test accounts; local integration cleanup suites were not run against hosted data.

The worker's authenticated solver/inspection/XLSX endpoints also passed direct HTTPS checks. Static source/requirements URLs return 404, and the superseded deployment with broad static output was removed. An explicit absolute worker `--local-config` avoids the CLI inheriting the ancestor app configuration.

The app project is connected to `kenoyek/farm-management-app` through Vercel's GitHub integration, with `main` selected as the Production branch. Pushes to `main` trigger deployment to the stable development-preview URL; other branches receive protected Preview deployments. The initial site was deployed directly with the CLI. Update the separately staged Python worker when its scripts or dependencies change. Provider credential reads that return `challenge_required` must continue through the provider's supported verification or secure user input, never alternate extraction routes.


The source-alias review update applied migration 013 before its Git-triggered app deployment. Sixteen hosted API/browser checks passed for its exact-reference review/history/conflict/download workflow; source warnings, ingredient approval and recipes were unchanged. Future additive migrations must likewise be applied and verified before pushing code that queries their new schema. Worker deployment is only required when that separate service's scripts, dependencies or protocol change.


For the expanded nutrient update, deploy the backward-compatible Python worker accepting eleven constraints before pushing the app, and apply migration 014 separately. The worker still accepts the original seven-row protocol. Its authenticated hosted eleven-row solve was checked against a known objective; static helper scripts remain private. Existing app/worker environment credentials and restrictions are retained. The current original workbook inspector and Excel writer do not require protocol changes.


The nutrient update passed 21 hosted API/browser checks after deployment, including real eleven-constraint optimization, unknown-data refusal, expanded workbook mapping, source-isolated reports, persisted controls and mobile rendering. An independent read of its downloaded XLSX confirmed all four measured concentrations, including numeric zero. Operational smoke fixtures are labeled synthetic and private; local cleanup suites remain restricted to the local test database.


Apply migration 015 before pushing the provenance/source-recipe app update. The existing Python worker already supports five report worksheets; this update changes its bounded input data, not the worker scripts/protocol, so a separate worker redeployment is unnecessary. Source imports use the same restricted runtime, tenant RLS, origin enforcement and authenticated export transport as other recipe operations.


The source-recipe/provenance update passed 22 hosted API/browser checks after deployment. Independent reading of its actual downloaded Excel report confirmed the fifth audit sheet, all 34 source rows, exactly 30 blank inclusions and the original four percentages. Supplier strings remained literal text; report bytes stayed unchanged after a new reference/provenance revision. These checks used labeled private synthetic fixtures, not existing user records.


For structured processing constraints, apply migration 016 and deploy the backward-compatible Python worker accepting up to 31 rows **before pushing the app**. This accommodates eleven nutrient rows plus at most twenty reviewed groups. Original seven/eleven-row clients remain valid; body/time/memory/variable limits are unchanged. Keep the worker's explicit absolute local configuration and project link when deploying from `.local/vercel-worker`; never deploy the app under that project. Normal Git pushes update only the app. No environment credential changes are needed.


The processing update passed all 25 hosted API/browser checks after Git deployment `2093b2c`, plus direct worker 31/32-row boundary and private-source checks. Its downloaded Excel workbook was independently read to confirm exact method evidence, group cap and saved total. Historical CSV bytes remained identical after reference/method/price/profile revisions. The dedicated database now has sixteen applied migrations. Hosted fixtures remain clearly labeled synthetic in private organizations; no local cleanup suite was pointed at Neon.


Optimizer scenario comparison is an app-only update. It reads existing immutable run snapshots through the current restricted Neon role, with no migration or Python protocol change. The existing authenticated Excel worker produces its five-sheet reports. Keep the current environment bindings and worker deployment; Git-triggered app deployment is sufficient. Verify selected-run tenant isolation, genuine optimal/infeasible comparisons, deterministic history, exports and browser controls on private labeled synthetic fixtures after deployment.


The scenario-comparison update passed 30 hosted API/browser checks after Git deployment `710bb6e` reached READY, with an independent read of its genuine five-sheet Excel export. Comparisons remained byte-stable after new quotation/method/profile revisions, used historical snapshots and denied outsider access to both JSON and reports. Auditor browser controls, baseline switching, filtered selection and mobile width passed without client errors. No remote schema, environment binding or Python worker change was required.


Saved mixing PDFs are an app-only update using pinned JavaScript dependencies and bundled licensed fonts. `next.config.ts` explicitly traces the font assets into the API function; no runtime download is made. Keep existing Neon/worker bindings unchanged. Verify an authenticated PDF download after Git deployment, including the original snapshot digest, repeated status, historical values, tenant denial and page rendering. Python worker redeployment and remote migrations are unnecessary for this update.


The PDF update passed 24 hosted API/browser checks after Git deployment `ea7b731` reached READY. Independent PDF.js/Poppler readers confirmed original quantities/costs, Unicode, repeated review status and the complete 34-row source audit with thirty unknown inclusions. Historical PDF bytes remained identical after later price/method/profile revisions; outsider and anonymous downloads were denied. Font/permission notices are bundled as server assets and included as literal PDF catalog metadata. The dedicated Neon database and separate Python worker were unchanged.


For conflict diagnostics, deploy the backward-compatible Python worker with the optional boolean `explain` flag **before pushing the app**. Old clients retain their original response shape and strict default bound protocol. New clients record conflict model 1, optimizer request model 6 and diagnostic model 3; the body/row/variable/memory/watchdog limits stay unchanged. Verify genuine irreducible and budget-exhausted hosted solves without returned counterfactual allocations, plus old-client compatibility, then publish the Git app update. No Neon migration or credential change is required.


The conflict update passed 26 hosted API/browser checks after worker-first publication and Git app deployment `84dafa1` reached READY. Direct worker validation additionally covered old-client compatibility, genuine irreducibility, a known optimum, bounded partial exhaustion and private source files. A real 61-candidate hosted app scenario displayed **Conflict search incomplete** after 48 checks without allocations. Independent reading of its five-sheet comparison workbook recovered the exact named constraints/status and blank infeasible costs. Original history and CSV bytes remained identical after price/profile revisions. Neon schema and runtime credentials were unchanged.


Layer hen-day reporting is an app-only update reading existing production/forecast tables. No Neon migration, worker deployment or credential change is required. Verify actual zero versus missing dates, weighted rates, calendar/legacy/misaligned baselines, source exports, auditor access and tenant isolation using clearly labeled private synthetic fixtures. Reports never post operational events or create saved report rows.


The layer report update passed 28 hosted API/browser checks after Git deployment `c366948` reached READY. Independent Decimal/CSV reading confirmed 296 hen-days, the weighted rate, exact feed/trays, explicit zero and leap-year baseline variance. Missing/unaligned/28-day comparisons were withheld appropriately; historical hashes and CSV bytes remained unchanged after later observations. Auditor controls/downloads, tenant isolation and mobile rendering passed without client errors. Neon schema, credentials and the separate worker were unchanged.


For layer record recovery, apply additive migration `017_layer_reconciliation.sql` to the dedicated Neon preview before pushing the app. It adds append-only review chains and security-invoker effective-record/population views; the restricted runtime credential and separate Python worker remain unchanged. Verify real member-visible originals/reviews, auditor/worker write denial, outsider isolation, exact retry receipts, competing review conflicts, census-segment loss bounds and effective dashboard/report totals. Hosted fixtures must remain explicitly synthetic and private.

The recovery update applied migration 017 successfully and passed restricted runtime/tenant checks before Git deployment `98736ee` reached READY on the stable preview. Thirty-one hosted API/Chromium checks passed for immutable originals and reviewer evidence, genuine zero backfills, full-value corrections with exact 3.123456 kg feed, forward-only census recovery, 179 weighted recovered hen-days, same-origin/role/tenant denial, receipt retry without duplicate reviews/audits, exactly one concurrent successor, impossible-loss rejection on both sides of a census, effective production/dashboard totals, private CSV/JSON digests, unchanged earlier-window evidence after a later-dated review, browser saves/downloads/mobile rendering and auditor read-only controls. Independent Python Decimal/CSV reading reproduced the weighted rate, exact feed, zero record, original values and every review UUID. The dedicated database now has seventeen applied migrations; no real-farm data, credentials or worker deployment changed.


For physical egg inventory, apply migration `018_egg_inventory.sql` to the dedicated preview before publishing the app. It adds RLS-protected immutable stores/batches/events and security-invoker balances, with locked stock checks, atomic first receipts, opening baselines, original source/price snapshots, receipt idempotency and exact reversals. No worker or runtime credential change is required. Verify whole-egg pricing, tenant/role/origin checks, receipt/sale races, zero vs missing data, production-correction reconciliation and readable mobile tables using private synthetic fixtures only.

The migration and restricted runtime/tenant checks passed. Git app deployment `a973414` passed 39 hosted API/Chromium checks for the complete receipt/grade/sale/return/reconciliation workflow and private exports. Deployment `abccca6` passed seven further hosted source-export checks; independent CSV/JSON reading reproduced full original/corrected receipt-source evidence, including quoted multiline Unicode notes and exact six-decimal observations. Independent Decimal reading verified every running stock balance and original-currency sale/reversal value. The database now has eighteen migrations. The worker, credentials and real-farm data remain unchanged.


For store transfers and partial returns, apply `019_egg_transfers_returns.sql` before publishing the app. It extends the existing RLS/immutable tables and invoker views/triggers with paired transfer destinations, parent batches and original-sale return evidence. Validate source/destination dates and balances, exact batch/source lineage, cumulative original-price rounding, inspected restock vs non-saleable returns, stale/concurrent reviews, latest-first corrections and unchanged original currency. No worker deployment or runtime credential change is required.

Migration 019 and restricted runtime/tenant checks succeeded. Git app deployment `b700973` passed 38 hosted API/Chromium checks for the complete transfer/partial-return/reversal/evidence flow, including concurrent stock/return protection, role/tenant/origin isolation, mobile reporting and auditor reads. Independent Decimal/CSV/SHA-256 reading reproduced every running balance, original monetary allocation, lineage, final 93 eggs and separate NGN/USD net values. Nineteen migrations are now installed in the dedicated preview. Fixtures are synthetic/private; no real-farm records, payment/financial events, credentials or worker deployment were changed.
