-- transaction_timestamp()/now() is fixed when a transaction starts, which can
-- disagree with project-lock order under contention. Capture the publish clock
-- immediately after the shared advisory lock instead so full and area cursors
-- remain monotonic in commit order.

do $migration$
declare
  v_function regprocedure;
  v_definition text;
  v_ordered_definition text;
  v_lock_statement constant text :=
    '  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));';
begin
  for v_function in
    select unnest(array[
      'public.publish_shared_project_area_snapshot(uuid,uuid,jsonb,integer,integer,timestamptz,text)'::regprocedure,
      'public.publish_shared_project_snapshot(uuid,jsonb,integer,timestamptz)'::regprocedure
    ])
  loop
    select pg_get_functiondef(v_function) into v_definition;
    if position(v_lock_statement in v_definition) = 0 then
      raise exception 'Could not find collaboration publish lock in %.', v_function::text;
    end if;

    v_ordered_definition := replace(
      v_definition,
      v_lock_statement,
      v_lock_statement || E'\n\n  v_next_published_at := clock_timestamp();'
    );
    execute v_ordered_definition;
  end loop;
end
$migration$;

notify pgrst, 'reload schema';
