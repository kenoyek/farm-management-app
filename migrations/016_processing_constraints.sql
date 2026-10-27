-- Recorded processing is evidence on an immutable reference, not inferred from
-- notes or a claim that a manufacturing treatment has actually been performed.
ALTER TABLE ingredients ADD COLUMN processing_method text;
ALTER TABLE ingredients ADD COLUMN processing_evidence text;
ALTER TABLE ingredients ADD CONSTRAINT processing_reference_evidence CHECK(
 (processing_method IS NULL AND processing_evidence IS NULL) OR
 (processing_method IS NOT NULL AND processing_evidence IS NOT NULL
  AND processing_method ~ '^[a-z][a-z0-9-]{0,49}$' AND length(btrim(processing_evidence)) BETWEEN 10 AND 2000)
);
ALTER TABLE requirement_profiles ADD COLUMN processing_rules jsonb NOT NULL DEFAULT '[]';
CREATE FUNCTION validate_processing_profile() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rule jsonb; reference jsonb; ref_id uuid; ingredient ingredients%ROWTYPE; names text[] := '{}'; ids uuid[]; method text;
BEGIN
 IF jsonb_typeof(NEW.processing_rules) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid processing rules' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(NEW.processing_rules)>20 THEN RAISE EXCEPTION 'Too many processing groups' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(NEW.processing_rules)>0 AND jsonb_array_length(NEW.ingredient_rules)=0 THEN
  RAISE EXCEPTION 'Processing groups require a closed allowed list' USING ERRCODE='23514';
 END IF;
 FOR rule IN SELECT * FROM jsonb_array_elements(NEW.processing_rules) LOOP
  IF jsonb_typeof(rule) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid processing group' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(rule))<>6
     OR jsonb_typeof(rule->'name') IS DISTINCT FROM 'string' OR length(btrim(rule->>'name')) NOT BETWEEN 2 AND 100
     OR jsonb_typeof(rule->'source') IS DISTINCT FROM 'string' OR length(btrim(rule->>'source')) NOT BETWEEN 10 AND 2000
     OR jsonb_typeof(rule->'minPercent') IS DISTINCT FROM 'number' OR jsonb_typeof(rule->'maxPercent') IS DISTINCT FROM 'number'
     OR jsonb_typeof(rule->'ingredientIds') IS DISTINCT FROM 'array'
     OR NOT(rule ? 'requiredMethod') THEN RAISE EXCEPTION 'Processing group requires explicit bounds and evidence' USING ERRCODE='23514'; END IF;
  IF (rule->>'minPercent')::numeric<0 OR (rule->>'maxPercent')::numeric>100 OR (rule->>'minPercent')::numeric>(rule->>'maxPercent')::numeric
     OR rule->>'name'=ANY(names) OR jsonb_array_length(rule->'ingredientIds') NOT BETWEEN 1 AND 100 THEN
   RAISE EXCEPTION 'Invalid processing group limits, name or references' USING ERRCODE='23514';
  END IF;
  names := array_append(names,rule->>'name'); ids := '{}'; method := rule->>'requiredMethod';
  IF rule->'requiredMethod'<>'null'::jsonb AND (jsonb_typeof(rule->'requiredMethod')<>'string' OR method !~ '^[a-z][a-z0-9-]{0,49}$') THEN
   RAISE EXCEPTION 'Invalid processing method identifier' USING ERRCODE='23514';
  END IF;
  FOR reference IN SELECT * FROM jsonb_array_elements(rule->'ingredientIds') LOOP
   IF jsonb_typeof(reference) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Exact reference UUID required' USING ERRCODE='23514'; END IF;
   BEGIN ref_id := (reference#>>'{}')::uuid;
   EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Invalid reference UUID' USING ERRCODE='23514'; END;
   IF ref_id=ANY(ids) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.ingredient_rules) r WHERE r->>'ingredientId'=ref_id::text) THEN
    RAISE EXCEPTION 'Every group member must be distinct and on the allowed list' USING ERRCODE='23514';
   END IF;
   ids := array_append(ids,ref_id);
   SELECT * INTO ingredient FROM ingredients WHERE organization_id=NEW.organization_id AND id=ref_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'Ingredient reference not found' USING ERRCODE='23503'; END IF;
   IF ingredient.review_status<>'approved' OR ingredient.species<>NEW.species OR NOT NEW.stage=ANY(ingredient.stages)
      OR ingredient.basis IS DISTINCT FROM NEW.basis OR ingredient.energy_system IS DISTINCT FROM NEW.energy_system OR ingredient.phosphorus_basis<>NEW.phosphorus_basis THEN
    RAISE EXCEPTION 'Processing groups require compatible approved references' USING ERRCODE='23514';
   END IF;
   IF method IS NOT NULL AND (ingredient.processing_method IS DISTINCT FROM method OR ingredient.processing_evidence IS NULL OR length(btrim(ingredient.processing_evidence))<10) THEN
    RAISE EXCEPTION 'Processing method and reference evidence must match' USING ERRCODE='23514';
   END IF;
  END LOOP;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER processing_profile BEFORE INSERT ON requirement_profiles FOR EACH ROW EXECUTE FUNCTION validate_processing_profile();
