-- Genuine returns of unused feed preserve original physical/cost/financial history.
ALTER TABLE feed_stock_events DROP CONSTRAINT feed_stock_events_kind_check;
ALTER TABLE feed_stock_events ADD CHECK(kind IN ('receipt','consume','loss','supplier_return','void'));
ALTER TABLE feed_stock_events DROP CONSTRAINT feed_stock_events_model_version_check;
ALTER TABLE feed_stock_events ADD CHECK(model_version IN ('specific-feed-lot-stock-v1','specific-feed-lot-stock-v2'));
CREATE UNIQUE INDEX feed_supplier_return_reference ON feed_stock_events(organization_id,(input->>'returnReference')) WHERE kind='supplier_return';
CREATE OR REPLACE FUNCTION validate_feed_stock() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d jsonb:=NEW.input; original feed_stock_events; lot feed_stock_events; locked_unit uuid; today date; last_day date; keys integer; balance numeric; value_balance numeric; issued numeric; snapshot jsonb; source_hash text;
BEGIN
 IF coalesce(member_role(NEW.organization_id),'') NOT IN ('owner','admin','manager','inventory') THEN RAISE EXCEPTION 'Feed stock posting role required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(d)<>'object' OR jsonb_typeof(d->'kind')<>'string' OR NOT broiler_plan_text(d->'reason',10,2000,false) OR NOT broiler_plan_text(d->'evidence',3,2000,false) THEN RAISE EXCEPTION 'Invalid feed stock evidence' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO keys FROM jsonb_object_keys(d);
 NEW.kind:=d->>'kind';NEW.unit_id:=NULL;NEW.source_snapshot:=NULL;NEW.source_sha256:=NULL;NEW.void_of_id:=NULL;NEW.reference:=NULL;NEW.amount:=NULL;
 IF NEW.kind='consume' THEN
  IF keys<>8 OR NOT(d ?& ARRAY['kind','lotId','unitId','weightKg','expectedSourceSha256','scope','reason','evidence']) OR jsonb_typeof(d->'unitId')<>'string' OR jsonb_typeof(d->'expectedSourceSha256')<>'string' OR (d->>'expectedSourceSha256')!~'^[a-f0-9]{64}$' OR d->>'scope' IS DISTINCT FROM 'actual-recorded-feed-consumption' THEN RAISE EXCEPTION 'Invalid consumed-feed source declaration' USING ERRCODE='23514';END IF;
  locked_unit:=(d->>'unitId')::uuid;NEW.unit_id:=locked_unit;
 ELSIF NEW.kind='void' THEN
  IF keys<>4 OR NOT(d ?& ARRAY['kind','voidOfId','reason','evidence']) OR jsonb_typeof(d->'voidOfId')<>'string' THEN RAISE EXCEPTION 'Invalid erroneous feed entry reversal' USING ERRCODE='23514';END IF;
  SELECT * INTO original FROM feed_stock_events WHERE organization_id=NEW.organization_id AND id=(d->>'voidOfId')::uuid AND kind<>'void';
  IF original.id IS NULL THEN RAISE EXCEPTION 'Original feed movement not found' USING ERRCODE='23514';END IF;
  locked_unit:=original.unit_id;
 END IF;
 -- Unit first, then organization stock; no production writer acquires these in reverse.
 IF locked_unit IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtext(locked_unit::text));END IF;
 PERFORM pg_advisory_xact_lock(813,hashtext(NEW.organization_id::text));
 IF NEW.expected_position<>(SELECT coalesce(max(position),0) FROM feed_stock_events WHERE organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'Stale feed stock head; reload and review' USING ERRCODE='23505';END IF;
 IF (SELECT count(*) FROM feed_stock_events WHERE organization_id=NEW.organization_id)>=1000 THEN RAISE EXCEPTION 'Organization reached its 1000 feed-event limit' USING ERRCODE='23514';END IF;
 SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
 IF NEW.recorded_on<'1900-01-01'::date OR NEW.recorded_on>today THEN RAISE EXCEPTION 'Feed movement date must be from 1900 through organization today' USING ERRCODE='23514';END IF;
 IF NEW.kind='receipt' THEN
  IF keys<>12 OR NOT(d ?& ARRAY['kind','feedName','supplier','reference','location','weightKg','currency','totalCost','costEvidence','scope','reason','evidence']) OR NOT broiler_plan_text(d->'feedName',2,200,false) OR NOT broiler_plan_text(d->'supplier',2,200,false) OR NOT broiler_plan_text(d->'reference',3,100,false) OR NOT broiler_plan_text(d->'location',2,100,false) OR NOT broiler_plan_decimal(d->'weightKg',100000000,6,false,false) OR jsonb_typeof(d->'currency')<>'string' OR (d->>'currency')!~'^[A-Z]{3}$' OR d->>'scope' IS DISTINCT FROM 'actual-owned-purchase-receipt' OR NOT((d->'totalCost'='null'::jsonb AND d->'costEvidence'='null'::jsonb) OR (broiler_plan_decimal(d->'totalCost',100000000,4,true,false) AND broiler_plan_text(d->'costEvidence',3,2000,false))) THEN RAISE EXCEPTION 'Invalid feed purchase receipt or known/unknown total cost' USING ERRCODE='23514';END IF;
  NEW.lot_id:=NEW.id;NEW.weight_kg:=(d->>'weightKg')::numeric;NEW.amount:=(d->>'totalCost')::numeric;NEW.currency:=d->>'currency';NEW.reference:=btrim(d->>'reference');
  d:=d||jsonb_build_object('feedName',btrim(d->>'feedName'),'supplier',btrim(d->>'supplier'),'location',btrim(d->>'location'),'reference',NEW.reference,'weightKg',NEW.weight_kg::text,'totalCost',NEW.amount::text,'costEvidence',CASE WHEN NEW.amount IS NULL THEN NULL ELSE btrim(d->>'costEvidence') END);
 ELSE
  IF NEW.kind='void' THEN
   IF EXISTS(SELECT 1 FROM feed_stock_events WHERE void_of_id=original.id) THEN RAISE EXCEPTION 'Feed movement already reversed' USING ERRCODE='23505';END IF;
   NEW.void_of_id:=original.id;NEW.lot_id:=original.lot_id;NEW.weight_kg:=original.weight_kg;NEW.amount:=original.amount;
   IF original.kind='receipt' AND EXISTS(SELECT 1 FROM active_feed_stock_events WHERE lot_id=original.id AND kind IN ('consume','loss','supplier_return')) THEN RAISE EXCEPTION 'Reverse dependent consumption and losses before erroneous receipt' USING ERRCODE='23514';END IF;
   d:=d||jsonb_build_object('voidOfId',original.id);
  ELSE
   IF NEW.kind NOT IN ('consume','loss','supplier_return') OR jsonb_typeof(d->'lotId')<>'string' OR NOT broiler_plan_decimal(d->'weightKg',100000000,6,false,false) OR (NEW.kind='loss' AND (keys<>5 OR NOT(d ?& ARRAY['kind','lotId','weightKg','reason','evidence']))) THEN RAISE EXCEPTION 'Invalid feed consumption/loss quantity' USING ERRCODE='23514';END IF;
   NEW.lot_id:=(d->>'lotId')::uuid;NEW.weight_kg:=(d->>'weightKg')::numeric;
   d:=d||jsonb_build_object('lotId',NEW.lot_id,'weightKg',NEW.weight_kg::text);
   IF NEW.kind='supplier_return' THEN
    IF keys<>8 OR NOT(d ?& ARRAY['kind','lotId','weightKg','returnReference','supplierEvidence','scope','reason','evidence']) OR NOT broiler_plan_text(d->'returnReference',3,100,false) OR NOT broiler_plan_text(d->'supplierEvidence',3,2000,false) OR d->>'scope' IS DISTINCT FROM 'actual-unused-feed-return-to-original-supplier' THEN RAISE EXCEPTION 'Declare an actual unused-feed return to the original supplier with handover evidence and reference' USING ERRCODE='23514';END IF;
    d:=d||jsonb_build_object('returnReference',btrim(d->>'returnReference'),'supplierEvidence',btrim(d->>'supplierEvidence'));
   END IF;
  END IF;
  SELECT * INTO lot FROM active_feed_stock_events WHERE organization_id=NEW.organization_id AND id=NEW.lot_id AND kind='receipt';
  IF lot.id IS NULL THEN RAISE EXCEPTION 'Choose an active feed lot from this organization' USING ERRCODE='23514';END IF;
  NEW.currency:=lot.currency;
  SELECT max(recorded_on) INTO last_day FROM feed_stock_events WHERE lot_id=lot.id;
  IF NEW.recorded_on<last_day THEN RAISE EXCEPTION 'Feed movements must follow this lot history in date order' USING ERRCODE='23514';END IF;
  IF NEW.kind IN ('consume','loss','supplier_return') THEN
   SELECT lot.weight_kg-coalesce(sum(weight_kg),0),CASE WHEN lot.amount IS NULL THEN NULL ELSE lot.amount-coalesce(sum(amount),0) END INTO balance,value_balance FROM active_feed_stock_events WHERE lot_id=lot.id AND kind IN ('consume','loss','supplier_return');
   IF NEW.weight_kg>balance THEN RAISE EXCEPTION 'Insufficient feed lot stock' USING ERRCODE='23514';END IF;
   NEW.amount:=CASE WHEN value_balance IS NULL THEN NULL WHEN NEW.weight_kg=balance THEN value_balance ELSE round(value_balance*NEW.weight_kg/balance,4) END;
  END IF;
  IF NEW.kind='consume' THEN
   snapshot:=feed_consumption_source(NEW.organization_id,NEW.unit_id,NEW.recorded_on);
   IF snapshot IS NULL OR (snapshot->'record'->>'feed_kg')::numeric<=0 THEN RAISE EXCEPTION 'Choose a genuine positive actual daily broiler feed record' USING ERRCODE='23514';END IF;
   source_hash:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
   IF d->>'expectedSourceSha256'<>source_hash THEN RAISE EXCEPTION 'Actual feed source changed; reload and review' USING ERRCODE='23505';END IF;
   SELECT coalesce(sum(weight_kg),0) INTO issued FROM active_feed_stock_events WHERE organization_id=NEW.organization_id AND kind='consume' AND unit_id=NEW.unit_id AND recorded_on=NEW.recorded_on;
   IF issued+NEW.weight_kg>(snapshot->'record'->>'feed_kg')::numeric THEN RAISE EXCEPTION 'Linked lot consumption exceeds this actual daily feed quantity' USING ERRCODE='23514';END IF;
   NEW.source_snapshot:=snapshot;NEW.source_sha256:=source_hash;
   d:=d||jsonb_build_object('unitId',NEW.unit_id);
  END IF;
 END IF;
 NEW.model_version:=CASE WHEN NEW.kind='supplier_return' OR (NEW.kind='void' AND original.kind='supplier_return') THEN 'specific-feed-lot-stock-v2' ELSE 'specific-feed-lot-stock-v1' END;
 NEW.input:=d||jsonb_build_object('reason',btrim(d->>'reason'),'evidence',btrim(d->>'evidence'));
 NEW.submission:=jsonb_build_object('organizationId',NEW.organization_id,'eventId',NEW.id,'date',NEW.recorded_on::text,'expectedPosition',NEW.expected_position::text,'data',NEW.input);
 NEW.position:=nextval('feed_stock_position');RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION validate_financial_feed() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d jsonb:=NEW.input; e feed_stock_events; lot feed_stock_events; parent uuid; debit_account text; credit_account text; today date;
BEGIN
 IF coalesce(member_role(NEW.organization_id),'') NOT IN ('owner','admin','manager') THEN RAISE EXCEPTION 'Financial posting role required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(d)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(d))<>8 OR NOT(d ?& ARRAY['kind','sourceId','purchaseSettlement','consumptionTreatment','paymentEvidence','policy','reason','evidence']) OR jsonb_typeof(d->'sourceId')<>'string' OR coalesce(d->>'policy','') NOT IN ('recorded-feed-lot-value-v1','recorded-feed-return-carrying-value-v1') OR NOT broiler_plan_text(d->'reason',10,2000,false) OR NOT broiler_plan_text(d->'evidence',3,2000,false) THEN RAISE EXCEPTION 'Invalid feed accounting recognition input' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM feed_stock_events WHERE organization_id=NEW.organization_id AND id=(d->>'sourceId')::uuid AND kind<>'void';
 IF e.id IS NULL THEN RAISE EXCEPTION 'Choose a visible original feed movement' USING ERRCODE='23514';END IF;
 IF d->>'policy' IS DISTINCT FROM (CASE WHEN e.kind='supplier_return' THEN 'recorded-feed-return-carrying-value-v1' ELSE 'recorded-feed-lot-value-v1' END) THEN RAISE EXCEPTION 'Choose the original carrying-value policy for this feed movement' USING ERRCODE='23514';END IF;
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
  IF e.kind='supplier_return' THEN
   IF jsonb_typeof(d->'purchaseSettlement')<>'string' OR (d->>'purchaseSettlement') NOT IN ('payables','cash_bank') OR d->'consumptionTreatment'<>'null'::jsonb OR (d->>'purchaseSettlement'='cash_bank' AND NOT broiler_plan_text(d->'paymentEvidence',3,1000,false)) OR (d->>'purchaseSettlement'='payables' AND d->'paymentEvidence'<>'null'::jsonb) THEN RAISE EXCEPTION 'Choose evidenced supplier credit or recorded cash refund at original carrying value' USING ERRCODE='23514';END IF;
  ELSE
  IF d->'purchaseSettlement'<>'null'::jsonb OR d->'paymentEvidence'<>'null'::jsonb OR (e.kind='consume' AND (jsonb_typeof(d->'consumptionTreatment')<>'string' OR (d->>'consumptionTreatment') NOT IN ('expense','work_in_progress'))) OR (e.kind='loss' AND d->'consumptionTreatment'<>'null'::jsonb) THEN RAISE EXCEPTION 'Choose the explicit consumption accounting treatment or stock-loss expense' USING ERRCODE='23514';END IF;
  END IF;
  SELECT j.id INTO parent FROM financial_journal_entries j WHERE j.organization_id=NEW.organization_id AND j.kind='recognize_feed' AND j.source_id=lot.id AND NOT EXISTS(SELECT 1 FROM financial_journal_entries r WHERE r.reversal_of_id=j.id) LIMIT 1;
  IF parent IS NULL THEN RAISE EXCEPTION 'Recognize the original feed purchase before its consumption or loss' USING ERRCODE='23514';END IF;
  IF e.kind='consume' AND NOT coalesce((SELECT s.source_current FROM financial_feed_sources s WHERE s.organization_id=NEW.organization_id AND s.source_id=e.id),false) THEN RAISE EXCEPTION 'Actual feed source changed or is overlinked; reconcile before financial recognition' USING ERRCODE='23514';END IF;
  debit_account:=CASE WHEN e.kind='supplier_return' THEN CASE WHEN d->>'purchaseSettlement'='payables' THEN '2000' ELSE '1000' END WHEN e.kind='loss' THEN '5200' WHEN d->>'consumptionTreatment'='expense' THEN '5000' ELSE '1300' END;credit_account:='1200';
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
ALTER TABLE feed_reconciliation_reviews DROP CONSTRAINT feed_reconciliation_reviews_model_version_check;
ALTER TABLE feed_reconciliation_reviews ADD CHECK(model_version IN ('feed-reconciliation-v1','feed-reconciliation-v2'));
CREATE OR REPLACE FUNCTION validate_feed_reconciliation_review() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
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
 NEW.model_version:=CASE WHEN NEW.kind='cost' AND EXISTS(SELECT 1 FROM feed_stock_events WHERE organization_id=NEW.organization_id AND lot_id=NEW.target_id AND kind='supplier_return') THEN 'feed-reconciliation-v2' ELSE 'feed-reconciliation-v1' END;
 NEW.input:=d||jsonb_build_object('targetId',e.id,'previousId',NEW.previous_id,'reason',btrim(d->>'reason'),'evidence',btrim(d->>'evidence'));
 NEW.submission:=jsonb_build_object('organizationId',NEW.organization_id,'reviewId',NEW.id,'date',NEW.reviewed_on::text,'expectedStockPosition',NEW.expected_stock_position::text,'expectedReviewPosition',NEW.expected_review_position::text,'expectedSourceSha256',NEW.expected_source_sha256,'data',NEW.input);
 NEW.position:=nextval('feed_review_position');RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION feed_cost_posting_basis_with_returns(p_org uuid,p_review uuid,p_settlement text,p_treatment text,p_return_settlement text) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r feed_reconciliation_reviews; e feed_stock_events; b record; receipt feed_stock_events; latest uuid; parent uuid; prior_date date; quantity numeric; value_left numeric; desired numeric; booked numeric; change numeric; purchase_booked numeric:=0; account_code text; basis jsonb; components jsonb:='[]'; nets jsonb:='{}'; lines jsonb; current_sha text; review_json jsonb;has_returns boolean;result jsonb;
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
 SELECT EXISTS(SELECT 1 FROM feed_stock_events WHERE organization_id=p_org AND lot_id=receipt.id AND kind='supplier_return') INTO has_returns;
 IF has_returns AND coalesce(p_return_settlement,'') NOT IN ('payables','cash_bank') THEN RAISE EXCEPTION 'This lot requires a return-aware posting with supplier-return settlement and accounting evidence' USING ERRCODE='23514';END IF;
 IF NOT has_returns AND p_return_settlement IS NOT NULL THEN RAISE EXCEPTION 'Use the v1 cost policy without supplier-return fields for this lot' USING ERRCODE='23514';END IF;
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
  account_code:=coalesce(account_code,CASE WHEN e.kind='receipt' THEN '1200' WHEN e.kind='loss' THEN '5200' WHEN e.kind='supplier_return' THEN CASE WHEN p_return_settlement='cash_bank' THEN '1000' ELSE '2000' END WHEN p_treatment='expense' THEN '5000' ELSE '1300' END);
  change:=desired-booked;
  components:=components||jsonb_build_array(jsonb_build_object('eventId',e.id,'kind',e.kind,'unitId',e.unit_id,'date',e.recorded_on::text,'weightKg',e.weight_kg::text,'account',account_code,'bookedValue',booked::numeric(20,4)::text,'reviewedValue',desired::numeric(20,4)::text,'delta',change::numeric(20,4)::text,'basis',basis,'sourceEvidence',CASE WHEN e.kind='consume' THEN jsonb_build_object('currentSource',feed_consumption_source(p_org,e.unit_id,e.recorded_on),'sourceReview',(SELECT to_jsonb(sr)||jsonb_build_object('position',sr.position::text,'expected_stock_position',sr.expected_stock_position::text,'expected_review_position',sr.expected_review_position::text,'reviewed_on',sr.reviewed_on::text) FROM current_feed_reconciliation_reviews sr WHERE sr.organization_id=p_org AND sr.kind='source' AND sr.target_id=e.id)) ELSE NULL END));
  IF octet_length(components::text)>786432 THEN RAISE EXCEPTION 'Cost source proof exceeds the 768 KiB bound' USING ERRCODE='23514';END IF;
  IF e.kind='receipt' THEN purchase_booked:=booked;nets:=feed_cost_add_net(nets,'1200',change);nets:=feed_cost_add_net(nets,CASE WHEN p_settlement='payables' THEN '2000' ELSE '1000' END,-change);
  ELSE nets:=feed_cost_add_net(nets,account_code,change);nets:=feed_cost_add_net(nets,'1200',-change);END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('account',a.key,'side',CASE WHEN a.value::numeric>0 THEN 'debit' ELSE 'credit' END,'amount',abs(a.value::numeric)::numeric(20,4)::text) ORDER BY a.key),'[]'::jsonb) INTO lines FROM jsonb_each_text(nets)a WHERE a.value::numeric<>0;
 IF jsonb_array_length(lines)=0 THEN lines:=jsonb_build_array(jsonb_build_object('account','1200','side','debit','amount','0.0000'),jsonb_build_object('account',CASE WHEN p_settlement='payables' THEN '2000' ELSE '1000' END,'side','credit','amount','0.0000'));END IF;
 review_json:=to_jsonb(r)||jsonb_build_object('position',r.position::text,'expected_stock_position',r.expected_stock_position::text,'expected_review_position',r.expected_review_position::text,'reviewed_on',r.reviewed_on::text);
 result:=jsonb_build_object('policy',CASE WHEN has_returns THEN 'reviewed-feed-cost-ledger-v2' ELSE 'reviewed-feed-cost-ledger-v1' END,'lotId',receipt.id,'review',review_json,'parentPostingId',parent,'currency',receipt.currency,'postedOn',r.reviewed_on::text,'reference','FEED COST '||receipt.reference,'bookedPurchaseValue',purchase_booked::numeric(20,4)::text,'reviewedPurchaseValue',(r.input->>'totalCost'),'purchaseDelta',((r.input->>'totalCost')::numeric-purchase_booked)::numeric(20,4)::text,'components',components,'lines',lines);
 IF octet_length(result::text)>786432 THEN RAISE EXCEPTION 'Cost source proof exceeds the 768 KiB bound' USING ERRCODE='23514';END IF;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION feed_cost_posting_basis_with_returns(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION feed_cost_posting_basis_with_returns(uuid,uuid,text,text,text) TO farm_app;
CREATE OR REPLACE FUNCTION feed_cost_posting_basis(p_org uuid,p_review uuid,p_settlement text,p_treatment text) RETURNS jsonb LANGUAGE sql SET search_path=public,pg_temp AS $$ SELECT feed_cost_posting_basis_with_returns(p_org,p_review,p_settlement,p_treatment,NULL); $$;
CREATE OR REPLACE FUNCTION validate_feed_cost_posting() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d jsonb:=NEW.input;s jsonb;today date;
BEGIN
 IF coalesce(member_role(NEW.organization_id),'') NOT IN ('owner','admin','manager') THEN RAISE EXCEPTION 'Financial posting role required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(d)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(d)) NOT IN (8,10) OR NOT(d ?& ARRAY['kind','reviewId','settlement','paymentEvidence','consumptionTreatment','policy','reason','evidence']) OR jsonb_typeof(d->'reviewId')<>'string' OR coalesce(d->>'policy','') NOT IN ('reviewed-feed-cost-ledger-v1','reviewed-feed-cost-ledger-v2') OR NOT broiler_plan_text(d->'reason',10,2000,false) OR NOT broiler_plan_text(d->'evidence',3,2000,false) OR (d->>'settlement'='cash_bank' AND NOT broiler_plan_text(d->'paymentEvidence',3,1000,false)) OR (d->>'settlement'='payables' AND d->'paymentEvidence'<>'null'::jsonb) THEN RAISE EXCEPTION 'Invalid reviewed cost posting evidence' USING ERRCODE='23514';END IF;
 IF d->>'policy'='reviewed-feed-cost-ledger-v2' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(d))<>10 OR NOT(d ?& ARRAY['returnSettlement','returnAccountingEvidence']) OR NOT broiler_plan_text(d->'returnAccountingEvidence',3,1000,false) THEN RAISE EXCEPTION 'Supplier-return accounting evidence and settlement required' USING ERRCODE='23514';END IF;
 ELSIF (SELECT count(*) FROM jsonb_object_keys(d))<>8 THEN RAISE EXCEPTION 'V1 postings must omit supplier-return fields' USING ERRCODE='23514';END IF;
 PERFORM lock_feed_cost_posting(NEW.organization_id,(d->>'reviewId')::uuid);
 IF NEW.expected_position<>(SELECT coalesce(max(position),0) FROM financial_journal_entries WHERE organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'Stale journal head' USING ERRCODE='23505';END IF;
 IF (SELECT count(*) FROM financial_journal_entries WHERE organization_id=NEW.organization_id)>=1000 THEN RAISE EXCEPTION 'Journal entry limit reached' USING ERRCODE='23514';END IF;
 s:=feed_cost_posting_basis_with_returns(NEW.organization_id,(d->>'reviewId')::uuid,d->>'settlement',d->>'consumptionTreatment',d->>'returnSettlement');
 IF s->>'policy' IS DISTINCT FROM d->>'policy' THEN RAISE EXCEPTION 'Cost posting policy must match this lot and its supplier returns' USING ERRCODE='23514';END IF;
 SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
 IF (s->>'postedOn')::date>today THEN RAISE EXCEPTION 'Cost review date is later than organization today' USING ERRCODE='23514';END IF;
 NEW.kind:='recognize_feed_cost';NEW.source_kind:='feed_cost';NEW.source_id:=(d->>'reviewId')::uuid;NEW.unit_id:=NULL;NEW.reversal_of_id:=NULL;NEW.currency:=s->>'currency';NEW.posted_on:=(s->>'postedOn')::date;NEW.reference:=s->>'reference';NEW.description:='Post reviewed feed cost against existing linked books';NEW.lines:=s->'lines';NEW.source_snapshot:=s;
 NEW.input:=d||jsonb_build_object('reviewId',NEW.source_id,'paymentEvidence',CASE WHEN d->'paymentEvidence'='null'::jsonb THEN NULL ELSE btrim(d->>'paymentEvidence') END,'reason',btrim(d->>'reason'),'evidence',btrim(d->>'evidence'));
 IF d->>'policy'='reviewed-feed-cost-ledger-v2' THEN NEW.input:=NEW.input||jsonb_build_object('returnAccountingEvidence',btrim(d->>'returnAccountingEvidence'));END IF;
 NEW.submission:=jsonb_build_object('organizationId',NEW.organization_id,'entryId',NEW.id,'expectedPosition',NEW.expected_position::text,'data',NEW.input);NEW.position:=nextval('financial_journal_position');RETURN NEW;
END $$;
