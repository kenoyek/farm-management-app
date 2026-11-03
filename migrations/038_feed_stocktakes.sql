-- Weighed observations do not move stock. Only a current manager-approved shortage appends a loss.
CREATE SEQUENCE feed_stocktake_position;
CREATE TABLE feed_stocktakes(
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
 model_version text NOT NULL DEFAULT 'weighed-feed-stocktake-v1' CHECK(model_version='weighed-feed-stocktake-v1'),
 kind text NOT NULL DEFAULT '',lot_id uuid NOT NULL,count_id uuid,previous_id uuid,loss_event_id uuid,
 position bigint NOT NULL DEFAULT 0 UNIQUE,expected_stock_position bigint NOT NULL CHECK(expected_stock_position>=0),expected_count_position bigint NOT NULL CHECK(expected_count_position>=0),
 recorded_on date NOT NULL DEFAULT current_date,currency text NOT NULL DEFAULT '' CHECK(currency~'^[A-Z]{3}$'),
 recorded_kg numeric(20,6) NOT NULL DEFAULT 0 CHECK(recorded_kg BETWEEN 0 AND 100000000),counted_kg numeric(20,6) NOT NULL DEFAULT 0 CHECK(counted_kg BETWEEN 0 AND 100000000),variance_kg numeric(20,6) NOT NULL DEFAULT 0,
 recorded_value numeric(20,4) CHECK(recorded_value>=0),shortage_value numeric(20,4) CHECK(shortage_value>=0),
 expected_source_sha256 text NOT NULL CHECK(expected_source_sha256~'^[a-f0-9]{64}$'),source_sha256 text NOT NULL DEFAULT '' CHECK(source_sha256~'^[a-f0-9]{64}$'),
 input jsonb NOT NULL CHECK(octet_length(input::text)<=10000),source_snapshot jsonb NOT NULL DEFAULT '{}',submission jsonb NOT NULL DEFAULT '{}',
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id),CHECK(kind IN ('count','resolve_shortage')),CHECK(variance_kg=counted_kg-recorded_kg),CHECK((kind='resolve_shortage')=(count_id IS NOT NULL)),CHECK((kind='resolve_shortage')=(loss_event_id IS NOT NULL)),CHECK(kind<>'resolve_shortage' OR previous_id IS NULL),CHECK(previous_id IS DISTINCT FROM id),CHECK(count_id IS DISTINCT FROM id),CHECK(kind<>'resolve_shortage' OR loss_event_id=id),
 CHECK(octet_length(source_snapshot::text)<=CASE WHEN kind='count' THEN 262144 ELSE 524288 END),
 FOREIGN KEY(organization_id,lot_id) REFERENCES feed_stock_events(organization_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(organization_id,count_id) REFERENCES feed_stocktakes(organization_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(organization_id,previous_id) REFERENCES feed_stocktakes(organization_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(organization_id,loss_event_id) REFERENCES feed_stock_events(organization_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX feed_count_root ON feed_stocktakes(organization_id,lot_id) WHERE kind='count' AND previous_id IS NULL;
CREATE UNIQUE INDEX feed_count_successor ON feed_stocktakes(previous_id) WHERE kind='count' AND previous_id IS NOT NULL;
CREATE UNIQUE INDEX feed_count_resolution_once ON feed_stocktakes(count_id) WHERE kind='resolve_shortage';
CREATE UNIQUE INDEX feed_count_reference ON feed_stocktakes(organization_id,lot_id,(input->>'reference')) WHERE kind='count';
CREATE INDEX ON feed_stocktakes(organization_id,position);
CREATE INDEX ON feed_stocktakes(organization_id,lot_id,position);
ALTER TABLE feed_stocktakes ENABLE ROW LEVEL SECURITY;
CREATE POLICY count_read ON feed_stocktakes FOR SELECT TO farm_app USING(member_role(organization_id) IN ('owner','admin','manager','inventory','accounts','auditor'));
CREATE POLICY count_write ON feed_stocktakes FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','manager','inventory') AND (kind='count' OR member_role(organization_id) IN ('owner','admin','manager')) AND created_by=current_actor() AND created_at=now());
GRANT SELECT,INSERT ON feed_stocktakes TO farm_app;
GRANT USAGE ON SEQUENCE feed_stocktake_position TO farm_app;
CREATE FUNCTION feed_stocktake_source(p_org uuid,p_lot uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('receipt',to_jsonb(l)||jsonb_build_object('position',l.position::text,'expected_position',l.expected_position::text,'recorded_on',l.recorded_on::text,'weight_kg',l.weight_kg::text,'amount',l.amount::text),'events',(SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('position',e.position::text,'expected_position',e.expected_position::text,'recorded_on',e.recorded_on::text,'weight_kg',e.weight_kg::text,'amount',e.amount::text) ORDER BY e.position) FROM feed_stock_events e WHERE e.organization_id=p_org AND e.lot_id=l.id)) FROM active_feed_stock_events l WHERE l.organization_id=p_org AND l.id=p_lot AND l.kind='receipt';
$$;
REVOKE ALL ON FUNCTION feed_stocktake_source(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION feed_stocktake_source(uuid,uuid) TO farm_app;
CREATE FUNCTION feed_stocktake_json(e feed_stocktakes) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT to_jsonb(e)||jsonb_build_object('position',e.position::text,'expected_stock_position',e.expected_stock_position::text,'expected_count_position',e.expected_count_position::text,'recorded_on',e.recorded_on::text,'recorded_kg',e.recorded_kg::text,'counted_kg',e.counted_kg::text,'variance_kg',e.variance_kg::text,'recorded_value',e.recorded_value::text,'shortage_value',e.shortage_value::text);
$$;
REVOKE ALL ON FUNCTION feed_stocktake_json(feed_stocktakes) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION feed_stocktake_json(feed_stocktakes) TO farm_app;
CREATE FUNCTION validate_feed_stocktake() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d jsonb:=NEW.input;c feed_stocktakes;prior feed_stocktakes;lot feed_stock_events;loss feed_stock_events;s jsonb;sha text;today date;last_day date;kg numeric;val numeric;
BEGIN
 IF coalesce(member_role(NEW.organization_id),'') NOT IN ('owner','admin','manager','inventory') OR (d->>'kind'='resolve_shortage' AND member_role(NEW.organization_id) NOT IN ('owner','admin','manager')) THEN RAISE EXCEPTION 'Stocktake recording or manager shortage approval role required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(d)<>'object' OR NOT broiler_plan_text(d->'reason',10,2000,false) OR NOT broiler_plan_text(d->'evidence',3,2000,false) THEN RAISE EXCEPTION 'Stocktake evidence required' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(813,hashtext(NEW.organization_id::text));PERFORM pg_advisory_xact_lock(815,hashtext(NEW.organization_id::text));
 IF NEW.expected_stock_position<>(SELECT coalesce(max(position),0) FROM feed_stock_events WHERE organization_id=NEW.organization_id) OR NEW.expected_count_position<>(SELECT coalesce(max(position),0) FROM feed_stocktakes WHERE organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'Stock or count head changed; reload and review' USING ERRCODE='23505';END IF;
 IF (SELECT count(*) FROM feed_stocktakes WHERE organization_id=NEW.organization_id)>=1000 THEN RAISE EXCEPTION 'Stocktake event limit reached' USING ERRCODE='23514';END IF;
 NEW.kind:=d->>'kind';NEW.count_id:=NULL;NEW.previous_id:=NULL;NEW.loss_event_id:=NULL;NEW.model_version:='weighed-feed-stocktake-v1';
 IF NEW.kind='count' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(d))<>9 OR NOT(d ?& ARRAY['kind','lotId','date','previousId','reference','countedKg','scope','reason','evidence']) OR jsonb_typeof(d->'lotId')<>'string' OR jsonb_typeof(d->'date')<>'string' OR NOT(d->'previousId'='null'::jsonb OR jsonb_typeof(d->'previousId')='string') OR NOT broiler_plan_text(d->'reference',3,100,false) OR NOT broiler_plan_decimal(d->'countedKg',100000000,6,true,false) OR d->>'scope' IS DISTINCT FROM 'actual-weighed-unused-feed-lot-count' THEN RAISE EXCEPTION 'Exact weighed count, reference, date and original lot declaration required' USING ERRCODE='23514';END IF;
  NEW.lot_id:=(d->>'lotId')::uuid;NEW.previous_id:=(d->>'previousId')::uuid;NEW.recorded_on:=(d->>'date')::date;
  SELECT * INTO prior FROM feed_stocktakes WHERE organization_id=NEW.organization_id AND lot_id=NEW.lot_id AND kind='count' ORDER BY position DESC LIMIT 1;
  IF NEW.previous_id IS DISTINCT FROM prior.id THEN RAISE EXCEPTION 'Count predecessor changed' USING ERRCODE='23505';END IF;
  IF (SELECT count(*) FROM feed_stocktakes WHERE organization_id=NEW.organization_id AND lot_id=NEW.lot_id AND kind='count')>=100 THEN RAISE EXCEPTION 'Per-lot count limit reached' USING ERRCODE='23514';END IF;
  NEW.counted_kg:=(d->>'countedKg')::numeric;
 ELSE
  IF NEW.kind<>'resolve_shortage' OR (SELECT count(*) FROM jsonb_object_keys(d))<>5 OR NOT(d ?& ARRAY['kind','countId','scope','reason','evidence']) OR jsonb_typeof(d->'countId')<>'string' OR d->>'scope' IS DISTINCT FROM 'approve-weighed-shortage-as-feed-loss' OR NOT broiler_plan_text(d->'reason',10,1000,false) OR NOT broiler_plan_text(d->'evidence',3,1500,false) THEN RAISE EXCEPTION 'Manager shortage approval declaration required' USING ERRCODE='23514';END IF;
  SELECT * INTO c FROM feed_stocktakes WHERE organization_id=NEW.organization_id AND id=(d->>'countId')::uuid AND kind='count';
  IF c.id IS NULL THEN RAISE EXCEPTION 'Choose a visible original count' USING ERRCODE='23514';END IF;
  IF c.id IS DISTINCT FROM (SELECT id FROM feed_stocktakes WHERE organization_id=NEW.organization_id AND lot_id=c.lot_id AND kind='count' ORDER BY position DESC LIMIT 1) OR EXISTS(SELECT 1 FROM feed_stocktakes WHERE count_id=c.id) THEN RAISE EXCEPTION 'Count is superseded or already resolved' USING ERRCODE='23505';END IF;
  IF c.variance_kg>=0 THEN RAISE EXCEPTION 'Only a weighed shortage can append a loss; surplus requires investigation' USING ERRCODE='23514';END IF;
  NEW.lot_id:=c.lot_id;NEW.count_id:=c.id;NEW.recorded_on:=c.recorded_on;NEW.counted_kg:=c.counted_kg;NEW.loss_event_id:=NEW.id;
 END IF;
 SELECT * INTO lot FROM active_feed_stock_events WHERE organization_id=NEW.organization_id AND id=NEW.lot_id AND kind='receipt';
 IF lot.id IS NULL THEN RAISE EXCEPTION 'Active original purchase lot required' USING ERRCODE='23514';END IF;
 SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
 SELECT max(recorded_on) INTO last_day FROM feed_stock_events WHERE organization_id=NEW.organization_id AND lot_id=lot.id;
 IF NEW.recorded_on<'1900-01-01'::date OR NEW.recorded_on>today OR NEW.recorded_on<last_day OR NEW.recorded_on<prior.recorded_on THEN RAISE EXCEPTION 'Count date must follow physical and count history through organization today' USING ERRCODE='23514';END IF;
 s:=feed_stocktake_source(NEW.organization_id,lot.id);
 IF octet_length(s::text)>262144 THEN RAISE EXCEPTION 'Count source exceeds the 256 KiB bound' USING ERRCODE='23514';END IF;
 sha:=encode(sha256(convert_to(s::text,'UTF8')),'hex');
 IF NEW.expected_source_sha256 IS DISTINCT FROM sha OR (NEW.kind='resolve_shortage' AND c.source_sha256 IS DISTINCT FROM sha) THEN RAISE EXCEPTION 'Physical count source changed; record a new count or reload' USING ERRCODE='23505';END IF;
 SELECT lot.weight_kg-coalesce(sum(weight_kg),0),CASE WHEN lot.amount IS NULL THEN NULL ELSE lot.amount-coalesce(sum(amount),0) END INTO kg,val FROM active_feed_stock_events WHERE organization_id=NEW.organization_id AND lot_id=lot.id AND kind IN ('consume','loss','supplier_return');
 NEW.currency:=lot.currency;NEW.recorded_kg:=kg;NEW.recorded_value:=val;NEW.variance_kg:=NEW.counted_kg-kg;
 NEW.shortage_value:=CASE WHEN NEW.variance_kg>=0 OR val IS NULL THEN NULL WHEN -NEW.variance_kg=kg THEN val ELSE round(val*(-NEW.variance_kg)/kg,4) END;
 NEW.source_sha256:=sha;
 IF NEW.kind='count' THEN
  NEW.source_snapshot:=s;
  d:=d||jsonb_build_object('lotId',lot.id,'previousId',NEW.previous_id,'date',NEW.recorded_on::text,'reference',btrim(d->>'reference'),'countedKg',NEW.counted_kg::text);
 ELSE
  INSERT INTO feed_stock_events(id,organization_id,lot_id,recorded_on,expected_position,input) VALUES(NEW.id,NEW.organization_id,lot.id,c.recorded_on,NEW.expected_stock_position,jsonb_build_object('kind','loss','lotId',lot.id,'weightKg',(-NEW.variance_kg)::numeric(20,6)::text,'reason',btrim(d->>'reason'),'evidence','Stocktake '||(c.input->>'reference')||' ('||c.id::text||'); source '||sha||'. '||btrim(d->>'evidence'))) RETURNING * INTO loss;
  IF loss.weight_kg<>-NEW.variance_kg OR loss.amount IS DISTINCT FROM NEW.shortage_value THEN RAISE EXCEPTION 'Derived count loss differs from captured shortage' USING ERRCODE='23514';END IF;
  NEW.source_snapshot:=jsonb_build_object('count',feed_stocktake_json(c),'loss',to_jsonb(loss)||jsonb_build_object('position',loss.position::text,'expected_position',loss.expected_position::text,'recorded_on',loss.recorded_on::text,'weight_kg',loss.weight_kg::text,'amount',loss.amount::text));
  d:=d||jsonb_build_object('countId',c.id);
 END IF;
 NEW.input:=d||jsonb_build_object('reason',btrim(d->>'reason'),'evidence',btrim(d->>'evidence'));
 NEW.submission:=jsonb_build_object('organizationId',NEW.organization_id,'eventId',NEW.id,'expectedStockPosition',NEW.expected_stock_position::text,'expectedCountPosition',NEW.expected_count_position::text,'expectedSourceSha256',NEW.expected_source_sha256,'data',NEW.input);
 NEW.position:=nextval('feed_stocktake_position');RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION validate_feed_stocktake() FROM PUBLIC;
CREATE TRIGGER feed_stocktake_check BEFORE INSERT ON feed_stocktakes FOR EACH ROW EXECUTE FUNCTION validate_feed_stocktake();
-- Original financial losses and reviewed cost postings retain the complete count/approval authority.
ALTER TABLE financial_journal_entries DROP CONSTRAINT financial_snapshot_bound;
ALTER TABLE financial_journal_entries ADD CONSTRAINT financial_snapshot_bound CHECK(source_snapshot IS NULL OR octet_length(source_snapshot::text)<=CASE WHEN source_kind='feed_cost' THEN 786432 WHEN source_kind='feed' AND source_snapshot ? 'countEvidence' THEN 524288 ELSE 32768 END);
CREATE FUNCTION attach_financial_stocktake() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE proof jsonb;
BEGIN
 SELECT feed_stocktake_json(e) INTO proof FROM feed_stocktakes e WHERE e.organization_id=NEW.organization_id AND e.kind='resolve_shortage' AND e.loss_event_id=NEW.source_id;
 IF proof IS NOT NULL THEN NEW.source_snapshot:=NEW.source_snapshot||jsonb_build_object('countEvidence',proof);END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION attach_financial_stocktake() FROM PUBLIC;
CREATE TRIGGER financial_feed_stocktake_evidence BEFORE INSERT ON financial_journal_entries FOR EACH ROW WHEN(NEW.input->>'kind'='recognize_feed') EXECUTE FUNCTION attach_financial_stocktake();
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
  components:=components||jsonb_build_array(jsonb_build_object('eventId',e.id,'kind',e.kind,'unitId',e.unit_id,'date',e.recorded_on::text,'weightKg',e.weight_kg::text,'account',account_code,'bookedValue',booked::numeric(20,4)::text,'reviewedValue',desired::numeric(20,4)::text,'delta',change::numeric(20,4)::text,'basis',basis,'sourceEvidence',CASE WHEN e.kind='consume' THEN jsonb_build_object('currentSource',feed_consumption_source(p_org,e.unit_id,e.recorded_on),'sourceReview',(SELECT to_jsonb(sr)||jsonb_build_object('position',sr.position::text,'expected_stock_position',sr.expected_stock_position::text,'expected_review_position',sr.expected_review_position::text,'reviewed_on',sr.reviewed_on::text) FROM current_feed_reconciliation_reviews sr WHERE sr.organization_id=p_org AND sr.kind='source' AND sr.target_id=e.id)) ELSE NULL END)||coalesce((SELECT jsonb_build_object('countEvidence',feed_stocktake_json(t)) FROM feed_stocktakes t WHERE t.organization_id=p_org AND t.kind='resolve_shortage' AND t.loss_event_id=e.id),'{}'::jsonb));
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

CREATE UNIQUE INDEX feed_stocktake_loss_link ON feed_stocktakes(loss_event_id) WHERE loss_event_id IS NOT NULL;
CREATE FUNCTION guard_stocktake_loss_void() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.kind='void' AND EXISTS(SELECT 1 FROM feed_stocktakes t WHERE t.organization_id=NEW.organization_id AND t.kind='resolve_shortage' AND t.loss_event_id=NEW.void_of_id) AND coalesce(member_role(NEW.organization_id),'') NOT IN ('owner','admin','manager') THEN RAISE EXCEPTION 'Only a manager may correct a stocktake-approved physical loss' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_stocktake_loss_void() FROM PUBLIC;
CREATE TRIGGER feed_stocktake_void_guard BEFORE INSERT ON feed_stock_events FOR EACH ROW EXECUTE FUNCTION guard_stocktake_loss_void();
