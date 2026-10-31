-- Bind source validation to the application schema even under caller-controlled schemas.
ALTER FUNCTION broiler_cost_snapshot(uuid,uuid) SET search_path=public,pg_temp;
ALTER FUNCTION validate_broiler_cost_review() SET search_path=public,pg_temp;
