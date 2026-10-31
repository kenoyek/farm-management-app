-- Explicit product receipts and measured kg movements; independent of live-animal movements.
CREATE SEQUENCE broiler_product_position;
CREATE TABLE broiler_product_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE, unit_id uuid NOT NULL,
 lot_id uuid NOT NULL, kind text NOT NULL DEFAULT '',recorded_on date NOT NULL,position bigint NOT NULL DEFAULT 0 UNIQUE,
 expected_position bigint NOT NULL CHECK(expected_position>=0),expected_source_position bigint NOT NULL CHECK(expected_source_position>=0),expected_daily_id uuid,
 input jsonb NOT NULL CHECK(octet_length(input::text)<=10000),source_review_id uuid,output_index integer,
 weight_kg numeric(20,6) NOT NULL DEFAULT 0,price_per_kg numeric(20,4),amount numeric(20,4),currency text,reference text,
 void_of_id uuid,source_snapshot jsonb,submission jsonb NOT NULL DEFAULT '{}',
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,unit_id,id),
 FOREIGN KEY(organization_id,unit_id) REFERENCES production_units(organization_id,id),
 FOREIGN KEY(organization_id,unit_id,lot_id) REFERENCES broiler_product_events(organization_id,unit_id,id),
 FOREIGN KEY(organization_id,unit_id,void_of_id) REFERENCES broiler_product_events(organization_id,unit_id,id),
 FOREIGN KEY(organization_id,unit_id,source_review_id) REFERENCES broiler_processing_reviews(organization_id,unit_id,id),
 CHECK(kind IN ('receipt','sale','loss','void')),CHECK(weight_kg>0 AND weight_kg<=100000000),CHECK(void_of_id IS DISTINCT FROM id),
 CHECK((kind='sale' AND price_per_kg BETWEEN 0 AND 100000000 AND price_per_kg IS NOT NULL AND amount IS NOT NULL AND amount>=0 AND currency IS NOT NULL AND currency~'^[A-Z]{3}$' AND reference IS NOT NULL) OR (kind<>'sale' AND price_per_kg IS NULL AND amount IS NULL AND currency IS NULL AND reference IS NULL)),
 CHECK((kind='receipt' AND source_review_id IS NOT NULL AND output_index BETWEEN 0 AND 11 AND source_snapshot IS NOT NULL AND lot_id=id) OR (kind<>'receipt' AND source_review_id IS NULL AND output_index IS NULL AND source_snapshot IS NULL)),
 CHECK((kind='void')=(void_of_id IS NOT NULL))
);
CREATE UNIQUE INDEX broiler_product_void_once ON broiler_product_events(void_of_id) WHERE void_of_id IS NOT NULL;
CREATE UNIQUE INDEX broiler_product_reference ON broiler_product_events(organization_id,reference) WHERE reference IS NOT NULL;
CREATE INDEX ON broiler_product_events(organization_id,unit_id,position);
CREATE INDEX ON broiler_product_events(lot_id,position);
ALTER TABLE broiler_product_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON broiler_product_events FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY manager_insert ON broiler_product_events FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','manager') AND created_by=current_actor() AND created_at=now());
GRANT SELECT,INSERT ON broiler_product_events TO farm_app;
GRANT USAGE ON SEQUENCE broiler_product_position TO farm_app;
CREATE VIEW active_broiler_product_events WITH (security_invoker=true) AS SELECT e.* FROM broiler_product_events e WHERE e.kind<>'void' AND NOT EXISTS(SELECT 1 FROM broiler_product_events v WHERE v.void_of_id=e.id);
GRANT SELECT ON active_broiler_product_events TO farm_app;
CREATE FUNCTION validate_broiler_product() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d jsonb:=NEW.input; r broiler_processing_reviews; lot broiler_product_events; original broiler_product_events; p jsonb; latest uuid; today date; curr text; balance numeric; last_day date; keys integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
 IF NOT EXISTS(SELECT 1 FROM production_units WHERE organization_id=NEW.organization_id AND id=NEW.unit_id AND kind='broilers') THEN RAISE EXCEPTION 'Choose a visible broiler batch' USING ERRCODE='23514'; END IF;
 SELECT (now() AT TIME ZONE timezone)::date,currency INTO today,curr FROM organizations WHERE id=NEW.organization_id;
 SELECT id INTO latest FROM effective_daily_records WHERE unit_id=NEW.unit_id ORDER BY recorded_on DESC LIMIT 1;
 IF NEW.expected_position<>(SELECT coalesce(max(position),0) FROM broiler_product_events WHERE unit_id=NEW.unit_id) OR NEW.expected_source_position<>broiler_latest_position(NEW.unit_id) OR NEW.expected_daily_id IS DISTINCT FROM latest THEN RAISE EXCEPTION 'Stale product or clinical source state; reload and review' USING ERRCODE='23505'; END IF;
 IF (SELECT count(*) FROM broiler_product_events WHERE unit_id=NEW.unit_id)>=1000 THEN RAISE EXCEPTION 'Batch reached its 1000 product-event limit' USING ERRCODE='23514'; END IF;
 IF NEW.recorded_on>today OR jsonb_typeof(d)<>'object' OR jsonb_typeof(d->'kind')<>'string' OR NOT broiler_plan_text(d->'reason',10,2000,false) OR NOT broiler_plan_text(d->'evidence',3,2000,false) THEN RAISE EXCEPTION 'Invalid product observation' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO keys FROM jsonb_object_keys(d);
 NEW.kind:=d->>'kind'; NEW.source_review_id:=NULL;NEW.output_index:=NULL;NEW.source_snapshot:=NULL;NEW.price_per_kg:=NULL;NEW.amount:=NULL;NEW.currency:=NULL;NEW.reference:=NULL;NEW.void_of_id:=NULL;
 IF NEW.kind='receipt' THEN
  IF keys<>7 OR NOT(d ?& ARRAY['kind','sourceReviewId','outputIndex','location','scope','reason','evidence']) OR jsonb_typeof(d->'sourceReviewId')<>'string' OR jsonb_typeof(d->'outputIndex')<>'number' OR (d->>'outputIndex')!~'^(0|[1-9]|1[01])$' OR NOT broiler_plan_text(d->'location',2,100,false) OR d->>'scope' IS DISTINCT FROM 'whole-output-owned-available' THEN RAISE EXCEPTION 'Invalid full-output stock receipt' USING ERRCODE='23514'; END IF;
  SELECT * INTO r FROM current_broiler_processing_reviews WHERE id=(d->>'sourceReviewId')::uuid AND organization_id=NEW.organization_id AND unit_id=NEW.unit_id AND input->>'kind'='record';
  IF r.id IS NULL OR NOT EXISTS(SELECT 1 FROM active_broiler_events WHERE id=r.harvest_id) THEN RAISE EXCEPTION 'Choose a current active processing measurement' USING ERRCODE='23514'; END IF;
  p:=r.input->'products'->(d->>'outputIndex')::integer;
  IF p IS NULL OR p->>'disposition' IS DISTINCT FROM 'intended' OR p->>'weightKg' IS NULL OR NEW.recorded_on<(r.input->>'processedOn')::date THEN RAISE EXCEPTION 'Only a measured intended output can supply owned available stock after processing' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM active_broiler_product_events e JOIN broiler_processing_reviews s ON s.id=e.source_review_id WHERE e.kind='receipt' AND s.harvest_id=r.harvest_id AND e.output_index=(d->>'outputIndex')::integer) THEN RAISE EXCEPTION 'This whole output is already received' USING ERRCODE='23505'; END IF;
  NEW.lot_id:=NEW.id; NEW.source_review_id:=r.id;NEW.output_index:=(d->>'outputIndex')::integer;NEW.source_snapshot:=to_jsonb(r)||jsonb_build_object('position',r.position::text,'expected_position',r.expected_position::text);NEW.weight_kg:=(p->>'weightKg')::numeric;
  d:=d||jsonb_build_object('sourceReviewId',r.id,'location',btrim(d->>'location'));
 ELSE
  IF NEW.kind='void' THEN
   IF keys<>4 OR NOT(d ?& ARRAY['kind','voidOfId','reason','evidence']) OR jsonb_typeof(d->'voidOfId')<>'string' THEN RAISE EXCEPTION 'Invalid erroneous-entry reversal' USING ERRCODE='23514'; END IF;
   SELECT * INTO original FROM active_broiler_product_events WHERE id=(d->>'voidOfId')::uuid AND organization_id=NEW.organization_id AND unit_id=NEW.unit_id;
   IF original.id IS NULL THEN RAISE EXCEPTION 'Original movement is missing or already voided' USING ERRCODE='23505'; END IF;
   NEW.lot_id:=original.lot_id;NEW.void_of_id:=original.id;NEW.weight_kg:=original.weight_kg;
   IF original.kind='receipt' AND EXISTS(SELECT 1 FROM active_broiler_product_events WHERE lot_id=original.id AND kind IN ('sale','loss')) THEN RAISE EXCEPTION 'Correct all dependent sales/losses before reversing an erroneous receipt' USING ERRCODE='23514'; END IF;
   d:=d||jsonb_build_object('voidOfId',original.id);
  ELSE
   IF NEW.kind NOT IN ('sale','loss') OR jsonb_typeof(d->'lotId')<>'string' OR NOT broiler_plan_decimal(d->'weightKg',100000000,6,false,false) THEN RAISE EXCEPTION 'Invalid measured product withdrawal' USING ERRCODE='23514'; END IF;
   IF (NEW.kind='loss' AND (keys<>5 OR NOT(d ?& ARRAY['kind','lotId','weightKg','reason','evidence']))) OR (NEW.kind='sale' AND (keys<>8 OR NOT(d ?& ARRAY['kind','lotId','weightKg','pricePerKg','reference','customer','reason','evidence']) OR NOT broiler_plan_decimal(d->'pricePerKg',100000000,4,true,false) OR NOT broiler_plan_text(d->'reference',3,100,false) OR NOT broiler_plan_text(d->'customer',2,200,false))) THEN RAISE EXCEPTION 'Invalid product sale/loss fields' USING ERRCODE='23514'; END IF;
   NEW.lot_id:=(d->>'lotId')::uuid;NEW.weight_kg:=(d->>'weightKg')::numeric;
   d:=d||jsonb_build_object('lotId',NEW.lot_id,'weightKg',NEW.weight_kg::text);
   IF NEW.kind='sale' THEN
    IF NEW.weight_kg*(d->>'pricePerKg')::numeric>=10000000000000000 THEN RAISE EXCEPTION 'Sale amount exceeds supported precision' USING ERRCODE='23514'; END IF;
    NEW.price_per_kg:=(d->>'pricePerKg')::numeric;NEW.amount:=round(NEW.weight_kg*NEW.price_per_kg,4);NEW.currency:=curr;NEW.reference:=btrim(d->>'reference');
    d:=d||jsonb_build_object('pricePerKg',NEW.price_per_kg::text,'reference',NEW.reference,'customer',btrim(d->>'customer'));
   END IF;
  END IF;
  SELECT * INTO lot FROM active_broiler_product_events WHERE id=NEW.lot_id AND organization_id=NEW.organization_id AND unit_id=NEW.unit_id AND kind='receipt';
  IF lot.id IS NULL THEN RAISE EXCEPTION 'Choose an active product lot from this batch' USING ERRCODE='23514'; END IF;
  SELECT max(recorded_on) INTO last_day FROM broiler_product_events WHERE lot_id=lot.id;
  IF NEW.recorded_on<last_day THEN RAISE EXCEPTION 'Product movements must follow this lot history in date order' USING ERRCODE='23514'; END IF;
  IF NEW.kind IN ('sale','loss') THEN
   SELECT coalesce(sum(CASE WHEN kind='receipt' THEN weight_kg ELSE -weight_kg END),0) INTO balance FROM active_broiler_product_events WHERE lot_id=lot.id;
   IF NEW.weight_kg>balance THEN RAISE EXCEPTION 'Measured withdrawal exceeds available product kg' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT * INTO r FROM broiler_processing_reviews WHERE id=lot.source_review_id;
 END IF;
 -- Current guidance can expose a historical harvest conflict. Observations/reversals remain possible,
 -- but admitting new saleable stock or recording dispatch is held for explicit source review.
 IF NEW.kind IN ('receipt','sale') AND EXISTS(SELECT 1 FROM effective_broiler_treatments WHERE unit_id=NEW.unit_id AND (earliest_harvest_on IS NULL OR earliest_harvest_on>(r.harvest_snapshot->>'recorded_on')::date)) THEN RAISE EXCEPTION 'Current withdrawal guidance conflicts with the source harvest; review it before product receipt/sale' USING ERRCODE='23514'; END IF;
 NEW.input:=d||jsonb_build_object('reason',btrim(d->>'reason'),'evidence',btrim(d->>'evidence'));
 NEW.submission:=jsonb_build_object('organizationId',NEW.organization_id,'unitId',NEW.unit_id,'eventId',NEW.id,'date',NEW.recorded_on::text,'expectedPosition',NEW.expected_position::text,'expectedSourcePosition',NEW.expected_source_position::text,'expectedDailyId',NEW.expected_daily_id,'data',NEW.input);
 NEW.position:=nextval('broiler_product_position');RETURN NEW;
END $$;
CREATE TRIGGER broiler_product_check BEFORE INSERT ON broiler_product_events FOR EACH ROW EXECUTE FUNCTION validate_broiler_product();
CREATE FUNCTION guard_stocked_processing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
 IF EXISTS(SELECT 1 FROM active_broiler_product_events e JOIN broiler_processing_reviews r ON r.id=e.source_review_id WHERE e.kind='receipt' AND r.harvest_id=NEW.harvest_id) THEN RAISE EXCEPTION 'Active product receipts depend on this processing source; correct dependent movements and erroneous receipts before changing it' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broiler_processing_stock_guard BEFORE INSERT ON broiler_processing_reviews FOR EACH ROW EXECUTE FUNCTION guard_stocked_processing();
REVOKE ALL ON FUNCTION validate_broiler_product(),guard_stocked_processing() FROM PUBLIC;
