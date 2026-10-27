ALTER TABLE ingredients ADD COLUMN species text NOT NULL DEFAULT 'unknown' CHECK(species IN ('unknown','poultry','catfish'));
ALTER TABLE ingredients ADD COLUMN stages text[] NOT NULL DEFAULT '{}';
ALTER TABLE ingredients ADD COLUMN phosphorus_basis text NOT NULL DEFAULT 'unknown' CHECK(phosphorus_basis IN ('unknown','total','available','digestible'));
ALTER TABLE ingredients ADD COLUMN quoted_on date;
ALTER TABLE requirement_profiles ADD COLUMN phosphorus_basis text NOT NULL DEFAULT 'unknown' CHECK(phosphorus_basis IN ('unknown','total','available','digestible'));
CREATE OR REPLACE FUNCTION validate_ingredient_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.review_status='approved' AND (member_role(NEW.organization_id) IS DISTINCT FROM 'nutritionist' OR NEW.source='' OR NEW.basis IS NULL OR NEW.energy_system IS NULL OR NEW.verified_at IS NULL OR NEW.reviewer_id IS DISTINCT FROM current_actor() OR NEW.species='unknown' OR cardinality(NEW.stages)=0 OR NEW.phosphorus_basis='unknown' OR NEW.quoted_on IS NULL OR NEW.quoted_on>current_date OR NEW.quoted_on<current_date-90) THEN RAISE EXCEPTION 'nutritionist review, species/stage, nutrient bases and recent quotation required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
