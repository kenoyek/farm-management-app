-- Attach measured whole-bird biomass to existing losses; never post animal counts.
CREATE TABLE broiler_loss_reviews (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,unit_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('daily','cull')),observed_on date NOT NULL,target_event_id uuid,
 source_id uuid NOT NULL,source_count integer NOT NULL CHECK(source_count BETWEEN 1 AND 100000000),
 weight_kg numeric(20,6) CHECK(weight_kg>0 AND weight_kg<=100000000),
 measurement_basis text NOT NULL DEFAULT 'whole-bird-at-loss' CHECK(measurement_basis='whole-bird-at-loss'),
 previous_id uuid,position bigint NOT NULL DEFAULT 0 UNIQUE,
 expected_position bigint NOT NULL CHECK(expected_position>=0),expected_daily_id uuid,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),evidence text NOT NULL CHECK(length(btrim(evidence)) BETWEEN 3 AND 2000),
 source_snapshot jsonb NOT NULL DEFAULT '{}',submission jsonb NOT NULL DEFAULT '{}',
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,unit_id,id),CHECK(previous_id IS DISTINCT FROM id),
 CHECK((kind='daily' AND target_event_id IS NULL) OR (kind='cull' AND target_event_id IS NOT NULL)),
 FOREIGN KEY(organization_id,unit_id) REFERENCES production_units(organization_id,id),
 FOREIGN KEY(organization_id,unit_id,target_event_id) REFERENCES broiler_events(organization_id,unit_id,id),
 FOREIGN KEY(organization_id,unit_id,previous_id) REFERENCES broiler_loss_reviews(organization_id,unit_id,id)
);
CREATE UNIQUE INDEX broiler_loss_successor ON broiler_loss_reviews(previous_id) WHERE previous_id IS NOT NULL;
CREATE UNIQUE INDEX broiler_loss_daily_root ON broiler_loss_reviews(unit_id,observed_on) WHERE kind='daily' AND previous_id IS NULL;
CREATE UNIQUE INDEX broiler_loss_cull_root ON broiler_loss_reviews(target_event_id) WHERE kind='cull' AND previous_id IS NULL;
CREATE INDEX ON broiler_loss_reviews(organization_id,unit_id,position);
ALTER TABLE broiler_loss_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON broiler_loss_reviews FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY reviewed_insert ON broiler_loss_reviews FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','manager') AND created_by=current_actor() AND created_at=now());
GRANT SELECT,INSERT ON broiler_loss_reviews TO farm_app;
CREATE VIEW current_broiler_loss_reviews WITH (security_invoker=true) AS SELECT r.* FROM broiler_loss_reviews r WHERE NOT EXISTS(SELECT 1 FROM broiler_loss_reviews n WHERE n.previous_id=r.id);
GRANT SELECT ON current_broiler_loss_reviews TO farm_app;
CREATE OR REPLACE FUNCTION broiler_latest_position(p_unit uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT greatest(coalesce((SELECT max(position) FROM broiler_events WHERE unit_id=p_unit),0),coalesce((SELECT max(position) FROM broiler_reviews WHERE unit_id=p_unit),0),coalesce((SELECT max(position) FROM broiler_loss_reviews WHERE unit_id=p_unit),0));
$$;
CREATE FUNCTION validate_broiler_loss_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest uuid; head uuid; prior broiler_loss_reviews; sid uuid; qty integer; snapshot jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
 IF NOT EXISTS(SELECT 1 FROM production_units WHERE id=NEW.unit_id AND organization_id=NEW.organization_id AND kind='broilers') THEN RAISE EXCEPTION 'Choose a visible broiler batch' USING ERRCODE='23514'; END IF;
 SELECT id INTO latest FROM effective_daily_records WHERE unit_id=NEW.unit_id ORDER BY recorded_on DESC LIMIT 1;
 IF NEW.expected_position<>broiler_latest_position(NEW.unit_id) OR NEW.expected_daily_id IS DISTINCT FROM latest THEN RAISE EXCEPTION 'Stale loss biomass review' USING ERRCODE='23505'; END IF;
 IF NEW.kind='daily' THEN
  SELECT coalesce(d.adjustment_id,d.id),d.mortality,to_jsonb(d)||jsonb_build_object('feed_kg',d.feed_kg::text,'average_weight_g',d.average_weight_g::text) INTO sid,qty,snapshot FROM effective_daily_records d WHERE organization_id=NEW.organization_id AND unit_id=NEW.unit_id AND recorded_on=NEW.observed_on;
  SELECT id INTO head FROM current_broiler_loss_reviews WHERE unit_id=NEW.unit_id AND kind='daily' AND observed_on=NEW.observed_on;
 ELSE
  SELECT e.id,e.quantity,to_jsonb(e)||jsonb_build_object('position',e.position::text,'expected_position',e.expected_position::text,'weight_kg',e.weight_kg::text,'price_per_unit',e.price_per_unit::text,'amount',e.amount::text) INTO sid,qty,snapshot FROM active_broiler_events e WHERE organization_id=NEW.organization_id AND unit_id=NEW.unit_id AND id=NEW.target_event_id AND kind='cull' AND recorded_on=NEW.observed_on;
  SELECT id INTO head FROM current_broiler_loss_reviews WHERE target_event_id=NEW.target_event_id AND kind='cull';
 END IF;
 IF sid IS NULL OR qty<=0 OR NEW.source_id IS DISTINCT FROM sid OR NEW.source_count IS DISTINCT FROM qty THEN RAISE EXCEPTION 'Loss source, effective revision or whole-bird count mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.previous_id IS DISTINCT FROM head THEN RAISE EXCEPTION 'Stale loss review predecessor' USING ERRCODE='23505'; END IF;
 IF NEW.previous_id IS NOT NULL THEN
  SELECT * INTO prior FROM broiler_loss_reviews WHERE id=NEW.previous_id;
  IF prior.kind<>NEW.kind OR prior.unit_id<>NEW.unit_id OR prior.observed_on<>NEW.observed_on OR prior.target_event_id IS DISTINCT FROM NEW.target_event_id THEN RAISE EXCEPTION 'Loss review lineage mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.source_snapshot:=snapshot;
 NEW.submission:=jsonb_build_object('organizationId',NEW.organization_id,'unitId',NEW.unit_id,'reviewId',NEW.id,'kind',NEW.kind,'date',NEW.observed_on::text,'targetEventId',NEW.target_event_id,'sourceId',NEW.source_id,'sourceCount',NEW.source_count,'weightKg',NEW.weight_kg::text,'measurementBasis',NEW.measurement_basis,'previousId',NEW.previous_id,'expectedPosition',NEW.expected_position::text,'expectedDailyId',NEW.expected_daily_id,'reason',btrim(NEW.reason),'evidence',btrim(NEW.evidence));
 NEW.position:=nextval('broiler_event_position');
 RETURN NEW;
END $$;
CREATE TRIGGER broiler_loss_check BEFORE INSERT ON broiler_loss_reviews FOR EACH ROW EXECUTE FUNCTION validate_broiler_loss_review();
REVOKE ALL ON FUNCTION validate_broiler_loss_review() FROM PUBLIC;
