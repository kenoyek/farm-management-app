-- Planning versions do not write actual stock, production, forecasts in other modules or finance.
CREATE TABLE broiler_plans (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,unit_id uuid NOT NULL,
 previous_id uuid,revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 100),
 model_version text NOT NULL DEFAULT 'broiler-daily-linear-targets-v1' CHECK(model_version='broiler-daily-linear-targets-v1'),
 input jsonb NOT NULL CHECK(octet_length(input::text)<=100000),unit_snapshot jsonb NOT NULL DEFAULT '{}',recipe_snapshots jsonb NOT NULL DEFAULT '[]',
 timezone text NOT NULL DEFAULT '',created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,unit_id,id),UNIQUE(unit_id,revision),
 FOREIGN KEY(organization_id,unit_id) REFERENCES production_units(organization_id,id),
 FOREIGN KEY(organization_id,unit_id,previous_id) REFERENCES broiler_plans(organization_id,unit_id,id),CHECK(previous_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX broiler_plan_root ON broiler_plans(unit_id) WHERE previous_id IS NULL;
CREATE UNIQUE INDEX broiler_plan_successor ON broiler_plans(previous_id) WHERE previous_id IS NOT NULL;
CREATE INDEX ON broiler_plans(organization_id,unit_id,revision);
ALTER TABLE broiler_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON broiler_plans FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY reviewed_insert ON broiler_plans FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','manager') AND created_by=current_actor() AND created_at=now());
GRANT SELECT,INSERT ON broiler_plans TO farm_app;
CREATE FUNCTION broiler_plan_decimal(v jsonb,maximum numeric,places integer,allow_zero boolean,nullable boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE t text;
BEGIN
 IF v IS NULL THEN RETURN false; END IF;
 IF v='null'::jsonb THEN RETURN nullable; END IF;
 IF jsonb_typeof(v)<>'string' THEN RETURN false; END IF;
 t:=v#>>'{}';
 IF t!~('^(0|[1-9][0-9]{0,8})(\.[0-9]{1,'||places||'})?$') THEN RETURN false; END IF;
 RETURN t::numeric<=maximum AND (allow_zero OR t::numeric>0);
END $$;
CREATE FUNCTION broiler_plan_integer(v jsonb,minimum integer,maximum integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF v IS NULL OR jsonb_typeof(v)<>'number' OR (v#>>'{}')!~'^[0-9]{1,8}$' THEN RETURN false; END IF;
 RETURN (v#>>'{}')::integer BETWEEN minimum AND maximum;
END $$;
CREATE FUNCTION broiler_plan_text(v jsonb,minimum integer,maximum integer,nullable boolean) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce((nullable AND v='null'::jsonb) OR (jsonb_typeof(v)='string' AND length(btrim(v#>>'{}')) BETWEEN minimum AND maximum),false);
$$;
CREATE FUNCTION validate_broiler_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u production_units; p broiler_plans; d jsonb:=NEW.input; s jsonb; t jsonb; f record; start_age integer; finish_age integer; next_age integer; prior integer; refs jsonb:='[]'; rid uuid; key text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
 SELECT * INTO u FROM production_units WHERE id=NEW.unit_id AND organization_id=NEW.organization_id;
 IF u.id IS NULL OR u.kind<>'broilers' THEN RAISE EXCEPTION 'Choose a visible broiler batch' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM broiler_plans WHERE unit_id=u.id ORDER BY revision DESC LIMIT 1;
 IF NEW.previous_id IS DISTINCT FROM p.id THEN RAISE EXCEPTION 'Stale planning version' USING ERRCODE='23505'; END IF;
 NEW.revision:=coalesce(p.revision,0)+1;
 IF NEW.revision>100 THEN RAISE EXCEPTION 'Plan revision limit reached' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(d)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(d))<>17 OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE k<>ALL(ARRAY['name','house','strain','supplier','hatchDate','startingAgeDays','harvestAgeDays','chickCostPerBird','currency','targetMarketWeightG','saleBasis','salePrice','sourceTitle','sourceReference','notes','stages','targets'])) THEN RAISE EXCEPTION 'Invalid plan structure' USING ERRCODE='23514'; END IF;
 IF NOT broiler_plan_text(d->'name',2,100,false) OR NOT broiler_plan_text(d->'house',2,200,true) OR NOT broiler_plan_text(d->'strain',2,200,true) OR NOT broiler_plan_text(d->'supplier',2,200,true) OR NOT broiler_plan_text(d->'sourceTitle',3,300,false) OR NOT broiler_plan_text(d->'sourceReference',3,2000,false) OR NOT broiler_plan_text(d->'notes',0,2000,false) OR jsonb_typeof(d->'currency')<>'string' OR (d->>'currency')!~'^[A-Z]{3}$' THEN RAISE EXCEPTION 'Invalid plan metadata' USING ERRCODE='23514'; END IF;
 IF NOT broiler_plan_integer(d->'startingAgeDays',0,3650) OR NOT broiler_plan_integer(d->'harvestAgeDays',1,4015) THEN RAISE EXCEPTION 'Invalid plan ages' USING ERRCODE='23514'; END IF;
 start_age:=(d->>'startingAgeDays')::integer;finish_age:=(d->>'harvestAgeDays')::integer;
 IF finish_age-start_age NOT BETWEEN 1 AND 365 THEN RAISE EXCEPTION 'Invalid plan duration' USING ERRCODE='23514'; END IF;
 IF d->'hatchDate'<>'null'::jsonb THEN
  IF jsonb_typeof(d->'hatchDate')<>'string' OR (d->>'hatchDate')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR u.stocked_on-(d->>'hatchDate')::date<>start_age THEN RAISE EXCEPTION 'Hatch date and placement age mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF NOT broiler_plan_decimal(d->'chickCostPerBird',100000000,4,true,true) OR NOT broiler_plan_decimal(d->'targetMarketWeightG',1000000,6,false,true) OR NOT broiler_plan_decimal(d->'salePrice',100000000,4,true,true) OR (d->>'saleBasis') NOT IN ('unpriced','bird','kg') OR ((d->>'saleBasis')='unpriced') IS DISTINCT FROM (d->'salePrice'='null'::jsonb) THEN RAISE EXCEPTION 'Invalid planning price assumptions' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(d->'stages')<>'array' OR jsonb_array_length(d->'stages') NOT BETWEEN 1 AND 24 OR jsonb_typeof(d->'targets')<>'array' OR jsonb_array_length(d->'targets') NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'Invalid schedule sizes' USING ERRCODE='23514'; END IF;
 next_age:=start_age;
 FOR s IN SELECT value FROM jsonb_array_elements(d->'stages') LOOP
  IF jsonb_typeof(s)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(s))<>10 OR NOT (s ?& ARRAY['stage','startAge','endAge','rationG','mortalityDaily','pricePerKg','recipeId','tempMinC','tempMaxC','evidence']) OR jsonb_typeof(s->'stage')<>'string' OR (s->>'stage') NOT IN ('pre-starter','starter','grower','finisher') OR NOT broiler_plan_integer(s->'startAge',0,4014) OR NOT broiler_plan_integer(s->'endAge',0,4014) OR NOT broiler_plan_decimal(s->'rationG',1000,6,true,true) OR NOT broiler_plan_decimal(s->'mortalityDaily',1,8,true,true) OR NOT broiler_plan_decimal(s->'pricePerKg',100000000,4,true,true) OR NOT broiler_plan_decimal(s->'tempMinC',60,6,true,true) OR NOT broiler_plan_decimal(s->'tempMaxC',60,6,true,true) OR NOT broiler_plan_text(s->'evidence',3,1000,false) THEN RAISE EXCEPTION 'Invalid stage assumptions' USING ERRCODE='23514'; END IF;
  IF (s->>'startAge')::integer<>next_age OR (s->>'endAge')::integer<next_age THEN RAISE EXCEPTION 'Stages must be contiguous' USING ERRCODE='23514'; END IF;
  next_age:=(s->>'endAge')::integer+1;
  IF (s->'tempMinC'='null'::jsonb) IS DISTINCT FROM (s->'tempMaxC'='null'::jsonb) OR (s->>'tempMinC')::numeric>(s->>'tempMaxC')::numeric THEN RAISE EXCEPTION 'Invalid guide temperature bounds' USING ERRCODE='23514'; END IF;
  IF s->'recipeId'<>'null'::jsonb THEN
   IF jsonb_typeof(s->'recipeId')<>'string' THEN RAISE EXCEPTION 'Invalid recipe version' USING ERRCODE='23514'; END IF;
   rid:=(s->>'recipeId')::uuid;
   SELECT v.id,v.name,v.status,v.batch_kg::text,v.profile_id,r.species,r.stage INTO f FROM formula_versions v LEFT JOIN requirement_profiles r ON r.id=v.profile_id AND r.organization_id=v.organization_id WHERE v.id=rid AND v.organization_id=NEW.organization_id;
   IF f.id IS NULL OR f.status='rejected' OR f.species='catfish' THEN RAISE EXCEPTION 'Recipe reference is unavailable for poultry planning' USING ERRCODE='23514'; END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(refs) x WHERE x->>'id'=rid::text) THEN refs:=refs||jsonb_build_array(to_jsonb(f)); END IF;
  END IF;
 END LOOP;
 IF next_age<>finish_age THEN RAISE EXCEPTION 'Stages must end before harvest age' USING ERRCODE='23514'; END IF;
 prior:=start_age;
 FOR t IN SELECT value FROM jsonb_array_elements(d->'targets') LOOP
  IF jsonb_typeof(t)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(t))<>3 OR NOT(t ?& ARRAY['ageDays','weightG','evidence']) OR NOT broiler_plan_integer(t->'ageDays',1,4015) OR NOT broiler_plan_decimal(t->'weightG',1000000,6,false,false) OR NOT broiler_plan_text(t->'evidence',3,1000,false) THEN RAISE EXCEPTION 'Invalid source growth point' USING ERRCODE='23514'; END IF;
  IF (t->>'ageDays')::integer<=prior OR (t->>'ageDays')::integer>finish_age THEN RAISE EXCEPTION 'Growth target ages must be increasing' USING ERRCODE='23514'; END IF;
  prior:=(t->>'ageDays')::integer;
 END LOOP;
 IF prior<>finish_age THEN RAISE EXCEPTION 'Harvest-age target is required' USING ERRCODE='23514'; END IF;
 NEW.unit_snapshot:=to_jsonb(u)||jsonb_build_object('stocked_on',u.stocked_on::text,'initial_weight_g',u.initial_weight_g::text);
 NEW.recipe_snapshots:=refs;
 SELECT timezone INTO NEW.timezone FROM organizations WHERE id=NEW.organization_id;
 RETURN NEW;
END $$;
CREATE TRIGGER broiler_plan_check BEFORE INSERT ON broiler_plans FOR EACH ROW EXECUTE FUNCTION validate_broiler_plan();
REVOKE ALL ON FUNCTION broiler_plan_decimal(jsonb,numeric,integer,boolean,boolean),broiler_plan_integer(jsonb,integer,integer),broiler_plan_text(jsonb,integer,integer,boolean),validate_broiler_plan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION broiler_plan_decimal(jsonb,numeric,integer,boolean,boolean),broiler_plan_integer(jsonb,integer,integer),broiler_plan_text(jsonb,integer,integer,boolean) TO farm_app;
