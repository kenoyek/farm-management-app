# Scientific data validation

All workbook nutritional data starts UNVERIFIED. Workbook provenance alone does not establish scientific authority. Preserve original cells and never guess corrections. Numeric plausibility checks are issue detectors, not scientific validation.

## Required review
A qualified nutritionist must approve species, strain/stage, nutrient system (ME vs DE, total vs available/digestible phosphorus and amino acids), as-fed vs dry-matter basis, units, ingredient processing restrictions, anti-nutritional factors, laboratory dates, inclusion bounds and profile references. Fish generic rows do not define African catfish requirements. Zero price may be a missing quotation, not free material; positive historical prices are still stale. Mineral/premix blank nutrients cannot be assumed zero. Source concentrate product specifications and label rates must match the actual purchased product.

Quarantine Dietary Needs I30=47/I36=22, Intake G12=10/H24=28.8/I24=63 and all alias mismatches. Do not “correct” them by moving decimal places. Defatted soybean methionine is absent: manual recipe methionine totals from the workbook are incomplete even when numeric cached results exist. Dry matter zero is a workbook formula omission, not a biological observation.

## Source hierarchy and traceability
Prefer product laboratory certificates and official strain feeding guides (current Ross/Cobb broiler and Hy-Line/ISA layer guides), then authoritative references such as NRC Nutrient Requirements of Poultry, NRC Nutrient Requirements of Fish and Shrimp, FAO aquaculture guidance and validated ingredient composition databases (e.g. Feedipedia). These are candidate references, not sources already independently verified in this task. Record publication/version/page, species, unit/basis, analyzer date, reviewer identity and approval date. Do not copy generic requirements into approved profiles without review.

## Workflow
Upload original → immutable hash → staged extraction → structural/unit/price/alias issues → preview → confirmed import as unverified → source/lab reconciliation → nutritionist-reviewed ingredient and requirement versions → solver eligibility → formula review → immutable approval → batch mixing. Changes to prices/ingredients create new scenario/formula versions. Manufacturing release requires all required data complete/current and approved, 100% inclusion, safe bounds and nutrient compliance; a solver optimum alone is insufficient.

Forecast mortality, rations, laying rates, fish feeding/water-quality thresholds and growth assumptions must be explicit and editable. Forecasts are estimates, never veterinary diagnoses. Flag representative sampling limits and water/temperature effects. Keep operational observations separate; preserve historical model/input versions.

Implemented review gates additionally require declared species/stages, phosphorus basis and price quotations within 90 days. The 90-day window is a first-release freshness policy, not scientific evidence that a price is current. Stored ingredient inclusion bounds cannot be relaxed by scenario overrides. Available-kg bounds may further restrict an optimization; blank availability explicitly means an unconstrained planning scenario. There is no manufacturing release or physical-stock reservation workflow yet. Poultry requirements and ingredients must match species, stage, energy, nutrient and phosphorus bases. Dedicated catfish digestible nutrient definitions are not implemented, so catfish formulation is rejected rather than borrowing poultry standards.
