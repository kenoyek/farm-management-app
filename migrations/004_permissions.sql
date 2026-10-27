DROP POLICY operation_insert ON production_units;
CREATE POLICY unit_insert ON production_units FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','manager'));
DROP POLICY feed_insert ON requirement_profiles;
CREATE POLICY profile_insert ON requirement_profiles FOR INSERT TO farm_app WITH CHECK(member_role(organization_id)='nutritionist' AND reviewer_id=current_actor());
DROP POLICY feed_insert ON formula_versions;
CREATE POLICY recipe_insert ON formula_versions FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','nutritionist') AND (status<>'approved' OR (member_role(organization_id)='nutritionist' AND (result->>'releaseEligible')::boolean IS TRUE AND profile_id IS NOT NULL)));
