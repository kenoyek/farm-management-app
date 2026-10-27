CREATE TABLE imports(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,source_hashes jsonb NOT NULL,raw_data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id));
CREATE TABLE ingredients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,name text NOT NULL,source text NOT NULL,nutrients jsonb NOT NULL,price numeric(20,4) CHECK(price>=0),review_status text NOT NULL DEFAULT 'unverified' CHECK(review_status IN ('unverified','approved')),basis text,energy_system text,verified_at timestamptz,reviewer_id uuid REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(organization_id,id));
CREATE TABLE requirement_profiles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,name text NOT NULL,species text NOT NULL,stage text NOT NULL,limits jsonb NOT NULL,source text NOT NULL,basis text NOT NULL,energy_system text NOT NULL,reviewer_id uuid REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(organization_id,id));
CREATE TABLE formula_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,name text NOT NULL,batch_kg numeric(20,6) NOT NULL CHECK(batch_kg>0),profile_id uuid,lines jsonb NOT NULL,ingredient_snapshot jsonb NOT NULL,result jsonb NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending-review','approved','rejected')),parent_id uuid,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(organization_id,profile_id) REFERENCES requirement_profiles(organization_id,id),FOREIGN KEY(organization_id,parent_id) REFERENCES formula_versions(organization_id,id),UNIQUE(organization_id,id));
CREATE TABLE optimization_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,request jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['imports','ingredients','requirement_profiles','formula_versions','optimization_runs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL)',t);
  EXECUTE format('CREATE POLICY feed_insert ON %I FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN (''owner'',''admin'',''nutritionist''))',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO farm_app',t);
  EXECUTE format('CREATE INDEX ON %I(organization_id)',t);
 END LOOP;
END $$;
CREATE POLICY ingredient_update ON ingredients FOR UPDATE TO farm_app USING(member_role(organization_id)='nutritionist') WITH CHECK(member_role(organization_id)='nutritionist');
GRANT UPDATE ON ingredients TO farm_app;
-- Nutritional approval requires an explicitly assigned nutritionist role. An owner
-- is not silently considered a qualified nutritionist.
CREATE FUNCTION validate_ingredient_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.review_status='approved' AND (member_role(NEW.organization_id) IS DISTINCT FROM 'nutritionist' OR NEW.source='' OR NEW.basis IS NULL OR NEW.energy_system IS NULL OR NEW.verified_at IS NULL OR NEW.reviewer_id IS DISTINCT FROM current_actor()) THEN RAISE EXCEPTION 'nutritionist review and provenance required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ingredient_review BEFORE INSERT OR UPDATE ON ingredients FOR EACH ROW EXECUTE FUNCTION validate_ingredient_review();
CREATE FUNCTION add_team_member(org uuid, member_email text, member_role_name text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target uuid;
BEGIN
 IF member_role(org) NOT IN ('owner','admin') OR member_role(org) IS NULL THEN RAISE EXCEPTION 'not permitted' USING ERRCODE='42501'; END IF;
 IF member_role_name NOT IN ('admin','manager','nutritionist','inventory','accounts','worker','auditor') THEN RAISE EXCEPTION 'invalid role'; END IF;
 SELECT id INTO target FROM users WHERE email=lower(trim(member_email));
 IF target IS NULL THEN RAISE EXCEPTION 'Member must create an account first' USING ERRCODE='P0002'; END IF;
 INSERT INTO memberships VALUES(org,target,member_role_name);
 INSERT INTO audit_logs(organization_id,action,object_id) VALUES(org,'member.added',target);
END $$;
REVOKE ALL ON FUNCTION add_team_member(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION add_team_member(uuid,text,text) TO farm_app;
