-- Stage 3: live Friends and Teacher races. Run AFTER schema.sql (safe to re-run).
--
-- The database is the referee: it accepts answers in order, records every
-- answer as a room event that all players replay to animate positions, and the
-- first player to reach 10 correct finishes the room for everyone in the same
-- transaction (handoff R01, R04, R06, AC13, AC16).
--
-- PROVISIONAL policies (handoff O05), all in this file:
--   * every approved student counts as one group until groups are added;
--   * up to 8 racers per room; Friends rooms need 2+ racers, all ready;
--     teacher rooms start when the teacher presses Start (1+ racer);
--   * no joining after the start; a racer who presses Leave loses the
--     500 participation bonus, a racer who only loses connection keeps it;
--   * simultaneous finishes: the first answer the database commits wins.

-- ---------- tables ----------

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  host_id uuid not null references public.profiles on delete cascade,
  mode text not null check (mode in ('friends', 'teacher')),
  set_id uuid not null references public.question_sets on delete cascade,
  status text not null default 'lobby' check (status in ('lobby', 'racing', 'finished', 'cancelled')),
  winner_id uuid references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists public.room_players (
  room_id uuid not null references public.rooms on delete cascade,
  student_id uuid not null references public.profiles on delete cascade,
  joined_at timestamptz not null default now(),
  ready boolean not null default false,
  left_at timestamptz,
  race_id uuid references public.races on delete set null,
  primary key (room_id, student_id)
);

create table if not exists public.room_events (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms on delete cascade,
  student_id uuid not null references public.profiles on delete cascade,
  question_id text not null,
  correct boolean not null,
  created_at timestamptz not null default now()
);

alter table public.races add column if not exists room_id uuid references public.rooms on delete set null;
create index if not exists room_events_room_idx on public.room_events (room_id, id);
create index if not exists room_players_student_idx on public.room_players (student_id);

-- ---------- access ----------

create or replace function public.is_room_member(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from rooms where id = p_room and host_id = auth.uid())
      or exists (select 1 from room_players where room_id = p_room and student_id = auth.uid());
$$;

alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.room_events enable row level security;

drop policy if exists "room members" on public.rooms;
create policy "room members" on public.rooms for select using (public.is_room_member(id) or public.is_teacher());
drop policy if exists "room members" on public.room_players;
create policy "room members" on public.room_players for select using (public.is_room_member(room_id) or public.is_teacher());
drop policy if exists "room members" on public.room_events;
create policy "room members" on public.room_events for select using (public.is_room_member(room_id) or public.is_teacher());

-- Live updates: clients subscribe to inserts/updates on these tables (RLS still applies).
do $$
declare t text;
begin
  foreach t in array array['rooms', 'room_players', 'room_events'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object or undefined_object then null;
    end;
  end loop;
end $$;

-- ---------- lobby ----------

create or replace function public.leave_other_lobbies(p_keep uuid) returns void
language sql security definer set search_path = public as $$
  delete from room_players rp using rooms r
  where rp.room_id = r.id and rp.student_id = auth.uid() and r.status = 'lobby' and r.id <> coalesce(p_keep, '00000000-0000-0000-0000-000000000000');
$$;
revoke execute on function public.leave_other_lobbies(uuid) from public, anon, authenticated;

create or replace function public.create_room(p_set_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare
  s question_sets;
  c text;
  rid uuid;
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
begin
  select * into s from question_sets where id = p_set_id;
  if not found then raise exception 'This race is not available'; end if;
  if s.mode = 'friends' then
    if not public.is_approved_student() then raise exception 'Your account is not approved yet'; end if;
    if not s.released then raise exception 'This race is not available'; end if;
  elsif s.mode = 'teacher' then
    if not public.is_teacher() then raise exception 'Only teachers can host class races'; end if;
  else
    raise exception 'Solo sets are raced on your own';
  end if;
  loop
    select string_agg(substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1), '') into c
    from generate_series(1, 5);
    exit when not exists (select 1 from rooms where code = c);
  end loop;
  insert into rooms (code, host_id, mode, set_id) values (c, auth.uid(), s.mode, s.id) returning id into rid;
  if s.mode = 'friends' then
    perform public.leave_other_lobbies(rid);
    insert into room_players (room_id, student_id, ready) values (rid, auth.uid(), false);
  end if;
  return json_build_object('room_id', rid, 'code', c);
end $$;

create or replace function public.join_room(p_code text) returns json
language plpgsql security definer set search_path = public as $$
declare rm rooms;
begin
  if not public.is_approved_student() then raise exception 'Your account is not approved yet'; end if;
  select * into rm from rooms where code = upper(trim(p_code)) for update;
  if not found or rm.status = 'cancelled' then raise exception 'No race has that code. Check the code and try again.'; end if;
  if rm.status <> 'lobby' then raise exception 'That race has already started.'; end if;
  if not exists (select 1 from room_players where room_id = rm.id and student_id = auth.uid())
     and (select count(*) from room_players where room_id = rm.id) >= 8 then
    raise exception 'That race is full (8 racers).';
  end if;
  perform public.leave_other_lobbies(rm.id);
  insert into room_players (room_id, student_id) values (rm.id, auth.uid())
  on conflict (room_id, student_id) do update set left_at = null;
  return json_build_object('room_id', rm.id, 'code', rm.code);
end $$;

create or replace function public.set_ready(p_room uuid, p_ready boolean) returns void
language sql security definer set search_path = public as $$
  update room_players rp set ready = p_ready from rooms r
  where rp.room_id = p_room and rp.student_id = auth.uid() and r.id = rp.room_id and r.status = 'lobby';
$$;

create or replace function public.leave_room(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare rm rooms;
begin
  select * into rm from rooms where id = p_room for update;
  if not found then return; end if;
  if rm.status = 'lobby' then
    if rm.host_id = auth.uid() then
      update rooms set status = 'cancelled' where id = rm.id;
    else
      delete from room_players where room_id = rm.id and student_id = auth.uid();
    end if;
  elsif rm.status = 'racing' then
    update room_players set left_at = now() where room_id = rm.id and student_id = auth.uid() and left_at is null;
  end if;
end $$;

create or replace function public.start_room(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  rm rooms;
  n int;
  p record;
  rid uuid;
begin
  select * into rm from rooms where id = p_room for update;
  if not found or rm.host_id <> auth.uid() then raise exception 'Only the host can start this race'; end if;
  if rm.status <> 'lobby' then raise exception 'This race has already started'; end if;
  select count(*) into n from room_players where room_id = rm.id;
  if rm.mode = 'friends' then
    if n < 2 then raise exception 'Wait for at least one friend to join'; end if;
    if exists (select 1 from room_players where room_id = rm.id and not ready) then
      raise exception 'Everyone needs to press Ready first';
    end if;
  elsif n < 1 then
    raise exception 'No students have joined yet';
  end if;
  for p in select student_id from room_players where room_id = rm.id loop
    insert into races (student_id, set_id, mode, room_id) values (p.student_id, rm.set_id, rm.mode, rm.id) returning id into rid;
    update room_players set race_id = rid where room_id = rm.id and student_id = p.student_id;
  end loop;
  update rooms set status = 'racing', started_at = now() where id = rm.id;
end $$;

-- Teachers may cancel a class race before it starts. Ending a race early is
-- an open decision (handoff T04), so it is not offered.
create or replace function public.cancel_room(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update rooms set status = 'cancelled' where id = p_room and status = 'lobby'
    and (host_id = auth.uid() or public.is_teacher());
end $$;

-- ---------- finish (internal) ----------

create or replace function public.finish_room(p_room uuid, p_winner uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  rm rooms;
  p record;
  wname text;
begin
  update rooms set status = 'finished', winner_id = p_winner, finished_at = now()
  where id = p_room and status = 'racing' returning * into rm;
  if not found then return; end if;
  select first_name into wname from profiles where id = p_winner;
  for p in select rp.student_id, rp.race_id, rp.left_at from room_players rp where rp.room_id = rm.id loop
    update races set finished_at = now(), winner = case when p.student_id = p_winner then 'you' else wname end
    where id = p.race_id and finished_at is null;
    if p.left_at is null then
      insert into reward_ledger (student_id, event_key, kind, amount, race_id)
      values (p.student_id, format('pt:%s:%s:%s', p.student_id, rm.set_id, rm.mode), 'participation', 500, p.race_id)
      on conflict (event_key) do nothing;
    end if;
    if p.student_id = p_winner then
      insert into reward_ledger (student_id, event_key, kind, amount, race_id)
      values (p.student_id, format('wn:%s:%s:%s', p.student_id, rm.set_id, rm.mode), 'winner', 200, p.race_id)
      on conflict (event_key) do nothing;
    end if;
  end loop;
end $$;
revoke execute on function public.finish_room(uuid, uuid) from public, anon, authenticated;

-- ---------- answers (replaces the Stage 2 version; Solo behaviour unchanged) ----------

create or replace function public.submit_answer(p_race_id uuid, p_question_id text, p_choice int, p_request_id text)
returns json language plpgsql security definer set search_path = public as $$
declare
  r races;
  rm rooms;
  s question_sets;
  q jsonb;
  prev answer_attempts;
  is_correct boolean;
  first_attempt boolean;
  ev bigint;
  uid uuid := auth.uid();
begin
  select * into prev from answer_attempts where request_id = p_request_id and student_id = uid;
  if found then
    select * into r from races where id = prev.race_id;
    return json_build_object('status', case when prev.correct then 'correct' else 'wrong' end,
      'correct_count', r.correct_count, 'finished', r.finished_at is not null, 'duplicate', true);
  end if;

  select * into r from races where id = p_race_id and student_id = uid;
  if not found then raise exception 'Race not found'; end if;
  if r.room_id is not null then
    -- One lock per room serialises answers, so exactly one racer can finish first.
    select * into rm from rooms where id = r.room_id for update;
    if rm.status <> 'racing' then return json_build_object('status', 'rejected', 'reason', 'race-finished'); end if;
    if exists (select 1 from room_players where room_id = rm.id and student_id = uid and left_at is not null) then
      return json_build_object('status', 'rejected', 'reason', 'left-race');
    end if;
  end if;
  select * into r from races where id = p_race_id for update;
  if r.finished_at is not null then return json_build_object('status', 'rejected', 'reason', 'race-finished'); end if;

  select * into s from question_sets where id = r.set_id;
  q := s.questions -> r.q_index;
  if q is null or q ->> 'id' <> p_question_id then
    return json_build_object('status', 'rejected', 'reason', 'not-current-question');
  end if;

  is_correct := (q ->> 'answer')::int = p_choice;
  first_attempt := not exists (select 1 from answer_attempts where race_id = r.id and question_id = p_question_id);
  insert into answer_attempts (race_id, student_id, question_id, choice, correct, request_id)
  values (r.id, uid, p_question_id, p_choice, is_correct, p_request_id);

  insert into reward_ledger (student_id, event_key, kind, amount, race_id)
  values (uid, format('fa:%s:%s:%s', uid, s.id, p_question_id), 'first_attempt', 100, r.id)
  on conflict (event_key) do nothing;

  if is_correct then
    insert into reward_ledger (student_id, event_key, kind, amount, race_id)
    values (uid, format('fc:%s:%s:%s', uid, s.id, p_question_id), 'first_correct', 100, r.id)
    on conflict (event_key) do nothing;
    update races set q_index = q_index + 1, correct_count = correct_count + 1,
      attempted_count = attempted_count + case when first_attempt then 1 else 0 end,
      first_try_correct = first_try_correct + case when first_attempt then 1 else 0 end
      where id = r.id returning * into r;
  else
    update races set wrong_count = wrong_count + 1,
      attempted_count = attempted_count + case when first_attempt then 1 else 0 end
      where id = r.id returning * into r;
  end if;

  if r.room_id is not null then
    insert into room_events (room_id, student_id, question_id, correct)
    values (r.room_id, uid, p_question_id, is_correct) returning id into ev;
  end if;

  if is_correct and r.correct_count >= jsonb_array_length(s.questions) then
    if r.room_id is not null then perform public.finish_room(r.room_id, uid);
    else perform public.close_race(r.id, 'you');
    end if;
    select * into r from races where id = r.id;
  end if;

  return json_build_object('status', case when is_correct then 'correct' else 'wrong' end,
    'correct_count', r.correct_count, 'finished', r.finished_at is not null, 'event_id', ev);
end $$;

-- ---------- state for clients ----------

-- Everything a lobby or race screen needs, plus room events after p_since.
-- Questions (without answers) are included once the race has started.
create or replace function public.room_state(p_room uuid, p_since bigint default 0) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  rm rooms;
  s question_sets;
  me room_players;
begin
  select * into rm from rooms where id = p_room;
  if not found or not (public.is_room_member(rm.id) or public.is_teacher()) then
    raise exception 'Race not found';
  end if;
  select * into s from question_sets where id = rm.set_id;
  select * into me from room_players where room_id = rm.id and student_id = auth.uid();
  return json_build_object(
    'id', rm.id, 'code', rm.code, 'mode', rm.mode, 'status', rm.status,
    'title', s.title, 'season', s.season,
    'is_host', rm.host_id = auth.uid(),
    'host_name', (select first_name || ' ' || last_name from profiles where id = rm.host_id),
    'winner_id', rm.winner_id, 'started_at', rm.started_at,
    'me', auth.uid(), 'my_race_id', me.race_id,
    'players', coalesce((select json_agg(json_build_object(
        'id', rp.student_id, 'name', p.first_name || ' ' || left(p.last_name, 1),
        'ready', rp.ready, 'left', rp.left_at is not null,
        'correct', coalesce(rc.correct_count, 0)) order by rp.joined_at)
      from room_players rp join profiles p on p.id = rp.student_id
      left join races rc on rc.id = rp.race_id
      where rp.room_id = rm.id), '[]'::json),
    'events', coalesce((select json_agg(json_build_object('id', e.id, 'student_id', e.student_id,
        'question_id', e.question_id, 'correct', e.correct) order by e.id)
      from room_events e where e.room_id = rm.id and e.id > p_since), '[]'::json),
    'questions', case when rm.status in ('racing', 'finished') and me.race_id is not null then
      (select json_agg(json_build_object('id', q ->> 'id', 'text', q ->> 'text', 'options', q -> 'options'))
       from jsonb_array_elements(s.questions) q) end
  );
end $$;

-- The open lobby or race this user belongs to (for resuming after a reload).
create or replace function public.my_active_room() returns uuid
language sql stable security definer set search_path = public as $$
  select r.id from rooms r
  where r.status in ('lobby', 'racing') and r.created_at > now() - interval '3 hours'
    and (r.host_id = auth.uid() or exists (
      select 1 from room_players rp where rp.room_id = r.id and rp.student_id = auth.uid() and rp.left_at is null))
  order by r.created_at desc limit 1;
$$;

grant execute on function public.create_room, public.join_room, public.set_ready, public.leave_room,
  public.start_room, public.cancel_room, public.submit_answer, public.room_state, public.my_active_room
  to authenticated;
