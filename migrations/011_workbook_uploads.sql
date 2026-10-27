CREATE TABLE workbook_uploads(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
 actor_id uuid NOT NULL DEFAULT current_actor() REFERENCES users,
 filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 200),sha256 text NOT NULL CHECK(length(sha256)=64),
 raw_bytes bytea NOT NULL CHECK(octet_length(raw_bytes)<=2097152),inspection jsonb NOT NULL,
 mapping jsonb,preview jsonb,state text NOT NULL DEFAULT 'uploaded' CHECK(state IN ('uploaded','previewed','confirmed')),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),created_at timestamptz NOT NULL DEFAULT now(),confirmed_at timestamptz,
 UNIQUE(organization_id,id),UNIQUE(organization_id,sha256)
);
ALTER TABLE workbook_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY upload_read ON workbook_uploads FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY upload_insert ON workbook_uploads FOR INSERT TO farm_app WITH CHECK(actor_id=current_actor() AND member_role(organization_id) IN ('owner','admin','nutritionist'));
CREATE POLICY upload_update ON workbook_uploads FOR UPDATE TO farm_app USING(member_role(organization_id) IN ('owner','admin','nutritionist')) WITH CHECK(member_role(organization_id) IN ('owner','admin','nutritionist'));
GRANT SELECT,INSERT ON workbook_uploads TO farm_app;
GRANT UPDATE(mapping,preview,state,revision,confirmed_at) ON workbook_uploads TO farm_app;
CREATE FUNCTION check_upload_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='confirmed' OR (NEW.state='previewed' AND NEW.revision<>OLD.revision+1) OR (NEW.state='confirmed' AND (OLD.state<>'previewed' OR NEW.revision<>OLD.revision)) OR NEW.state='uploaded' THEN
  RAISE EXCEPTION 'Invalid upload state transition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER upload_transition BEFORE UPDATE ON workbook_uploads FOR EACH ROW EXECUTE FUNCTION check_upload_transition();
ALTER TABLE ingredients ADD COLUMN upload_id uuid;
ALTER TABLE ingredients ADD COLUMN upload_row integer;
ALTER TABLE ingredients ADD CONSTRAINT ingredient_upload_tenant FOREIGN KEY(organization_id,upload_id) REFERENCES workbook_uploads(organization_id,id);
CREATE UNIQUE INDEX ingredient_upload_row ON ingredients(upload_id,upload_row) WHERE upload_id IS NOT NULL;
