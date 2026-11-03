-- Reviewed cost postings are explicit ledger deltas; original physical rows never change.
ALTER TABLE financial_journal_entries DROP CONSTRAINT financial_journal_entries_kind_check;
ALTER TABLE financial_journal_entries ADD CHECK(kind IN ('manual','recognize_sale','recognize_feed','recognize_feed_cost','reverse'));
ALTER TABLE financial_journal_entries DROP CONSTRAINT financial_journal_entries_source_kind_check;
ALTER TABLE financial_journal_entries ADD CHECK(source_kind IS NULL OR source_kind IN ('live','product','feed','feed_cost'));
ALTER TABLE financial_journal_entries ADD CHECK(kind<>'recognize_feed_cost' OR (source_kind='feed_cost' AND source_id IS NOT NULL AND source_snapshot IS NOT NULL));
DO $$ DECLARE n text; BEGIN
 FOR n IN SELECT conname FROM pg_constraint WHERE conrelid='public.financial_journal_entries'::regclass AND pg_get_constraintdef(oid) LIKE '%source_snapshot%' AND pg_get_constraintdef(oid) LIKE '%32768%' LOOP EXECUTE format('ALTER TABLE public.financial_journal_entries DROP CONSTRAINT %I',n);END LOOP;
END $$;
ALTER TABLE financial_journal_entries ADD CONSTRAINT financial_snapshot_bound CHECK(source_snapshot IS NULL OR octet_length(source_snapshot::text)<=CASE WHEN source_kind='feed_cost' THEN 786432 ELSE 32768 END);
CREATE FUNCTION feed_cost_is_managed(p_org uuid,p_lot uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(member_role(p_org) IN ('owner','admin','manager','inventory','accounts','auditor'),false) AND EXISTS(SELECT 1 FROM financial_journal_entries j WHERE j.organization_id=p_org AND j.kind='recognize_feed_cost' AND j.source_snapshot->>'lotId'=p_lot::text AND NOT EXISTS(SELECT 1 FROM financial_journal_entries r WHERE r.reversal_of_id=j.id));
$$;
REVOKE ALL ON FUNCTION feed_cost_is_managed(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION feed_cost_is_managed(uuid,uuid) TO farm_app;
CREATE FUNCTION lock_feed_cost_posting(p_org uuid,p_review uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE u uuid; lot uuid; locked_units uuid[];
BEGIN
 SELECT target_id INTO lot FROM feed_reconciliation_reviews WHERE organization_id=p_org AND id=p_review AND kind='cost';
 SELECT coalesce(array_agg(DISTINCT unit_id ORDER BY unit_id),ARRAY[]::uuid[]) INTO locked_units FROM feed_stock_events WHERE organization_id=p_org AND lot_id=lot AND unit_id IS NOT NULL;
 FOREACH u IN ARRAY locked_units LOOP PERFORM pg_advisory_xact_lock(hashtext(u::text));END LOOP;
 PERFORM pg_advisory_xact_lock(813,hashtext(p_org::text));PERFORM pg_advisory_xact_lock(814,hashtext(p_org::text));PERFORM pg_advisory_xact_lock(812,hashtext(p_org::text));
 IF EXISTS(SELECT 1 FROM feed_stock_events WHERE organization_id=p_org AND lot_id=lot AND unit_id IS NOT NULL AND NOT(unit_id=ANY(locked_units))) THEN RAISE EXCEPTION 'Feed lot sources changed while locking; reload and review again' USING ERRCODE='23505';END IF;
END $$;
REVOKE ALL ON FUNCTION lock_feed_cost_posting(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_feed_cost_posting(uuid,uuid) TO farm_app;
CREATE FUNCTION feed_cost_add_net(n jsonb,a text,v numeric) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$ SELECT n||jsonb_build_object(a,((coalesce(n->>a,'0'))::numeric+v)::numeric(20,4)::text); $$;
REVOKE ALL ON FUNCTION feed_cost_add_net(jsonb,text,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION feed_cost_add_net(jsonb,text,numeric) TO farm_app;
CREATE FUNCTION feed_cost_posting_basis(p_org uuid,p_review uuid,p_settlement text,p_treatment text) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r feed_reconciliation_reviews; e feed_stock_events; b record; receipt feed_stock_events; latest uuid; parent uuid; prior_date date; quantity numeric; value_left numeric; desired numeric; booked numeric; change numeric; purchase_booked numeric:=0; account_code text; basis jsonb; components jsonb:='[]'; nets jsonb:='{}'; lines jsonb; current_sha text; review_json jsonb;
BEGIN
 IF coalesce(member_role(p_org),'') NOT IN ('owner','admin','manager','auditor') THEN RAISE EXCEPTION 'Financial read role required' USING ERRCODE='42501';END IF;
 IF coalesce(p_settlement,'') NOT IN ('payables','cash_bank') OR coalesce(p_treatment,'') NOT IN ('expense','work_in_progress') THEN RAISE EXCEPTION 'Explicit cost settlement and unbooked-consumption policy required' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM feed_reconciliation_reviews WHERE organization_id=p_org AND id=p_review AND kind='cost';
 IF r.id IS NULL THEN RAISE EXCEPTION 'Choose a visible cost review' USING ERRCODE='23514';END IF;
 SELECT id INTO latest FROM current_feed_reconciliation_reviews WHERE organization_id=p_org AND kind='cost' AND target_id=r.target_id;
 SELECT encode(sha256(convert_to(feed_review_snapshot(p_org,'cost',r.target_id)::text,'UTF8')),'hex') INTO current_sha;
 IF latest<>r.id OR current_sha IS DISTINCT FROM r.source_sha256 THEN RAISE EXCEPTION 'Cost review is superseded or its physical source changed' USING ERRCODE='23505';END IF;
 IF EXISTS(SELECT 1 FROM financial_journal_entries j WHERE j.organization_id=p_org AND j.kind='recognize_feed_cost' AND j.source_id=r.id AND NOT EXISTS(SELECT 1 FROM financial_journal_entries v WHERE v.reversal_of_id=j.id)) THEN RAISE EXCEPTION 'This cost review is already posted' USING ERRCODE='23505';END IF;
 SELECT * INTO receipt FROM active_feed_stock_events WHERE organization_id=p_org AND id=r.target_id AND kind='receipt';
 IF receipt.id IS NULL THEN RAISE EXCEPTION 'Active original feed receipt required' USING ERRCODE='23514';END IF;
 SELECT max(j.posted_on) INTO prior_date FROM financial_journal_entries j WHERE j.organization_id=p_org AND ((j.source_kind='feed_cost' AND j.source_snapshot->>'lotId'=receipt.id::text) OR (j.source_kind='feed' AND j.source_id IN (SELECT id FROM feed_stock_events WHERE organization_id=p_org AND lot_id=receipt.id)));
 IF r.reviewed_on<prior_date THEN RAISE EXCEPTION 'Cost review date must not precede existing lot accounting or reversal dates' USING ERRCODE='23514';END IF;
 SELECT j.id INTO parent FROM financial_journal_entries j WHERE j.organization_id=p_org AND j.kind='recognize_feed_cost' AND j.source_snapshot->>'lotId'=receipt.id::text AND NOT EXISTS(SELECT 1 FROM financial_journal_entries v WHERE v.reversal_of_id=j.id) ORDER BY j.position DESC LIMIT 1;
 quantity:=receipt.weight_kg;value_left:=(r.input->>'totalCost')::numeric;
 FOR e IN SELECT * FROM active_feed_stock_events WHERE organization_id=p_org AND lot_id=receipt.id ORDER BY CASE WHEN kind='receipt' THEN 0 ELSE 1 END,position LOOP
  IF e.kind='receipt' THEN desired:=value_left;
  ELSE
   IF e.weight_kg>quantity THEN RAISE EXCEPTION 'Invalid captured stock quantity' USING ERRCODE='23514';END IF;
   IF e.kind='consume' AND NOT coalesce((SELECT source_current FROM financial_feed_sources WHERE organization_id=p_org AND source_id=e.id),false) THEN RAISE EXCEPTION 'All actual feed sources must be current before cost posting' USING ERRCODE='23514';END IF;
   desired:=CASE WHEN e.weight_kg=quantity THEN value_left ELSE round(value_left*e.weight_kg/quantity,4) END;quantity:=quantity-e.weight_kg;value_left:=value_left-desired;
  END IF;
  booked:=0;account_code:=NULL;basis:='[]';
  FOR b IN
   SELECT j.id,j.position,j.kind,(j.lines->0->>'amount')::numeric AS value,j.lines->0->>'account' AS account FROM financial_journal_entries j WHERE j.organization_id=p_org AND j.kind='recognize_feed' AND j.source_id=e.id AND NOT EXISTS(SELECT 1 FROM financial_journal_entries v WHERE v.reversal_of_id=j.id)
   UNION ALL
   SELECT j.id,j.position,j.kind,(c.value->>'delta')::numeric,c.value->>'account' FROM financial_journal_entries j CROSS JOIN LATERAL jsonb_array_elements(j.source_snapshot->'components')c WHERE j.organization_id=p_org AND j.kind='recognize_feed_cost' AND j.source_snapshot->>'lotId'=receipt.id::text AND c.value->>'eventId'=e.id::text AND NOT EXISTS(SELECT 1 FROM financial_journal_entries v WHERE v.reversal_of_id=j.id)
   ORDER BY position
  LOOP
   booked:=booked+b.value;
   IF account_code IS NOT NULL AND account_code<>b.account THEN RAISE EXCEPTION 'Conflicting existing consumption classifications' USING ERRCODE='23514';END IF;
   account_code:=b.account;basis:=basis||jsonb_build_array(jsonb_build_object('entryId',b.id,'kind',b.kind,'value',b.value::numeric(20,4)::text,'account',b.account));
  END LOOP;
  IF booked<0 THEN RAISE EXCEPTION 'Invalid negative source book basis' USING ERRCODE='23514';END IF;
  account_code:=coalesce(account_code,CASE WHEN e.kind='receipt' THEN '1200' WHEN e.kind='loss' THEN '5200' WHEN p_treatment='expense' THEN '5000' ELSE '1300' END);
  change:=desired-booked;
  components:=components||jsonb_build_array(jsonb_build_object('eventId',e.id,'kind',e.kind,'unitId',e.unit_id,'date',e.recorded_on::text,'weightKg',e.weight_kg::text,'account',account_code,'bookedValue',booked::numeric(20,4)::text,'reviewedValue',desired::numeric(20,4)::text,'delta',change::numeric(20,4)::text,'basis',basis));
  IF e.kind='receipt' THEN purchase_booked:=booked;nets:=feed_cost_add_net(nets,'1200',change);nets:=feed_cost_add_net(nets,CASE WHEN p_settlement='payables' THEN '2000' ELSE '1000' END,-change);
  ELSE nets:=feed_cost_add_net(nets,account_code,change);nets:=feed_cost_add_net(nets,'1200',-change);END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('account',a.key,'side',CASE WHEN a.value::numeric>0 THEN 'debit' ELSE 'credit' END,'amount',abs(a.value::numeric)::numeric(20,4)::text) ORDER BY a.key),'[]'::jsonb) INTO lines FROM jsonb_each_text(nets)a WHERE a.value::numeric<>0;
 IF jsonb_array_length(lines)=0 THEN lines:=jsonb_build_array(jsonb_build_object('account','1200','side','debit','amount','0.0000'),jsonb_build_object('account',CASE WHEN p_settlement='payables' THEN '2000' ELSE '1000' END,'side','credit','amount','0.0000'));END IF;
 review_json:=to_jsonb(r)||jsonb_build_object('position',r.position::text,'expected_stock_position',r.expected_stock_position::text,'expected_review_position',r.expected_review_position::text,'reviewed_on',r.reviewed_on::text);
 RETURN jsonb_build_object('policy','reviewed-feed-cost-ledger-v1','lotId',receipt.id,'review',review_json,'parentPostingId',parent,'currency',receipt.currency,'postedOn',r.reviewed_on::text,'reference','FEED COST '||receipt.reference,'bookedPurchaseValue',purchase_booked::numeric(20,4)::text,'reviewedPurchaseValue',(r.input->>'totalCost'),'purchaseDelta',((r.input->>'totalCost')::numeric-purchase_booked)::numeric(20,4)::text,'components',components,'lines',lines);
END $$;
REVOKE ALL ON FUNCTION feed_cost_posting_basis(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION feed_cost_posting_basis(uuid,uuid,text,text) TO farm_app;
CREATE FUNCTION validate_feed_cost_posting() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d jsonb:=NEW.input;s jsonb;today date;
BEGIN
 IF coalesce(member_role(NEW.organization_id),'') NOT IN ('owner','admin','manager') THEN RAISE EXCEPTION 'Financial posting role required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(d)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(d))<>8 OR NOT(d ?& ARRAY['kind','reviewId','settlement','paymentEvidence','consumptionTreatment','policy','reason','evidence']) OR jsonb_typeof(d->'reviewId')<>'string' OR d->>'policy' IS DISTINCT FROM 'reviewed-feed-cost-ledger-v1' OR NOT broiler_plan_text(d->'reason',10,2000,false) OR NOT broiler_plan_text(d->'evidence',3,2000,false) OR (d->>'settlement'='cash_bank' AND NOT broiler_plan_text(d->'paymentEvidence',3,1000,false)) OR (d->>'settlement'='payables' AND d->'paymentEvidence'<>'null'::jsonb) THEN RAISE EXCEPTION 'Invalid reviewed cost posting evidence' USING ERRCODE='23514';END IF;
 PERFORM lock_feed_cost_posting(NEW.organization_id,(d->>'reviewId')::uuid);
 IF NEW.expected_position<>(SELECT coalesce(max(position),0) FROM financial_journal_entries WHERE organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'Stale journal head' USING ERRCODE='23505';END IF;
 IF (SELECT count(*) FROM financial_journal_entries WHERE organization_id=NEW.organization_id)>=1000 THEN RAISE EXCEPTION 'Journal entry limit reached' USING ERRCODE='23514';END IF;
 s:=feed_cost_posting_basis(NEW.organization_id,(d->>'reviewId')::uuid,d->>'settlement',d->>'consumptionTreatment');
 SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
 IF (s->>'postedOn')::date>today THEN RAISE EXCEPTION 'Cost review date is later than organization today' USING ERRCODE='23514';END IF;
 NEW.kind:='recognize_feed_cost';NEW.source_kind:='feed_cost';NEW.source_id:=(d->>'reviewId')::uuid;NEW.unit_id:=NULL;NEW.reversal_of_id:=NULL;NEW.currency:=s->>'currency';NEW.posted_on:=(s->>'postedOn')::date;NEW.reference:=s->>'reference';NEW.description:='Post reviewed feed cost against existing linked books';NEW.lines:=s->'lines';NEW.source_snapshot:=s;
 NEW.input:=d||jsonb_build_object('reviewId',NEW.source_id,'paymentEvidence',CASE WHEN d->'paymentEvidence'='null'::jsonb THEN NULL ELSE btrim(d->>'paymentEvidence') END,'reason',btrim(d->>'reason'),'evidence',btrim(d->>'evidence'));
 NEW.submission:=jsonb_build_object('organizationId',NEW.organization_id,'entryId',NEW.id,'expectedPosition',NEW.expected_position::text,'data',NEW.input);NEW.position:=nextval('financial_journal_position');RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION validate_feed_cost_posting() FROM PUBLIC;
DROP TRIGGER financial_journal_check ON financial_journal_entries;
CREATE TRIGGER financial_journal_check BEFORE INSERT ON financial_journal_entries FOR EACH ROW WHEN(NEW.input->>'kind' NOT IN ('recognize_feed','recognize_feed_cost') OR NEW.input->>'kind' IS NULL) EXECUTE FUNCTION validate_financial_journal();
CREATE TRIGGER financial_feed_cost_check BEFORE INSERT ON financial_journal_entries FOR EACH ROW WHEN(NEW.input->>'kind'='recognize_feed_cost') EXECUTE FUNCTION validate_feed_cost_posting();
CREATE FUNCTION guard_feed_cost_basis() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE lot uuid;unit uuid;original financial_journal_entries;last_date date;
BEGIN
 IF NEW.input->>'kind'='recognize_feed' THEN SELECT lot_id,unit_id INTO lot,unit FROM feed_stock_events WHERE organization_id=NEW.organization_id AND id=(NEW.input->>'sourceId')::uuid;
 ELSIF NEW.input->>'kind'='reverse' THEN
  SELECT * INTO original FROM financial_journal_entries WHERE organization_id=NEW.organization_id AND id=(NEW.input->>'originalId')::uuid;
  IF original.kind='recognize_feed_cost' THEN
   PERFORM lock_feed_cost_posting(NEW.organization_id,original.source_id);
   IF EXISTS(SELECT 1 FROM financial_journal_entries j WHERE j.organization_id=NEW.organization_id AND j.kind='recognize_feed_cost' AND j.source_snapshot->>'parentPostingId'=original.id::text AND NOT EXISTS(SELECT 1 FROM financial_journal_entries r WHERE r.reversal_of_id=j.id)) THEN RAISE EXCEPTION 'Reverse newer reviewed-cost postings first' USING ERRCODE='23514';END IF;
   SELECT max(r.posted_on) INTO last_date FROM financial_journal_entries j JOIN financial_journal_entries r ON r.reversal_of_id=j.id WHERE j.organization_id=NEW.organization_id AND j.source_snapshot->>'parentPostingId'=original.id::text;
   IF (NEW.input->>'date')::date<last_date THEN RAISE EXCEPTION 'Cost reversal cannot precede dependent reversal dates' USING ERRCODE='23514';END IF;
   RETURN NEW;
  ELSIF original.source_kind='feed' THEN SELECT lot_id,unit_id INTO lot,unit FROM feed_stock_events WHERE organization_id=NEW.organization_id AND id=original.source_id;
  ELSE RETURN NEW;END IF;
 ELSE RETURN NEW;END IF;
 IF lot IS NOT NULL THEN
  IF unit IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtext(unit::text));END IF;
  PERFORM pg_advisory_xact_lock(813,hashtext(NEW.organization_id::text));PERFORM pg_advisory_xact_lock(812,hashtext(NEW.organization_id::text));
  IF feed_cost_is_managed(NEW.organization_id,lot) THEN RAISE EXCEPTION 'Use a current reviewed-cost posting, or reverse all reviewed-cost postings before changing original feed accounting' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_feed_cost_basis() FROM PUBLIC;
CREATE TRIGGER a_feed_cost_basis_guard BEFORE INSERT ON financial_journal_entries FOR EACH ROW WHEN(NEW.input->>'kind' IN ('recognize_feed','reverse')) EXECUTE FUNCTION guard_feed_cost_basis();
CREATE OR REPLACE FUNCTION feed_financial_is_booked(p_org uuid,p_source uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(member_role(p_org) IN ('owner','admin','manager','inventory','accounts','auditor'),false) AND EXISTS(SELECT 1 FROM financial_journal_entries e WHERE e.organization_id=p_org AND ((e.kind='recognize_feed' AND e.source_id=p_source) OR (e.kind='recognize_feed_cost' AND e.source_snapshot->'components' @> jsonb_build_array(jsonb_build_object('eventId',p_source)))) AND NOT EXISTS(SELECT 1 FROM financial_journal_entries r WHERE r.reversal_of_id=e.id));
$$;
CREATE FUNCTION check_feed_cost_consistency() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM financial_journal_entries j LEFT JOIN active_feed_stock_events l ON l.organization_id=j.organization_id AND l.id=(j.source_snapshot->>'lotId')::uuid WHERE j.organization_id=NEW.organization_id AND j.kind='recognize_feed_cost' AND NOT EXISTS(SELECT 1 FROM financial_journal_entries r WHERE r.reversal_of_id=j.id) AND (l.id IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(j.source_snapshot->'components')c WHERE NOT EXISTS(SELECT 1 FROM active_feed_stock_events a WHERE a.organization_id=j.organization_id AND a.id=(c.value->>'eventId')::uuid)) OR (j.source_snapshot->>'parentPostingId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM financial_journal_entries p WHERE p.organization_id=j.organization_id AND p.id=(j.source_snapshot->>'parentPostingId')::uuid AND p.kind='recognize_feed_cost' AND NOT EXISTS(SELECT 1 FROM financial_journal_entries pr WHERE pr.reversal_of_id=p.id))))) THEN RAISE EXCEPTION 'Active cost postings require their active sources and predecessor' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION check_feed_cost_consistency() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER feed_cost_consistency AFTER INSERT ON financial_journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.source_kind IN ('feed','feed_cost')) EXECUTE FUNCTION check_feed_cost_consistency();
CREATE CONSTRAINT TRIGGER feed_cost_stock_consistency AFTER INSERT ON feed_stock_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='void') EXECUTE FUNCTION check_feed_cost_consistency();

CREATE OR REPLACE VIEW financial_feed_sources WITH (security_invoker=true) AS
 SELECT e.organization_id,e.id AS source_id,e.lot_id,e.unit_id,e.kind,e.recorded_on,e.currency,e.amount::text AS amount,e.weight_kg::text AS weight_kg,l.input->>'feedName' AS feed_name,l.reference,
 (SELECT j.id FROM financial_journal_entries j WHERE j.organization_id=e.organization_id AND ((j.kind='recognize_feed' AND j.source_id=e.id) OR (j.kind='recognize_feed_cost' AND j.source_snapshot->'components' @> jsonb_build_array(jsonb_build_object('eventId',e.id)))) AND NOT EXISTS(SELECT 1 FROM financial_journal_entries v WHERE v.reversal_of_id=j.id) LIMIT 1) AS recognized_id,
 (SELECT j.id FROM financial_journal_entries j WHERE j.organization_id=e.organization_id AND ((j.kind='recognize_feed' AND j.source_id=e.lot_id) OR (j.kind='recognize_feed_cost' AND j.source_snapshot->'components' @> jsonb_build_array(jsonb_build_object('eventId',e.lot_id)))) AND NOT EXISTS(SELECT 1 FROM financial_journal_entries v WHERE v.reversal_of_id=j.id) LIMIT 1) AS receipt_recognized_id,
 CASE WHEN e.kind<>'consume' THEN true ELSE feed_effective_source_sha(e.organization_id,e.id)=encode(sha256(convert_to(feed_consumption_source(e.organization_id,e.unit_id,e.recorded_on)::text,'UTF8')),'hex') AND (SELECT coalesce(sum(a.weight_kg),0) FROM active_feed_stock_events a WHERE a.organization_id=e.organization_id AND a.unit_id=e.unit_id AND a.recorded_on=e.recorded_on AND a.kind='consume')<=(SELECT (feed_consumption_source(e.organization_id,e.unit_id,e.recorded_on)->'record'->>'feed_kg')::numeric) END AS source_current
 FROM active_feed_stock_events e JOIN active_feed_stock_events l ON l.organization_id=e.organization_id AND l.id=e.lot_id AND l.kind='receipt';

