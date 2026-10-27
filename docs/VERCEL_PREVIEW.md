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

The provisioning helper was exercised on an isolated PostgreSQL 17 cluster using a database owner with CREATEROLE but no superuser privilege, including migrations, idempotence, actual owner-visible data versus another actor, restricted runtime access, unrelated-data refusal and credential-destination checks. All thirteen migrations were applied to the dedicated hosted Neon database, and restricted-runtime/tenant checks passed there. The administrator credential was entered through secure environment settings and was never installed in either Vercel runtime. Do not run integration/browser cleanup suites against the hosted database.

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

The app is deployed at **https://farmstead-preview.vercel.app** with the separate worker at `https://farmstead-python-worker.vercel.app`. Both are new projects in the user's Vercel account. Neon Free provisioning and all thirteen migrations succeeded. Only the restricted pooled `farm_server` credential is installed on the app; the worker has no database credential.

The hosted app passed HTTPS checks for registration and Secure/HttpOnly/SameSite cookies, persistence, cross-origin write rejection, outsider isolation, a real HiGHS optimum and an infeasible scenario, immutable recipe snapshots, CSV/Excel report contents, real workbook inspection, 32-row mapped preview and an exact SHA-256 source-file download round trip. Chromium also verified the saved recipe in the library, responsive mobile rendering after reload and no uncaught client errors; all 22 hosted checks passed. Synthetic validation fixtures are labeled and private to their test accounts; local integration cleanup suites were not run against hosted data.

The worker's authenticated solver/inspection/XLSX endpoints also passed direct HTTPS checks. Static source/requirements URLs return 404, and the superseded deployment with broad static output was removed. An explicit absolute worker `--local-config` avoids the CLI inheriting the ancestor app configuration.

The app project is connected to `kenoyek/farm-management-app` through Vercel's GitHub integration, with `main` selected as the Production branch. Pushes to `main` trigger deployment to the stable development-preview URL; other branches receive protected Preview deployments. The initial site was deployed directly with the CLI. Update the separately staged Python worker when its scripts or dependencies change. Provider credential reads that return `challenge_required` must continue through the provider's supported verification or secure user input, never alternate extraction routes.


The source-alias review update applied migration 013 before its Git-triggered app deployment. Sixteen hosted API/browser checks passed for its exact-reference review/history/conflict/download workflow; source warnings, ingredient approval and recipes were unchanged. Future additive migrations must likewise be applied and verified before pushing code that queries their new schema. Worker deployment is only required when that separate service's scripts, dependencies or protocol change.
