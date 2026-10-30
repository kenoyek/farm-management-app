-- Immutable planning budgets. No actual production, inventory or finance posting.
CREATE TABLE broiler_economic_scenarios (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,unit_id uuid NOT NULL,
 previous_id uuid,revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 100),plan_id uuid NOT NULL,
 model_version text NOT NULL DEFAULT 'broiler-declared-budget-yield-v1' CHECK(model_version='broiler-declared-budget-yield-v1'),
 input jsonb NOT NULL CHECK(octet_length(input::text)<=20000),plan_snapshot jsonb NOT NULL DEFAULT '{}',
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,unit_id,id),UNIQUE(unit_id,revision),
 FOREIGN KEY(organization_id,unit_id) REFERENCES production_units(organization_id,id),
 FOREIGN KEY(organization_id,unit_id,plan_id) REFERENCES broiler_plans(organization_id,unit_id,id),
 FOREIGN KEY(organization_id,unit_id,previous_id) REFERENCES broiler_economic_scenarios(organization_id,unit_id,id),CHECK(previous_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX broiler_economics_root ON broiler_economic_scenarios(unit_id) WHERE previous_id IS NULL;
CREATE UNIQUE INDEX broiler_economics_successor ON broiler_economic_scenarios(previous_id) WHERE previous_id IS NOT NULL;
CREATE INDEX ON broiler_economic_scenarios(organization_id,unit_id,revision);
ALTER TABLE broiler_economic_scenarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON broiler_economic_scenarios FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY reviewed_insert ON broiler_economic_scenarios FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','manager') AND created_by=current_actor() AND created_at=now());
GRANT SELECT,INSERT ON broiler_economic_scenarios TO farm_app;
CREATE FUNCTION validate_broiler_economics() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p broiler_plans; prior broiler_economic_scenarios; d jsonb:=NEW.input; row jsonb; seen text[]:='{}';
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
 SELECT * INTO p FROM broiler_plans WHERE organization_id=NEW.organization_id AND unit_id=NEW.unit_id AND id=NEW.plan_id;
 IF p.id IS NULL OR p.model_version<>'broiler-daily-linear-targets-v1' THEN RAISE EXCEPTION 'Choose a visible supported saved plan for this batch' USING ERRCODE='23514'; END IF;
 SELECT * INTO prior FROM broiler_economic_scenarios WHERE unit_id=NEW.unit_id ORDER BY revision DESC LIMIT 1;
 IF NEW.previous_id IS DISTINCT FROM prior.id THEN RAISE EXCEPTION 'Stale economic scenario version' USING ERRCODE='23505'; END IF;
 NEW.revision:=coalesce(prior.revision,0)+1;
 IF jsonb_typeof(d)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(d))<>10 OR NOT(d ?& ARRAY['name','saleBasis','salePrice','yieldFraction','priceEvidence','yieldEvidence','allocationEvidence','completeBudget','costs','notes']) THEN RAISE EXCEPTION 'Invalid economic scenario structure' USING ERRCODE='23514'; END IF;
 IF NOT broiler_plan_text(d->'name',2,100,false) OR NOT broiler_plan_text(d->'allocationEvidence',3,2000,false) OR NOT broiler_plan_text(d->'priceEvidence',0,1000,false) OR NOT broiler_plan_text(d->'yieldEvidence',0,1000,false) OR NOT broiler_plan_text(d->'notes',0,2000,false) OR jsonb_typeof(d->'completeBudget')<>'boolean' OR jsonb_typeof(d->'saleBasis')<>'string' OR (d->>'saleBasis') NOT IN ('bird','liveKg','processedKg') OR NOT broiler_plan_decimal(d->'salePrice',100000000,4,true,true) OR NOT broiler_plan_decimal(d->'yieldFraction',1,8,true,true) THEN RAISE EXCEPTION 'Invalid economic assumptions' USING ERRCODE='23514'; END IF;
 IF d->'salePrice'<>'null'::jsonb AND NOT broiler_plan_text(d->'priceEvidence',3,1000,false) THEN RAISE EXCEPTION 'Price source is required' USING ERRCODE='23514'; END IF;
 IF d->>'saleBasis'<>'processedKg' AND (d->'yieldFraction'<>'null'::jsonb OR d->>'yieldEvidence'<>'') THEN RAISE EXCEPTION 'Yield applies only to processed sales' USING ERRCODE='23514'; END IF;
 IF d->>'saleBasis'='processedKg' AND d->'yieldFraction'<>'null'::jsonb AND NOT broiler_plan_text(d->'yieldEvidence',3,1000,false) THEN RAISE EXCEPTION 'Yield source is required' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(d->'costs')<>'array' OR jsonb_array_length(d->'costs')<>8 THEN RAISE EXCEPTION 'Supply all eight budget categories' USING ERRCODE='23514'; END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(d->'costs') LOOP
  IF jsonb_typeof(row)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(row))<>3 OR NOT(row ?& ARRAY['category','amount','evidence']) OR jsonb_typeof(row->'category')<>'string' OR (row->>'category') NOT IN ('health','litter','labour','utilities','transport','processing','overhead','other') OR row->>'category'=ANY(seen) OR NOT broiler_plan_decimal(row->'amount',100000000,4,true,true) OR NOT broiler_plan_text(row->'evidence',3,1000,false) THEN RAISE EXCEPTION 'Invalid or duplicate budget category' USING ERRCODE='23514'; END IF;
  seen:=array_append(seen,row->>'category');
 END LOOP;
 -- The exact original plan is derived by the database, never accepted as client evidence.
 NEW.plan_snapshot:=to_jsonb(p);
 RETURN NEW;
END $$;
CREATE TRIGGER broiler_economics_check BEFORE INSERT ON broiler_economic_scenarios FOR EACH ROW EXECUTE FUNCTION validate_broiler_economics();
REVOKE ALL ON FUNCTION validate_broiler_economics() FROM PUBLIC;
