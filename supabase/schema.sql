-- Dr. Omar's Science World: Stage 2 database (accounts, question sets, races, O-Bucks).
-- Paste into Supabase → SQL Editor → Run. Safe to re-run: it drops and recreates
-- only its own functions/policies, never data tables that already exist.
--
-- Security model: students never read answer keys or write balances directly.
-- They call SECURITY DEFINER functions that check membership, release state and
-- the current question, and write rewards to an append-only ledger whose unique
-- event keys make every reward apply at most once (handoff I02, E01, AC16, AC19).

-- ---------- tables ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null check (username ~ '^[a-z0-9_.-]{3,30}$'),
  first_name text not null,
  last_name text not null default '',
  role text not null default 'student' check (role in ('student', 'teacher', 'parent')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'revoked')),
  created_at timestamptz not null default now()
);

create table if not exists public.question_sets (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  season text not null default '',
  mode text not null default 'solo' check (mode in ('solo', 'friends', 'teacher')),
  -- [{ "id": "q1", "text": "...", "options": ["A","B","C","D"], "answer": 1 }, ...] exactly 10
  questions jsonb not null check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) = 10),
  released boolean not null default false,
  released_at timestamptz,
  created_by uuid references public.profiles default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.races (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles on delete cascade,
  set_id uuid not null references public.question_sets on delete cascade,
  mode text not null,
  q_index int not null default 0,
  correct_count int not null default 0,
  attempted_count int not null default 0,
  wrong_count int not null default 0,
  first_try_correct int not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  winner text            -- 'you', or the bot's name in Solo
);

create table if not exists public.answer_attempts (
  id bigint generated always as identity primary key,
  race_id uuid not null references public.races on delete cascade,
  student_id uuid not null references public.profiles on delete cascade,
  question_id text not null,
  choice int not null,
  correct boolean not null,
  request_id text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.reward_ledger (
  id bigint generated always as identity primary key,
  student_id uuid not null references public.profiles on delete cascade,
  event_key text not null unique,
  kind text not null check (kind in ('first_attempt', 'first_correct', 'participation', 'winner', 'adjustment')),
  amount int not null,
  race_id uuid references public.races on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists races_student_idx on public.races (student_id, started_at desc);
create index if not exists ledger_student_idx on public.reward_ledger (student_id);
create index if not exists attempts_race_idx on public.answer_attempts (race_id);

-- ---------- helpers ----------

create or replace function public.is_teacher() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'teacher' and status = 'approved');
$$;

create or replace function public.is_approved_student() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'student' and status = 'approved');
$$;

-- New sign-ups get a pending profile. Only 'student' or 'parent' can be requested;
-- teachers are promoted by running the SQL at the bottom of this file.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  r text := coalesce(m ->> 'role', 'student');
begin
  if r not in ('student', 'parent') then r := 'student'; end if;
  insert into profiles (id, username, first_name, last_name, role)
  values (new.id, lower(m ->> 'username'), coalesce(m ->> 'first_name', ''), coalesce(m ->> 'last_name', ''), r);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- row level security ----------

alter table public.profiles enable row level security;
alter table public.question_sets enable row level security;
alter table public.races enable row level security;
alter table public.answer_attempts enable row level security;
alter table public.reward_ledger enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select using (id = auth.uid() or public.is_teacher());

-- Teachers manage sets directly; students get them only through play functions (no answer keys).
drop policy if exists "teacher sets" on public.question_sets;
create policy "teacher sets" on public.question_sets for all using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists "own races" on public.races;
create policy "own races" on public.races for select using (student_id = auth.uid() or public.is_teacher());

drop policy if exists "own attempts" on public.answer_attempts;
create policy "own attempts" on public.answer_attempts for select using (student_id = auth.uid() or public.is_teacher());

drop policy if exists "own ledger" on public.reward_ledger;
create policy "own ledger" on public.reward_ledger for select using (student_id = auth.uid() or public.is_teacher());

-- No insert/update/delete policies for students anywhere: all writes go through the functions below.

-- ---------- student functions ----------

create or replace function public.my_profile() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', p.id, 'username', p.username, 'first_name', p.first_name, 'last_name', p.last_name,
    'role', p.role, 'status', p.status,
    'balance', coalesce((select sum(amount) from reward_ledger where student_id = p.id), 0)
  ) from profiles p where p.id = auth.uid();
$$;

create or replace function public.list_released_sets() returns table (id uuid, title text, season text, mode text, released_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.id, s.title, s.season, s.mode, s.released_at from question_sets s
  where s.released and (public.is_approved_student() or public.is_teacher())
  order by s.released_at desc nulls last;
$$;

-- Starts a race and returns its id plus the questions WITHOUT answers.
create or replace function public.start_race(p_set_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare
  s question_sets;
  rid uuid;
begin
  if not public.is_approved_student() then raise exception 'Your account is not approved yet'; end if;
  select * into s from question_sets where id = p_set_id and released;
  if not found then raise exception 'This race is not available'; end if;   -- hidden sets stay hidden (AC06)
  if s.mode <> 'solo' then raise exception 'Only Solo races can be started here'; end if;
  insert into races (student_id, set_id, mode) values (auth.uid(), s.id, s.mode) returning id into rid;
  return json_build_object(
    'race_id', rid, 'set_id', s.id, 'title', s.title, 'season', s.season,
    'questions', (select json_agg(json_build_object('id', q ->> 'id', 'text', q ->> 'text', 'options', q -> 'options'))
                  from jsonb_array_elements(s.questions) q)
  );
end $$;

-- Checks one answer. Duplicate request ids return the first result unchanged.
create or replace function public.submit_answer(p_race_id uuid, p_question_id text, p_choice int, p_request_id text)
returns json language plpgsql security definer set search_path = public as $$
declare
  r races;
  s question_sets;
  q jsonb;
  prev answer_attempts;
  is_correct boolean;
  first_attempt boolean;
  uid uuid := auth.uid();
begin
  select * into prev from answer_attempts where request_id = p_request_id and student_id = uid;
  if found then
    select * into r from races where id = prev.race_id;
    return json_build_object('status', case when prev.correct then 'correct' else 'wrong' end,
      'correct_count', r.correct_count, 'finished', r.finished_at is not null, 'duplicate', true);
  end if;

  select * into r from races where id = p_race_id and student_id = uid for update;
  if not found then raise exception 'Race not found'; end if;
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

  -- Rewards are keyed per student + set + question, so replaying a set cannot mint them again
  -- (PROVISIONAL replay policy, handoff O04).
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
    if r.correct_count >= jsonb_array_length(s.questions) then
      perform public.close_race(r.id, 'you');
      select * into r from races where id = r.id;
    end if;
  else
    update races set wrong_count = wrong_count + 1,
      attempted_count = attempted_count + case when first_attempt then 1 else 0 end
      where id = r.id returning * into r;
  end if;

  return json_build_object('status', case when is_correct then 'correct' else 'wrong' end,
    'correct_count', r.correct_count, 'finished', r.finished_at is not null);
end $$;

-- Internal: mark finished and award participation once per student + set + mode (PROVISIONAL, O04).
-- The 200 winner bonus applies only to Friends/Teacher races (E01), never Solo.
create or replace function public.close_race(p_race_id uuid, p_winner text) returns void
language plpgsql security definer set search_path = public as $$
declare r races;
begin
  update races set finished_at = now(), winner = p_winner where id = p_race_id and finished_at is null returning * into r;
  if not found then return; end if;
  insert into reward_ledger (student_id, event_key, kind, amount, race_id)
  values (r.student_id, format('pt:%s:%s:%s', r.student_id, r.set_id, r.mode), 'participation', 500, r.id)
  on conflict (event_key) do nothing;
  if p_winner = 'you' and r.mode in ('friends', 'teacher') then
    insert into reward_ledger (student_id, event_key, kind, amount, race_id)
    values (r.student_id, format('wn:%s:%s:%s', r.student_id, r.set_id, r.mode), 'winner', 200, r.id)
    on conflict (event_key) do nothing;
  end if;
end $$;
revoke execute on function public.close_race(uuid, text) from public, anon, authenticated;

-- Solo: the client reports that a bot reached 10 first. Requires at least one
-- accepted answer and 60 seconds of racing so an instant "bot win" earns nothing.
create or replace function public.finish_solo_race(p_race_id uuid, p_bot_name text) returns json
language plpgsql security definer set search_path = public as $$
declare r races;
begin
  select * into r from races where id = p_race_id and student_id = auth.uid();
  if not found then raise exception 'Race not found'; end if;
  if r.finished_at is null then
    if r.attempted_count = 0 or now() - r.started_at < interval '60 seconds' then
      update races set finished_at = now(), winner = p_bot_name where id = r.id;
    else
      perform public.close_race(r.id, p_bot_name);
    end if;
  end if;
  return public.race_summary(p_race_id);
end $$;

-- What this race actually added to the wallet, by reward type.
create or replace function public.race_summary(p_race_id uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'race_id', r.id, 'correct_count', r.correct_count, 'attempted_count', r.attempted_count,
    'winner', r.winner, 'finished', r.finished_at is not null,
    'earned', coalesce((select json_object_agg(kind, total) from (
        select kind, sum(amount) total from reward_ledger where race_id = r.id group by kind) k), '{}'::json),
    'balance', (select coalesce(sum(amount), 0) from reward_ledger where student_id = r.student_id)
  ) from races r where r.id = p_race_id and (r.student_id = auth.uid() or public.is_teacher());
$$;

-- ---------- teacher functions ----------

create or replace function public.set_account_status(p_user uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_teacher() then raise exception 'Teachers only'; end if;
  if p_status not in ('pending', 'approved', 'revoked') then raise exception 'Unknown status'; end if;
  update profiles set status = p_status where id = p_user and role <> 'teacher';
end $$;

create or replace function public.teacher_students() returns table (
  id uuid, username text, first_name text, last_name text, role text, status text, created_at timestamptz,
  balance bigint, races bigint, last_race timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.username, p.first_name, p.last_name, p.role, p.status, p.created_at,
    coalesce((select sum(amount) from reward_ledger l where l.student_id = p.id), 0),
    (select count(*) from races r where r.student_id = p.id),
    (select max(started_at) from races r where r.student_id = p.id)
  from profiles p where public.is_teacher() and p.role <> 'teacher'
  order by p.status = 'pending' desc, p.created_at desc;
$$;

grant execute on function public.my_profile, public.list_released_sets, public.start_race,
  public.submit_answer, public.finish_solo_race, public.race_summary,
  public.set_account_status, public.teacher_students to authenticated;

-- ---------- make yourself the teacher ----------
-- 1. Sign up on the site with your teacher username.
-- 2. Run this line with that username:
--    update public.profiles set role = 'teacher', status = 'approved' where username = 'your-username';
