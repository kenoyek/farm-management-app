-- Whole saleable eggs only. All movements are explicit, immutable operational events.
CREATE TABLE egg_stores (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,farm_id uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 100),
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 submission jsonb NOT NULL,UNIQUE(organization_id,id),UNIQUE(organization_id,farm_id,name),
 FOREIGN KEY(organization_id,farm_id) REFERENCES farms(organization_id,id)
);
CREATE TABLE egg_batches (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,store_id uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 100),source_kind text NOT NULL CHECK(source_kind IN ('opening','collection')),
 unit_id uuid,collected_on date,received_on date NOT NULL,
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id),UNIQUE(unit_id,collected_on),
 FOREIGN KEY(organization_id,store_id) REFERENCES egg_stores(organization_id,id),
 FOREIGN KEY(organization_id,unit_id) REFERENCES production_units(organization_id,id),
 CHECK((source_kind='opening' AND unit_id IS NULL AND collected_on IS NULL) OR
       (source_kind='collection' AND unit_id IS NOT NULL AND collected_on IS NOT NULL AND received_on>=collected_on))
);
CREATE TABLE egg_events (
 id uuid PRIMARY KEY,position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,batch_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('opening','receipt','grade','sale','loss','count','reversal')),occurred_on date NOT NULL,
 grade text NOT NULL CHECK(grade IN ('ungraded','small','medium','large','extra-large','other')),
 target_grade text CHECK(target_grade IN ('ungraded','small','medium','large','extra-large','other') AND target_grade<>grade),
 quantity integer NOT NULL CHECK(quantity BETWEEN -100000000 AND 100000000),
 previous_id uuid,reverses_id uuid,
 source_snapshot jsonb,source_quantity integer CHECK(source_quantity BETWEEN 0 AND 100000000),
 stock_count integer CHECK(stock_count BETWEEN 0 AND 100000000),expected_position bigint,
 pricing jsonb,amount numeric(20,4),currency text,customer text,reference text,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),evidence text NOT NULL CHECK(length(btrim(evidence)) BETWEEN 3 AND 2000),
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),submission jsonb NOT NULL,
 UNIQUE(organization_id,batch_id,id),
 FOREIGN KEY(organization_id,batch_id) REFERENCES egg_batches(organization_id,id),
 FOREIGN KEY(organization_id,batch_id,previous_id) REFERENCES egg_events(organization_id,batch_id,id),
 FOREIGN KEY(organization_id,batch_id,reverses_id) REFERENCES egg_events(organization_id,batch_id,id),
 CHECK(previous_id IS DISTINCT FROM id AND reverses_id IS DISTINCT FROM id),
 CHECK((kind='receipt')=(source_snapshot IS NOT NULL AND source_quantity IS NOT NULL)),
 CHECK(kind='receipt' OR (previous_id IS NULL AND source_snapshot IS NULL AND source_quantity IS NULL)),
 CHECK((kind='count')=(stock_count IS NOT NULL AND expected_position IS NOT NULL)),
 CHECK(kind='count' OR (stock_count IS NULL AND expected_position IS NULL)),
 CHECK((kind='reversal')=(reverses_id IS NOT NULL)),
 CHECK((kind IN ('sale','reversal')) OR (pricing IS NULL AND amount IS NULL AND currency IS NULL AND customer IS NULL AND reference IS NULL))
);
CREATE UNIQUE INDEX egg_receipt_root ON egg_events(batch_id) WHERE kind='receipt' AND previous_id IS NULL;
CREATE UNIQUE INDEX egg_receipt_successor ON egg_events(previous_id) WHERE previous_id IS NOT NULL;
CREATE UNIQUE INDEX egg_opening_once ON egg_events(batch_id) WHERE kind='opening';
CREATE UNIQUE INDEX egg_reversal_once ON egg_events(reverses_id) WHERE reverses_id IS NOT NULL;
CREATE UNIQUE INDEX egg_sale_reference ON egg_events(organization_id,reference) WHERE kind='sale';
CREATE INDEX ON egg_events(organization_id,batch_id,position);
CREATE INDEX ON egg_batches(organization_id,store_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['egg_stores','egg_batches','egg_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL)',t);
 EXECUTE format('CREATE POLICY stock_insert ON %I FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN (''owner'',''admin'',''manager'',''inventory'') AND created_by=current_actor() AND created_at=now())',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO farm_app',t);
 END LOOP;
END $$;
GRANT USAGE ON SEQUENCE egg_events_position_seq TO farm_app;
CREATE VIEW egg_movements WITH (security_invoker=true) AS
 SELECT id AS event_id,position,organization_id,batch_id,occurred_on,grade,
 CASE WHEN target_grade IS NOT NULL THEN -quantity ELSE quantity END AS eggs FROM egg_events
 UNION ALL SELECT id,position,organization_id,batch_id,occurred_on,target_grade,quantity FROM egg_events WHERE target_grade IS NOT NULL;
CREATE VIEW egg_balances WITH (security_invoker=true) AS
 SELECT organization_id,batch_id,grade,sum(eggs)::bigint AS eggs FROM egg_movements GROUP BY organization_id,batch_id,grade;
GRANT SELECT ON egg_movements,egg_balances TO farm_app;

CREATE FUNCTION validate_egg_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f uuid; today date; baseline date;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.organization_id::text),618);
 SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
 IF today IS NULL OR NEW.received_on>today THEN RAISE EXCEPTION 'Invalid receipt date' USING ERRCODE='23514'; END IF;
 SELECT min(received_on) INTO baseline FROM egg_batches WHERE store_id=NEW.store_id AND source_kind='opening';
 IF NEW.source_kind='opening' THEN
  IF EXISTS(SELECT 1 FROM egg_events e JOIN egg_batches b ON b.id=e.batch_id WHERE b.store_id=NEW.store_id AND e.kind<>'opening') OR (baseline IS NOT NULL AND baseline<>NEW.received_on) THEN
   RAISE EXCEPTION 'Opening stock must share one opening-of-day baseline before other store operations' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.source_kind='collection' THEN
  IF baseline IS NOT NULL AND NEW.collected_on<baseline THEN RAISE EXCEPTION 'Collections before the opening baseline cannot be received again' USING ERRCODE='23514'; END IF;
  SELECT s.farm_id INTO f FROM egg_stores s JOIN production_units u ON u.farm_id=s.farm_id AND u.organization_id=s.organization_id
  WHERE s.id=NEW.store_id AND s.organization_id=NEW.organization_id AND u.id=NEW.unit_id AND u.kind='layers' AND NEW.collected_on>=u.stocked_on;
  IF f IS NULL THEN RAISE EXCEPTION 'Collection and store must belong to the same layer farm' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER egg_batch_check BEFORE INSERT ON egg_batches FOR EACH ROW EXECUTE FUNCTION validate_egg_batch();
CREATE FUNCTION require_egg_batch_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM egg_events WHERE batch_id=NEW.id AND kind=CASE WHEN NEW.source_kind='collection' THEN 'receipt' ELSE 'opening' END) THEN
 RAISE EXCEPTION 'A batch requires an atomic opening or collection receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER egg_batch_receipt AFTER INSERT ON egg_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_egg_batch_receipt();

CREATE FUNCTION validate_egg_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b egg_batches; old egg_events; head egg_events; source jsonb; n integer; last_pos bigint; last_day date;
 balance bigint; today date; org_currency text; p jsonb; q numeric; total numeric; price numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.organization_id::text),618);
 -- Allocate ordering under the organization lock, including direct runtime inserts.
 NEW.position=nextval('egg_events_position_seq');
 SELECT * INTO b FROM egg_batches WHERE id=NEW.batch_id AND organization_id=NEW.organization_id;
 IF b.id IS NULL THEN RAISE EXCEPTION 'Batch not found' USING ERRCODE='23503'; END IF;
 SELECT (now() AT TIME ZONE timezone)::date,currency INTO today,org_currency FROM organizations WHERE id=NEW.organization_id;
 SELECT max(position),max(occurred_on) INTO last_pos,last_day FROM egg_events WHERE batch_id=b.id;
 IF NEW.occurred_on<b.received_on OR NEW.occurred_on>today OR NEW.occurred_on<last_day THEN
 RAISE EXCEPTION 'Movements must follow the batch receipt and latest movement and must not be future dated' USING ERRCODE='23514'; END IF;
 IF last_pos IS NULL AND (NEW.occurred_on<>b.received_on OR NEW.kind<>CASE WHEN b.source_kind='collection' THEN 'receipt' ELSE 'opening' END) THEN
 RAISE EXCEPTION 'First movement must be its opening or receipt' USING ERRCODE='23514'; END IF;
 IF NEW.kind IN ('count','reversal') AND member_role(NEW.organization_id) NOT IN ('owner','admin','manager') THEN
 RAISE EXCEPTION 'A manager must review counts and reversals' USING ERRCODE='42501'; END IF;
 IF NEW.kind<>'reversal' AND NEW.kind<>'grade' AND NEW.target_grade IS NOT NULL THEN RAISE EXCEPTION 'Invalid grading movement' USING ERRCODE='23514'; END IF;
 IF NEW.kind='opening' AND (b.source_kind<>'opening' OR last_pos IS NOT NULL OR NEW.quantity<=0) THEN RAISE EXCEPTION 'Invalid opening stock' USING ERRCODE='23514'; END IF;
 IF NEW.kind='receipt' THEN
  IF b.source_kind<>'collection' OR NEW.grade<>'ungraded' THEN RAISE EXCEPTION 'Invalid collection receipt' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(b.unit_id::text));
  SELECT to_jsonb(d)||jsonb_build_object('feed_kg',d.feed_kg::text) INTO source FROM effective_daily_records d WHERE unit_id=b.unit_id AND organization_id=b.organization_id AND recorded_on=b.collected_on;
  IF source IS NULL OR source IS DISTINCT FROM NEW.source_snapshot THEN RAISE EXCEPTION 'Stale collection evidence' USING ERRCODE='23505'; END IF;
  n=(source->>'eggs')::integer-(source->>'cracked')::integer;
  SELECT e.* INTO head FROM egg_events e WHERE batch_id=b.id AND kind='receipt' AND NOT EXISTS(SELECT 1 FROM egg_events s WHERE s.previous_id=e.id);
  IF head.id IS DISTINCT FROM NEW.previous_id THEN RAISE EXCEPTION 'Stale receipt predecessor' USING ERRCODE='23505'; END IF;
  IF NEW.source_quantity<>n OR NEW.quantity<>n-coalesce(head.source_quantity,0) THEN RAISE EXCEPTION 'Receipt must reconcile exact saleable counts' USING ERRCODE='23514'; END IF;
  IF head.source_snapshot=source THEN RAISE EXCEPTION 'Collection evidence was already reconciled' USING ERRCODE='23505'; END IF;
 END IF;
 IF NEW.kind='grade' AND (NEW.target_grade IS NULL OR NEW.quantity<=0) THEN RAISE EXCEPTION 'Invalid grading count' USING ERRCODE='23514'; END IF;
 IF NEW.kind IN ('sale','loss') AND NEW.quantity>=0 THEN RAISE EXCEPTION 'Sale/loss must issue positive whole eggs' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(eggs),0) INTO balance FROM egg_balances WHERE batch_id=b.id AND grade=NEW.grade;
 IF NEW.kind='count' AND (NEW.expected_position<>last_pos OR NEW.quantity<>NEW.stock_count-balance) THEN RAISE EXCEPTION 'Stale physical count' USING ERRCODE='23505'; END IF;
 IF NEW.kind='sale' THEN
  p=NEW.pricing;
  IF p IS NULL OR NEW.currency IS DISTINCT FROM org_currency OR NEW.customer IS NULL OR length(btrim(NEW.customer)) NOT BETWEEN 1 AND 200 OR NEW.reference IS NULL OR length(btrim(NEW.reference)) NOT BETWEEN 3 AND 100 OR NEW.amount IS NULL THEN RAISE EXCEPTION 'Missing sale evidence or currency' USING ERRCODE='23514'; END IF;
  IF p->>'mode'='per-egg' THEN
   IF coalesce(p->>'pricePerEgg','') !~ '^\d{1,9}(\.\d{1,4})?$' OR coalesce(p->>'eggs','') !~ '^\d{1,9}$' THEN RAISE EXCEPTION 'Invalid per-egg price/count' USING ERRCODE='23514'; END IF;
   q=(p->>'eggs')::numeric;price=(p->>'pricePerEgg')::numeric;total=q*price;
  ELSIF p->>'mode'='tray-and-loose' THEN
   IF coalesce(p->>'pricePerTray','') !~ '^\d{1,9}(\.\d{1,4})?$' OR coalesce(p->>'pricePerEgg','') !~ '^\d{1,9}(\.\d{1,4})?$' OR coalesce(p->>'trays','') !~ '^\d{1,9}$' OR coalesce(p->>'looseEggs','') !~ '^\d{1,9}$' OR coalesce(p->>'traySize','') !~ '^\d{1,4}$' THEN RAISE EXCEPTION 'Invalid tray pricing' USING ERRCODE='23514'; END IF;
   IF (p->>'traySize')::integer NOT BETWEEN 1 AND 1000 OR (p->>'looseEggs')::integer>=(p->>'traySize')::integer THEN RAISE EXCEPTION 'Invalid tray/remainder' USING ERRCODE='23514'; END IF;
   price=greatest((p->>'pricePerTray')::numeric,(p->>'pricePerEgg')::numeric);
   q=(p->>'trays')::numeric*(p->>'traySize')::numeric+(p->>'looseEggs')::numeric;
   total=(p->>'trays')::numeric*(p->>'pricePerTray')::numeric+(p->>'looseEggs')::numeric*(p->>'pricePerEgg')::numeric;
  ELSE RAISE EXCEPTION 'Invalid pricing mode' USING ERRCODE='23514'; END IF;
  IF price>100000000 OR q NOT BETWEEN 1 AND 100000000 OR NEW.quantity<>-q OR NEW.amount<>total OR total>=10000000000000000 THEN RAISE EXCEPTION 'Sale amount/count mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.kind='reversal' THEN
  SELECT * INTO old FROM egg_events WHERE id=NEW.reverses_id AND batch_id=b.id;
  IF old.id IS NULL OR old.kind NOT IN ('sale','grade','loss','count') OR NEW.quantity<>-old.quantity OR NEW.grade<>old.grade OR NEW.target_grade IS DISTINCT FROM old.target_grade OR NEW.amount IS DISTINCT FROM -old.amount OR NEW.currency IS DISTINCT FROM old.currency OR NEW.pricing IS DISTINCT FROM old.pricing OR NEW.customer IS DISTINCT FROM old.customer OR NEW.reference IS DISTINCT FROM old.reference THEN RAISE EXCEPTION 'Reversal must exactly reverse an eligible movement' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.target_grade IS NULL THEN
  IF balance+NEW.quantity<0 THEN RAISE EXCEPTION 'Insufficient egg stock; reconcile grading/returns before removing received eggs' USING ERRCODE='23514'; END IF;
 ELSE
  IF balance-NEW.quantity<0 OR coalesce((SELECT eggs FROM egg_balances WHERE batch_id=b.id AND grade=NEW.target_grade),0)+NEW.quantity<0 THEN RAISE EXCEPTION 'Insufficient eggs for grading or its reversal' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER egg_event_check BEFORE INSERT ON egg_events FOR EACH ROW EXECUTE FUNCTION validate_egg_event();
REVOKE ALL ON FUNCTION validate_egg_batch(),require_egg_batch_receipt(),validate_egg_event() FROM PUBLIC;
