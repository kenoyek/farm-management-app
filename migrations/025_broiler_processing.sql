-- Measurements of one whole unsold harvest. No additional animal, product-stock or money posting.
CREATE TABLE broiler_processing_reviews (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,unit_id uuid NOT NULL,harvest_id uuid NOT NULL,
 previous_id uuid,revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 100),position bigint NOT NULL DEFAULT 0 UNIQUE,
 expected_position bigint NOT NULL CHECK(expected_position>=0),expected_daily_id uuid,
 input jsonb NOT NULL CHECK(octet_length(input::text)<=20000),harvest_snapshot jsonb NOT NULL DEFAULT '{}',unit_snapshot jsonb NOT NULL DEFAULT '{}',timezone text NOT NULL DEFAULT '',submission jsonb NOT NULL DEFAULT '{}',
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,unit_id,id),UNIQUE(harvest_id,revision),CHECK(previous_id IS DISTINCT FROM id),
 FOREIGN KEY(organization_id,unit_id) REFERENCES production_units(organization_id,id),
 FOREIGN KEY(organization_id,unit_id,harvest_id) REFERENCES broiler_events(organization_id,unit_id,id),
 FOREIGN KEY(organization_id,unit_id,previous_id) REFERENCES broiler_processing_reviews(organization_id,unit_id,id)
);
CREATE UNIQUE INDEX broiler_processing_root ON broiler_processing_reviews(harvest_id) WHERE previous_id IS NULL;
CREATE UNIQUE INDEX broiler_processing_successor ON broiler_processing_reviews(previous_id) WHERE previous_id IS NOT NULL;
CREATE INDEX ON broiler_processing_reviews(organization_id,unit_id,position);
ALTER TABLE broiler_processing_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON broiler_processing_reviews FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY reviewed_insert ON broiler_processing_reviews FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','manager') AND created_by=current_actor() AND created_at=now());
GRANT SELECT,INSERT ON broiler_processing_reviews TO farm_app;
CREATE VIEW current_broiler_processing_reviews WITH (security_invoker=true) AS SELECT r.* FROM broiler_processing_reviews r WHERE NOT EXISTS(SELECT 1 FROM broiler_processing_reviews n WHERE n.previous_id=r.id);
GRANT SELECT ON current_broiler_processing_reviews TO farm_app;
CREATE OR REPLACE FUNCTION broiler_latest_position(p_unit uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT greatest(coalesce((SELECT max(position) FROM broiler_events WHERE unit_id=p_unit),0),coalesce((SELECT max(position) FROM broiler_reviews WHERE unit_id=p_unit),0),coalesce((SELECT max(position) FROM broiler_loss_reviews WHERE unit_id=p_unit),0),coalesce((SELECT max(position) FROM broiler_processing_reviews WHERE unit_id=p_unit),0));
$$;
CREATE FUNCTION validate_broiler_processing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u production_units; e broiler_events; prior broiler_processing_reviews; d jsonb:=NEW.input; p jsonb; products jsonb:='[]'; labels text[]:='{}'; latest uuid; today date; known numeric:=0; primary_count integer:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
 SELECT * INTO u FROM production_units WHERE organization_id=NEW.organization_id AND id=NEW.unit_id AND kind='broilers';
 SELECT * INTO e FROM broiler_events WHERE organization_id=NEW.organization_id AND unit_id=NEW.unit_id AND id=NEW.harvest_id AND kind='harvest' AND price_basis='unpriced';
 IF u.id IS NULL OR e.id IS NULL THEN RAISE EXCEPTION 'Choose an unsold measured harvest from this batch' USING ERRCODE='23514'; END IF;
 SELECT id INTO latest FROM effective_daily_records WHERE unit_id=u.id ORDER BY recorded_on DESC LIMIT 1;
 IF NEW.expected_position<>broiler_latest_position(u.id) OR NEW.expected_daily_id IS DISTINCT FROM latest THEN RAISE EXCEPTION 'Stale processing evidence' USING ERRCODE='23505'; END IF;
 SELECT * INTO prior FROM current_broiler_processing_reviews WHERE harvest_id=e.id;
 IF NEW.previous_id IS DISTINCT FROM prior.id THEN RAISE EXCEPTION 'Stale processing predecessor' USING ERRCODE='23505'; END IF;
 NEW.revision:=coalesce(prior.revision,0)+1;
 IF jsonb_typeof(d)<>'object' OR NOT broiler_plan_text(d->'reason',10,2000,false) OR NOT broiler_plan_text(d->'evidence',3,2000,false) OR jsonb_typeof(d->'kind')<>'string' THEN RAISE EXCEPTION 'Invalid processing evidence' USING ERRCODE='23514'; END IF;
 IF d->>'kind'='withdraw' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(d))<>3 OR NOT(d ?& ARRAY['kind','reason','evidence']) OR prior.id IS NULL OR prior.input->>'kind'<>'record' THEN RAISE EXCEPTION 'Only an existing current processing record can be withdrawn as erroneous' USING ERRCODE='23514'; END IF;
 ELSE
  IF d->>'kind'<>'record' OR (SELECT count(*) FROM jsonb_object_keys(d))<>8 OR NOT(d ?& ARRAY['kind','processedOn','productForm','products','residualKg','reason','evidence','scope']) OR jsonb_typeof(d->'processedOn')<>'string' OR (d->>'processedOn')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR jsonb_typeof(d->'scope')<>'string' OR d->>'scope'<>'whole-harvest-no-added-mass' OR jsonb_typeof(d->'productForm')<>'string' OR (d->>'productForm') NOT IN ('dressed_whole','cut_parts','other') OR NOT broiler_plan_decimal(d->'residualKg',100000000,6,true,true) THEN RAISE EXCEPTION 'Invalid measured processing structure' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM active_broiler_events WHERE id=e.id) THEN RAISE EXCEPTION 'The harvest was voided' USING ERRCODE='23514'; END IF;
  SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
  IF (d->>'processedOn')::date<e.recorded_on OR (d->>'processedOn')::date>today THEN RAISE EXCEPTION 'Processing observation must be from harvest through today' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(d->'products')<>'array' OR jsonb_array_length(d->'products') NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'Supply 1 to 12 distinct measured outputs' USING ERRCODE='23514'; END IF;
  FOR p IN SELECT value FROM jsonb_array_elements(d->'products') LOOP
   IF jsonb_typeof(p)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>4 OR NOT(p ?& ARRAY['name','role','disposition','weightKg']) OR NOT broiler_plan_text(p->'name',2,100,false) OR btrim(p->>'name')=ANY(labels) OR jsonb_typeof(p->'role')<>'string' OR (p->>'role') NOT IN ('primary','by_product','other') OR jsonb_typeof(p->'disposition')<>'string' OR (p->>'disposition') NOT IN ('intended','not_intended','unassessed') OR NOT broiler_plan_decimal(p->'weightKg',100000000,6,false,true) THEN RAISE EXCEPTION 'Invalid or duplicate processing output' USING ERRCODE='23514'; END IF;
   labels:=array_append(labels,btrim(p->>'name'));IF p->>'role'='primary' THEN primary_count:=primary_count+1; END IF;
   known:=known+coalesce((p->>'weightKg')::numeric,0);
   products:=products||jsonb_build_array(p||jsonb_build_object('name',btrim(p->>'name'),'weightKg',((p->>'weightKg')::numeric(20,6))::text));
  END LOOP;
  IF primary_count=0 OR known+coalesce((d->>'residualKg')::numeric,0)>e.weight_kg THEN RAISE EXCEPTION 'Known outputs/residual exceed input mass, or primary output is missing' USING ERRCODE='23514'; END IF;
  d:=d||jsonb_build_object('products',products,'residualKg',((d->>'residualKg')::numeric(20,6))::text);
 END IF;
 NEW.input:=d||jsonb_build_object('reason',btrim(d->>'reason'),'evidence',btrim(d->>'evidence'));
 NEW.harvest_snapshot:=to_jsonb(e)||jsonb_build_object('position',e.position::text,'expected_position',e.expected_position::text,'weight_kg',e.weight_kg::text,'price_per_unit',e.price_per_unit::text,'amount',e.amount::text);
 NEW.unit_snapshot:=to_jsonb(u)||jsonb_build_object('stocked_on',u.stocked_on::text,'initial_weight_g',u.initial_weight_g::text);
 SELECT timezone INTO NEW.timezone FROM organizations WHERE id=NEW.organization_id;
 NEW.submission:=jsonb_build_object('organizationId',NEW.organization_id,'unitId',NEW.unit_id,'reviewId',NEW.id,'harvestId',NEW.harvest_id,'previousId',NEW.previous_id,'expectedPosition',NEW.expected_position::text,'expectedDailyId',NEW.expected_daily_id,'data',NEW.input);
 NEW.position:=nextval('broiler_event_position');
 RETURN NEW;
END $$;
CREATE TRIGGER broiler_processing_check BEFORE INSERT ON broiler_processing_reviews FOR EACH ROW EXECUTE FUNCTION validate_broiler_processing();
CREATE FUNCTION guard_processed_harvest_void() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='void' THEN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
  IF EXISTS(SELECT 1 FROM current_broiler_processing_reviews WHERE harvest_id=NEW.void_of_id AND input->>'kind'='record') THEN RAISE EXCEPTION 'Withdraw erroneous processing evidence before voiding its source harvest' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broiler_processing_source_guard BEFORE INSERT ON broiler_events FOR EACH ROW EXECUTE FUNCTION guard_processed_harvest_void();
REVOKE ALL ON FUNCTION validate_broiler_processing(),guard_processed_harvest_void() FROM PUBLIC;
