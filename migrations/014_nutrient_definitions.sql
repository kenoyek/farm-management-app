-- Validate new versions without rewriting any historical JSON or inventing
-- values for expanded nutrients. Existing tenant RLS and grants are unchanged.
CREATE FUNCTION valid_feed_nutrients(doc jsonb, ranges boolean) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE nutrient text; value jsonb; bound text; number_value numeric;
BEGIN
 IF jsonb_typeof(doc) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOR nutrient,value IN SELECT * FROM jsonb_each(doc) LOOP
  IF NOT nutrient=ANY(ARRAY['energy','protein','dryMatter','calcium','phosphorus','methionine','lysine','crudeFat','crudeFibre','moisture','ash']) THEN RETURN false; END IF;
  IF ranges THEN
   IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
   IF NOT (value ? 'min' OR value ? 'max') OR EXISTS(SELECT 1 FROM jsonb_object_keys(value) k WHERE k NOT IN ('min','max')) THEN RETURN false; END IF;
   FOREACH bound IN ARRAY ARRAY['min','max'] LOOP
    IF value ? bound THEN
     IF jsonb_typeof(value->bound) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
     number_value := (value->>bound)::numeric;
     IF number_value<0 OR (nutrient<>'energy' AND number_value>100) THEN RETURN false; END IF;
    END IF;
   END LOOP;
   IF value ? 'min' AND value ? 'max' AND (value->>'min')::numeric>(value->>'max')::numeric THEN RETURN false; END IF;
  ELSIF value<>'null'::jsonb THEN
   IF jsonb_typeof(value) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
   number_value := value::text::numeric;
   IF number_value<0 OR (nutrient<>'energy' AND number_value>100) THEN RETURN false; END IF;
  END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE FUNCTION validate_feed_nutrient_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='ingredients' THEN
  IF NOT valid_feed_nutrients(NEW.nutrients,false) OR (NEW.basis='dry-matter' AND coalesce(NEW.nutrients->'moisture','null'::jsonb)<>'null'::jsonb) THEN
   RAISE EXCEPTION 'Invalid nutrient concentrations or moisture basis' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NOT valid_feed_nutrients(NEW.limits,true) OR (NEW.limits ? 'moisture' AND NEW.basis<>'as-fed') THEN
   RAISE EXCEPTION 'Invalid nutrient limits or moisture basis' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ingredient_nutrient_data BEFORE INSERT ON ingredients FOR EACH ROW EXECUTE FUNCTION validate_feed_nutrient_insert();
CREATE TRIGGER profile_nutrient_data BEFORE INSERT ON requirement_profiles FOR EACH ROW EXECUTE FUNCTION validate_feed_nutrient_insert();
