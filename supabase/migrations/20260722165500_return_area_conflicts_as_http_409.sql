-- SQLSTATE 40001 means serialization failure and may be retried by database
-- infrastructure. A stale collaboration revision is a product-level conflict,
-- so return PostgREST's explicit HTTP 409 code instead of replaying the call.

do $migration$
declare
  v_function regprocedure :=
    'public.publish_shared_project_area_snapshot(uuid,uuid,jsonb,integer,integer,timestamptz,text)'::regprocedure;
  v_definition text;
  v_updated_definition text;
begin
  select pg_get_functiondef(v_function) into v_definition;
  v_updated_definition := replace(
    v_definition,
    'using errcode = ''40001'';',
    'using errcode = ''PT409'';'
  );

  if v_updated_definition = v_definition then
    raise exception 'Could not find the stale area conflict SQLSTATE in %.', v_function::text;
  end if;

  execute v_updated_definition;
end
$migration$;
