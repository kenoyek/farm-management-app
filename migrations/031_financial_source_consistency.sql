-- Source checks must observe writes from the same transaction/statement as well.
ALTER FUNCTION financial_sale_is_booked(uuid,text,uuid) VOLATILE;
CREATE FUNCTION check_financial_source_consistency() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE checked_kind text; checked_source uuid; active_count integer;
BEGIN
 IF TG_TABLE_NAME='financial_journal_entries' THEN
  IF NEW.kind<>'recognize_sale' THEN RETURN NULL; END IF;
  checked_kind:=NEW.source_kind;checked_source:=NEW.source_id;
 ELSE
  checked_kind:=CASE WHEN TG_TABLE_NAME='broiler_events' THEN 'live' ELSE 'product' END;checked_source:=NEW.void_of_id;
 END IF;
 SELECT count(*) INTO active_count FROM financial_journal_entries e WHERE e.organization_id=NEW.organization_id AND e.kind='recognize_sale' AND e.source_kind=checked_kind AND e.source_id=checked_source AND NOT EXISTS(SELECT 1 FROM financial_journal_entries r WHERE r.reversal_of_id=e.id);
 IF active_count>1 THEN RAISE EXCEPTION 'A recorded sale has multiple active financial recognitions' USING ERRCODE='23505'; END IF;
 IF active_count=1 AND NOT EXISTS(SELECT 1 FROM financial_broiler_sources s WHERE s.organization_id=NEW.organization_id AND s.source_kind=checked_kind AND s.source_id=checked_source) THEN RAISE EXCEPTION 'Active financial recognition requires its active operational sale' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER financial_source_consistency AFTER INSERT ON financial_journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_financial_source_consistency();
CREATE CONSTRAINT TRIGGER financial_live_source_consistency AFTER INSERT ON broiler_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='void') EXECUTE FUNCTION check_financial_source_consistency();
CREATE CONSTRAINT TRIGGER financial_product_source_consistency AFTER INSERT ON broiler_product_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='void') EXECUTE FUNCTION check_financial_source_consistency();
REVOKE ALL ON FUNCTION check_financial_source_consistency() FROM PUBLIC;
