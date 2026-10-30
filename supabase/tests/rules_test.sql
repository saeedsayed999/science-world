-- Run against a scratch database with the schema applied (see README).
-- Simulates Supabase's per-request user with set_config('request.uid', ...).
\set ON_ERROR_STOP 1
grant usage on schema auth to authenticated; -- Supabase already grants this
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id, raw_user_meta_data) values
 ('00000000-0000-0000-0000-00000000000f', '{"username":"drteacher","first_name":"Omar","role":"teacher"}'),
 ('00000000-0000-0000-0000-00000000000a', '{"username":"ali","first_name":"Ali","role":"student"}'),
 ('00000000-0000-0000-0000-00000000000b', '{"username":"sara","first_name":"Sara"}');

do $$ begin
  assert (select role from profiles where username='drteacher') = 'student', 'teacher role cannot be self-requested';
  assert (select status from profiles where username='ali') = 'pending', 'new accounts start pending';
end $$;
update profiles set role='teacher', status='approved' where username='drteacher';

create or replace function pg_temp.as_user(u text) returns void language sql as $$ select set_config('request.uid', u, false) $$;

-- Teacher creates two sets: one released, one hidden.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000f');
insert into question_sets (id, title, mode, questions, released, released_at)
select '10000000-0000-0000-0000-000000000001', 'Released set', 'solo',
  (select jsonb_agg(jsonb_build_object('id','q'||i,'text','Q'||i,'options',jsonb_build_array('a','b','c','d'),'answer',i % 4)) from generate_series(1,10) i),
  true, now();
insert into question_sets (id, title, mode, questions)
select '10000000-0000-0000-0000-000000000002', 'Hidden set', 'solo',
  (select jsonb_agg(jsonb_build_object('id','q'||i,'text','Q'||i,'options',jsonb_build_array('a','b','c','d'),'answer',0)) from generate_series(1,10) i);

-- Pending student cannot start.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  begin perform start_race('10000000-0000-0000-0000-000000000001'); assert false, 'pending student started a race';
  exception when others then assert sqlerrm like '%not approved%', sqlerrm; end;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000f');
select set_account_status('00000000-0000-0000-0000-00000000000a', 'approved');
select set_account_status('00000000-0000-0000-0000-00000000000b', 'approved');

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$
declare j json; rid uuid; res json; i int;
begin
  -- AC06: hidden set cannot be opened directly.
  begin perform start_race('10000000-0000-0000-0000-000000000002'); assert false, 'hidden set opened';
  exception when others then assert sqlerrm like '%not available%', sqlerrm; end;
  assert (select count(*) from list_released_sets()) = 1, 'student sees only released sets';

  j := start_race('10000000-0000-0000-0000-000000000001');
  rid := (j->>'race_id')::uuid;
  assert (j->'questions'->0->>'answer') is null, 'answer key leaked to client';

  -- Wrong twice, then right on q1; duplicate request ignored.
  res := submit_answer(rid, 'q1', 0, 'r1'); assert res->>'status' = 'wrong', res::text;
  res := submit_answer(rid, 'q1', 2, 'r2'); assert res->>'status' = 'wrong', res::text;
  res := submit_answer(rid, 'q1', 1, 'r3'); assert res->>'status' = 'correct', res::text;
  res := submit_answer(rid, 'q1', 1, 'r3'); assert (res->>'duplicate')::bool, 'duplicate not detected';
  res := submit_answer(rid, 'q1', 1, 'r4'); assert res->>'status' = 'rejected', 'stale question accepted';
  assert (select sum(amount) from reward_ledger where race_id = rid) = 200, 'one attempt + one correct = 200';

  for i in 2..10 loop res := submit_answer(rid, 'q'||i, i % 4, 'x'||i); end loop;
  assert (res->>'finished')::bool, 'race should finish at 10 correct';
  res := race_summary(rid);
  -- Solo winner: 1000 + 1000 + 500, no 200 winner bonus.
  assert (res->>'balance')::int = 2500, 'solo winner total ' || res::text;
  res := submit_answer(rid, 'q10', 1, 'late'); assert res->>'status' = 'rejected', 'answer after finish accepted';

  -- AC19: replaying the same set earns nothing new.
  j := start_race('10000000-0000-0000-0000-000000000001'); rid := (j->>'race_id')::uuid;
  for i in 1..10 loop res := submit_answer(rid, 'q'||i, i % 4, 'y'||i); end loop;
  assert (race_summary(rid)->>'balance')::int = 2500, 'replay minted rewards';

  -- Instant fake bot win earns no participation.
  j := start_race('10000000-0000-0000-0000-000000000001'); rid := (j->>'race_id')::uuid;
  res := finish_solo_race(rid, 'Leo');
  assert (res->>'finished')::bool and (res->>'balance')::int = 2500, res::text;
end $$;

-- Student B: bot wins after 60 s with 5 correct + 1 attempted → 600 + 500 + 500.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$
declare j json; rid uuid; res json; i int;
begin
  j := start_race('10000000-0000-0000-0000-000000000001'); rid := (j->>'race_id')::uuid;
  for i in 1..5 loop perform submit_answer(rid, 'q'||i, i % 4, 'b'||i); end loop;
  perform submit_answer(rid, 'q6', 0, 'b6w');
  update races set started_at = now() - interval '2 minutes' where id = rid;
  res := finish_solo_race(rid, 'Leo');
  assert (res->>'balance')::int = 1600, 'nonwinner total ' || res::text;
  assert (select correct_count from races where id = rid) = 5, 'participation must not mark questions correct';
end $$;

-- RLS: as the authenticated role, a student cannot read answer keys or others' data, or write rewards.
set role authenticated;
do $$ begin
  assert (select count(*) from question_sets) = 0, 'student can read question_sets (answer keys)';
  assert (select count(*) from reward_ledger where student_id <> auth.uid()) = 0, 'student sees other ledgers';
  assert (select count(*) from profiles) = 1, 'student sees other profiles';
  begin insert into reward_ledger (student_id, event_key, kind, amount) values (auth.uid(), 'hack', 'adjustment', 99999);
    assert false, 'student inserted into ledger';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'ALL SQL RULE TESTS PASSED' as result;
