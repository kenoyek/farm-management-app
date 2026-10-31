-- Reviewed evidence/valuation overlays. Original stock and journal rows remain untouched.
CREATE SEQUENCE feed_review_position;
CREATE TABLE feed_reconciliation_reviews(
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
 model_version text NOT NULL DEFAULT 'feed-reconciliation-v1' CHECK(model_version='feed-reconciliation-v1'),
 kind text NOT NULL,target_id uuid NOT NULL,previous_id uuid,revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 100),
 position bigint NOT NULL DEFAULT 0 UNIQUE,reviewed_on date NOT NULL,expected_stock_position bigint NOT NULL CHECK(expected_stock_position>=0),expected_review_position bigint NOT NULL CHECK(expected_review_position>=0),
 expected_source_sha256 text NOT NULL CHECK(expected_source_sha256~'^[a-f0-9]{64}$'),source_sha256 text NOT NULL DEFAULT '',currency text NOT NULL DEFAULT '',
 input jsonb NOT NULL CHECK(octet_length(input::text)<=10000),source_snapshot jsonb NOT NULL DEFAULT '{}' CHECK(octet_length(source_snapshot::text)<=524288),submission jsonb NOT NULL DEFAULT '{}',
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,kind,target_id,id),FOREIGN KEY(organization_id,target_id) REFERENCES feed_stock_events(organization_id,id),
 FOREIGN KEY(organization_id,kind,target_id,previous_id) REFERENCES feed_reconciliation_reviews(organization_id,kind,target_id,id),
 CHECK(kind IN ('source','cost')),CHECK(id IS DISTINCT FROM previous_id),CHECK(source_sha256~'^[a-f0-9]{64}$'),CHECK(currency~'^[A-Z]{3}$')
);
CREATE UNIQUE INDEX feed_review_root ON feed_reconciliation_reviews(organization_id,kind,target_id) WHERE previous_id IS NULL;
CREATE UNIQUE INDEX feed_review_successor ON feed_reconciliation_reviews(previous_id) WHERE previous_id IS NOT NULL;
CREATE INDEX ON feed_reconciliation_reviews(organization_id,position);
ALTER TABLE feed_reconciliation_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY feed_review_read ON feed_reconciliation_reviews FOR SELECT TO farm_app USING(member_role(organization_id) IN ('owner','admin','manager','inventory','accounts','auditor'));
CREATE POLICY feed_review_write ON feed_reconciliation_reviews FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','manager') AND created_by=current_actor() AND created_at=now());
GRANT SELECT,INSERT ON feed_reconciliation_reviews TO farm_app;
GRANT USAGE ON SEQUENCE feed_review_position TO farm_app;
CREATE VIEW current_feed_reconciliation_reviews WITH(security_invoker=true) AS SELECT r.* FROM feed_reconciliation_reviews r WHERE NOT EXISTS(SELECT 1 FROM feed_reconciliation_reviews n WHERE n.previous_id=r.id);
GRANT SELECT ON current_feed_reconciliation_reviews TO farm_app;
CREATE FUNCTION feed_review_snapshot(p_org uuid,p_kind text,p_target uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN p_kind='source' AND e.kind='consume' THEN jsonb_build_object('event',to_jsonb(e)||jsonb_build_object('recorded_on',e.recorded_on::text,'position',e.position::text,'expected_position',e.expected_position::text,'weight_kg',e.weight_kg::text,'amount',e.amount::text),'currentSource',feed_consumption_source(p_org,e.unit_id,e.recorded_on),'linkedConsumption',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'lot_id',a.lot_id,'weight_kg',a.weight_kg::text,'source_sha256',a.source_sha256) ORDER BY a.position),'[]'::jsonb) FROM active_feed_stock_events a WHERE a.organization_id=p_org AND a.unit_id=e.unit_id AND a.recorded_on=e.recorded_on AND a.kind='consume'))
 WHEN p_kind='cost' AND e.kind='receipt' THEN jsonb_build_object('receipt',to_jsonb(e)||jsonb_build_object('recorded_on',e.recorded_on::text,'position',e.position::text,'expected_position',e.expected_position::text,'weight_kg',e.weight_kg::text,'amount',e.amount::text),'events',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('recorded_on',a.recorded_on::text,'position',a.position::text,'expected_position',a.expected_position::text,'weight_kg',a.weight_kg::text,'amount',a.amount::text) ORDER BY a.position),'[]'::jsonb) FROM feed_stock_events a WHERE a.organization_id=p_org AND a.lot_id=e.id)) ELSE NULL END
 FROM active_feed_stock_events e WHERE e.organization_id=p_org AND e.id=p_target;
$$;
REVOKE ALL ON FUNCTION feed_review_snapshot(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION feed_review_snapshot(uuid,text,uuid) TO farm_app;
CREATE FUNCTION feed_effective_source_sha(p_org uuid,p_event uuid) RETURNS text LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT r.source_sha256 FROM current_feed_reconciliation_reviews r WHERE r.organization_id=p_org AND r.kind='source' AND r.target_id=e.id),e.source_sha256) FROM feed_stock_events e WHERE e.organization_id=p_org AND e.id=p_event AND e.kind='consume';
$$;
REVOKE ALL ON FUNCTION feed_effective_source_sha(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION feed_effective_source_sha(uuid,uuid) TO farm_app;
CREATE FUNCTION validate_feed_reconciliation_review() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d jsonb:=NEW.input; e feed_stock_events; prior feed_reconciliation_reviews; snap jsonb; today date; expected_hash text; quantity numeric; keys integer; last_day date;
BEGIN
 IF coalesce(member_role(NEW.organization_id),'') NOT IN ('owner','admin','manager') THEN RAISE EXCEPTION 'Manager feed review role required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(d)<>'object' OR jsonb_typeof(d->'kind')<>'string' OR jsonb_typeof(d->'targetId')<>'string' OR NOT(d->'previousId'='null'::jsonb OR jsonb_typeof(d->'previousId')='string') OR NOT broiler_plan_text(d->'reason',10,2000,false) OR NOT broiler_plan_text(d->'evidence',3,2000,false) THEN RAISE EXCEPTION 'Invalid reviewed feed evidence' USING ERRCODE='23514';END IF;
 NEW.kind:=d->>'kind';NEW.target_id:=(d->>'targetId')::uuid;NEW.previous_id:=(d->>'previousId')::uuid;
 SELECT * INTO e FROM feed_stock_events WHERE organization_id=NEW.organization_id AND id=NEW.target_id;
 IF e.id IS NULL OR (NEW.kind='source' AND e.kind<>'consume') OR (NEW.kind='cost' AND e.kind<>'receipt') THEN RAISE EXCEPTION 'Choose the original consumption or purchase receipt for this review' USING ERRCODE='23514';END IF;
 IF e.unit_id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtext(e.unit_id::text));END IF;
 PERFORM pg_advisory_xact_lock(813,hashtext(NEW.organization_id::text));PERFORM pg_advisory_xact_lock(814,hashtext(NEW.organization_id::text));
 IF NEW.expected_stock_position<>(SELECT coalesce(max(position),0) FROM feed_stock_events WHERE organization_id=NEW.organization_id) OR NEW.expected_review_position<>(SELECT coalesce(max(position),0) FROM feed_reconciliation_reviews WHERE organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'Stock or review head changed; reload evidence' USING ERRCODE='23505';END IF;
 IF (SELECT count(*) FROM feed_reconciliation_reviews WHERE organization_id=NEW.organization_id)>=1000 THEN RAISE EXCEPTION 'Organization reached its feed-review limit' USING ERRCODE='23514';END IF;
 SELECT * INTO prior FROM current_feed_reconciliation_reviews WHERE organization_id=NEW.organization_id AND kind=NEW.kind AND target_id=e.id;
 IF NEW.previous_id IS DISTINCT FROM prior.id THEN RAISE EXCEPTION 'Review predecessor changed' USING ERRCODE='23505';END IF;
 NEW.revision:=coalesce(prior.revision,0)+1;NEW.currency:=e.currency;
 SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
 SELECT count(*) INTO keys FROM jsonb_object_keys(d);
 snap:=feed_review_snapshot(NEW.organization_id,NEW.kind,e.id);
 IF snap IS NULL THEN RAISE EXCEPTION 'Original feed source is inactive or unsupported' USING ERRCODE='23514';END IF;
 IF NEW.kind='source' THEN
  IF keys<>7 OR NOT(d ?& ARRAY['kind','targetId','previousId','policy','scope','reason','evidence']) OR d->>'policy' IS DISTINCT FROM 'same-quantity-current-feed-evidence-v1' OR d->>'scope' IS DISTINCT FROM 'unchanged-physical-consumption' OR snap->'currentSource'='null'::jsonb THEN RAISE EXCEPTION 'Only unchanged physical consumption may be reaffirmed' USING ERRCODE='23514';END IF;
  expected_hash:=encode(sha256(convert_to((snap->'currentSource')::text,'UTF8')),'hex');
  SELECT coalesce(sum(weight_kg),0) INTO quantity FROM active_feed_stock_events WHERE organization_id=NEW.organization_id AND unit_id=e.unit_id AND recorded_on=e.recorded_on AND kind='consume';
  IF quantity>(snap->'currentSource'->'record'->>'feed_kg')::numeric OR e.weight_kg>(snap->'currentSource'->'record'->>'feed_kg')::numeric THEN RAISE EXCEPTION 'Overlinked or missing actual feed cannot be reaffirmed; reconcile quantities separately' USING ERRCODE='23514';END IF;
  IF feed_effective_source_sha(NEW.organization_id,e.id)=expected_hash THEN RAISE EXCEPTION 'This exact actual feed evidence is already current' USING ERRCODE='23505';END IF;
  last_day:=e.recorded_on;
 ELSIF NEW.kind='cost' THEN
  IF keys<>9 OR NOT(d ?& ARRAY['kind','targetId','previousId','totalCost','costEvidence','policy','scope','reason','evidence']) OR NOT broiler_plan_decimal(d->'totalCost',100000000,4,true,false) OR NOT broiler_plan_text(d->'costEvidence',3,2000,false) OR d->>'policy' IS DISTINCT FROM 'reviewed-specific-lot-cost-v1' OR d->>'scope' IS DISTINCT FROM 'actual-purchase-cost-revision' THEN RAISE EXCEPTION 'Invalid evidenced revised purchase cost' USING ERRCODE='23514';END IF;
  expected_hash:=encode(sha256(convert_to(snap::text,'UTF8')),'hex');
  SELECT max(recorded_on) INTO last_day FROM feed_stock_events WHERE organization_id=NEW.organization_id AND lot_id=e.id;
  d:=d||jsonb_build_object('totalCost',(d->>'totalCost')::numeric(20,4)::text,'costEvidence',btrim(d->>'costEvidence'));
 ELSE RAISE EXCEPTION 'Unknown feed review kind' USING ERRCODE='23514';END IF;
 IF NEW.expected_source_sha256<>expected_hash THEN RAISE EXCEPTION 'Review source evidence changed' USING ERRCODE='23505';END IF;
 IF NEW.reviewed_on<last_day OR NEW.reviewed_on>today THEN RAISE EXCEPTION 'Review date must follow its captured source through organization today' USING ERRCODE='23514';END IF;
 NEW.source_sha256:=expected_hash;NEW.source_snapshot:=snap;
 NEW.input:=d||jsonb_build_object('targetId',e.id,'previousId',NEW.previous_id,'reason',btrim(d->>'reason'),'evidence',btrim(d->>'evidence'));
 NEW.submission:=jsonb_build_object('organizationId',NEW.organization_id,'reviewId',NEW.id,'date',NEW.reviewed_on::text,'expectedStockPosition',NEW.expected_stock_position::text,'expectedReviewPosition',NEW.expected_review_position::text,'expectedSourceSha256',NEW.expected_source_sha256,'data',NEW.input);
 NEW.position:=nextval('feed_review_position');RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION validate_feed_reconciliation_review() FROM PUBLIC;
CREATE TRIGGER feed_review_check BEFORE INSERT ON feed_reconciliation_reviews FOR EACH ROW EXECUTE FUNCTION validate_feed_reconciliation_review();

CREATE OR REPLACE VIEW financial_feed_sources WITH (security_invoker=true) AS
 SELECT e.organization_id,e.id AS source_id,e.lot_id,e.unit_id,e.kind,e.recorded_on,e.currency,e.amount::text AS amount,e.weight_kg::text AS weight_kg,l.input->>'feedName' AS feed_name,l.reference,
 (SELECT j.id FROM financial_journal_entries j WHERE j.organization_id=e.organization_id AND j.kind='recognize_feed' AND j.source_id=e.id AND NOT EXISTS(SELECT 1 FROM financial_journal_entries v WHERE v.reversal_of_id=j.id) LIMIT 1) AS recognized_id,
 (SELECT j.id FROM financial_journal_entries j WHERE j.organization_id=e.organization_id AND j.kind='recognize_feed' AND j.source_id=e.lot_id AND NOT EXISTS(SELECT 1 FROM financial_journal_entries v WHERE v.reversal_of_id=j.id) LIMIT 1) AS receipt_recognized_id,
 CASE WHEN e.kind<>'consume' THEN true ELSE feed_effective_source_sha(e.organization_id,e.id)=encode(sha256(convert_to(feed_consumption_source(e.organization_id,e.unit_id,e.recorded_on)::text,'UTF8')),'hex') AND (SELECT coalesce(sum(a.weight_kg),0) FROM active_feed_stock_events a WHERE a.organization_id=e.organization_id AND a.unit_id=e.unit_id AND a.recorded_on=e.recorded_on AND a.kind='consume')<=(SELECT (feed_consumption_source(e.organization_id,e.unit_id,e.recorded_on)->'record'->>'feed_kg')::numeric) END AS source_current
 FROM active_feed_stock_events e JOIN active_feed_stock_events l ON l.organization_id=e.organization_id AND l.id=e.lot_id AND l.kind='receipt';

CREATE FUNCTION attach_financial_feed_review() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r feed_reconciliation_reviews;
BEGIN
 SELECT * INTO r FROM current_feed_reconciliation_reviews WHERE organization_id=NEW.organization_id AND kind='source' AND target_id=NEW.source_id;
 IF r.id IS NOT NULL THEN NEW.source_snapshot:=NEW.source_snapshot||jsonb_build_object('sourceReview',to_jsonb(r)||jsonb_build_object('position',r.position::text,'expected_stock_position',r.expected_stock_position::text,'expected_review_position',r.expected_review_position::text,'reviewed_on',r.reviewed_on::text));END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION attach_financial_feed_review() FROM PUBLIC;
CREATE TRIGGER financial_feed_review_evidence BEFORE INSERT ON financial_journal_entries FOR EACH ROW WHEN(NEW.input->>'kind'='recognize_feed') EXECUTE FUNCTION attach_financial_feed_review();
