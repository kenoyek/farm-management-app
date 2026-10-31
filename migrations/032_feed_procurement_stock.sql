-- Specific identified feed purchase lots. No journals, recipe approval or production feed writes.
CREATE SEQUENCE feed_stock_position;
CREATE TABLE feed_stock_events(
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
 model_version text NOT NULL DEFAULT 'specific-feed-lot-stock-v1' CHECK(model_version='specific-feed-lot-stock-v1'),
 policy text NOT NULL DEFAULT 'specific-lot-remaining-cost-v1' CHECK(policy='specific-lot-remaining-cost-v1'),
 kind text NOT NULL DEFAULT '',position bigint NOT NULL DEFAULT 0 UNIQUE,expected_position bigint NOT NULL CHECK(expected_position>=0),recorded_on date NOT NULL,
 lot_id uuid NOT NULL,unit_id uuid,weight_kg numeric(20,6) NOT NULL DEFAULT 0 CHECK(weight_kg>0 AND weight_kg<=100000000),
 amount numeric(20,4) CHECK(amount>=0),currency text NOT NULL DEFAULT '' CHECK(currency~'^[A-Z]{3}$'),reference text,void_of_id uuid,
 input jsonb NOT NULL CHECK(octet_length(input::text)<=10000),source_snapshot jsonb,source_sha256 text,submission jsonb NOT NULL DEFAULT '{}',
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id),FOREIGN KEY(organization_id,lot_id) REFERENCES feed_stock_events(organization_id,id),
 FOREIGN KEY(organization_id,unit_id) REFERENCES production_units(organization_id,id),FOREIGN KEY(organization_id,void_of_id) REFERENCES feed_stock_events(organization_id,id),
 CHECK(kind IN ('receipt','consume','loss','void')),CHECK((kind='void')=(void_of_id IS NOT NULL)),CHECK(void_of_id IS DISTINCT FROM id),
 CHECK((kind='receipt')=(reference IS NOT NULL)),CHECK((kind='consume')=(unit_id IS NOT NULL)),
 CHECK((kind='consume')=(source_snapshot IS NOT NULL)),CHECK((kind='consume')=(source_sha256 IS NOT NULL)),
 CHECK(source_sha256 IS NULL OR source_sha256~'^[a-f0-9]{64}$'),CHECK(source_snapshot IS NULL OR octet_length(source_snapshot::text)<=16384)
);
CREATE UNIQUE INDEX feed_stock_void_once ON feed_stock_events(void_of_id) WHERE void_of_id IS NOT NULL;
CREATE UNIQUE INDEX feed_stock_receipt_reference ON feed_stock_events(organization_id,reference) WHERE reference IS NOT NULL;
CREATE INDEX ON feed_stock_events(organization_id,position);
CREATE INDEX ON feed_stock_events(lot_id,position);
CREATE INDEX ON feed_stock_events(unit_id,recorded_on) WHERE kind='consume';
ALTER TABLE feed_stock_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_read ON feed_stock_events FOR SELECT TO farm_app USING(member_role(organization_id) IN ('owner','admin','manager','inventory','accounts','auditor'));
CREATE POLICY stock_write ON feed_stock_events FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','manager','inventory') AND created_by=current_actor() AND created_at=now());
GRANT SELECT,INSERT ON feed_stock_events TO farm_app;
GRANT USAGE ON SEQUENCE feed_stock_position TO farm_app;
CREATE VIEW active_feed_stock_events WITH (security_invoker=true) AS SELECT e.* FROM feed_stock_events e WHERE e.kind<>'void' AND NOT EXISTS(SELECT 1 FROM feed_stock_events v WHERE v.void_of_id=e.id);
GRANT SELECT ON active_feed_stock_events TO farm_app;
CREATE FUNCTION feed_consumption_source(p_org uuid,p_unit uuid,p_day date) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('unit',to_jsonb(u)||jsonb_build_object('stocked_on',u.stocked_on::text,'initial_weight_g',u.initial_weight_g::text),'record',to_jsonb(d)||jsonb_build_object('recorded_on',d.recorded_on::text,'feed_kg',d.feed_kg::text,'average_weight_g',d.average_weight_g::text))
 FROM effective_daily_records d JOIN production_units u ON u.id=d.unit_id AND u.organization_id=d.organization_id
 WHERE d.organization_id=p_org AND d.unit_id=p_unit AND d.recorded_on=p_day AND u.kind='broilers';
$$;
REVOKE ALL ON FUNCTION feed_consumption_source(uuid,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION feed_consumption_source(uuid,uuid,date) TO farm_app;
CREATE FUNCTION validate_feed_stock() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d jsonb:=NEW.input; original feed_stock_events; lot feed_stock_events; locked_unit uuid; today date; last_day date; keys integer; balance numeric; value_balance numeric; issued numeric; snapshot jsonb; source_hash text;
BEGIN
 IF coalesce(member_role(NEW.organization_id),'') NOT IN ('owner','admin','manager','inventory') THEN RAISE EXCEPTION 'Feed stock posting role required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(d)<>'object' OR jsonb_typeof(d->'kind')<>'string' OR NOT broiler_plan_text(d->'reason',10,2000,false) OR NOT broiler_plan_text(d->'evidence',3,2000,false) THEN RAISE EXCEPTION 'Invalid feed stock evidence' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO keys FROM jsonb_object_keys(d);
 NEW.kind:=d->>'kind';NEW.unit_id:=NULL;NEW.source_snapshot:=NULL;NEW.source_sha256:=NULL;NEW.void_of_id:=NULL;NEW.reference:=NULL;NEW.amount:=NULL;
 IF NEW.kind='consume' THEN
  IF keys<>8 OR NOT(d ?& ARRAY['kind','lotId','unitId','weightKg','expectedSourceSha256','scope','reason','evidence']) OR jsonb_typeof(d->'unitId')<>'string' OR jsonb_typeof(d->'expectedSourceSha256')<>'string' OR (d->>'expectedSourceSha256')!~'^[a-f0-9]{64}$' OR d->>'scope' IS DISTINCT FROM 'actual-recorded-feed-consumption' THEN RAISE EXCEPTION 'Invalid consumed-feed source declaration' USING ERRCODE='23514';END IF;
  locked_unit:=(d->>'unitId')::uuid;NEW.unit_id:=locked_unit;
 ELSIF NEW.kind='void' THEN
  IF keys<>4 OR NOT(d ?& ARRAY['kind','voidOfId','reason','evidence']) OR jsonb_typeof(d->'voidOfId')<>'string' THEN RAISE EXCEPTION 'Invalid erroneous feed entry reversal' USING ERRCODE='23514';END IF;
  SELECT * INTO original FROM feed_stock_events WHERE organization_id=NEW.organization_id AND id=(d->>'voidOfId')::uuid AND kind<>'void';
  IF original.id IS NULL THEN RAISE EXCEPTION 'Original feed movement not found' USING ERRCODE='23514';END IF;
  locked_unit:=original.unit_id;
 END IF;
 -- Unit first, then organization stock; no production writer acquires these in reverse.
 IF locked_unit IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtext(locked_unit::text));END IF;
 PERFORM pg_advisory_xact_lock(813,hashtext(NEW.organization_id::text));
 IF NEW.expected_position<>(SELECT coalesce(max(position),0) FROM feed_stock_events WHERE organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'Stale feed stock head; reload and review' USING ERRCODE='23505';END IF;
 IF (SELECT count(*) FROM feed_stock_events WHERE organization_id=NEW.organization_id)>=1000 THEN RAISE EXCEPTION 'Organization reached its 1000 feed-event limit' USING ERRCODE='23514';END IF;
 SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
 IF NEW.recorded_on<'1900-01-01'::date OR NEW.recorded_on>today THEN RAISE EXCEPTION 'Feed movement date must be from 1900 through organization today' USING ERRCODE='23514';END IF;
 IF NEW.kind='receipt' THEN
  IF keys<>12 OR NOT(d ?& ARRAY['kind','feedName','supplier','reference','location','weightKg','currency','totalCost','costEvidence','scope','reason','evidence']) OR NOT broiler_plan_text(d->'feedName',2,200,false) OR NOT broiler_plan_text(d->'supplier',2,200,false) OR NOT broiler_plan_text(d->'reference',3,100,false) OR NOT broiler_plan_text(d->'location',2,100,false) OR NOT broiler_plan_decimal(d->'weightKg',100000000,6,false,false) OR jsonb_typeof(d->'currency')<>'string' OR (d->>'currency')!~'^[A-Z]{3}$' OR d->>'scope' IS DISTINCT FROM 'actual-owned-purchase-receipt' OR NOT((d->'totalCost'='null'::jsonb AND d->'costEvidence'='null'::jsonb) OR (broiler_plan_decimal(d->'totalCost',100000000,4,true,false) AND broiler_plan_text(d->'costEvidence',3,2000,false))) THEN RAISE EXCEPTION 'Invalid feed purchase receipt or known/unknown total cost' USING ERRCODE='23514';END IF;
  NEW.lot_id:=NEW.id;NEW.weight_kg:=(d->>'weightKg')::numeric;NEW.amount:=(d->>'totalCost')::numeric;NEW.currency:=d->>'currency';NEW.reference:=btrim(d->>'reference');
  d:=d||jsonb_build_object('feedName',btrim(d->>'feedName'),'supplier',btrim(d->>'supplier'),'location',btrim(d->>'location'),'reference',NEW.reference,'weightKg',NEW.weight_kg::text,'totalCost',NEW.amount::text,'costEvidence',CASE WHEN NEW.amount IS NULL THEN NULL ELSE btrim(d->>'costEvidence') END);
 ELSE
  IF NEW.kind='void' THEN
   IF EXISTS(SELECT 1 FROM feed_stock_events WHERE void_of_id=original.id) THEN RAISE EXCEPTION 'Feed movement already reversed' USING ERRCODE='23505';END IF;
   NEW.void_of_id:=original.id;NEW.lot_id:=original.lot_id;NEW.weight_kg:=original.weight_kg;NEW.amount:=original.amount;
   IF original.kind='receipt' AND EXISTS(SELECT 1 FROM active_feed_stock_events WHERE lot_id=original.id AND kind IN ('consume','loss')) THEN RAISE EXCEPTION 'Reverse dependent consumption and losses before erroneous receipt' USING ERRCODE='23514';END IF;
   d:=d||jsonb_build_object('voidOfId',original.id);
  ELSE
   IF NEW.kind NOT IN ('consume','loss') OR jsonb_typeof(d->'lotId')<>'string' OR NOT broiler_plan_decimal(d->'weightKg',100000000,6,false,false) OR (NEW.kind='loss' AND (keys<>5 OR NOT(d ?& ARRAY['kind','lotId','weightKg','reason','evidence']))) THEN RAISE EXCEPTION 'Invalid feed consumption/loss quantity' USING ERRCODE='23514';END IF;
   NEW.lot_id:=(d->>'lotId')::uuid;NEW.weight_kg:=(d->>'weightKg')::numeric;
   d:=d||jsonb_build_object('lotId',NEW.lot_id,'weightKg',NEW.weight_kg::text);
  END IF;
  SELECT * INTO lot FROM active_feed_stock_events WHERE organization_id=NEW.organization_id AND id=NEW.lot_id AND kind='receipt';
  IF lot.id IS NULL THEN RAISE EXCEPTION 'Choose an active feed lot from this organization' USING ERRCODE='23514';END IF;
  NEW.currency:=lot.currency;
  SELECT max(recorded_on) INTO last_day FROM feed_stock_events WHERE lot_id=lot.id;
  IF NEW.recorded_on<last_day THEN RAISE EXCEPTION 'Feed movements must follow this lot history in date order' USING ERRCODE='23514';END IF;
  IF NEW.kind IN ('consume','loss') THEN
   SELECT lot.weight_kg-coalesce(sum(weight_kg),0),CASE WHEN lot.amount IS NULL THEN NULL ELSE lot.amount-coalesce(sum(amount),0) END INTO balance,value_balance FROM active_feed_stock_events WHERE lot_id=lot.id AND kind IN ('consume','loss');
   IF NEW.weight_kg>balance THEN RAISE EXCEPTION 'Insufficient feed lot stock' USING ERRCODE='23514';END IF;
   NEW.amount:=CASE WHEN value_balance IS NULL THEN NULL WHEN NEW.weight_kg=balance THEN value_balance ELSE round(value_balance*NEW.weight_kg/balance,4) END;
  END IF;
  IF NEW.kind='consume' THEN
   snapshot:=feed_consumption_source(NEW.organization_id,NEW.unit_id,NEW.recorded_on);
   IF snapshot IS NULL OR (snapshot->'record'->>'feed_kg')::numeric<=0 THEN RAISE EXCEPTION 'Choose a genuine positive actual daily broiler feed record' USING ERRCODE='23514';END IF;
   source_hash:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
   IF d->>'expectedSourceSha256'<>source_hash THEN RAISE EXCEPTION 'Actual feed source changed; reload and review' USING ERRCODE='23505';END IF;
   SELECT coalesce(sum(weight_kg),0) INTO issued FROM active_feed_stock_events WHERE organization_id=NEW.organization_id AND kind='consume' AND unit_id=NEW.unit_id AND recorded_on=NEW.recorded_on;
   IF issued+NEW.weight_kg>(snapshot->'record'->>'feed_kg')::numeric THEN RAISE EXCEPTION 'Linked lot consumption exceeds this actual daily feed quantity' USING ERRCODE='23514';END IF;
   NEW.source_snapshot:=snapshot;NEW.source_sha256:=source_hash;
   d:=d||jsonb_build_object('unitId',NEW.unit_id);
  END IF;
 END IF;
 NEW.input:=d||jsonb_build_object('reason',btrim(d->>'reason'),'evidence',btrim(d->>'evidence'));
 NEW.submission:=jsonb_build_object('organizationId',NEW.organization_id,'eventId',NEW.id,'date',NEW.recorded_on::text,'expectedPosition',NEW.expected_position::text,'data',NEW.input);
 NEW.position:=nextval('feed_stock_position');RETURN NEW;
END $$;
CREATE TRIGGER feed_stock_check BEFORE INSERT ON feed_stock_events FOR EACH ROW EXECUTE FUNCTION validate_feed_stock();
REVOKE ALL ON FUNCTION validate_feed_stock() FROM PUBLIC;
