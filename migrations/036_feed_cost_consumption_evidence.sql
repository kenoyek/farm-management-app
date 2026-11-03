-- Preserve the accepted actual-consumption proof in each new cost posting.
-- Existing journal/source rows and reports remain immutable.
CREATE OR REPLACE FUNCTION feed_cost_posting_basis(p_org uuid,p_review uuid,p_settlement text,p_treatment text) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
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
  components:=components||jsonb_build_array(jsonb_build_object('eventId',e.id,'kind',e.kind,'unitId',e.unit_id,'date',e.recorded_on::text,'weightKg',e.weight_kg::text,'account',account_code,'bookedValue',booked::numeric(20,4)::text,'reviewedValue',desired::numeric(20,4)::text,'delta',change::numeric(20,4)::text,'basis',basis,'sourceEvidence',CASE WHEN e.kind='consume' THEN jsonb_build_object('currentSource',feed_consumption_source(p_org,e.unit_id,e.recorded_on),'sourceReview',(SELECT to_jsonb(sr)||jsonb_build_object('position',sr.position::text,'expected_stock_position',sr.expected_stock_position::text,'expected_review_position',sr.expected_review_position::text,'reviewed_on',sr.reviewed_on::text) FROM current_feed_reconciliation_reviews sr WHERE sr.organization_id=p_org AND sr.kind='source' AND sr.target_id=e.id)) ELSE NULL END));
  IF e.kind='receipt' THEN purchase_booked:=booked;nets:=feed_cost_add_net(nets,'1200',change);nets:=feed_cost_add_net(nets,CASE WHEN p_settlement='payables' THEN '2000' ELSE '1000' END,-change);
  ELSE nets:=feed_cost_add_net(nets,account_code,change);nets:=feed_cost_add_net(nets,'1200',-change);END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('account',a.key,'side',CASE WHEN a.value::numeric>0 THEN 'debit' ELSE 'credit' END,'amount',abs(a.value::numeric)::numeric(20,4)::text) ORDER BY a.key),'[]'::jsonb) INTO lines FROM jsonb_each_text(nets)a WHERE a.value::numeric<>0;
 IF jsonb_array_length(lines)=0 THEN lines:=jsonb_build_array(jsonb_build_object('account','1200','side','debit','amount','0.0000'),jsonb_build_object('account',CASE WHEN p_settlement='payables' THEN '2000' ELSE '1000' END,'side','credit','amount','0.0000'));END IF;
 review_json:=to_jsonb(r)||jsonb_build_object('position',r.position::text,'expected_stock_position',r.expected_stock_position::text,'expected_review_position',r.expected_review_position::text,'reviewed_on',r.reviewed_on::text);
 RETURN jsonb_build_object('policy','reviewed-feed-cost-ledger-v1','lotId',receipt.id,'review',review_json,'parentPostingId',parent,'currency',receipt.currency,'postedOn',r.reviewed_on::text,'reference','FEED COST '||receipt.reference,'bookedPurchaseValue',purchase_booked::numeric(20,4)::text,'reviewedPurchaseValue',(r.input->>'totalCost'),'purchaseDelta',((r.input->>'totalCost')::numeric-purchase_booked)::numeric(20,4)::text,'components',components,'lines',lines);
END $$;
