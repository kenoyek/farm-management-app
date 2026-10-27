CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='farm_app') THEN CREATE ROLE farm_app NOLOGIN NOBYPASSRLS; END IF; END $$;
CREATE TABLE users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sessions(token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE organizations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL CHECK(length(name) BETWEEN 2 AND 100),currency text NOT NULL DEFAULT 'NGN',timezone text NOT NULL DEFAULT 'Africa/Lagos',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE memberships(organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,role text NOT NULL CHECK(role IN ('owner','admin','manager','nutritionist','inventory','accounts','worker','auditor')), PRIMARY KEY(organization_id,user_id));
CREATE INDEX memberships_user_idx ON memberships(user_id);
CREATE FUNCTION current_actor() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id',true),'')::uuid $$;
CREATE FUNCTION member_role(org uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT role FROM memberships WHERE organization_id=org AND user_id=current_actor() $$;
REVOKE ALL ON FUNCTION member_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_role(uuid) TO farm_app;
CREATE TABLE farms(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,name text NOT NULL CHECK(length(name) BETWEEN 2 AND 100),location text NOT NULL DEFAULT '',kind text NOT NULL CHECK(kind IN ('mixed','layers','broilers','catfish','feed_mill')),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(organization_id,id));
CREATE INDEX farms_org_idx ON farms(organization_id);
CREATE TABLE audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,actor_id uuid NOT NULL DEFAULT current_actor() REFERENCES users,action text NOT NULL,object_id uuid,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_org_date_idx ON audit_logs(organization_id,created_at DESC);
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE farms ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_read ON organizations FOR SELECT TO farm_app USING(member_role(id) IS NOT NULL);
CREATE POLICY member_read ON memberships FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY farm_read ON farms FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY farm_insert ON farms FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin'));
CREATE POLICY farm_update ON farms FOR UPDATE TO farm_app USING(member_role(organization_id) IN ('owner','admin')) WITH CHECK(member_role(organization_id) IN ('owner','admin'));
CREATE POLICY audit_read ON audit_logs FOR SELECT TO farm_app USING(member_role(organization_id) IN ('owner','admin','auditor'));
CREATE POLICY audit_insert ON audit_logs FOR INSERT TO farm_app WITH CHECK(actor_id=current_actor() AND member_role(organization_id) IS NOT NULL);
GRANT USAGE ON SCHEMA public TO farm_app;
GRANT SELECT ON organizations,memberships TO farm_app;
GRANT SELECT,INSERT,UPDATE ON farms TO farm_app;
GRANT SELECT,INSERT ON audit_logs TO farm_app;
-- Organization creation is a narrowly scoped atomic bootstrap; identity is read from
-- transaction context, never caller-supplied membership or role data.
CREATE FUNCTION create_organization(org_name text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org_id uuid;
BEGIN
 IF current_actor() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
 INSERT INTO organizations(name) VALUES(org_name) RETURNING id INTO org_id;
 INSERT INTO memberships VALUES(org_id,current_actor(),'owner');
 INSERT INTO audit_logs(organization_id,action,object_id) VALUES(org_id,'organization.created',org_id);
 RETURN org_id;
END $$;
REVOKE ALL ON FUNCTION create_organization(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_organization(text) TO farm_app;
