-- Identity reconciliation is separate from scientific/reference approval.
ALTER TABLE import_reference_rows ADD CONSTRAINT catalog_tenant_id UNIQUE(organization_id,id);
CREATE TABLE catalog_alias_reviews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
 source_row_id uuid NOT NULL,
 ingredient_id uuid,
 decision text NOT NULL CHECK(decision IN ('mapped','rejected','unresolved')),
 evidence text NOT NULL CHECK(length(btrim(evidence)) BETWEEN 10 AND 2000),
 reviewer_id uuid NOT NULL DEFAULT current_actor() REFERENCES users,
 revision integer NOT NULL CHECK(revision>0),
 parent_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id),
 UNIQUE(source_row_id,revision),
 FOREIGN KEY(organization_id,source_row_id) REFERENCES import_reference_rows(organization_id,id),
 FOREIGN KEY(organization_id,ingredient_id) REFERENCES ingredients(organization_id,id),
 FOREIGN KEY(organization_id,parent_id) REFERENCES catalog_alias_reviews(organization_id,id),
 CHECK((decision='mapped')=(ingredient_id IS NOT NULL))
);
CREATE UNIQUE INDEX alias_review_one_successor ON catalog_alias_reviews(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX alias_review_source_idx ON catalog_alias_reviews(organization_id,source_row_id,revision DESC);
ALTER TABLE catalog_alias_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY alias_review_read ON catalog_alias_reviews FOR SELECT TO farm_app USING(member_role(organization_id) IS NOT NULL);
CREATE POLICY alias_review_insert ON catalog_alias_reviews FOR INSERT TO farm_app WITH CHECK(member_role(organization_id)='nutritionist' AND reviewer_id=current_actor());
GRANT SELECT,INSERT ON catalog_alias_reviews TO farm_app;
CREATE FUNCTION validate_catalog_alias_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_category text; previous catalog_alias_reviews%ROWTYPE;
BEGIN
 IF member_role(NEW.organization_id) IS DISTINCT FROM 'nutritionist' OR NEW.reviewer_id IS DISTINCT FROM current_actor() THEN
  RAISE EXCEPTION 'Only the assigned nutritionist can record alias reviews' USING ERRCODE='42501';
 END IF;
 -- Serialize even direct runtime inserts; a stale review cannot fork history.
 PERFORM pg_advisory_xact_lock(hashtext('catalog-alias:'||NEW.source_row_id::text));
 SELECT category INTO source_category FROM import_reference_rows WHERE organization_id=NEW.organization_id AND id=NEW.source_row_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Source row not found' USING ERRCODE='23503'; END IF;
 IF source_category NOT IN ('restriction','recipe') THEN
  RAISE EXCEPTION 'This source row does not identify an ingredient' USING ERRCODE='23514';
 END IF;
 SELECT * INTO previous FROM catalog_alias_reviews WHERE organization_id=NEW.organization_id AND source_row_id=NEW.source_row_id ORDER BY revision DESC LIMIT 1;
 IF FOUND THEN
  IF NEW.parent_id IS DISTINCT FROM previous.id OR NEW.revision<>previous.revision+1 THEN
   RAISE EXCEPTION 'Alias review has changed; reload the latest revision' USING ERRCODE='23505';
  END IF;
 ELSIF NEW.parent_id IS NOT NULL OR NEW.revision<>1 THEN
  RAISE EXCEPTION 'Invalid initial alias review revision' USING ERRCODE='23514';
 END IF;
 NEW.created_at := statement_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_alias_review_version BEFORE INSERT ON catalog_alias_reviews FOR EACH ROW EXECUTE FUNCTION validate_catalog_alias_review();
-- Runtime UPDATE/DELETE is deliberately unavailable. Source rows and references
-- remain immutable and no alias is applied to existing recipes or constraints.
