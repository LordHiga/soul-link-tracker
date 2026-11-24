begin;

drop policy if exists catches_delete_open_run on public.catches;

create policy catches_delete_open_run
    on public.catches
    as restrictive
    for delete
    to authenticated
    using (
        exists (
            select 1
            from public.runs as r
            where r.id = catches.run_id
              and r.is_finished is not true
            -- Serialize direct catch deletes with run completion and the team trigger.
            for no key update of r
        )
    );

commit;
