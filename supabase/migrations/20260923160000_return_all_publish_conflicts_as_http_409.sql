-- Product revision conflicts must not use serialization_failure: PostgREST 14
-- retries SQLSTATE 40001 indefinitely, exhausting the API connection pool.
-- Keep each function's validation, permissions, and conflict message intact.
do $migration$
declare
  v_function regprocedure;
  v_definition text;
begin
  foreach v_function in array array[
    'public.publish_shared_project_metadata_snapshot(uuid,jsonb,integer,integer,text)'::regprocedure,
    'public.publish_shared_project_snapshot(uuid,jsonb,integer,timestamptz)'::regprocedure,
    'public.publish_shared_project_snapshot_versioned(uuid,jsonb,integer,timestamptz,integer)'::regprocedure
  ] loop
    select pg_get_functiondef(v_function) into v_definition;
    if position('using errcode = ''40001'';' in v_definition) = 0 then
      raise exception 'Expected revision conflict SQLSTATE in %.', v_function::text;
    end if;
    execute replace(v_definition, 'using errcode = ''40001'';', 'using errcode = ''PT409'';');
  end loop;
end
$migration$;

notify pgrst, 'reload schema';
