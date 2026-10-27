-- Provenance changes append ingredient versions through the existing RLS path.
ALTER TABLE ingredients ADD COLUMN category text CHECK(category IS NULL OR length(btrim(category)) BETWEEN 1 AND 100);
ALTER TABLE ingredients ADD COLUMN supplier text CHECK(supplier IS NULL OR length(btrim(supplier)) BETWEEN 1 AND 200);
ALTER TABLE ingredients ADD COLUMN laboratory_on date;
ALTER TABLE ingredients ADD COLUMN certificate_reference text CHECK(certificate_reference IS NULL OR length(btrim(certificate_reference)) BETWEEN 1 AND 500);
ALTER TABLE ingredients ADD COLUMN processing_notes text CHECK(processing_notes IS NULL OR length(btrim(processing_notes)) BETWEEN 1 AND 2000);
CREATE FUNCTION validate_reference_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.laboratory_on>current_date THEN RAISE EXCEPTION 'Laboratory date cannot be in the future' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reference_date BEFORE INSERT ON ingredients FOR EACH ROW EXECUTE FUNCTION validate_reference_date();

-- An import is an immutable draft recipe, not an approval or a stock event.
ALTER TABLE formula_versions ADD COLUMN source_recipe jsonb;
CREATE UNIQUE INDEX source_recipe_once ON formula_versions(organization_id,(source_recipe->>'previewDigest')) WHERE source_recipe IS NOT NULL;
CREATE FUNCTION validate_source_recipe() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE item jsonb; source import_reference_rows%ROWTYPE; review catalog_alias_reviews%ROWTYPE; ids uuid[] := '{}'; targets uuid[] := '{}'; source_id uuid;
 expected_lines jsonb := '[]'; percent numeric; total numeric := 0;
BEGIN
 IF NEW.source_recipe IS NULL THEN RETURN NEW; END IF;
 IF NEW.status<>'draft' OR NEW.profile_id IS NOT NULL OR NEW.result->>'releaseEligible' IS DISTINCT FROM 'false'
    OR NEW.source_recipe->>'modelVersion' IS DISTINCT FROM '1'
    OR coalesce(NEW.source_recipe->>'previewDigest','') !~ '^[a-f0-9]{64}$'
    OR NEW.source_recipe->>'omittedUnspecifiedConfirmed' IS DISTINCT FROM 'true'
    OR NEW.source_recipe->>'sheet' NOT IN ('Broiler Starter','Broiler Finisher')
    OR jsonb_typeof(NEW.source_recipe->'rows') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Source imports must preserve draft provenance and explicit omissions' USING ERRCODE='23514';
 END IF;
 IF jsonb_array_length(NEW.source_recipe->'rows')<>34 THEN RAISE EXCEPTION 'Incomplete source evidence' USING ERRCODE='23514'; END IF;
 FOR source_id IN SELECT (value->>'id')::uuid FROM jsonb_array_elements(NEW.source_recipe->'rows') ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtext('catalog-alias:'||source_id::text));
 END LOOP;
 FOR item IN SELECT * FROM jsonb_array_elements(NEW.source_recipe->'rows') LOOP
  source_id := (item->>'id')::uuid;
  IF source_id IS NULL OR source_id=ANY(ids) THEN RAISE EXCEPTION 'Duplicate or missing source evidence' USING ERRCODE='23514'; END IF;
  ids := array_append(ids,source_id);
  SELECT * INTO source FROM import_reference_rows WHERE organization_id=NEW.organization_id AND id=source_id;
  IF NOT FOUND OR source.category<>'recipe' OR source.sheet IS DISTINCT FROM NEW.source_recipe->>'sheet' OR source.source_hash IS DISTINCT FROM NEW.source_recipe->>'sourceHash' THEN
   RAISE EXCEPTION 'Source evidence must belong to this organization and workbook' USING ERRCODE='23503';
  END IF;
  IF source.fields IS DISTINCT FROM item->'fields' OR source.issues IS DISTINCT FROM item->'issues' OR source.label IS DISTINCT FROM item->>'label'
     OR source.source_row IS DISTINCT FROM (item->>'source_row')::integer OR source.context IS DISTINCT FROM item->>'context' THEN
   RAISE EXCEPTION 'Original source evidence cannot be rewritten' USING ERRCODE='23514';
  END IF;
  IF item->'alias_review' IS NOT NULL AND item->'alias_review'<>'null'::jsonb THEN
   SELECT * INTO review FROM catalog_alias_reviews WHERE organization_id=NEW.organization_id AND id=(item->'alias_review'->>'id')::uuid AND source_row_id=source_id;
   IF NOT FOUND OR to_jsonb(review) IS DISTINCT FROM item->'alias_review' THEN
    RAISE EXCEPTION 'Alias review evidence must match the original decision' USING ERRCODE='23503';
   END IF;
  END IF;
  IF source.fields->'inclusion'->'parsed'->>'kind'='scalar' THEN
   percent := (source.fields->'inclusion'->'parsed'->>'value')::numeric;
   IF percent IS NULL OR percent<0 OR percent>100 THEN RAISE EXCEPTION 'Invalid source percentage' USING ERRCODE='23514'; END IF;
   total := total+percent;
   IF percent>0 THEN
    SELECT * INTO review FROM catalog_alias_reviews WHERE organization_id=NEW.organization_id AND source_row_id=source_id ORDER BY revision DESC LIMIT 1;
    IF NOT FOUND OR review.decision<>'mapped' OR review.id::text IS DISTINCT FROM item->'alias_review'->>'id' OR review.ingredient_id=ANY(targets) THEN
     RAISE EXCEPTION 'Every populated row needs a distinct current mapping' USING ERRCODE='23514';
    END IF;
    targets := array_append(targets,review.ingredient_id);
    expected_lines := expected_lines||jsonb_build_array(jsonb_build_object('ingredientId',review.ingredient_id,'percent',percent));
   END IF;
  ELSIF source.fields->'inclusion'->'parsed'->>'kind' IS DISTINCT FROM 'missing' THEN
   RAISE EXCEPTION 'Source inclusion needs interpretation' USING ERRCODE='23514';
  END IF;
 END LOOP;
 IF cardinality(targets)=0 OR abs(total-100)>0.000001 OR NEW.lines IS DISTINCT FROM expected_lines THEN
  RAISE EXCEPTION 'Source allocations cannot be changed, merged or normalized' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_recipe_evidence BEFORE INSERT ON formula_versions FOR EACH ROW EXECUTE FUNCTION validate_source_recipe();
