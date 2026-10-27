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

Use **Revise specification** to append a reviewed version. History and JSON downloads preserve source evidence; existing recipe approvals and solver inputs retain the old version. Historical references required by a selected profile remain selectable in the formulator. Manual rule violations prevent approval, and optimizer conflicts never relax reviewed bounds. Profiles without rules retain the existing reviewed-ingredient selection checks. These limits do not replace qualified scientific review, processing constraints or stock reservations.
