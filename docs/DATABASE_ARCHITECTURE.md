# Database architecture

## Foundation and stack decision
Next.js App Router, strict TypeScript and PostgreSQL. Development uses a local PostgreSQL container to permit real tenant-isolation tests without external accounts. SQL migrations are portable to Supabase PostgreSQL. The foundation uses server-side scrypt identity/session storage; Supabase Auth/Storage integration remains a deployment adapter, not a claim of configured Supabase services. Production adoption must choose managed Supabase Auth (migrate identity through reset/invite, not copy password hashes) or independently audit this identity implementation. No service-role key is exposed to the browser.

Identity: users(email normalized unique, password_hash, created_at), sessions(token_hash PK, user FK, expires_at). Organizations(id, name, currency, timezone); memberships(org,user composite PK, constrained role); farms(id,org,name,location,kind). Every operational query runs a transaction with a transaction-local `app.user_id`; a non-login `farm_app` role has no BYPASSRLS, cannot change schemas or identities, and uses membership RLS policies. Pool connections reset context at transaction end. Identity/session lookups use the server pool; operational SQL switches to farm_app. Security-definer membership helpers use fixed search_path, no caller-controlled SQL. Audit writes are part of the same transaction, audit reads are scoped; members cannot rewrite audit rows.

Owner/admin manage farms; manager can record/edit operations; worker records only permitted daily entries; auditor is read-only. Owner status is established atomically on organization creation, never by trusting a role submitted by the client. Membership management must prevent last-owner removal. Stable UUID keys; all timestamps timestamptz; currency ISO code; local dates stored as date; money numeric(20,4), quantities numeric(20,6).

## Domain model, phased
- organizations 1→N memberships/farms; users N→N organizations. Farm units → poultry houses/flocks/broiler batches/ponds. Composite (organization_id,id) references prevent cross-tenant parent assignment.
- production cycles own daily records, samples, mortality, health, treatments, transfers, partial harvests. Date/idempotency unique constraints stop duplicate entry; transfer pairs transactional.
- nutrient definitions include unit/basis/energy system/species; requirement profiles and restrictions are versioned. Ingredient composition, verification, laboratory sources and historical prices are separate versions, not destructive updates. Missing concentrations nullable; approved profiles immutable.
- feed formulas → versions → ingredient allocations + nutrient snapshots; optimizer runs store immutable inputs, solver version/status, results and residuals; batches reference approved version IDs.
- warehouses/items/lots/movements: immutable signed movements, reference idempotency, row locks for stock checks. Purchasing, receiving and stock usage distinct.
- suppliers/customers/purchase orders/sales/expenses/payments and balanced journal entries: transactions, immutable historical prices; corrections use reversals. No implicit doubling of receiving/expense events.
- forecasts → scenarios → versioned input/output snapshots separate from actuals. Imports → original object hash + staged rows/issues + confirmed normalized mapping. Tasks/notifications configurable; subscriptions/entitlements data-driven, payment collection disabled.

## Security and operations
Enable RLS and least-privilege grants on every tenant table, including new migrations. Test outsider reads and forged inserts/updates across tenants with the actual runtime role. Authorize every export and object download. Storage paths include organization IDs and explicit policies. Use non-public original workbook storage in production. Safe upload limits/type checking, no spreadsheet formula evaluation. Export CSV neutralizes leading =,+,-,@ user strings. Audit staff/organization/action/object and timestamp without credentials. Backups, retention, restore tests, TLS, connection pooling and migration rollback/recovery must be documented before production. Down migrations must never silently discard historical records.

## Implemented schema and permissions

Twelve forward-only migrations currently create identities/sessions, organizations/memberships/farms/audit, imports/ingredients/reviewed requirements/formula versions/optimization runs, forecasts, production units and append-only daily records. They also add scientific context and inclusion limits, guarded team functions, organization settings and the restricted `farm_server` login. `farm_server` has NOINHERIT/NOSUPERUSER/NOBYPASSRLS and identity/session grants only; operational access requires `SET LOCAL ROLE farm_app`. Local migration/test-administration credentials are read only by setup/test helpers. Rollbacks for destructive historical tables are intentionally not automated; take and verify backups before schema changes.

```mermaid
erDiagram
    USERS ||--o{ SESSIONS : authenticates
    USERS ||--o{ MEMBERSHIPS : joins
    ORGANIZATIONS ||--o{ MEMBERSHIPS : scopes
    ORGANIZATIONS ||--o{ FARMS : owns
    FARMS ||--o{ PRODUCTION_UNITS : contains
    PRODUCTION_UNITS ||--o{ DAILY_RECORDS : records
    ORGANIZATIONS ||--o{ INGREDIENTS : reviews
    ORGANIZATIONS ||--o{ REQUIREMENT_PROFILES : specifies
    REQUIREMENT_PROFILES ||--o{ FORMULA_VERSIONS : constrains
    ORGANIZATIONS ||--o{ OPTIMIZATION_RUNS : preserves
    ORGANIZATIONS ||--o{ IMPORTS : audits
    ORGANIZATIONS ||--o{ FORECASTS : plans
    ORGANIZATIONS ||--o{ AUDIT_LOGS : traces
```

Formula/forecast/import snapshots intentionally retain original input JSON alongside the relational tenant/identity graph; the expanded normalized nutrient and operational ledger entities above are still planned, not all implemented. Production record writes serialize per unit with a transaction advisory lock, reject mortality above current stock, require chronological unique dates and reject incomplete sampling pairs. Composite tenant-parent keys prevent cross-organization unit assignments. Operations and forecasts are not yet an integrated stock or financial ledger.


Migration 009 adds `import_reference_rows` with tenant/import composite ownership, immutable source fields/issues, hash/sheet/row/context uniqueness, and reader/editor RLS. `ingredients.parent_id` uses a composite tenant foreign key; revision sequencing is checked on insert and each parent can have only one successor. Runtime UPDATE access to ingredients is revoked, including for nutritionists. Review and price changes append new records, preserving recipe snapshots and their original IDs. These source candidates are separate from approved requirement profiles and are never applied automatically.


Migration 010 adds `formulation_drafts`, unique by `(organization_id, actor_id)`. RLS scopes reads/writes to the current actor with a current feed-editor membership; other administrators do not inherit access to private content. Column-level update grants prevent changing ownership, and a trigger checks revision increments. The API uses compare-and-swap updates and verifies every nonempty ingredient/profile/recipe reference against the organization. Save requests bind the browser's loaded actor identity to the authenticated session. Draft content has an explicit model version, omits approval status/results, and can represent incomplete editing states. It is never a released recipe or a financial/stock event. Saves record audit metadata without the private draft payload.


Migration 011 adds `workbook_uploads` with organization-scoped RLS, original bytea/hash, bounded inspection JSON, mapping/preview JSON, revision and confirmation state. Originals are shared only within their organization; the private formulation draft policy is unchanged. Only feed editors can upload/map/confirm. Column-level grants keep original bytes/hash/filename immutable, and a transition trigger locks confirmed jobs. Confirmations use a row lock and a unique `(upload_id,upload_row)` ingredient index; a composite tenant foreign key prevents attaching ingredient provenance to another organization's upload. Stored binaries require backup/storage planning; managed object storage can replace bytea behind the same authorized download contract later.


Migration 012 adds `requirement_profiles.parent_id/revision/ingredient_rules`. Parent IDs use a composite tenant foreign key; each version has at most one successor. All rule JSON is stored in the immutable parent row, preventing later child-rule insertion from changing historical semantics. Before-insert validation checks the current assigned nutritionist/reviewer, exact same-tenant approved ingredient UUIDs under RLS, compatible scientific context, distinct references, explicit bounds/evidence and simple inclusion feasibility. Runtime UPDATE/DELETE is not granted. API revision creation serializes by parent advisory lock; the unique successor index also protects direct concurrent inserts. No new tenant table or broader runtime grants are introduced. Rule UUIDs are validated by trigger rather than JSON foreign keys; runtime ingredient deletion/update remains unavailable. New recipe and optimization snapshots retain the exact profile/rules used.


Saved-recipe report/compare endpoints read `formula_versions` and immutable `requirement_profiles` in current-member RLS transactions. Comparisons fetch all requested IDs in one scoped query and reject any missing version before producing a response. Embedded historical profiles take precedence; older versions may resolve their immutable composite-tenant profile reference. Ingredient evidence comes exclusively from `ingredient_snapshot`, never the current ingredient table. New saved result JSON adds `savedBy` from the authenticated session; no migration or wider grants are introduced. Exports and comparisons are read-only and do not create financial, stock or manufacturing events.


Optimizer history uses the existing append-only `optimization_runs` RLS table. List queries project summary fields for the latest 100 records; detail queries scope both organization and UUID. Runtime UPDATE/DELETE remains unavailable. New request model 3 stores the same input/reference snapshots with richer result evidence and diagnostic model version 1. Before offering restoration, the API validates scenario structure and all ingredient/profile/cloned-recipe IDs against current same-organization visibility. Restored content is draft-only and follows the existing private CAS autosave path. Legacy raw records are available without rewriting or inventing missing evidence. No new migration or database grant is required.
