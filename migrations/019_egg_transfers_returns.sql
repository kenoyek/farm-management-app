-- Atomic paired store transfers and original-price partial returns.
ALTER TABLE egg_batches ADD COLUMN parent_batch_id uuid;
ALTER TABLE egg_batches ADD FOREIGN KEY(organization_id,parent_batch_id) REFERENCES egg_batches(organization_id,id);
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='egg_batches'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%source_kind%' LOOP EXECUTE format('ALTER TABLE egg_batches DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE egg_batches ADD CHECK(source_kind IN ('opening','collection','transfer'));
ALTER TABLE egg_batches ADD CHECK((source_kind='opening' AND unit_id IS NULL AND collected_on IS NULL AND parent_batch_id IS NULL)
 OR(source_kind='collection' AND unit_id IS NOT NULL AND collected_on IS NOT NULL AND parent_batch_id IS NULL AND received_on>=collected_on)
 OR(source_kind='transfer' AND unit_id IS NULL AND collected_on IS NULL AND parent_batch_id IS NOT NULL AND parent_batch_id<>id));
ALTER TABLE egg_events ADD COLUMN destination_batch_id uuid, ADD COLUMN return_of_id uuid,
 ADD COLUMN return_tray_eggs integer, ADD COLUMN return_loose_eggs integer, ADD COLUMN expected_return_position bigint;
ALTER TABLE egg_events ADD FOREIGN KEY(organization_id,destination_batch_id) REFERENCES egg_batches(organization_id,id);
ALTER TABLE egg_events ADD FOREIGN KEY(organization_id,batch_id,return_of_id) REFERENCES egg_events(organization_id,batch_id,id);
ALTER TABLE egg_events DROP CONSTRAINT egg_events_kind_check;
ALTER TABLE egg_events ADD CHECK(kind IN ('opening','receipt','grade','sale','loss','count','reversal','transfer','return'));
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='egg_events'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%pricing%' LOOP EXECUTE format('ALTER TABLE egg_events DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE egg_events ADD CHECK(kind IN ('sale','reversal','return') OR(pricing IS NULL AND amount IS NULL AND currency IS NULL AND customer IS NULL AND reference IS NULL));
ALTER TABLE egg_events ADD CHECK((destination_batch_id IS NULL OR(kind IN ('transfer','reversal') AND destination_batch_id<>batch_id)) AND(kind<>'transfer' OR destination_batch_id IS NOT NULL));
ALTER TABLE egg_events ADD CHECK(
 (return_of_id IS NULL AND return_tray_eggs IS NULL AND return_loose_eggs IS NULL AND expected_return_position IS NULL)
 OR(kind IN ('return','reversal') AND return_of_id IS NOT NULL AND return_tray_eggs IS NOT NULL AND return_loose_eggs IS NOT NULL
 AND return_tray_eggs BETWEEN 0 AND 100000000 AND return_loose_eggs BETWEEN 0 AND 100000000 AND return_tray_eggs+return_loose_eggs BETWEEN 1 AND 100000000
 AND((kind='return' AND expected_return_position IS NOT NULL) OR(kind='reversal' AND expected_return_position IS NULL))));
ALTER TABLE egg_events ADD CHECK(kind<>'return' OR return_of_id IS NOT NULL);
CREATE UNIQUE INDEX egg_transfer_destination ON egg_events(destination_batch_id) WHERE kind='transfer';
CREATE UNIQUE INDEX egg_return_reference ON egg_events(organization_id,reference) WHERE kind='return';
CREATE INDEX ON egg_events(return_of_id,position);
CREATE OR REPLACE VIEW egg_movements WITH(security_invoker=true) AS
 SELECT id AS event_id,position,organization_id,batch_id,occurred_on,grade,CASE WHEN target_grade IS NOT NULL THEN -quantity ELSE quantity END AS eggs FROM egg_events
 UNION ALL SELECT id,position,organization_id,batch_id,occurred_on,target_grade,quantity FROM egg_events WHERE target_grade IS NOT NULL
 UNION ALL SELECT id,position,organization_id,destination_batch_id,occurred_on,grade,-quantity FROM egg_events WHERE destination_batch_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_egg_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f uuid; today date; baseline date; parent egg_batches;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.organization_id::text),618);
 SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
 IF today IS NULL OR NEW.received_on>today THEN RAISE EXCEPTION 'Invalid receipt date' USING ERRCODE='23514'; END IF;
 SELECT min(received_on) INTO baseline FROM egg_batches WHERE store_id=NEW.store_id AND source_kind='opening';
 IF NEW.source_kind='opening' THEN
  IF EXISTS(SELECT 1 FROM egg_events e JOIN egg_batches b ON (b.id=e.batch_id OR b.id=e.destination_batch_id) WHERE b.store_id=NEW.store_id AND e.kind<>'opening') OR (baseline IS NOT NULL AND baseline<>NEW.received_on) THEN
   RAISE EXCEPTION 'Opening stock must share one opening-of-day baseline before other store operations' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.source_kind='collection' THEN
  IF baseline IS NOT NULL AND NEW.collected_on<baseline THEN RAISE EXCEPTION 'Collections before the opening baseline cannot be received again' USING ERRCODE='23514'; END IF;
  SELECT s.farm_id INTO f FROM egg_stores s JOIN production_units u ON u.farm_id=s.farm_id AND u.organization_id=s.organization_id
  WHERE s.id=NEW.store_id AND s.organization_id=NEW.organization_id AND u.id=NEW.unit_id AND u.kind='layers' AND NEW.collected_on>=u.stocked_on;
  IF f IS NULL THEN RAISE EXCEPTION 'Collection and store must belong to the same layer farm' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.source_kind='transfer' THEN
  SELECT * INTO parent FROM egg_batches WHERE id=NEW.parent_batch_id AND organization_id=NEW.organization_id;
  IF parent.id IS NULL OR parent.store_id=NEW.store_id OR NEW.received_on<parent.received_on OR (baseline IS NOT NULL AND NEW.received_on<baseline) THEN RAISE EXCEPTION 'Invalid transfer lineage, store or opening date' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION require_egg_batch_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_kind='transfer' THEN
 IF NOT EXISTS(SELECT 1 FROM egg_events WHERE destination_batch_id=NEW.id AND kind='transfer') THEN RAISE EXCEPTION 'A transferred batch requires its atomic incoming movement' USING ERRCODE='23514'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM egg_events WHERE batch_id=NEW.id AND kind=CASE WHEN NEW.source_kind='collection' THEN 'receipt' ELSE 'opening' END) THEN
 RAISE EXCEPTION 'A batch requires an atomic opening or collection receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION validate_egg_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b egg_batches; old egg_events; head egg_events; source jsonb; n integer; last_pos bigint; last_day date;
 balance bigint; today date; org_currency text; p jsonb; q numeric; total numeric; price numeric; dest egg_batches; returned_t bigint; returned_l bigint; sold_t bigint; sold_l bigint; latest bigint; latest_id uuid; credit numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.organization_id::text),618);
 -- Allocate ordering under the organization lock, including direct runtime inserts.
 NEW.position=nextval('egg_events_position_seq');
 SELECT * INTO b FROM egg_batches WHERE id=NEW.batch_id AND organization_id=NEW.organization_id;
 IF b.id IS NULL THEN RAISE EXCEPTION 'Batch not found' USING ERRCODE='23503'; END IF;
 SELECT (now() AT TIME ZONE timezone)::date,currency INTO today,org_currency FROM organizations WHERE id=NEW.organization_id;
 SELECT max(position),max(occurred_on) INTO last_pos,last_day FROM egg_events WHERE batch_id=b.id OR destination_batch_id=b.id;
 IF NEW.occurred_on<b.received_on OR NEW.occurred_on>today OR NEW.occurred_on<last_day THEN
 RAISE EXCEPTION 'Movements must follow the batch receipt and latest movement and must not be future dated' USING ERRCODE='23514'; END IF;
 IF last_pos IS NULL AND (NEW.occurred_on<>b.received_on OR NEW.kind<>CASE WHEN b.source_kind='collection' THEN 'receipt' ELSE 'opening' END) THEN
 RAISE EXCEPTION 'First movement must be its opening or receipt' USING ERRCODE='23514'; END IF;
 IF NEW.kind IN ('count','reversal','return') AND member_role(NEW.organization_id) NOT IN ('owner','admin','manager') THEN
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
  IF old.id IS NULL OR old.kind NOT IN ('sale','grade','loss','count','transfer','return') OR NEW.quantity<>-old.quantity OR NEW.grade<>old.grade OR NEW.target_grade IS DISTINCT FROM old.target_grade OR NEW.amount IS DISTINCT FROM -old.amount OR NEW.currency IS DISTINCT FROM old.currency OR NEW.pricing IS DISTINCT FROM old.pricing OR NEW.customer IS DISTINCT FROM old.customer OR NEW.reference IS DISTINCT FROM old.reference OR NEW.destination_batch_id IS DISTINCT FROM old.destination_batch_id OR NEW.return_of_id IS DISTINCT FROM old.return_of_id OR NEW.return_tray_eggs IS DISTINCT FROM old.return_tray_eggs OR NEW.return_loose_eggs IS DISTINCT FROM old.return_loose_eggs THEN RAISE EXCEPTION 'Reversal must exactly reverse an eligible movement' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.kind NOT IN ('return','reversal') AND NEW.return_of_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid return link' USING ERRCODE='23514'; END IF;
 IF NEW.kind='transfer' THEN
  SELECT * INTO dest FROM egg_batches WHERE id=NEW.destination_batch_id AND organization_id=NEW.organization_id;
  IF NEW.quantity>=0 OR NEW.target_grade IS NOT NULL OR dest.id IS NULL OR dest.source_kind<>'transfer' OR dest.parent_batch_id<>b.id OR dest.store_id=b.store_id OR dest.received_on<>NEW.occurred_on THEN RAISE EXCEPTION 'Invalid paired transfer' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.kind='return' THEN
  SELECT * INTO old FROM egg_events WHERE id=NEW.return_of_id AND batch_id=b.id AND kind='sale';
  IF old.id IS NULL OR EXISTS(SELECT 1 FROM egg_events WHERE reverses_id=old.id) THEN RAISE EXCEPTION 'Sale is missing or already reversed' USING ERRCODE='23514'; END IF;
  SELECT max(position) INTO latest FROM egg_events WHERE id=old.id OR return_of_id=old.id OR reverses_id=old.id;
  IF NEW.expected_return_position<>latest THEN RAISE EXCEPTION 'Stale sale return state' USING ERRCODE='23505'; END IF;
  SELECT coalesce(sum(return_tray_eggs),0),coalesce(sum(return_loose_eggs),0) INTO returned_t,returned_l FROM egg_events r WHERE r.kind='return' AND r.return_of_id=old.id AND NOT EXISTS(SELECT 1 FROM egg_events x WHERE x.reverses_id=r.id);
  p=old.pricing;
  IF p->>'mode'='per-egg' THEN sold_t=0;sold_l=-old.quantity;credit=NEW.return_loose_eggs*(p->>'pricePerEgg')::numeric;
  ELSE sold_t=(p->>'trays')::bigint*(p->>'traySize')::bigint;sold_l=(p->>'looseEggs')::bigint;
   credit=round((returned_t+NEW.return_tray_eggs)*(p->>'pricePerTray')::numeric/(p->>'traySize')::numeric,4)-round(returned_t*(p->>'pricePerTray')::numeric/(p->>'traySize')::numeric,4)+NEW.return_loose_eggs*(p->>'pricePerEgg')::numeric;
  END IF;
  IF NEW.return_tray_eggs+returned_t>sold_t OR NEW.return_loose_eggs+returned_l>sold_l OR NEW.quantity<0 OR NEW.quantity>NEW.return_tray_eggs+NEW.return_loose_eggs OR NEW.grade<>old.grade OR NEW.target_grade IS NOT NULL OR NEW.pricing IS DISTINCT FROM old.pricing OR NEW.currency IS DISTINCT FROM old.currency OR NEW.customer IS DISTINCT FROM old.customer OR NEW.amount IS DISTINCT FROM -credit OR NEW.reference IS NULL OR length(btrim(NEW.reference)) NOT BETWEEN 3 AND 100 THEN RAISE EXCEPTION 'Return exceeds original quantities or credit/stock evidence differs' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.kind='reversal' THEN
  SELECT * INTO old FROM egg_events WHERE id=NEW.reverses_id;
  IF old.kind='sale' AND EXISTS(SELECT 1 FROM egg_events r WHERE r.kind='return' AND r.return_of_id=old.id AND NOT EXISTS(SELECT 1 FROM egg_events x WHERE x.reverses_id=r.id)) THEN RAISE EXCEPTION 'Sale has active partial returns; return the remaining quantities instead' USING ERRCODE='23514'; END IF;
  IF old.kind='return' THEN
   SELECT r.id INTO latest_id FROM egg_events r WHERE r.kind='return' AND r.return_of_id=old.return_of_id AND NOT EXISTS(SELECT 1 FROM egg_events x WHERE x.reverses_id=r.id) ORDER BY r.position DESC LIMIT 1;
   IF latest_id<>old.id THEN RAISE EXCEPTION 'Reverse the latest active return first to preserve credit rounding' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF NEW.destination_batch_id IS NOT NULL THEN
  SELECT * INTO dest FROM egg_batches WHERE id=NEW.destination_batch_id;
  SELECT max(occurred_on) INTO last_day FROM egg_events WHERE batch_id=dest.id OR destination_batch_id=dest.id;
  IF NEW.occurred_on<dest.received_on OR NEW.occurred_on<last_day OR coalesce((SELECT eggs FROM egg_balances WHERE batch_id=dest.id AND grade=NEW.grade),0)-NEW.quantity<0 THEN RAISE EXCEPTION 'Insufficient destination stock or stale transfer date' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.target_grade IS NULL THEN
  IF balance+NEW.quantity<0 THEN RAISE EXCEPTION 'Insufficient egg stock; reconcile grading/returns before removing received eggs' USING ERRCODE='23514'; END IF;
 ELSE
  IF balance-NEW.quantity<0 OR coalesce((SELECT eggs FROM egg_balances WHERE batch_id=b.id AND grade=NEW.target_grade),0)+NEW.quantity<0 THEN RAISE EXCEPTION 'Insufficient eggs for grading or its reversal' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
