-- Rules live in the immutable profile row, so additional rules cannot be
-- appended after a recipe has used that version. Exact ingredient UUIDs are
-- checked under tenant RLS on insert; source and approved rows are immutable.
ALTER TABLE requirement_profiles ADD COLUMN parent_id uuid;
ALTER TABLE requirement_profiles ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE requirement_profiles ADD COLUMN ingredient_rules jsonb NOT NULL DEFAULT '[]';
ALTER TABLE requirement_profiles ADD CONSTRAINT profile_parent_tenant FOREIGN KEY(organization_id,parent_id) REFERENCES requirement_profiles(organization_id,id);
CREATE UNIQUE INDEX profile_one_successor ON requirement_profiles(parent_id) WHERE parent_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_profile_version() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE previous_revision integer; rule jsonb; ingredient ingredients%ROWTYPE;
        seen uuid[] := '{}'; ingredient_id uuid; lower_bound numeric; upper_bound numeric;
        minimum_total numeric := 0; maximum_total numeric := 0;
BEGIN
 IF member_role(NEW.organization_id) IS DISTINCT FROM 'nutritionist' OR NEW.reviewer_id IS DISTINCT FROM current_actor() THEN
  RAISE EXCEPTION 'Nutritionist review required' USING ERRCODE='42501';
 END IF;
 IF NEW.parent_id IS NULL THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'Invalid initial profile revision' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT revision INTO previous_revision FROM requirement_profiles WHERE id=NEW.parent_id AND organization_id=NEW.organization_id;
  IF previous_revision IS NULL THEN RAISE EXCEPTION 'Profile reference not found' USING ERRCODE='23503'; END IF;
  IF NEW.revision<>previous_revision+1 THEN RAISE EXCEPTION 'Invalid profile revision' USING ERRCODE='23514'; END IF;
 END IF;
 IF jsonb_typeof(NEW.ingredient_rules) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid ingredient rules' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(NEW.ingredient_rules)>100 THEN RAISE EXCEPTION 'Too many ingredient rules' USING ERRCODE='23514'; END IF;
 FOR rule IN SELECT * FROM jsonb_array_elements(NEW.ingredient_rules) LOOP
  IF jsonb_typeof(rule) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid rule' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(rule))<>4
     OR jsonb_typeof(rule->'ingredientId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(rule->'min') IS DISTINCT FROM 'number'
     OR jsonb_typeof(rule->'max') IS DISTINCT FROM 'number'
     OR jsonb_typeof(rule->'source') IS DISTINCT FROM 'string'
     OR length(trim(rule->>'source')) NOT BETWEEN 10 AND 2000 THEN
   RAISE EXCEPTION 'Rule requires exact reference, explicit bounds and review evidence' USING ERRCODE='23514';
  END IF;
  BEGIN ingredient_id := (rule->>'ingredientId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Invalid ingredient UUID' USING ERRCODE='23514'; END;
  lower_bound := (rule->>'min')::numeric; upper_bound := (rule->>'max')::numeric;
  IF lower_bound<0 OR upper_bound>100 OR lower_bound>upper_bound OR ingredient_id=ANY(seen) THEN
   RAISE EXCEPTION 'Invalid or duplicate ingredient limits' USING ERRCODE='23514';
  END IF;
  seen := array_append(seen,ingredient_id);
  SELECT * INTO ingredient FROM ingredients WHERE id=ingredient_id AND organization_id=NEW.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingredient reference not found' USING ERRCODE='23503'; END IF;
  IF ingredient.review_status<>'approved' OR ingredient.species<>NEW.species
     OR NOT NEW.stage=ANY(ingredient.stages) OR ingredient.basis IS DISTINCT FROM NEW.basis
     OR ingredient.energy_system IS DISTINCT FROM NEW.energy_system
     OR ingredient.phosphorus_basis<>NEW.phosphorus_basis THEN
   RAISE EXCEPTION 'Rules require approved, stage and basis compatible references' USING ERRCODE='23514';
  END IF;
  lower_bound := greatest(lower_bound,ingredient.inclusion_min);
  upper_bound := least(upper_bound,ingredient.inclusion_max);
  IF lower_bound>upper_bound THEN RAISE EXCEPTION 'Rule conflicts with ingredient limits' USING ERRCODE='23514'; END IF;
  minimum_total := minimum_total+lower_bound; maximum_total := maximum_total+upper_bound;
 END LOOP;
 IF cardinality(seen)>0 AND (minimum_total>100.0000001 OR maximum_total<99.9999999) THEN
  RAISE EXCEPTION 'Reviewed ingredient bounds cannot total 100 percent' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profile_version BEFORE INSERT ON requirement_profiles FOR EACH ROW EXECUTE FUNCTION validate_profile_version();
-- No runtime UPDATE/DELETE grants exist on requirement_profiles.
