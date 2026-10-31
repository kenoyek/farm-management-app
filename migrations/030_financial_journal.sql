-- Explicit balanced book entries. No physical, forecast or bank/payment mutation.
CREATE SEQUENCE financial_journal_position;
CREATE TABLE financial_journal_entries (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,unit_id uuid,
 model_version text NOT NULL DEFAULT 'balanced-financial-journal-v1' CHECK(model_version='balanced-financial-journal-v1'),chart_version text NOT NULL DEFAULT 'farm-chart-v1' CHECK(chart_version='farm-chart-v1'),
 kind text NOT NULL DEFAULT '',position bigint NOT NULL DEFAULT 0 UNIQUE,expected_position bigint NOT NULL CHECK(expected_position>=0),
 posted_on date NOT NULL DEFAULT current_date,currency text NOT NULL DEFAULT '' CHECK(currency~'^[A-Z]{3}$'),reference text NOT NULL DEFAULT '',description text NOT NULL DEFAULT '',
 lines jsonb NOT NULL DEFAULT '[]',input jsonb NOT NULL CHECK(octet_length(input::text)<=20000),
 source_kind text,source_id uuid,source_snapshot jsonb,reversal_of_id uuid,submission jsonb NOT NULL DEFAULT '{}',
 created_by uuid NOT NULL DEFAULT current_actor() REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,unit_id) REFERENCES production_units(organization_id,id),
 FOREIGN KEY(organization_id,reversal_of_id) REFERENCES financial_journal_entries(organization_id,id),
 CHECK(kind IN ('manual','recognize_sale','reverse')),CHECK(reversal_of_id IS DISTINCT FROM id),
 CHECK((kind='reverse')=(reversal_of_id IS NOT NULL)),CHECK((source_kind IS NULL)=(source_id IS NULL)),
 CHECK(source_kind IS NULL OR source_kind IN ('live','product')),
 CHECK(kind<>'recognize_sale' OR (source_kind IS NOT NULL AND source_snapshot IS NOT NULL AND unit_id IS NOT NULL)),
 CHECK(kind<>'manual' OR source_kind IS NULL),CHECK(jsonb_typeof(lines)='array' AND jsonb_array_length(lines) BETWEEN 2 AND 20),
 CHECK(source_snapshot IS NULL OR octet_length(source_snapshot::text)<=32768)
);
CREATE UNIQUE INDEX financial_reverse_once ON financial_journal_entries(reversal_of_id) WHERE reversal_of_id IS NOT NULL;
CREATE UNIQUE INDEX financial_manual_reference ON financial_journal_entries(organization_id,reference) WHERE kind='manual';
CREATE INDEX ON financial_journal_entries(organization_id,position);
CREATE INDEX ON financial_journal_entries(organization_id,source_kind,source_id) WHERE kind='recognize_sale';
ALTER TABLE financial_journal_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_read ON financial_journal_entries FOR SELECT TO farm_app USING(member_role(organization_id) IN ('owner','admin','manager','auditor'));
CREATE POLICY finance_write ON financial_journal_entries FOR INSERT TO farm_app WITH CHECK(member_role(organization_id) IN ('owner','admin','manager') AND created_by=current_actor() AND created_at=now());
GRANT SELECT,INSERT ON financial_journal_entries TO farm_app;
GRANT USAGE ON SEQUENCE financial_journal_position TO farm_app;
CREATE FUNCTION financial_sale_is_booked(p_org uuid,p_kind text,p_source uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM financial_journal_entries e WHERE e.organization_id=p_org AND e.kind='recognize_sale' AND e.source_kind=p_kind AND e.source_id=p_source AND NOT EXISTS(SELECT 1 FROM financial_journal_entries r WHERE r.reversal_of_id=e.id));
$$;
REVOKE ALL ON FUNCTION financial_sale_is_booked(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION financial_sale_is_booked(uuid,text,uuid) TO farm_app;
CREATE VIEW financial_broiler_sources WITH (security_invoker=true) AS
 SELECT e.organization_id,e.unit_id,u.name AS unit_name,'live'::text AS source_kind,e.id AS source_id,e.recorded_on,e.currency,e.amount::text AS amount,e.reference,e.customer
 FROM active_broiler_events e JOIN production_units u ON u.id=e.unit_id AND u.organization_id=e.organization_id WHERE e.kind='harvest' AND e.price_basis IN ('bird','kg') AND u.kind='broilers'
 UNION ALL
 SELECT e.organization_id,e.unit_id,u.name,'product',e.id,e.recorded_on,e.currency,e.amount::text,e.reference,e.input->>'customer'
 FROM active_broiler_product_events e JOIN production_units u ON u.id=e.unit_id AND u.organization_id=e.organization_id WHERE e.kind='sale' AND u.kind='broilers';
GRANT SELECT ON financial_broiler_sources TO farm_app;
CREATE FUNCTION validate_financial_journal() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d jsonb:=NEW.input; original financial_journal_entries; live broiler_events; product broiler_product_events; lot broiler_product_events; u production_units; l jsonb; normalized jsonb:='[]'; accounts text[]:='{}'; debits numeric:=0; credits numeric:=0; today date; value numeric; debit_account text; income_account text;
BEGIN
 IF coalesce(member_role(NEW.organization_id),'') NOT IN ('owner','admin','manager') THEN RAISE EXCEPTION 'Financial posting role required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(d)<>'object' OR jsonb_typeof(d->'kind')<>'string' OR NOT broiler_plan_text(d->'reason',10,2000,false) OR NOT broiler_plan_text(d->'evidence',3,2000,false) THEN RAISE EXCEPTION 'Invalid journal evidence' USING ERRCODE='23514'; END IF;
 NEW.kind:=d->>'kind';NEW.source_kind:=NULL;NEW.source_id:=NULL;NEW.source_snapshot:=NULL;NEW.reversal_of_id:=NULL;NEW.unit_id:=NULL;
 -- Every writer acquires a source unit before the organization journal lock.
 IF NEW.kind='manual' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(d))<>11 OR NOT(d ?& ARRAY['kind','date','currency','unitId','purpose','reference','description','lines','scope','reason','evidence']) OR NOT broiler_plan_text(d->'currency',3,3,false) OR (d->>'currency')!~'^[A-Z]{3}$' OR NOT broiler_plan_text(d->'reference',3,100,false) OR NOT broiler_plan_text(d->'description',3,1000,false) OR jsonb_typeof(d->'purpose')<>'string' OR (d->>'purpose') NOT IN ('opening_balance','purchase','consumption','expense','cost_transfer','cash_record','adjustment') OR d->>'scope' IS DISTINCT FROM 'evidenced-manual-book-entry' OR NOT(d->'unitId'='null'::jsonb OR jsonb_typeof(d->'unitId')='string') THEN RAISE EXCEPTION 'Invalid manual journal structure' USING ERRCODE='23514'; END IF;
  NEW.unit_id:=(d->>'unitId')::uuid;
 ELSIF NEW.kind='recognize_sale' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(d))<>8 OR NOT(d ?& ARRAY['kind','sourceKind','sourceId','settlement','cashEvidence','policy','reason','evidence']) THEN RAISE EXCEPTION 'Invalid sale recognition structure' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(d))<>8 OR jsonb_typeof(d->'sourceKind')<>'string' OR (d->>'sourceKind') NOT IN ('live','product') OR jsonb_typeof(d->'sourceId')<>'string' OR jsonb_typeof(d->'settlement')<>'string' OR (d->>'settlement') NOT IN ('receivables','cash_bank') OR d->>'policy' IS DISTINCT FROM 'recorded-dispatch-value-v1' OR (d->>'settlement'='cash_bank' AND NOT broiler_plan_text(d->'cashEvidence',3,1000,false)) OR (d->>'settlement'='receivables' AND d->'cashEvidence'<>'null'::jsonb) THEN RAISE EXCEPTION 'Explicit settlement and cash evidence are required' USING ERRCODE='23514'; END IF;
  NEW.source_kind:=d->>'sourceKind';NEW.source_id:=(d->>'sourceId')::uuid;
  IF NEW.source_kind='live' THEN SELECT * INTO live FROM broiler_events WHERE organization_id=NEW.organization_id AND id=NEW.source_id AND kind='harvest' AND price_basis IN ('bird','kg');NEW.unit_id:=live.unit_id;
  ELSE SELECT * INTO product FROM broiler_product_events WHERE organization_id=NEW.organization_id AND id=NEW.source_id AND kind='sale';NEW.unit_id:=product.unit_id;END IF;
  IF NEW.unit_id IS NULL THEN RAISE EXCEPTION 'Choose a visible priced broiler sale' USING ERRCODE='23514'; END IF;
 ELSIF NEW.kind='reverse' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(d))<>5 OR NOT(d ?& ARRAY['kind','originalId','date','reason','evidence']) OR jsonb_typeof(d->'originalId')<>'string' THEN RAISE EXCEPTION 'Invalid journal reversal structure' USING ERRCODE='23514'; END IF;
  SELECT * INTO original FROM financial_journal_entries WHERE organization_id=NEW.organization_id AND id=(d->>'originalId')::uuid AND kind<>'reverse';
  IF original.id IS NULL THEN RAISE EXCEPTION 'Choose an original journal entry' USING ERRCODE='23514'; END IF;
  NEW.unit_id:=original.unit_id;
 ELSE RAISE EXCEPTION 'Unknown journal kind' USING ERRCODE='23514';END IF;
 IF NEW.unit_id IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
  SELECT * INTO u FROM production_units WHERE organization_id=NEW.organization_id AND id=NEW.unit_id AND kind='broilers';
  IF u.id IS NULL THEN RAISE EXCEPTION 'Choose a visible broiler cost center' USING ERRCODE='23514'; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(812,hashtext(NEW.organization_id::text));
 IF NEW.expected_position<>(SELECT coalesce(max(position),0) FROM financial_journal_entries WHERE organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'Stale journal head' USING ERRCODE='23505'; END IF;
 IF (SELECT count(*) FROM financial_journal_entries WHERE organization_id=NEW.organization_id)>=1000 THEN RAISE EXCEPTION 'Organization reached its 1000 journal-entry limit' USING ERRCODE='23514'; END IF;
 SELECT (now() AT TIME ZONE timezone)::date INTO today FROM organizations WHERE id=NEW.organization_id;
 IF NEW.kind='manual' THEN
  IF jsonb_typeof(d->'date')<>'string' OR (d->>'date')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR jsonb_typeof(d->'lines')<>'array' OR jsonb_array_length(d->'lines') NOT BETWEEN 2 AND 20 THEN RAISE EXCEPTION 'Invalid date or line count' USING ERRCODE='23514'; END IF;
  NEW.posted_on:=(d->>'date')::date;NEW.currency:=d->>'currency';NEW.reference:=btrim(d->>'reference');NEW.description:=btrim(d->>'description');
  FOR l IN SELECT j.value FROM jsonb_array_elements(d->'lines') j LOOP
   IF jsonb_typeof(l)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(l))<>3 OR NOT(l ?& ARRAY['account','side','amount']) OR jsonb_typeof(l->'account')<>'string' OR (l->>'account') NOT IN ('1000','1100','1200','1300','1400','2000','3000','4200','5000','5100','5200','5900') OR (l->>'account')=ANY(accounts) OR jsonb_typeof(l->'side')<>'string' OR (l->>'side') NOT IN ('debit','credit') OR NOT broiler_plan_decimal(l->'amount',100000000,4,false,false) THEN RAISE EXCEPTION 'Invalid, repeated or reserved manual account/line' USING ERRCODE='23514'; END IF;
   accounts:=array_append(accounts,l->>'account');value:=(l->>'amount')::numeric;
   IF l->>'side'='debit' THEN debits:=debits+value;ELSE credits:=credits+value;END IF;
   normalized:=normalized||jsonb_build_array(l||jsonb_build_object('amount',value::numeric(20,4)::text));
  END LOOP;
  IF debits<=0 OR debits<>credits THEN RAISE EXCEPTION 'Positive debits must equal credits exactly' USING ERRCODE='23514'; END IF;
  NEW.lines:=normalized;
  IF u.id IS NOT NULL THEN NEW.source_snapshot:=jsonb_build_object('unit',to_jsonb(u)||jsonb_build_object('stocked_on',u.stocked_on::text,'initial_weight_g',u.initial_weight_g::text));END IF;
  d:=d||jsonb_build_object('unitId',NEW.unit_id,'reference',NEW.reference,'description',NEW.description,'lines',NEW.lines);
 ELSIF NEW.kind='recognize_sale' THEN
  IF financial_sale_is_booked(NEW.organization_id,NEW.source_kind,NEW.source_id) THEN RAISE EXCEPTION 'This sale is already financially recognized' USING ERRCODE='23505'; END IF;
  IF NEW.source_kind='live' THEN
   IF NOT EXISTS(SELECT 1 FROM active_broiler_events WHERE id=live.id) THEN RAISE EXCEPTION 'The live sale was voided' USING ERRCODE='23514'; END IF;
   NEW.posted_on:=live.recorded_on;NEW.currency:=live.currency;NEW.reference:=live.reference;value:=live.amount;income_account:='4000';
   NEW.source_snapshot:=jsonb_build_object('event',to_jsonb(live)||jsonb_build_object('recorded_on',live.recorded_on::text,'position',live.position::text,'expected_position',live.expected_position::text,'weight_kg',live.weight_kg::text,'price_per_unit',live.price_per_unit::text,'amount',live.amount::text));
  ELSE
   IF NOT EXISTS(SELECT 1 FROM active_broiler_product_events WHERE id=product.id) THEN RAISE EXCEPTION 'The product sale was voided' USING ERRCODE='23514'; END IF;
   SELECT * INTO lot FROM broiler_product_events WHERE id=product.lot_id;
   NEW.posted_on:=product.recorded_on;NEW.currency:=product.currency;NEW.reference:=product.reference;value:=product.amount;income_account:='4100';
   NEW.source_snapshot:=jsonb_build_object('event',to_jsonb(product)||jsonb_build_object('recorded_on',product.recorded_on::text,'position',product.position::text,'expected_position',product.expected_position::text,'expected_source_position',product.expected_source_position::text,'weight_kg',product.weight_kg::text,'price_per_kg',product.price_per_kg::text,'amount',product.amount::text),'lot',to_jsonb(lot)||jsonb_build_object('recorded_on',lot.recorded_on::text,'position',lot.position::text,'expected_position',lot.expected_position::text,'expected_source_position',lot.expected_source_position::text,'weight_kg',lot.weight_kg::text));
  END IF;
  IF value IS NULL OR value<0 OR value>=10000000000000000 THEN RAISE EXCEPTION 'Invalid recorded sale value' USING ERRCODE='23514'; END IF;
  NEW.source_snapshot:=NEW.source_snapshot||jsonb_build_object('unit',to_jsonb(u)||jsonb_build_object('stocked_on',u.stocked_on::text,'initial_weight_g',u.initial_weight_g::text));
  NEW.description:='Recognize recorded '||NEW.source_kind||' broiler sale';debit_account:=CASE WHEN d->>'settlement'='cash_bank' THEN '1000' ELSE '1100' END;
  NEW.lines:=jsonb_build_array(jsonb_build_object('account',debit_account,'side','debit','amount',value::numeric(20,4)::text),jsonb_build_object('account',income_account,'side','credit','amount',value::numeric(20,4)::text));
  d:=d||jsonb_build_object('sourceId',NEW.source_id,'cashEvidence',CASE WHEN d->'cashEvidence'='null'::jsonb THEN NULL ELSE btrim(d->>'cashEvidence') END);
 ELSE
  IF EXISTS(SELECT 1 FROM financial_journal_entries WHERE reversal_of_id=original.id) THEN RAISE EXCEPTION 'This journal entry was already reversed' USING ERRCODE='23505'; END IF;
  IF jsonb_typeof(d->'date')<>'string' OR (d->>'date')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid reversal date' USING ERRCODE='23514'; END IF;
  NEW.posted_on:=(d->>'date')::date;
  IF NEW.posted_on<original.posted_on THEN RAISE EXCEPTION 'Reversal cannot precede its original entry' USING ERRCODE='23514'; END IF;
  NEW.currency:=original.currency;NEW.reference:='REV '||original.reference;NEW.description:='Reverse journal entry '||original.id;NEW.reversal_of_id:=original.id;NEW.source_kind:=original.source_kind;NEW.source_id:=original.source_id;NEW.source_snapshot:=original.source_snapshot;
  SELECT jsonb_agg(a.l||jsonb_build_object('side',CASE WHEN a.l->>'side'='debit' THEN 'credit' ELSE 'debit' END) ORDER BY a.n) INTO NEW.lines FROM jsonb_array_elements(original.lines) WITH ORDINALITY a(l,n);
  d:=d||jsonb_build_object('originalId',original.id);
 END IF;
 IF NEW.posted_on<'1900-01-01'::date OR NEW.posted_on>today THEN RAISE EXCEPTION 'Journal dates must be from 1900 through organizational today' USING ERRCODE='23514'; END IF;
 NEW.input:=d||jsonb_build_object('reason',btrim(d->>'reason'),'evidence',btrim(d->>'evidence'));
 NEW.submission:=jsonb_build_object('organizationId',NEW.organization_id,'entryId',NEW.id,'expectedPosition',NEW.expected_position::text,'data',NEW.input);
 NEW.position:=nextval('financial_journal_position');RETURN NEW;
END $$;
CREATE TRIGGER financial_journal_check BEFORE INSERT ON financial_journal_entries FOR EACH ROW EXECUTE FUNCTION validate_financial_journal();
REVOKE ALL ON FUNCTION validate_financial_journal() FROM PUBLIC;
CREATE FUNCTION guard_financial_sale_void() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source_kind text;
BEGIN
 IF NEW.kind='void' THEN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.unit_id::text));
  PERFORM pg_advisory_xact_lock(812,hashtext(NEW.organization_id::text));
  source_kind:=CASE WHEN TG_TABLE_NAME='broiler_events' THEN 'live' ELSE 'product' END;
  IF financial_sale_is_booked(NEW.organization_id,source_kind,NEW.void_of_id) THEN RAISE EXCEPTION 'Reverse the financial sale recognition before voiding its operational source' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_live_sale_guard BEFORE INSERT ON broiler_events FOR EACH ROW EXECUTE FUNCTION guard_financial_sale_void();
CREATE TRIGGER financial_product_sale_guard BEFORE INSERT ON broiler_product_events FOR EACH ROW EXECUTE FUNCTION guard_financial_sale_void();
REVOKE ALL ON FUNCTION guard_financial_sale_void() FROM PUBLIC;
