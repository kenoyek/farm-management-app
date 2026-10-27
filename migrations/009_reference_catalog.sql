-- Scientific and price corrections append a new reference; old IDs remain valid.
REVOKE UPDATE ON ingredients FROM farm_app;
DROP POLICY ingredient_update ON ingredients;
ALTER TABLE ingredients ADD COLUMN parent_id uuid;
ALTER TABLE ingredients ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE ingredients ADD CONSTRAINT ingredient_parent_tenant FOREIGN KEY(organization_id,parent_id) REFERENCES ingredients(organization_id,id);
CREATE UNIQUE INDEX ingredient_one_successor ON ingredients(parent_id) WHERE parent_id IS NOT NULL;
CREATE FUNCTION check_ingredient_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_revision integer;
BEGIN
 IF NEW.parent_id IS NULL THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'Invalid initial revision' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT revision INTO previous_revision FROM ingredients WHERE id=NEW.parent_id AND organization_id=NEW.organization_id;
  IF previous_revision IS NULL THEN RAISE EXCEPTION 'Reference not found' USING ERRCODE='23503'; END IF;
  IF NEW.revision<>previous_revision+1 THEN RAISE EXCEPTION 'Invalid reference revision' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ingredient_revision BEFORE INSERT ON ingredients FOR EACH ROW EXECUTE FUNCTION check_ingredient_revision();
CREATE TABLE import_reference_rows(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
 import_id uuid NOT NULL,
 source_hash text NOT NULL,
 sheet text NOT NULL,
 source_row integer NOT NULL CHECK(source_row>0),
 category text NOT NULL CHECK(category IN ('requirement','restriction','recipe')),
 label text NOT NULL,
 context text NOT NULL,
 fields jsonb NOT NULL,
 issues jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,import_id) REFERENCES imports(organization_id,id),
 UNIQUE(organization_id,source_hash,sheet,source_row,context)
);
ALTER TABLE import_reference_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY catalog_read ON import_reference_rows FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY catalog_insert ON import_reference_rows FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','nutritionist'));
GRANT SELECT,INSERT ON import_reference_rows TO farm_app;
CREATE INDEX catalog_org_idx ON import_reference_rows(organization_id,category);
