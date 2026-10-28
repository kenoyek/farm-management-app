-- Append-only reviewed replacements and opening-of-day physical counts.
CREATE TABLE layer_adjustments (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
 unit_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('daily','census')), observed_on date NOT NULL,
 previous_id uuid, base_record_id uuid REFERENCES daily_records(id),
 mortality integer, eggs integer, cracked integer, feed_kg numeric(20,6), notes text,
 opening_hens integer, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
 evidence text NOT NULL CHECK(length(btrim(evidence)) BETWEEN 3 AND 2000),
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,
 created_at timestamptz NOT NULL DEFAULT now(), submission jsonb NOT NULL,
 UNIQUE(organization_id,unit_id,kind,observed_on,id),
 FOREIGN KEY(organization_id,unit_id) REFERENCES production_units(organization_id,id),
 FOREIGN KEY(organization_id,unit_id,kind,observed_on,previous_id)
 REFERENCES layer_adjustments(organization_id,unit_id,kind,observed_on,id),
 CHECK(previous_id IS DISTINCT FROM id),
 CHECK((kind='daily' AND mortality BETWEEN 0 AND 100000000 AND eggs BETWEEN 0 AND 100000000
   AND cracked BETWEEN 0 AND eggs AND feed_kg BETWEEN 0 AND 100000000 AND notes IS NOT NULL
   AND length(notes)<=2000 AND opening_hens IS NULL
   AND mortality IS NOT NULL AND eggs IS NOT NULL AND cracked IS NOT NULL AND feed_kg IS NOT NULL)
 OR (kind='census' AND opening_hens BETWEEN 0 AND 100000000 AND opening_hens IS NOT NULL
   AND base_record_id IS NULL AND mortality IS NULL AND eggs IS NULL AND cracked IS NULL AND feed_kg IS NULL AND notes IS NULL))
);
CREATE UNIQUE INDEX layer_adjustment_root ON layer_adjustments(unit_id,kind,observed_on) WHERE previous_id IS NULL;
CREATE UNIQUE INDEX layer_adjustment_successor ON layer_adjustments(previous_id) WHERE previous_id IS NOT NULL;
CREATE INDEX ON layer_adjustments(organization_id,unit_id,observed_on);
ALTER TABLE layer_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON layer_adjustments FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY reviewed_insert ON layer_adjustments FOR INSERT TO farm_app
 WITH CHECK(member_role(organization_id) IN ('owner','admin','manager') AND created_by=current_actor() AND created_at=now());
GRANT SELECT,INSERT ON layer_adjustments TO farm_app;

CREATE VIEW current_layer_adjustments WITH (security_invoker=true) AS
 SELECT a.* FROM layer_adjustments a WHERE NOT EXISTS(SELECT 1 FROM layer_adjustments n WHERE n.previous_id=a.id);
-- The immutable original remains in daily_records. A replacement supplies full values, never a delta.
CREATE VIEW effective_daily_records WITH (security_invoker=true) AS
 SELECT d.id,d.organization_id,d.unit_id,d.recorded_on,
 coalesce(a.mortality,d.mortality) AS mortality,coalesce(a.eggs,d.eggs) AS eggs,coalesce(a.cracked,d.cracked) AS cracked,
 coalesce(a.feed_kg,d.feed_kg) AS feed_kg,d.average_weight_g,d.sample_size,d.water_quality,
 coalesce(a.notes,d.notes) AS notes,d.created_at,a.id AS adjustment_id,d.id AS base_record_id
 FROM daily_records d LEFT JOIN current_layer_adjustments a ON a.base_record_id=d.id AND a.kind='daily'
 UNION ALL
 SELECT a.id,a.organization_id,a.unit_id,a.observed_on,a.mortality,a.eggs,a.cracked,a.feed_kg,
 NULL::numeric,NULL::integer,NULL::jsonb,a.notes,a.created_at,a.id,NULL::uuid
 FROM current_layer_adjustments a WHERE a.kind='daily' AND a.base_record_id IS NULL;
CREATE VIEW production_population_balances WITH (security_invoker=true) AS
 SELECT u.id,u.organization_id,
 coalesce(a.opening_hens,u.opening_count)-coalesce((SELECT sum(d.mortality) FROM effective_daily_records d
 WHERE d.unit_id=u.id AND d.recorded_on>=coalesce(a.observed_on,u.stocked_on)),0) AS recorded_balance,
 a.id AS census_id,a.observed_on AS census_on
 FROM production_units u LEFT JOIN LATERAL(SELECT c.* FROM current_layer_adjustments c
 WHERE c.unit_id=u.id AND c.kind='census' ORDER BY c.observed_on DESC LIMIT 1) a ON true;
GRANT SELECT ON current_layer_adjustments,effective_daily_records,production_population_balances TO farm_app;

CREATE FUNCTION validate_layer_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u production_units; base uuid; head uuid; prior layer_adjustments; today date;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
 SELECT * INTO u FROM production_units WHERE id=NEW.unit_id AND organization_id=NEW.organization_id;
 IF u.id IS NULL OR u.kind<>'layers' THEN RAISE EXCEPTION 'Choose a visible layer flock' USING ERRCODE='23514'; END IF;
 SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
 IF NEW.observed_on<u.stocked_on OR NEW.observed_on>today THEN RAISE EXCEPTION 'Invalid observation date' USING ERRCODE='23514'; END IF;
 SELECT id INTO head FROM current_layer_adjustments WHERE unit_id=u.id AND kind=NEW.kind AND observed_on=NEW.observed_on;
 IF head IS DISTINCT FROM NEW.previous_id THEN RAISE EXCEPTION 'Stale adjustment' USING ERRCODE='23505'; END IF;
 IF NEW.kind='daily' THEN
  SELECT id INTO base FROM daily_records WHERE unit_id=u.id AND recorded_on=NEW.observed_on;
  IF base IS DISTINCT FROM NEW.base_record_id THEN RAISE EXCEPTION 'Original record mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER layer_adjustment_check BEFORE INSERT ON layer_adjustments FOR EACH ROW EXECUTE FUNCTION validate_layer_adjustment();

CREATE FUNCTION check_layer_population(p_unit uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE bad boolean;
BEGIN
 -- A census resets only its own forward segment. Unknown deaths are never invented.
 WITH anchors AS (
  SELECT stocked_on AS d,opening_count AS n FROM production_units u WHERE id=p_unit
   AND NOT EXISTS(SELECT 1 FROM current_layer_adjustments c WHERE c.unit_id=u.id AND c.kind='census' AND c.observed_on=u.stocked_on)
  UNION ALL SELECT observed_on,opening_hens FROM current_layer_adjustments WHERE unit_id=p_unit AND kind='census'
 ), segments AS (SELECT d,n,lead(d) OVER(ORDER BY d) AS until FROM anchors)
 SELECT EXISTS(SELECT 1 FROM segments s WHERE s.n<coalesce((SELECT sum(r.mortality) FROM effective_daily_records r
  WHERE r.unit_id=p_unit AND r.recorded_on>=s.d AND (s.until IS NULL OR r.recorded_on<s.until)),0)) INTO bad;
 IF bad THEN RAISE EXCEPTION 'Recorded deaths exceed the opening count within a census segment' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION check_layer_adjustment_population() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM check_layer_population(NEW.unit_id); RETURN NEW; END $$;
CREATE TRIGGER layer_adjustment_population AFTER INSERT ON layer_adjustments FOR EACH ROW EXECUTE FUNCTION check_layer_adjustment_population();

CREATE OR REPLACE FUNCTION validate_daily_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unit production_units; used integer; last_date date; balance bigint; today date;
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
 SELECT recorded_balance INTO balance FROM production_population_balances WHERE id=unit.id;
 IF NEW.mortality>balance THEN RAISE EXCEPTION 'Mortality exceeds recorded population balance' USING ERRCODE='23514'; END IF;
 IF unit.kind<>'layers' AND (NEW.eggs>0 OR NEW.cracked>0) THEN RAISE EXCEPTION 'Egg records require layers' USING ERRCODE='23514'; END IF;
 IF unit.kind<>'catfish' AND NEW.water_quality IS NOT NULL THEN RAISE EXCEPTION 'Water records require a fish unit' USING ERRCODE='23514'; END IF;
 IF NEW.sample_size>balance-NEW.mortality THEN RAISE EXCEPTION 'Sample exceeds live stock' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION validate_layer_adjustment(),check_layer_population(uuid),check_layer_adjustment_population() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_layer_population(uuid) TO farm_app;
