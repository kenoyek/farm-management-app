CREATE TABLE forecasts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,name text NOT NULL,kind text NOT NULL CHECK(kind IN ('layer-feed','layer-eggs')),input jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE production_units(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,farm_id uuid NOT NULL,name text NOT NULL,kind text NOT NULL CHECK(kind IN ('layers','broilers','catfish')),stocked_on date NOT NULL,opening_count integer NOT NULL CHECK(opening_count>0),initial_weight_g numeric(20,6) NOT NULL CHECK(initial_weight_g>0),created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(organization_id,farm_id) REFERENCES farms(organization_id,id),UNIQUE(organization_id,id));
CREATE TABLE daily_records(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,unit_id uuid NOT NULL,recorded_on date NOT NULL,mortality integer NOT NULL DEFAULT 0 CHECK(mortality>=0),eggs integer NOT NULL DEFAULT 0 CHECK(eggs>=0),cracked integer NOT NULL DEFAULT 0 CHECK(cracked BETWEEN 0 AND eggs),feed_kg numeric(20,6) NOT NULL DEFAULT 0 CHECK(feed_kg>=0),average_weight_g numeric(20,6) CHECK(average_weight_g>0),sample_size integer CHECK(sample_size>0),water_quality jsonb,notes text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(organization_id,unit_id) REFERENCES production_units(organization_id,id),UNIQUE(unit_id,recorded_on),CHECK((average_weight_g IS NULL)=(sample_size IS NULL)));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['forecasts','production_units','daily_records'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL)',t);
  EXECUTE format('CREATE POLICY operation_insert ON %I FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN (''owner'',''admin'',''manager'',''worker''))',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO farm_app',t);
  EXECUTE format('CREATE INDEX ON %I(organization_id)',t);
 END LOOP;
END $$;
CREATE FUNCTION validate_daily_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unit production_units; used integer; last_date date;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
 SELECT * INTO unit FROM production_units WHERE id=NEW.unit_id AND organization_id=NEW.organization_id;
 IF unit.id IS NULL THEN RAISE EXCEPTION 'unit not found' USING ERRCODE='23503'; END IF;
 SELECT coalesce(sum(mortality),0),max(recorded_on) INTO used,last_date FROM daily_records WHERE unit_id=NEW.unit_id;
 IF NEW.recorded_on<unit.stocked_on OR NEW.recorded_on>current_date OR (last_date IS NOT NULL AND NEW.recorded_on<=last_date) THEN RAISE EXCEPTION 'Records must follow stocking, be chronological, unique and not future dated' USING ERRCODE='23514'; END IF;
 IF NEW.mortality>unit.opening_count-used THEN RAISE EXCEPTION 'Mortality exceeds live stock' USING ERRCODE='23514'; END IF;
 IF unit.kind<>'layers' AND (NEW.eggs>0 OR NEW.cracked>0) THEN RAISE EXCEPTION 'Egg records require layers' USING ERRCODE='23514'; END IF;
 IF unit.kind<>'catfish' AND NEW.water_quality IS NOT NULL THEN RAISE EXCEPTION 'Water records require a fish unit' USING ERRCODE='23514'; END IF;
 IF NEW.sample_size>unit.opening_count-used-NEW.mortality THEN RAISE EXCEPTION 'Sample exceeds live stock' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER daily_record_check BEFORE INSERT ON daily_records FOR EACH ROW EXECUTE FUNCTION validate_daily_record();
