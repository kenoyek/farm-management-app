-- A private working copy, separate from immutable recipe/approval versions.
CREATE TABLE formulation_drafts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
 actor_id uuid NOT NULL DEFAULT current_actor() REFERENCES users ON DELETE CASCADE,
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND content ? 'modelVersion' AND content->>'modelVersion'='1' AND NOT content ? 'status'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,actor_id)
);
ALTER TABLE formulation_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY draft_read ON formulation_drafts FOR SELECT TO farm_app USING(actor_id=current_actor() AND member_role(organization_id) IN ('owner','admin','nutritionist'));
CREATE POLICY draft_insert ON formulation_drafts FOR INSERT TO farm_app WITH CHECK(actor_id=current_actor() AND member_role(organization_id) IN ('owner','admin','nutritionist'));
CREATE POLICY draft_update ON formulation_drafts FOR UPDATE TO farm_app USING(actor_id=current_actor() AND member_role(organization_id) IN ('owner','admin','nutritionist')) WITH CHECK(actor_id=current_actor() AND member_role(organization_id) IN ('owner','admin','nutritionist'));
GRANT SELECT,INSERT ON formulation_drafts TO farm_app;
GRANT UPDATE(content,revision,updated_at) ON formulation_drafts TO farm_app;
CREATE FUNCTION check_draft_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.revision<>1 OR TG_OP='UPDATE' AND NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'Draft revision must increase by one' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER draft_revision BEFORE INSERT OR UPDATE ON formulation_drafts FOR EACH ROW EXECUTE FUNCTION check_draft_revision();
