-- Actual broiler lifecycle observations and reviewed whole-bird withdrawals.
CREATE SEQUENCE broiler_event_position;
CREATE TABLE broiler_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
 unit_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('health','treatment','cull','harvest','void')),
 recorded_on date NOT NULL, position bigint NOT NULL DEFAULT 0,
 expected_position bigint NOT NULL CHECK(expected_position>=0), expected_daily_id uuid,
 quantity integer, weight_kg numeric(20,6),
 description text NOT NULL CHECK(length(btrim(description)) BETWEEN 3 AND 2000),
 product text, administration text, earliest_harvest_on date,
 price_basis text, price_per_unit numeric(20,4), amount numeric(20,4), currency text, reference text, customer text,
 void_of_id uuid, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
 evidence text NOT NULL CHECK(length(btrim(evidence)) BETWEEN 3 AND 2000),
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(), submission jsonb NOT NULL,
 UNIQUE(organization_id,unit_id,id), UNIQUE(position),
 FOREIGN KEY(organization_id,unit_id) REFERENCES production_units(organization_id,id),
 FOREIGN KEY(organization_id,unit_id,void_of_id) REFERENCES broiler_events(organization_id,unit_id,id),
 CHECK(void_of_id IS DISTINCT FROM id),
 CHECK(quantity IS NULL OR quantity BETWEEN 1 AND 100000000),
 CHECK(weight_kg IS NULL OR (weight_kg>0 AND weight_kg<=100000000)),
 CHECK(price_per_unit IS NULL OR price_per_unit BETWEEN 0 AND 100000000),
 CHECK((kind='health' AND quantity IS NOT NULL AND weight_kg IS NULL AND product IS NULL AND administration IS NULL AND earliest_harvest_on IS NULL AND void_of_id IS NULL)
 OR (kind='treatment' AND quantity IS NOT NULL AND weight_kg IS NULL AND length(btrim(product)) BETWEEN 2 AND 200 AND length(btrim(administration)) BETWEEN 3 AND 2000 AND void_of_id IS NULL)
 OR (kind='cull' AND quantity IS NOT NULL AND product IS NULL AND administration IS NULL AND earliest_harvest_on IS NULL AND void_of_id IS NULL)
 OR (kind='harvest' AND quantity IS NOT NULL AND weight_kg IS NOT NULL AND product IS NULL AND administration IS NULL AND earliest_harvest_on IS NULL AND void_of_id IS NULL)
 OR (kind='void' AND quantity IS NULL AND weight_kg IS NULL AND product IS NULL AND administration IS NULL AND earliest_harvest_on IS NULL AND void_of_id IS NOT NULL)),
 CHECK((kind='treatment' AND product IS NOT NULL AND administration IS NOT NULL) OR kind<>'treatment'),
 CHECK((kind='harvest' AND price_basis IS NOT NULL AND price_basis IN ('unpriced','bird','kg') AND
  ((price_basis='unpriced' AND price_per_unit IS NULL AND amount IS NULL AND currency IS NULL AND reference IS NULL AND customer IS NULL)
   OR (price_basis IN ('bird','kg') AND price_per_unit IS NOT NULL AND amount IS NOT NULL AND amount>=0 AND currency ~ '^[A-Z]{3}$' AND currency IS NOT NULL
    AND length(btrim(reference)) BETWEEN 3 AND 100 AND reference IS NOT NULL AND length(btrim(customer)) BETWEEN 2 AND 200 AND customer IS NOT NULL)))
 OR (kind<>'harvest' AND price_basis IS NULL AND price_per_unit IS NULL AND amount IS NULL AND currency IS NULL AND reference IS NULL AND customer IS NULL))
);
CREATE UNIQUE INDEX broiler_void_once ON broiler_events(void_of_id) WHERE void_of_id IS NOT NULL;
CREATE UNIQUE INDEX broiler_sale_reference ON broiler_events(organization_id,reference) WHERE reference IS NOT NULL;
CREATE INDEX ON broiler_events(organization_id,unit_id,position);
ALTER TABLE broiler_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON broiler_events FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY reviewed_insert ON broiler_events FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','manager') AND created_by=current_actor() AND created_at=now());
GRANT SELECT,INSERT ON broiler_events TO farm_app;
GRANT USAGE ON SEQUENCE broiler_event_position TO farm_app;
CREATE VIEW active_broiler_events WITH (security_invoker=true) AS
 SELECT e.* FROM broiler_events e WHERE e.kind<>'void' AND NOT EXISTS(SELECT 1 FROM broiler_events v WHERE v.void_of_id=e.id);
GRANT SELECT ON active_broiler_events TO farm_app;
CREATE OR REPLACE VIEW production_population_balances WITH (security_invoker=true) AS
 SELECT u.id,u.organization_id,
 coalesce(a.opening_hens,u.opening_count)-coalesce((SELECT sum(d.mortality) FROM effective_daily_records d
 WHERE d.unit_id=u.id AND d.recorded_on>=coalesce(a.observed_on,u.stocked_on)),0)
 -coalesce((SELECT sum(e.quantity) FROM active_broiler_events e WHERE e.unit_id=u.id AND e.kind IN ('cull','harvest')),0) AS recorded_balance,
 a.id AS census_id,a.observed_on AS census_on
 FROM production_units u LEFT JOIN LATERAL(SELECT c.* FROM current_layer_adjustments c
 WHERE c.unit_id=u.id AND c.kind='census' ORDER BY c.observed_on DESC LIMIT 1) a ON true;

CREATE FUNCTION validate_broiler_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u production_units; today date; last_day date; last_daily uuid; last_pos bigint; balance bigint; original broiler_events; curr text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
 SELECT * INTO u FROM production_units WHERE id=NEW.unit_id AND organization_id=NEW.organization_id;
 IF u.id IS NULL OR u.kind<>'broilers' THEN RAISE EXCEPTION 'Choose a visible broiler batch' USING ERRCODE='23514'; END IF;
 SELECT (now() AT TIME ZONE timezone)::date,currency INTO today,curr FROM organizations WHERE id=NEW.organization_id;
 SELECT id,recorded_on INTO last_daily,last_day FROM daily_records WHERE unit_id=u.id ORDER BY recorded_on DESC LIMIT 1;
 SELECT coalesce(max(position),0),greatest(last_day,max(recorded_on)) INTO last_pos,last_day FROM broiler_events WHERE unit_id=u.id;
 IF NEW.expected_position<>last_pos OR NEW.expected_daily_id IS DISTINCT FROM last_daily THEN RAISE EXCEPTION 'Stale broiler review' USING ERRCODE='23505'; END IF;
 IF NEW.recorded_on<u.stocked_on OR NEW.recorded_on>today OR NEW.recorded_on<last_day THEN RAISE EXCEPTION 'Broiler events must be chronological and not future dated' USING ERRCODE='23514'; END IF;
 SELECT recorded_balance INTO balance FROM production_population_balances WHERE id=u.id;
 IF NEW.quantity>balance THEN RAISE EXCEPTION 'Bird count exceeds recorded balance' USING ERRCODE='23514'; END IF;
 IF NEW.earliest_harvest_on<NEW.recorded_on THEN RAISE EXCEPTION 'Withdrawal date cannot precede treatment' USING ERRCODE='23514'; END IF;
 IF NEW.kind='harvest' THEN
  IF EXISTS(SELECT 1 FROM active_broiler_events WHERE unit_id=u.id AND kind='treatment' AND (earliest_harvest_on IS NULL OR earliest_harvest_on>NEW.recorded_on)) THEN RAISE EXCEPTION 'Recorded medication withdrawal prevents harvest' USING ERRCODE='23514'; END IF;
  IF NEW.price_basis IN ('bird','kg') AND (NEW.currency IS DISTINCT FROM curr OR NEW.amount IS DISTINCT FROM round(NEW.price_per_unit*CASE WHEN NEW.price_basis='bird' THEN NEW.quantity ELSE NEW.weight_kg END,4)) THEN RAISE EXCEPTION 'Harvest price snapshot mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.kind='void' THEN
  SELECT * INTO original FROM active_broiler_events WHERE id=NEW.void_of_id AND unit_id=u.id AND organization_id=NEW.organization_id;
  IF original.id IS NULL THEN RAISE EXCEPTION 'Original event is missing or already voided' USING ERRCODE='23514'; END IF;
  IF original.kind IN ('cull','harvest') AND (EXISTS(SELECT 1 FROM daily_records WHERE unit_id=u.id AND recorded_on>original.recorded_on)
    OR EXISTS(SELECT 1 FROM active_broiler_events WHERE unit_id=u.id AND position>original.position)) THEN
   RAISE EXCEPTION 'Correct the latest withdrawal before any subsequent production activity' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.position:=nextval('broiler_event_position');
 RETURN NEW;
END $$;
CREATE TRIGGER broiler_event_check BEFORE INSERT ON broiler_events FOR EACH ROW EXECUTE FUNCTION validate_broiler_event();

-- Keep daily observations before same-day withdrawals; all writers share the unit lock.
CREATE OR REPLACE FUNCTION validate_daily_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unit production_units; last_date date; balance bigint; today date;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
 SELECT * INTO unit FROM production_units WHERE id=NEW.unit_id AND organization_id=NEW.organization_id;
 IF unit.id IS NULL THEN RAISE EXCEPTION 'unit not found' USING ERRCODE='23503'; END IF;
 SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
 SELECT max(recorded_on) INTO last_date FROM effective_daily_records WHERE unit_id=NEW.unit_id;
 IF NEW.recorded_on<unit.stocked_on OR NEW.recorded_on>today OR (last_date IS NOT NULL AND NEW.recorded_on<=last_date) THEN
 RAISE EXCEPTION 'Daily records must be chronological; use reviewed layer recovery for earlier dates' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM current_layer_adjustments WHERE unit_id=NEW.unit_id AND kind='census' AND observed_on>NEW.recorded_on) THEN
 RAISE EXCEPTION 'Use reviewed recovery for dates before an existing census' USING ERRCODE='23514'; END IF;
 IF unit.kind='broilers' AND EXISTS(SELECT 1 FROM broiler_events WHERE unit_id=unit.id AND recorded_on>=NEW.recorded_on) THEN
 RAISE EXCEPTION 'Enter the daily observation before lifecycle events on that date' USING ERRCODE='23514'; END IF;
 SELECT recorded_balance INTO balance FROM production_population_balances WHERE id=unit.id;
 IF NEW.mortality>balance THEN RAISE EXCEPTION 'Mortality exceeds recorded population balance' USING ERRCODE='23514'; END IF;
 IF unit.kind<>'layers' AND (NEW.eggs>0 OR NEW.cracked>0) THEN RAISE EXCEPTION 'Egg records require layers' USING ERRCODE='23514'; END IF;
 IF unit.kind<>'catfish' AND NEW.water_quality IS NOT NULL THEN RAISE EXCEPTION 'Water records require a fish unit' USING ERRCODE='23514'; END IF;
 IF NEW.sample_size>balance-NEW.mortality THEN RAISE EXCEPTION 'Sample exceeds live stock' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION validate_broiler_event() FROM PUBLIC;
