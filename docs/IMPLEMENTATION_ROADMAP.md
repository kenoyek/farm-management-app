# Implementation roadmap

Each phase requires lint, strict types, production build, domain tests, database/RLS integration checks and relevant browser workflows. This is a delivery sequence, not a declaration that all features exist.

| Phase | Deliverable | Exit gate |
|---|---|---|
|0|Requirements, audited seven sheets, formula model, DB/security design, scientific gates|Every source nonempty cell and cached formula inventoried, anomalies identified|
|1|Identity, organization membership, farm setup, persistent real-data dashboard, audit, design system|Registration→organization→farm→reload; invalid input and cross-tenant requests denied|
|2|Ingredient/reference import preview, formula editor, nutrient and cost engine, save/scale recipes|Missing-aware source fixture tests, persistent versioned draft, no unsafe approval|
|3|HiGHS least-cost solver, comparisons, approval/versioning, mixing reports|Known optimal, bounded, infeasible and unavailable-data tests; no constraint relaxation|
|4|Layer flocks, feed/egg forecast versions, daily collection, egg inventory|24-week and 18-period baselines plus calendar/actual reconciliations|
|5|Broiler batches, samples, FCR, health, harvest economics|Whole production cycle including partial sales and mortality|
|6|Catfish ponds, stocking, sampling, feeding, water quality, harvest|Biomass/SGR, paired transfers and source-specific alert thresholds|
|7|Integrated inventory/procurement/sales/journal/tasks|Concurrent idempotent postings, no double-counted financial/inventory events|
|8|Scenario comparison, exports, cross-farm analytics|Reproducible versioned forecasts, authorization on reports, export parity|
|9|Entitlements, admin, monitoring, deployment|Security/load/backup review, production acceptance; payments only on authorization|

Prioritize the formulation studio after foundation. Do not add decorative placeholder modules and label them complete. Track implementation evidence and remaining work in PHASE_STATUS.md. External nutrition approval, deployment credentials and commercial payment authorization are distinct prerequisites; continue all independent local development.
