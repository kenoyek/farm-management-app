-- Immutable reviews of supplied incurred category totals and explicit product-lot allocations.
CREATE FUNCTION broiler_cost_snapshot(p_org uuid,p_unit uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('source',(to_jsonb(s)-'today')||jsonb_build_object('modelVersion','broiler-processing-source-lifecycle-v4'),'events',coalesce((SELECT jsonb_agg(p.event ORDER BY (p.event->>'position')::bigint) FROM (SELECT to_jsonb(e)||jsonb_build_object('recorded_on',e.recorded_on::text,'position',e.position::text,'expected_position',e.expected_position::text,'expected_source_position',e.expected_source_position::text,'weight_kg',e.weight_kg::text,'price_per_kg',e.price_per_kg::text,'amount',e.amount::text) AS event FROM broiler_product_events e WHERE organization_id=$1 AND unit_id=$2 ORDER BY e.position LIMIT 1001)p),'[]'::jsonb))
 FROM (SELECT to_jsonb(u)||jsonb_build_object('stocked_on',u.stocked_on::text,'initial_weight_g',u.initial_weight_g::text) AS unit,o.timezone,(now() AT TIME ZONE o.timezone)::date::text AS today,
   coalesce((SELECT jsonb_agg(to_jsonb(d)||jsonb_build_object('feed_kg',d.feed_kg::text,'average_weight_g',d.average_weight_g::text) ORDER BY d.recorded_on,d.id) FROM (SELECT * FROM effective_daily_records WHERE organization_id=$1 AND unit_id=$2 ORDER BY recorded_on,id LIMIT 10001)d),'[]'::jsonb) AS records,
   coalesce((SELECT jsonb_agg(to_jsonb(d)||jsonb_build_object('feed_kg',d.feed_kg::text,'average_weight_g',d.average_weight_g::text) ORDER BY d.recorded_on,d.id) FROM (SELECT * FROM daily_records WHERE organization_id=$1 AND unit_id=$2 ORDER BY recorded_on,id LIMIT 10001)d),'[]'::jsonb) AS "originalRecords",
   coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('position',r.position::text,'expected_position',r.expected_position::text,'feed_kg',r.feed_kg::text,'average_weight_g',r.average_weight_g::text) ORDER BY r.position) FROM (SELECT * FROM broiler_reviews WHERE organization_id=$1 AND unit_id=$2 ORDER BY position LIMIT 10001)r),'[]'::jsonb) AS reviews,
   coalesce((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('position',e.position::text,'expected_position',e.expected_position::text,'weight_kg',e.weight_kg::text,'price_per_unit',e.price_per_unit::text,'amount',e.amount::text) ORDER BY e.position) FROM (SELECT * FROM broiler_events WHERE organization_id=$1 AND unit_id=$2 ORDER BY position LIMIT 10001)e),'[]'::jsonb) AS events,
   coalesce((SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('position',l.position::text,'expected_position',l.expected_position::text,'weight_kg',l.weight_kg::text) ORDER BY l.position) FROM (SELECT * FROM broiler_loss_reviews WHERE organization_id=$1 AND unit_id=$2 ORDER BY position LIMIT 10001)l),'[]'::jsonb) AS "lossReviews",
   coalesce((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('position',p.position::text,'expected_position',p.expected_position::text) ORDER BY p.position) FROM (SELECT * FROM broiler_processing_reviews WHERE organization_id=$1 AND unit_id=$2 ORDER BY position LIMIT 10001)p),'[]'::jsonb) AS "processingReviews"
   FROM production_units u JOIN organizations o ON o.id=u.organization_id WHERE u.organization_id=$1 AND u.id=$2 AND u.kind='broilers')s;
$$;
REVOKE ALL ON FUNCTION broiler_cost_snapshot(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION broiler_cost_snapshot(uuid,uuid) TO farm_app;
CREATE TABLE broiler_cost_reviews (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,unit_id uuid NOT NULL,previous_id uuid,
 revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 100),model_version text NOT NULL DEFAULT 'broiler-incurred-cost-explicit-lot-allocation-v1' CHECK(model_version='broiler-incurred-cost-explicit-lot-allocation-v1'),
 expected_position bigint NOT NULL CHECK(expected_position>=0),expected_source_position bigint NOT NULL CHECK(expected_source_position>=0),expected_daily_id uuid,expected_source_sha256 text NOT NULL CHECK(expected_source_sha256~'^[a-f0-9]{64}$'),
 input jsonb NOT NULL CHECK(octet_length(input::text)<=64000),source_snapshot jsonb NOT NULL DEFAULT '{}',submission jsonb NOT NULL DEFAULT '{}',
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,unit_id,id),UNIQUE(unit_id,revision),CHECK(previous_id IS DISTINCT FROM id),
 FOREIGN KEY(organization_id,unit_id) REFERENCES production_units(organization_id,id),
 FOREIGN KEY(organization_id,unit_id,previous_id) REFERENCES broiler_cost_reviews(organization_id,unit_id,id)
);
CREATE UNIQUE INDEX broiler_cost_root ON broiler_cost_reviews(unit_id) WHERE previous_id IS NULL;
CREATE UNIQUE INDEX broiler_cost_successor ON broiler_cost_reviews(previous_id) WHERE previous_id IS NOT NULL;
ALTER TABLE broiler_cost_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON broiler_cost_reviews FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY manager_insert ON broiler_cost_reviews FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','manager') AND created_by=current_actor() AND created_at=now());
GRANT SELECT,INSERT ON broiler_cost_reviews TO farm_app;
CREATE FUNCTION validate_broiler_cost_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d jsonb:=NEW.input; prior broiler_cost_reviews; latest uuid; c jsonb; a jsonb; categories text[]:='{}'; lots uuid[]:='{}'; costs jsonb:='[]'; allocations jsonb:='[]'; known numeric:=0; allocated numeric:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
 IF NOT EXISTS(SELECT 1 FROM production_units WHERE organization_id=NEW.organization_id AND id=NEW.unit_id AND kind='broilers') THEN RAISE EXCEPTION 'Choose a visible broiler batch' USING ERRCODE='23514'; END IF;
 SELECT * INTO prior FROM broiler_cost_reviews WHERE unit_id=NEW.unit_id ORDER BY revision DESC LIMIT 1;
 IF NEW.previous_id IS DISTINCT FROM prior.id THEN RAISE EXCEPTION 'Stale cost-review predecessor' USING ERRCODE='23505'; END IF;
 NEW.revision:=coalesce(prior.revision,0)+1;
 SELECT id INTO latest FROM effective_daily_records WHERE unit_id=NEW.unit_id ORDER BY recorded_on DESC LIMIT 1;
 IF NEW.expected_position<>(SELECT coalesce(max(position),0) FROM broiler_product_events WHERE unit_id=NEW.unit_id) OR NEW.expected_source_position<>broiler_latest_position(NEW.unit_id) OR NEW.expected_daily_id IS DISTINCT FROM latest THEN RAISE EXCEPTION 'Stale actual cost source' USING ERRCODE='23505'; END IF;
 IF jsonb_typeof(d)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(d))<>8 OR NOT(d ?& ARRAY['currency','costs','allocations','completeCosts','policy','scope','reason','evidence']) OR jsonb_typeof(d->'currency')<>'string' OR (d->>'currency')!~'^[A-Z]{3}$' OR jsonb_typeof(d->'completeCosts')<>'boolean' OR d->>'policy' IS DISTINCT FROM 'explicit-lot-totals-uniform-kg-v1' OR d->>'scope' IS DISTINCT FROM 'actual-incurred-batch-category-totals' OR NOT broiler_plan_text(d->'reason',10,2000,false) OR NOT broiler_plan_text(d->'evidence',3,2000,false) THEN RAISE EXCEPTION 'Invalid actual cost review structure' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(d->'costs')<>'array' OR jsonb_array_length(d->'costs')<>10 OR jsonb_typeof(d->'allocations')<>'array' OR jsonb_array_length(d->'allocations')>40 THEN RAISE EXCEPTION 'Provide ten categories and at most forty distinct receipt allocations' USING ERRCODE='23514'; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(d->'costs') LOOP
  IF jsonb_typeof(c)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(c))<>3 OR NOT(c ?& ARRAY['category','amount','evidence']) OR jsonb_typeof(c->'category')<>'string' OR (c->>'category') NOT IN ('chicks','feed','health','litter','labour','utilities','transport','processing','overhead','other') OR (c->>'category')=ANY(categories) OR NOT broiler_plan_decimal(c->'amount',100000000,4,true,true) OR NOT broiler_plan_text(c->'evidence',CASE WHEN c->'amount'='null'::jsonb THEN 0 ELSE 3 END,1000,false) THEN RAISE EXCEPTION 'Invalid, repeated or unevidenced actual cost category' USING ERRCODE='23514'; END IF;
  categories:=array_append(categories,c->>'category');known:=known+coalesce((c->>'amount')::numeric,0);
  costs:=costs||jsonb_build_array(c||jsonb_build_object('amount',((c->>'amount')::numeric(20,4))::text,'evidence',btrim(c->>'evidence')));
 END LOOP;
 FOR a IN SELECT value FROM jsonb_array_elements(d->'allocations') LOOP
  IF jsonb_typeof(a)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(a))<>3 OR NOT(a ?& ARRAY['lotId','amount','evidence']) OR jsonb_typeof(a->'lotId')<>'string' OR (a->>'lotId')::uuid=ANY(lots) OR NOT broiler_plan_decimal(a->'amount',100000000,4,true,false) OR NOT broiler_plan_text(a->'evidence',3,1000,false) THEN RAISE EXCEPTION 'Invalid, repeated or unevidenced lot allocation' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM active_broiler_product_events WHERE organization_id=NEW.organization_id AND unit_id=NEW.unit_id AND id=(a->>'lotId')::uuid AND kind='receipt') THEN RAISE EXCEPTION 'Allocate only active receipt lots in this batch' USING ERRCODE='23514'; END IF;
  lots:=array_append(lots,(a->>'lotId')::uuid);allocated:=allocated+(a->>'amount')::numeric;
  allocations:=allocations||jsonb_build_array(a||jsonb_build_object('lotId',(a->>'lotId')::uuid,'amount',((a->>'amount')::numeric(20,4))::text,'evidence',btrim(a->>'evidence')));
 END LOOP;
 IF allocated>known THEN RAISE EXCEPTION 'Explicit lot allocations exceed the known incurred-cost subtotal' USING ERRCODE='23514'; END IF;
 NEW.input:=d||jsonb_build_object('costs',costs,'allocations',allocations,'reason',btrim(d->>'reason'),'evidence',btrim(d->>'evidence'));
 NEW.source_snapshot:=broiler_cost_snapshot(NEW.organization_id,NEW.unit_id);
 IF NEW.source_snapshot IS NULL OR octet_length(NEW.source_snapshot::text)>524288 THEN RAISE EXCEPTION 'Actual source exceeds the 512 KiB immutable snapshot limit' USING ERRCODE='23514'; END IF;
 IF encode(digest(NEW.source_snapshot::text,'sha256'),'hex')<>NEW.expected_source_sha256 THEN RAISE EXCEPTION 'Stale actual source digest' USING ERRCODE='23505'; END IF;
 NEW.submission:=jsonb_build_object('organizationId',NEW.organization_id,'unitId',NEW.unit_id,'reviewId',NEW.id,'previousId',NEW.previous_id,'expectedPosition',NEW.expected_position::text,'expectedSourcePosition',NEW.expected_source_position::text,'expectedDailyId',NEW.expected_daily_id,'expectedSourceSha256',NEW.expected_source_sha256,'data',NEW.input);
 RETURN NEW;
END $$;
CREATE TRIGGER broiler_cost_review_check BEFORE INSERT ON broiler_cost_reviews FOR EACH ROW EXECUTE FUNCTION validate_broiler_cost_review();
REVOKE ALL ON FUNCTION validate_broiler_cost_review() FROM PUBLIC;
