-- Add feed source recognition without changing old row shapes, chart or frozen evidence.
ALTER TABLE financial_journal_entries DROP CONSTRAINT financial_journal_entries_kind_check;
ALTER TABLE financial_journal_entries ADD CHECK(kind IN ('manual','recognize_sale','recognize_feed','reverse'));
ALTER TABLE financial_journal_entries DROP CONSTRAINT financial_journal_entries_source_kind_check;
ALTER TABLE financial_journal_entries ADD CHECK(source_kind IS NULL OR source_kind IN ('live','product','feed'));
ALTER TABLE financial_journal_entries ADD CONSTRAINT financial_feed_required CHECK(kind<>'recognize_feed' OR (source_kind='feed' AND source_id IS NOT NULL AND source_snapshot IS NOT NULL));
-- Inventory officers may learn a block exists, without permission to read financial entries.
CREATE FUNCTION feed_financial_is_booked(p_org uuid,p_source uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(member_role(p_org) IN ('owner','admin','manager','inventory','accounts','auditor'),false) AND EXISTS(SELECT 1 FROM financial_journal_entries e WHERE e.organization_id=p_org AND e.kind='recognize_feed' AND e.source_id=p_source AND NOT EXISTS(SELECT 1 FROM financial_journal_entries r WHERE r.reversal_of_id=e.id));
$$;
REVOKE ALL ON FUNCTION feed_financial_is_booked(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION feed_financial_is_booked(uuid,uuid) TO farm_app;
CREATE VIEW financial_feed_sources WITH (security_invoker=true) AS
 SELECT e.organization_id,e.id AS source_id,e.lot_id,e.unit_id,e.kind,e.recorded_on,e.currency,e.amount::text AS amount,e.weight_kg::text AS weight_kg,l.input->>'feedName' AS feed_name,l.reference,
 (SELECT j.id FROM financial_journal_entries j WHERE j.organization_id=e.organization_id AND j.kind='recognize_feed' AND j.source_id=e.id AND NOT EXISTS(SELECT 1 FROM financial_journal_entries v WHERE v.reversal_of_id=j.id) LIMIT 1) AS recognized_id,
 (SELECT j.id FROM financial_journal_entries j WHERE j.organization_id=e.organization_id AND j.kind='recognize_feed' AND j.source_id=e.lot_id AND NOT EXISTS(SELECT 1 FROM financial_journal_entries v WHERE v.reversal_of_id=j.id) LIMIT 1) AS receipt_recognized_id,
 CASE WHEN e.kind<>'consume' THEN true ELSE e.source_sha256=encode(sha256(convert_to(feed_consumption_source(e.organization_id,e.unit_id,e.recorded_on)::text,'UTF8')),'hex') AND (SELECT coalesce(sum(a.weight_kg),0) FROM active_feed_stock_events a WHERE a.organization_id=e.organization_id AND a.unit_id=e.unit_id AND a.recorded_on=e.recorded_on AND a.kind='consume')<=(SELECT (feed_consumption_source(e.organization_id,e.unit_id,e.recorded_on)->'record'->>'feed_kg')::numeric) END AS source_current
 FROM active_feed_stock_events e JOIN active_feed_stock_events l ON l.organization_id=e.organization_id AND l.id=e.lot_id AND l.kind='receipt';
GRANT SELECT ON financial_feed_sources TO farm_app;
CREATE FUNCTION validate_financial_feed() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d jsonb:=NEW.input; e feed_stock_events; lot feed_stock_events; parent uuid; debit_account text; credit_account text; today date;
BEGIN
 IF coalesce(member_role(NEW.organization_id),'') NOT IN ('owner','admin','manager') THEN RAISE EXCEPTION 'Financial posting role required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(d)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(d))<>8 OR NOT(d ?& ARRAY['kind','sourceId','purchaseSettlement','consumptionTreatment','paymentEvidence','policy','reason','evidence']) OR jsonb_typeof(d->'sourceId')<>'string' OR d->>'policy' IS DISTINCT FROM 'recorded-feed-lot-value-v1' OR NOT broiler_plan_text(d->'reason',10,2000,false) OR NOT broiler_plan_text(d->'evidence',3,2000,false) THEN RAISE EXCEPTION 'Invalid feed accounting recognition input' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM feed_stock_events WHERE organization_id=NEW.organization_id AND id=(d->>'sourceId')::uuid AND kind<>'void';
 IF e.id IS NULL THEN RAISE EXCEPTION 'Choose a visible original feed movement' USING ERRCODE='23514';END IF;
 IF e.unit_id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtext(e.unit_id::text));END IF;
 PERFORM pg_advisory_xact_lock(813,hashtext(NEW.organization_id::text));
 PERFORM pg_advisory_xact_lock(812,hashtext(NEW.organization_id::text));
 IF NEW.expected_position<>(SELECT coalesce(max(position),0) FROM financial_journal_entries WHERE organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'Stale financial journal head' USING ERRCODE='23505';END IF;
 IF (SELECT count(*) FROM financial_journal_entries WHERE organization_id=NEW.organization_id)>=1000 THEN RAISE EXCEPTION 'Journal reached its entry limit' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM active_feed_stock_events WHERE id=e.id) OR e.amount IS NULL OR feed_financial_is_booked(NEW.organization_id,e.id) THEN RAISE EXCEPTION 'Feed movement is voided, unknown-cost or already recognized' USING ERRCODE='23514';END IF;
 SELECT * INTO lot FROM active_feed_stock_events WHERE organization_id=NEW.organization_id AND id=e.lot_id AND kind='receipt';
 IF lot.id IS NULL THEN RAISE EXCEPTION 'Original active feed receipt is required' USING ERRCODE='23514';END IF;
 IF e.kind='receipt' THEN
  IF jsonb_typeof(d->'purchaseSettlement')<>'string' OR (d->>'purchaseSettlement') NOT IN ('payables','cash_bank') OR d->'consumptionTreatment'<>'null'::jsonb OR (d->>'purchaseSettlement'='cash_bank' AND NOT broiler_plan_text(d->'paymentEvidence',3,1000,false)) OR (d->>'purchaseSettlement'='payables' AND d->'paymentEvidence'<>'null'::jsonb) THEN RAISE EXCEPTION 'Choose purchase payables or evidenced cash/bank payment' USING ERRCODE='23514';END IF;
  debit_account:='1200';credit_account:=CASE WHEN d->>'purchaseSettlement'='payables' THEN '2000' ELSE '1000' END;
 ELSE
  IF d->'purchaseSettlement'<>'null'::jsonb OR d->'paymentEvidence'<>'null'::jsonb OR (e.kind='consume' AND (jsonb_typeof(d->'consumptionTreatment')<>'string' OR (d->>'consumptionTreatment') NOT IN ('expense','work_in_progress'))) OR (e.kind='loss' AND d->'consumptionTreatment'<>'null'::jsonb) THEN RAISE EXCEPTION 'Choose the explicit consumption accounting treatment or stock-loss expense' USING ERRCODE='23514';END IF;
  SELECT j.id INTO parent FROM financial_journal_entries j WHERE j.organization_id=NEW.organization_id AND j.kind='recognize_feed' AND j.source_id=lot.id AND NOT EXISTS(SELECT 1 FROM financial_journal_entries r WHERE r.reversal_of_id=j.id) LIMIT 1;
  IF parent IS NULL THEN RAISE EXCEPTION 'Recognize the original feed purchase before its consumption or loss' USING ERRCODE='23514';END IF;
  IF e.kind='consume' AND NOT coalesce((SELECT s.source_current FROM financial_feed_sources s WHERE s.organization_id=NEW.organization_id AND s.source_id=e.id),false) THEN RAISE EXCEPTION 'Actual feed source changed or is overlinked; reconcile before financial recognition' USING ERRCODE='23514';END IF;
  debit_account:=CASE WHEN e.kind='loss' THEN '5200' WHEN d->>'consumptionTreatment'='expense' THEN '5000' ELSE '1300' END;credit_account:='1200';
 END IF;
 SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
 IF e.recorded_on>today THEN RAISE EXCEPTION 'Feed source date is later than organization today' USING ERRCODE='23514';END IF;
 NEW.kind:='recognize_feed';NEW.unit_id:=e.unit_id;NEW.source_kind:='feed';NEW.source_id:=e.id;NEW.reversal_of_id:=NULL;NEW.posted_on:=e.recorded_on;NEW.currency:=e.currency;NEW.reference:='FEED '||lot.reference;NEW.description:='Recognize original feed '||e.kind;
 NEW.lines:=jsonb_build_array(jsonb_build_object('account',debit_account,'side','debit','amount',e.amount::text),jsonb_build_object('account',credit_account,'side','credit','amount',e.amount::text));
 NEW.source_snapshot:=jsonb_build_object('event',to_jsonb(e)||jsonb_build_object('position',e.position::text,'expected_position',e.expected_position::text,'recorded_on',e.recorded_on::text,'weight_kg',e.weight_kg::text,'amount',e.amount::text),'lot',to_jsonb(lot)||jsonb_build_object('position',lot.position::text,'expected_position',lot.expected_position::text,'recorded_on',lot.recorded_on::text,'weight_kg',lot.weight_kg::text,'amount',lot.amount::text),'purchaseRecognitionId',parent);
 NEW.input:=d||jsonb_build_object('sourceId',e.id,'reason',btrim(d->>'reason'),'evidence',btrim(d->>'evidence'),'paymentEvidence',CASE WHEN d->'paymentEvidence'='null'::jsonb THEN NULL ELSE btrim(d->>'paymentEvidence') END);
 NEW.submission:=jsonb_build_object('organizationId',NEW.organization_id,'entryId',NEW.id,'expectedPosition',NEW.expected_position::text,'data',NEW.input);
 NEW.position:=nextval('financial_journal_position');RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION validate_financial_feed() FROM PUBLIC;
DROP TRIGGER financial_journal_check ON financial_journal_entries;
CREATE TRIGGER financial_journal_check BEFORE INSERT ON financial_journal_entries FOR EACH ROW WHEN(NEW.input->>'kind' IS DISTINCT FROM 'recognize_feed') EXECUTE FUNCTION validate_financial_journal();
CREATE TRIGGER financial_feed_check BEFORE INSERT ON financial_journal_entries FOR EACH ROW WHEN(NEW.input->>'kind'='recognize_feed') EXECUTE FUNCTION validate_financial_feed();
CREATE FUNCTION guard_financial_feed_reversal() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original financial_journal_entries; last_dependency date;
BEGIN
 SELECT * INTO original FROM financial_journal_entries WHERE organization_id=NEW.organization_id AND id=(NEW.input->>'originalId')::uuid AND source_kind='feed' AND kind='recognize_feed';
 IF original.id IS NULL THEN RETURN NEW;END IF;
 IF original.unit_id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtext(original.unit_id::text));END IF;
 PERFORM pg_advisory_xact_lock(813,hashtext(NEW.organization_id::text));PERFORM pg_advisory_xact_lock(812,hashtext(NEW.organization_id::text));
 IF original.source_snapshot->'event'->>'kind'='receipt' THEN
  IF EXISTS(SELECT 1 FROM financial_journal_entries e WHERE e.organization_id=NEW.organization_id AND e.kind='recognize_feed' AND e.source_snapshot->>'purchaseRecognitionId'=original.id::text AND NOT EXISTS(SELECT 1 FROM financial_journal_entries r WHERE r.reversal_of_id=e.id)) THEN RAISE EXCEPTION 'Reverse dependent feed consumption/loss recognition before the purchase' USING ERRCODE='23514';END IF;
  SELECT max(r.posted_on) INTO last_dependency FROM financial_journal_entries e JOIN financial_journal_entries r ON r.reversal_of_id=e.id WHERE e.organization_id=NEW.organization_id AND e.kind='recognize_feed' AND e.source_snapshot->>'purchaseRecognitionId'=original.id::text;
  IF (NEW.input->>'date')::date<last_dependency THEN RAISE EXCEPTION 'Purchase reversal cannot precede its dependent accounting reversals' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_financial_feed_reversal() FROM PUBLIC;
CREATE TRIGGER financial_feed_reversal_check BEFORE INSERT ON financial_journal_entries FOR EACH ROW WHEN(NEW.input->>'kind'='reverse') EXECUTE FUNCTION guard_financial_feed_reversal();
CREATE FUNCTION guard_booked_feed_void() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.kind='void' THEN
  PERFORM pg_advisory_xact_lock(813,hashtext(NEW.organization_id::text));PERFORM pg_advisory_xact_lock(812,hashtext(NEW.organization_id::text));
  IF feed_financial_is_booked(NEW.organization_id,NEW.void_of_id) THEN RAISE EXCEPTION 'Reverse feed financial recognition before voiding its physical source' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_booked_feed_void() FROM PUBLIC;
-- Existing feed_stock_check validates and acquires the unit/stock locks first.
CREATE TRIGGER z_financial_feed_void_check BEFORE INSERT ON feed_stock_events FOR EACH ROW EXECUTE FUNCTION guard_booked_feed_void();
CREATE FUNCTION check_feed_financial_consistency() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM financial_journal_entries e WHERE e.organization_id=NEW.organization_id AND e.kind='recognize_feed' AND NOT EXISTS(SELECT 1 FROM financial_journal_entries r WHERE r.reversal_of_id=e.id) GROUP BY e.source_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate active feed financial recognition' USING ERRCODE='23505';END IF;
 IF EXISTS(SELECT 1 FROM financial_journal_entries e LEFT JOIN active_feed_stock_events s ON s.organization_id=e.organization_id AND s.id=e.source_id WHERE e.organization_id=NEW.organization_id AND e.kind='recognize_feed' AND NOT EXISTS(SELECT 1 FROM financial_journal_entries r WHERE r.reversal_of_id=e.id) AND (s.id IS NULL OR s.amount IS NULL OR (s.kind<>'receipt' AND NOT EXISTS(SELECT 1 FROM financial_journal_entries p WHERE p.id=(e.source_snapshot->>'purchaseRecognitionId')::uuid AND p.organization_id=e.organization_id AND p.source_id=s.lot_id AND p.kind='recognize_feed' AND NOT EXISTS(SELECT 1 FROM financial_journal_entries pr WHERE pr.reversal_of_id=p.id))))) THEN RAISE EXCEPTION 'Active feed recognition requires its original source and active purchase recognition' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION check_feed_financial_consistency() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER feed_financial_consistency AFTER INSERT ON financial_journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.source_kind='feed') EXECUTE FUNCTION check_feed_financial_consistency();
CREATE CONSTRAINT TRIGGER feed_stock_financial_consistency AFTER INSERT ON feed_stock_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='void') EXECUTE FUNCTION check_feed_financial_consistency();
