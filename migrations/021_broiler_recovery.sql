-- Immutable daily replacements/backfills and withdrawal guidance for genuine administrations.
CREATE UNIQUE INDEX daily_tenant_source ON daily_records(organization_id,unit_id,recorded_on,id);
CREATE TABLE broiler_reviews (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
 unit_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('daily','withdrawal')),
 observed_on date NOT NULL, previous_id uuid, base_record_id uuid, treatment_id uuid,
 mortality integer, feed_kg numeric(20,6), average_weight_g numeric(20,6), sample_size integer, notes text,
 earliest_harvest_on date, position bigint NOT NULL DEFAULT 0,
 expected_position bigint NOT NULL CHECK(expected_position>=0), expected_daily_id uuid,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
 evidence text NOT NULL CHECK(length(btrim(evidence)) BETWEEN 3 AND 2000),
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,
 created_at timestamptz NOT NULL DEFAULT now(), submission jsonb NOT NULL,
 UNIQUE(organization_id,unit_id,id), UNIQUE(position),
 FOREIGN KEY(organization_id,unit_id) REFERENCES production_units(organization_id,id),
 FOREIGN KEY(organization_id,unit_id,previous_id) REFERENCES broiler_reviews(organization_id,unit_id,id),
 FOREIGN KEY(organization_id,unit_id,observed_on,base_record_id) REFERENCES daily_records(organization_id,unit_id,recorded_on,id),
 FOREIGN KEY(organization_id,unit_id,treatment_id) REFERENCES broiler_events(organization_id,unit_id,id),
 CHECK(previous_id IS DISTINCT FROM id),
 CHECK((kind='daily' AND treatment_id IS NULL AND mortality IS NOT NULL AND mortality BETWEEN 0 AND 100000000
   AND feed_kg IS NOT NULL AND feed_kg BETWEEN 0 AND 100000000 AND notes IS NOT NULL AND length(notes)<=2000
   AND earliest_harvest_on IS NULL AND ((average_weight_g IS NULL AND sample_size IS NULL)
    OR (average_weight_g IS NOT NULL AND average_weight_g>0 AND average_weight_g<=1000000 AND sample_size IS NOT NULL AND sample_size BETWEEN 1 AND 100000000)))
 OR (kind='withdrawal' AND treatment_id IS NOT NULL AND base_record_id IS NULL AND mortality IS NULL AND feed_kg IS NULL AND notes IS NULL AND average_weight_g IS NULL AND sample_size IS NULL))
);
CREATE UNIQUE INDEX broiler_review_successor ON broiler_reviews(previous_id) WHERE previous_id IS NOT NULL;
CREATE UNIQUE INDEX broiler_daily_root ON broiler_reviews(unit_id,observed_on) WHERE kind='daily' AND previous_id IS NULL;
CREATE UNIQUE INDEX broiler_withdrawal_root ON broiler_reviews(treatment_id) WHERE kind='withdrawal' AND previous_id IS NULL;
CREATE INDEX ON broiler_reviews(organization_id,unit_id,position);
CREATE INDEX broiler_review_daily_lookup ON broiler_reviews(organization_id,unit_id,kind,observed_on);
CREATE INDEX broiler_review_base_lookup ON broiler_reviews(base_record_id) WHERE base_record_id IS NOT NULL;
CREATE INDEX broiler_review_treatment_lookup ON broiler_reviews(treatment_id,position) WHERE treatment_id IS NOT NULL;
ALTER TABLE broiler_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON broiler_reviews FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY reviewed_insert ON broiler_reviews FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','manager') AND created_by=current_actor() AND created_at=now());
GRANT SELECT,INSERT ON broiler_reviews TO farm_app;
CREATE VIEW current_broiler_reviews WITH (security_invoker=true) AS
 SELECT r.* FROM broiler_reviews r WHERE NOT EXISTS(SELECT 1 FROM broiler_reviews n WHERE n.previous_id=r.id);
CREATE VIEW effective_broiler_treatments WITH (security_invoker=true) AS
 SELECT e.id,e.organization_id,e.unit_id,e.recorded_on,e.product,e.administration,e.quantity,e.position,
 CASE WHEN r.id IS NOT NULL THEN r.earliest_harvest_on ELSE e.earliest_harvest_on END AS earliest_harvest_on,
 r.id AS review_id,r.observed_on AS reviewed_on,r.reason AS review_reason,r.evidence AS review_evidence
 FROM active_broiler_events e LEFT JOIN current_broiler_reviews r ON r.treatment_id=e.id AND r.kind='withdrawal'
 WHERE e.kind='treatment';
GRANT SELECT ON current_broiler_reviews,effective_broiler_treatments TO farm_app;

CREATE OR REPLACE VIEW effective_daily_records WITH (security_invoker=true) AS
 SELECT d.id,d.organization_id,d.unit_id,d.recorded_on,
 coalesce(b.mortality,a.mortality,d.mortality) AS mortality,coalesce(a.eggs,d.eggs) AS eggs,coalesce(a.cracked,d.cracked) AS cracked,
 coalesce(b.feed_kg,a.feed_kg,d.feed_kg) AS feed_kg,
 CASE WHEN b.id IS NOT NULL THEN b.average_weight_g ELSE d.average_weight_g END AS average_weight_g,
 CASE WHEN b.id IS NOT NULL THEN b.sample_size ELSE d.sample_size END AS sample_size,d.water_quality,
 coalesce(b.notes,a.notes,d.notes) AS notes,d.created_at,coalesce(b.id,a.id) AS adjustment_id,d.id AS base_record_id
 FROM daily_records d LEFT JOIN current_layer_adjustments a ON a.base_record_id=d.id AND a.kind='daily'
 LEFT JOIN current_broiler_reviews b ON b.base_record_id=d.id AND b.kind='daily'
 UNION ALL
 SELECT a.id,a.organization_id,a.unit_id,a.observed_on,a.mortality,a.eggs,a.cracked,a.feed_kg,
 NULL::numeric,NULL::integer,NULL::jsonb,a.notes,a.created_at,a.id,NULL::uuid
 FROM current_layer_adjustments a WHERE a.kind='daily' AND a.base_record_id IS NULL
 UNION ALL
 SELECT b.id,b.organization_id,b.unit_id,b.observed_on,b.mortality,0,0,b.feed_kg,b.average_weight_g,b.sample_size,NULL::jsonb,b.notes,b.created_at,b.id,NULL::uuid
 FROM current_broiler_reviews b WHERE b.kind='daily' AND b.base_record_id IS NULL;

CREATE FUNCTION broiler_latest_position(p_unit uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT greatest(coalesce((SELECT max(position) FROM broiler_events WHERE unit_id=p_unit),0),coalesce((SELECT max(position) FROM broiler_reviews WHERE unit_id=p_unit),0));
$$;
CREATE FUNCTION check_broiler_population(p_unit uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE balance bigint; r record;
BEGIN
 SELECT opening_count INTO balance FROM production_units WHERE id=p_unit AND kind='broilers';
 IF balance IS NULL THEN RETURN; END IF;
 FOR r IN SELECT d.recorded_on AS day,0 AS priority,0::bigint AS position,d.mortality AS removed,d.sample_size FROM effective_daily_records d WHERE d.unit_id=p_unit
 UNION ALL SELECT e.recorded_on,1,e.position,e.quantity,NULL::integer FROM active_broiler_events e WHERE e.unit_id=p_unit AND e.kind IN ('cull','harvest')
 ORDER BY day,priority,position LOOP
  balance:=balance-r.removed;
  IF balance<0 OR r.sample_size>balance THEN RAISE EXCEPTION 'Revised daily evidence exceeds the population at a later sample or withdrawal' USING ERRCODE='23514'; END IF;
 END LOOP;
END $$;
CREATE FUNCTION validate_broiler_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u production_units; t broiler_events; p broiler_reviews; head uuid; base uuid; latest uuid; today date; last_day date;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
 SELECT * INTO u FROM production_units WHERE id=NEW.unit_id AND organization_id=NEW.organization_id;
 IF u.id IS NULL OR u.kind<>'broilers' THEN RAISE EXCEPTION 'Choose a visible broiler batch' USING ERRCODE='23514'; END IF;
 SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
 SELECT id INTO latest FROM effective_daily_records WHERE unit_id=u.id ORDER BY recorded_on DESC LIMIT 1;
 IF NEW.expected_position<>broiler_latest_position(u.id) OR NEW.expected_daily_id IS DISTINCT FROM latest THEN RAISE EXCEPTION 'Stale broiler recovery review' USING ERRCODE='23505'; END IF;
 IF NEW.observed_on<u.stocked_on OR NEW.observed_on>today THEN RAISE EXCEPTION 'Invalid recovery date' USING ERRCODE='23514'; END IF;
 IF NEW.kind='daily' THEN
  SELECT id INTO head FROM current_broiler_reviews WHERE unit_id=u.id AND kind='daily' AND observed_on=NEW.observed_on;
  SELECT id INTO base FROM daily_records WHERE unit_id=u.id AND recorded_on=NEW.observed_on;
  IF base IS DISTINCT FROM NEW.base_record_id THEN RAISE EXCEPTION 'Original daily evidence mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO t FROM active_broiler_events WHERE id=NEW.treatment_id AND unit_id=u.id AND kind='treatment';
  IF t.id IS NULL THEN RAISE EXCEPTION 'Choose a genuine active administration' USING ERRCODE='23514'; END IF;
  SELECT id INTO head FROM current_broiler_reviews WHERE treatment_id=t.id AND kind='withdrawal';
  SELECT greatest((SELECT max(recorded_on) FROM effective_daily_records WHERE unit_id=u.id),(SELECT max(recorded_on) FROM broiler_events WHERE unit_id=u.id),(SELECT max(observed_on) FROM broiler_reviews WHERE unit_id=u.id AND kind='withdrawal')) INTO last_day;
  IF NEW.observed_on<last_day OR NEW.earliest_harvest_on<t.recorded_on THEN RAISE EXCEPTION 'Review date must follow activity; guidance cannot precede administration' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.previous_id IS DISTINCT FROM head THEN RAISE EXCEPTION 'Stale review predecessor' USING ERRCODE='23505'; END IF;
 IF NEW.previous_id IS NOT NULL THEN
  SELECT * INTO p FROM broiler_reviews WHERE id=NEW.previous_id;
  IF p.kind<>NEW.kind OR p.unit_id<>NEW.unit_id OR (NEW.kind='daily' AND (p.observed_on<>NEW.observed_on OR p.base_record_id IS DISTINCT FROM NEW.base_record_id)) OR (NEW.kind='withdrawal' AND p.treatment_id<>NEW.treatment_id) THEN RAISE EXCEPTION 'Review lineage mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.position:=nextval('broiler_event_position');
 RETURN NEW;
END $$;
CREATE TRIGGER broiler_review_check BEFORE INSERT ON broiler_reviews FOR EACH ROW EXECUTE FUNCTION validate_broiler_review();
CREATE FUNCTION check_broiler_population_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM check_broiler_population(NEW.unit_id); RETURN NEW; END $$;
CREATE TRIGGER broiler_review_population AFTER INSERT ON broiler_reviews FOR EACH ROW EXECUTE FUNCTION check_broiler_population_trigger();
CREATE TRIGGER broiler_event_population AFTER INSERT ON broiler_events FOR EACH ROW EXECUTE FUNCTION check_broiler_population_trigger();

CREATE OR REPLACE FUNCTION validate_broiler_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u production_units; today date; last_day date; last_daily uuid; last_pos bigint; balance bigint; original broiler_events; curr text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
 SELECT * INTO u FROM production_units WHERE id=NEW.unit_id AND organization_id=NEW.organization_id;
 IF u.id IS NULL OR u.kind<>'broilers' THEN RAISE EXCEPTION 'Choose a visible broiler batch' USING ERRCODE='23514'; END IF;
 SELECT (now() AT TIME ZONE timezone)::date,currency INTO today,curr FROM organizations WHERE id=NEW.organization_id;
 SELECT id,recorded_on INTO last_daily,last_day FROM effective_daily_records WHERE unit_id=u.id ORDER BY recorded_on DESC LIMIT 1;
 SELECT broiler_latest_position(u.id),greatest(last_day,(SELECT max(recorded_on) FROM broiler_events WHERE unit_id=u.id),(SELECT max(observed_on) FROM broiler_reviews WHERE unit_id=u.id AND kind='withdrawal')) INTO last_pos,last_day;
 IF NEW.expected_position<>last_pos OR NEW.expected_daily_id IS DISTINCT FROM last_daily THEN RAISE EXCEPTION 'Stale broiler review' USING ERRCODE='23505'; END IF;
 IF NEW.recorded_on<u.stocked_on OR NEW.recorded_on>today OR NEW.recorded_on<last_day THEN RAISE EXCEPTION 'Broiler events must be chronological and not future dated' USING ERRCODE='23514'; END IF;
 SELECT recorded_balance INTO balance FROM production_population_balances WHERE id=u.id;
 IF NEW.quantity>balance THEN RAISE EXCEPTION 'Bird count exceeds recorded balance' USING ERRCODE='23514'; END IF;
 IF NEW.earliest_harvest_on<NEW.recorded_on THEN RAISE EXCEPTION 'Withdrawal date cannot precede treatment' USING ERRCODE='23514'; END IF;
 IF NEW.kind='harvest' THEN
  IF EXISTS(SELECT 1 FROM effective_broiler_treatments WHERE unit_id=u.id AND (earliest_harvest_on IS NULL OR earliest_harvest_on>NEW.recorded_on)) THEN RAISE EXCEPTION 'Recorded medication withdrawal prevents harvest' USING ERRCODE='23514'; END IF;
  IF NEW.price_basis IN ('bird','kg') AND (NEW.currency IS DISTINCT FROM curr OR NEW.amount IS DISTINCT FROM round(NEW.price_per_unit*CASE WHEN NEW.price_basis='bird' THEN NEW.quantity ELSE NEW.weight_kg END,4)) THEN RAISE EXCEPTION 'Harvest price snapshot mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.kind='void' THEN
  SELECT * INTO original FROM active_broiler_events WHERE id=NEW.void_of_id AND unit_id=u.id AND organization_id=NEW.organization_id;
  IF original.id IS NULL THEN RAISE EXCEPTION 'Original event is missing or already voided' USING ERRCODE='23514'; END IF;
  IF original.kind IN ('cull','harvest') AND (EXISTS(SELECT 1 FROM effective_daily_records WHERE unit_id=u.id AND recorded_on>original.recorded_on)
    OR EXISTS(SELECT 1 FROM active_broiler_events WHERE unit_id=u.id AND position>original.position) OR EXISTS(SELECT 1 FROM broiler_reviews WHERE unit_id=u.id AND position>original.position)) THEN
   RAISE EXCEPTION 'Correct the latest withdrawal before any subsequent production activity' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.position:=nextval('broiler_event_position');
 RETURN NEW;
END $$;

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
 IF unit.kind='broilers' AND (EXISTS(SELECT 1 FROM broiler_events WHERE unit_id=unit.id AND recorded_on>=NEW.recorded_on) OR EXISTS(SELECT 1 FROM broiler_reviews WHERE unit_id=unit.id AND kind='withdrawal' AND observed_on>=NEW.recorded_on)) THEN
 RAISE EXCEPTION 'Enter the daily observation before lifecycle events on that date' USING ERRCODE='23514'; END IF;
 SELECT recorded_balance INTO balance FROM production_population_balances WHERE id=unit.id;
 IF NEW.mortality>balance THEN RAISE EXCEPTION 'Mortality exceeds recorded population balance' USING ERRCODE='23514'; END IF;
 IF unit.kind<>'layers' AND (NEW.eggs>0 OR NEW.cracked>0) THEN RAISE EXCEPTION 'Egg records require layers' USING ERRCODE='23514'; END IF;
 IF unit.kind<>'catfish' AND NEW.water_quality IS NOT NULL THEN RAISE EXCEPTION 'Water records require a fish unit' USING ERRCODE='23514'; END IF;
 IF NEW.sample_size>balance-NEW.mortality THEN RAISE EXCEPTION 'Sample exceeds live stock' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION broiler_latest_position(uuid),check_broiler_population(uuid),validate_broiler_review(),check_broiler_population_trigger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION broiler_latest_position(uuid),check_broiler_population(uuid) TO farm_app;
