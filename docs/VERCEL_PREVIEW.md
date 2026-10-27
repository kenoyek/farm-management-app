# Vercel + Neon preview

The deployment configuration and adapters are prepared and locally tested. A hosted URL is not established until both provider authentication flows, deployment, remote migrations and the external smoke checks below succeed. Network access and Vercel device authorization have been verified in this session. Neon was provisioned through the Vercel Marketplace on its Free plan. Database credential verification and app deployment are tracked separately below; no app preview is claimed until its external checks pass.

## Projects and data

Use a new, dedicated Neon PostgreSQL 17 project/database for preview data, a Vercel Next.js project for this repository and a separate Vercel Python worker project. The app and worker are configured for US East (`iad1`), matching the provisioned Neon Marketplace resource. A direct Neon project can use `aws-us-east-1` alongside them. No existing user database, local account/session, local farm record or local password is copied into the preview.

The Next.js Node runtime does not provide the local Python interpreter. The Python project runs the existing fixed solver/inspection/export scripts in resource-limited subprocesses. App-to-worker calls require a shared secret, use HTTPS without redirects, and bound both request and response bodies. The worker has no database credentials. Unknown operations and unauthenticated requests are rejected before starting a subprocess. Existing scientific gates, independent solver checks, workbook validation and immutable report behavior still run.

## Account access

Sign in with the provider CLIs using browser authorization. Do not paste account credentials into chat or put them in Git. These CLI versions were available in the workspace: Vercel 65.4.0 and the current neonctl package. Vercel Marketplace provisioning can replace the direct Neon CLI flow when its browser authorization uses a localhost callback that cannot reach the cloud machine. Accept provider terms in the browser; never work around a credential `challenge_required` response. Store CLI configuration outside the checkout, for example under `/workspace/.deployment-auth` using Vercel's `--global-config` or XDG configuration paths and neonctl's `--config-dir`.

Required network destinations are `vercel.com`, `*.vercel.com`, `*.vercel.app`, `neon.com`, `*.neon.com`, `*.neon.tech`, and `api.github.com`; existing package-manager/Git destinations must be retained. A saved cloud-environment draft is not evidence that these destinations are reachable. Recheck authentication after the user applies it.

## Database preparation

1. Create a dedicated Neon project. A supported CLI invocation is `neonctl projects create --name farmstead-preview --database farmstead_preview --pg-version 17 --region-id aws-us-east-1 --cu 0.25 --no-secrets`. Select the user's intended organization and retain the project ID. Do not print connection credentials in tool output (`--no-secrets` is important).
2. Obtain its direct administrator connection URL securely and enter it as `PREVIEW_DATABASE_ADMIN_URL` in the cloud execution environment (or set `MIGRATION_DATABASE_URL` for the provisioning command only). The uniquely named preview variable does not affect ordinary local database setup. Use a private ignored environment file or the execution environment's secure variable entry, not a tracked file. The URL is not an app runtime credential.
3. From this checkout run `node scripts/provision-preview-db.mjs`. It refuses unrelated data/migration history, applies pending migrations, creates/enables the restricted `farm_server` login, checks that direct tenant reads are denied, verifies `SET LOCAL ROLE farm_app` isolation, and writes only the runtime URL to `.local/preview-runtime.env` with mode 0600. Repeated runs reuse that credential. `PREVIEW_CREDENTIALS_FILE` can select a separate ignored/private file for another database.
4. The runtime URL uses Neon's pooled host and `sslmode=verify-full`. Put this restricted URL into the **app** project's `DATABASE_URL`. Do not put `MIGRATION_DATABASE_URL`, Neon owner passwords or development database credentials in the app/worker environment.

The provisioning helper was exercised on an isolated PostgreSQL 17 cluster using a database owner with CREATEROLE but no superuser privilege, including migrations, idempotence, actual owner-visible data versus another actor, restricted runtime access, unrelated-data refusal and credential-destination checks. Actual Neon connectivity still needs verification after login. Do not run integration/browser cleanup suites against the hosted database.

## Python worker deployment

1. Run `node scripts/prepare-vercel-worker.mjs`. It copies the deployment template and the current three scripts into ignored `.local/vercel-worker`; the source workbooks and local database files are not part of that project. The staged project includes pinned scientific dependencies and Python 3.12.
2. Create/link a **new** Vercel Python project rooted in that staged directory. Run the CLI from the physical staged working directory with an explicit absolute `--local-config` path to its `vercel.json`; this avoids the native CLI inheriting the ancestor Next.js configuration. Public static output is restricted to `public/`; `workers/**` is included only inside the Python function bundle. Generate a strong random shared service secret and enter it securely as `FARM_WORKER_SECRET` in that project's Production environment. Retain it securely for the app environment; never display it or put it in Git.
3. Deploy the worker project and retain its stable HTTPS URL. A production target is appropriate for this isolated service so its stable URL can be used by app previews. This is a new worker service, not a release of the farm app.
4. Its route is `POST /api/worker?operation=optimize|inspect|export`. If Vercel Deployment Protection applies to the worker URL, obtain its supported automation bypass secret and set `FARM_WORKER_BYPASS_SECRET` only on the app. The worker's bearer secret remains required regardless of platform protection.

The worker's environment does not need `DATABASE_URL`. Root-runtime CPU limits are not applied to the reusable HTTP process; each isolated subprocess retains its own worker limits and timeout. The handler only exposes three fixed script paths and never evaluates uploaded formulas. Requests are limited to two simultaneous subprocesses per worker instance. The serverless platform provides additional execution/memory/request limits that must be checked during the first deployment.

## App deployment

Import/link `kenoyek/farm-management-app` as the Next.js project and use Node 24. `vercel.json` uses the existing locked npm install and production build. Migrations are run separately, not during every Vercel build. The runtime pool is capped at three connections per app instance, with connection and idle timeouts, and tenant operations still use transactions with local role/actor context.

Set these **Preview** environment variables securely:

| Variable | Source |
|---|---|
| `DATABASE_URL` | Restricted pooled Neon URL produced above |
| `FARM_WORKER_URL` | Stable HTTPS origin of the new Python service |
| `FARM_WORKER_SECRET` | Same shared service secret as the Python project |
| `FARM_WORKER_BYPASS_SECRET` | Only if the worker's deployment protection requires it |

Leave `APP_ORIGIN` unset for generated preview URLs: Vercel requests use HTTPS plus their exact current Host for origin checks and Secure session cookies. An explicit `APP_ORIGIN` remains available for a later canonical domain, configured only on its matching environment. Neither credentials nor worker settings use `NEXT_PUBLIC_` variables. A missing worker configuration returns a controlled unavailable response instead of pretending a local Python executable is present.

Preserve the existing development `.env.local` when linking with the CLI; do not accept an environment-pull prompt that overwrites it. `.env*`, `.local`, tests and deployment templates are excluded from the app upload. `.vercel/` is ignored. Keep Vercel's preview access protection for this development preview and create real preview accounts through the app. Do not seed fictional metrics.

## Required external smoke checks

After deployment, verify the actual HTTPS URL and provider logs:

1. Protected preview access and app shell; unauthenticated app API reads return 401.
2. Register a dedicated preview test account, create an organization/farm, reload persistence, and verify HTTPS Secure/HttpOnly/SameSite session cookies and same-origin write enforcement.
3. Compare two isolated test accounts/organizations to verify runtime tenant isolation with hosted PostgreSQL.
4. Preview the supplied workbook catalog, upload a real .xlsx ingredient table, and confirm authorized original downloads and unverified import state.
5. With explicitly labeled synthetic test references/profile, exercise a genuine constrained optimum and an infeasible run; verify stored history and unchanged hard constraints. Scientific test data is not production guidance.
6. Save a test recipe and round-trip its XLSX/CSV mixing reports through the hosted Python worker; unknowns and formula-like strings must retain their existing behavior.

Publish the resulting app preview URL only after these checks pass. Local tests do not establish provider deployment success. Redeploy the worker whenever its scripts/dependencies change; coordinate both projects for worker protocol changes. Git-based app deployments alone do not update the separately staged Python service. Distributed throttling, managed-auth/recovery, monitoring and the other documented production release gates remain separate work.


## Current session status

Vercel account authorization, a new Next.js project, a new Python worker project and a Neon Free resource have been created. The worker is deployed and its actual solver/inspection/XLSX endpoints passed authenticated HTTPS checks. Static source/requirements URLs are private (404); the earlier deployment with broad static output was removed. Vercel native CLI 65.4 inherited the ancestor app configuration in one deployment; specifying the staged worker's absolute `--local-config` produced the correct Python build.

The provider database-secret read requires additional verification (`challenge_required`). Do not try alternate credential-extraction routes to evade that requirement. The user can obtain the direct unpooled URL through their authenticated provider console and enter it as **PREVIEW_DATABASE_ADMIN_URL** in this cloud environment's secure settings. After the value is applied, run provisioning and continue app deployment. Do not enter that administrator URL on either Vercel runtime project. The frontend has not been deployed or externally smoke-tested yet. A GitHub Login Connection in Vercel is required for automatic Git pushes; the current new project can receive direct CLI source deployments.
