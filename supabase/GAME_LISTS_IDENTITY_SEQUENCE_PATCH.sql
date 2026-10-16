-- Fix ERROR 23505 steam_games_pkey when identity generates an existing id.
-- Run as the table owner (Supabase SQL Editor / postgres).
-- No rows or constraints are removed. Serialize briefly against table writes.
begin;
lock table public.game_lists in share row exclusive mode;
do $$
declare
    identity_sequence regclass;
    maximum_id bigint;
    sequence_last bigint;
begin
    identity_sequence := pg_get_serial_sequence('public.game_lists', 'id')::regclass;
    if identity_sequence is null then
        raise exception 'Identity sequence for public.game_lists.id not found';
    end if;
    select max(id) into maximum_id from public.game_lists;
    execute format('select last_value from %s', identity_sequence) into sequence_last;
    -- Do not move a sequence backwards if it is already ahead of table data.
    perform setval(identity_sequence, greatest(coalesce(maximum_id, 1), sequence_last), true);
end $$;
commit;

-- Inspect without consuming a sequence value:
select max(id) as maximum_existing_id,
       pg_get_serial_sequence('public.game_lists', 'id') as identity_sequence
from public.game_lists;
