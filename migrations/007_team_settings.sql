CREATE POLICY org_update ON organizations FOR UPDATE TO farm_app USING(member_role(id) IN ('owner','admin')) WITH CHECK(member_role(id) IN ('owner','admin'));
GRANT UPDATE(name,currency,timezone) ON organizations TO farm_app;
CREATE FUNCTION team_members(org uuid) RETURNS TABLE(id uuid,email text,role text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT u.id,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=org AND member_role(org) IS NOT NULL ORDER BY u.email $$;
REVOKE ALL ON FUNCTION team_members(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION team_members(uuid) TO farm_app;
CREATE FUNCTION change_team_member(org uuid,target uuid,new_role text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE existing_role text;
BEGIN
 IF member_role(org) NOT IN ('owner','admin') OR member_role(org) IS NULL THEN RAISE EXCEPTION 'not permitted' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext(org::text));
 SELECT role INTO existing_role FROM memberships WHERE organization_id=org AND user_id=target;
 IF existing_role IS NULL OR existing_role='owner' THEN RAISE EXCEPTION 'Owner membership cannot be changed here' USING ERRCODE='42501'; END IF;
 IF new_role IS NULL THEN DELETE FROM memberships WHERE organization_id=org AND user_id=target;
 ELSE
  IF new_role NOT IN ('admin','manager','nutritionist','inventory','accounts','worker','auditor') THEN RAISE EXCEPTION 'invalid role'; END IF;
  UPDATE memberships SET role=new_role WHERE organization_id=org AND user_id=target;
 END IF;
 INSERT INTO audit_logs(organization_id,action,object_id) VALUES(org,CASE WHEN new_role IS NULL THEN 'member.removed' ELSE 'member.role_changed' END,target);
END $$;
REVOKE ALL ON FUNCTION change_team_member(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION change_team_member(uuid,uuid,text) TO farm_app;
