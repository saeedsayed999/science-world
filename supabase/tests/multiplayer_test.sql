-- Run after rules_test.sql on the same scratch database (it reuses its users).
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(u text) returns void language sql as $$ select set_config('request.uid', u, false) $$;

-- Users from rules_test: ...0f teacher, ...0a Ali, ...0b Sara. Add Omar (approved) and Noor (pending).
insert into auth.users (id, raw_user_meta_data) values
 ('00000000-0000-0000-0000-0000000000c1', '{"username":"omar","first_name":"Omar","last_name":"K"}'),
 ('00000000-0000-0000-0000-0000000000d1', '{"username":"noor","first_name":"Noor"}');
update profiles set status = 'approved' where username = 'omar';

select pg_temp.as_user('00000000-0000-0000-0000-00000000000f');
insert into question_sets (id, title, mode, questions, released, released_at)
select ('20000000-0000-0000-0000-00000000000' || n)::uuid, t, m,
  (select jsonb_agg(jsonb_build_object('id','q'||i,'text','Q'||i,'options',jsonb_build_array('a','b','c','d'),'answer',i % 4)) from generate_series(1,10) i),
  rel, now()
from (values (1, 'Friends set', 'friends', true), (2, 'Class set', 'teacher', false), (3, 'Friends hidden', 'friends', false)) v(n, t, m, rel);

create temp table ctx (k text primary key, v text);
grant all on ctx to public;

-- ---------- Friends room ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$
declare j json;
begin
  begin perform create_room('20000000-0000-0000-0000-000000000003'); assert false, 'hidden friends set hosted';
  exception when others then assert sqlerrm like '%not available%', sqlerrm; end;
  begin perform create_room('20000000-0000-0000-0000-000000000002'); assert false, 'student hosted a teacher set';
  exception when others then assert sqlerrm like '%Only teachers%', sqlerrm; end;
  j := create_room('20000000-0000-0000-0000-000000000001');
  insert into ctx values ('room', j->>'room_id'), ('code', j->>'code');
  begin perform start_room((j->>'room_id')::uuid); assert false, 'started alone';
  exception when others then assert sqlerrm like '%at least one friend%', sqlerrm; end;
end $$;

select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
do $$ begin
  begin perform join_room((select v from ctx where k='code')); assert false, 'pending student joined';
  exception when others then assert sqlerrm like '%not approved%', sqlerrm; end;
end $$;

-- Omar: not a member yet, cannot read the room.
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  begin perform room_state((select v from ctx where k='room')::uuid); assert false, 'non-member read room';
  exception when others then assert sqlerrm like '%not found%', sqlerrm; end;
end $$;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select join_room(lower((select v from ctx where k='code')));   -- codes are case-insensitive
select set_ready((select v from ctx where k='room')::uuid, true);

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$
declare rid uuid := (select v from ctx where k='room')::uuid;
begin
  begin perform start_room(rid); assert false, 'started with host not ready';
  exception when others then assert sqlerrm like '%Ready%', sqlerrm; end;
  perform set_ready(rid, true);
  perform start_room(rid);
  assert (room_state(rid)->>'status') = 'racing';
  assert json_array_length(room_state(rid)->'questions') = 10;
  assert (room_state(rid)->'questions'->0->>'answer') is null, 'answer key leaked';
end $$;

-- Late join is refused.
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  begin perform join_room((select v from ctx where k='code')); assert false, 'late join allowed';
  exception when others then assert sqlerrm like '%already started%', sqlerrm; end;
end $$;

-- Sara answers 5 correct then 1 wrong; Ali (with two early wrongs) reaches 10 first.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$
declare rid uuid := (select v from ctx where k='room')::uuid; race uuid; i int; res json;
begin
  race := (room_state(rid)->>'my_race_id')::uuid;
  insert into ctx values ('sara_race', race);
  for i in 1..5 loop res := submit_answer(race, 'q'||i, i % 4, 'sara'||i); end loop;
  res := submit_answer(race, 'q6', (6 + 1) % 4, 'sara-w6');
  assert res->>'status' = 'wrong' and (res->>'event_id') is not null, res::text;
end $$;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$
declare rid uuid := (select v from ctx where k='room')::uuid; race uuid; i int; res json;
begin
  race := (room_state(rid)->>'my_race_id')::uuid;
  insert into ctx values ('ali_race', race);
  perform submit_answer(race, 'q1', 0, 'ali-w1');
  perform submit_answer(race, 'q1', 2, 'ali-w2');
  for i in 1..10 loop res := submit_answer(race, 'q'||i, i % 4, 'ali'||i); end loop;
  assert (res->>'finished')::bool, 'Ali should finish';
  assert (room_state(rid)->>'status') = 'finished';
  assert (room_state(rid)->>'winner_id')::uuid = auth.uid();
  -- AC17: 10 new attempts + 10 correct + 500 + 200 winner bonus.
  assert (select sum(amount) from reward_ledger where race_id = race) = 2700, 'winner total';
  -- Every event is visible to members, in order.
  assert json_array_length(room_state(rid)->'events') = 2 + 10 + 6, 'event count';
  assert json_array_length(room_state(rid, 15)->'events') = 3, 'events since cursor';
end $$;

-- Sara: race over for her too (AC13), answers refused, participation paid without completing questions.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$
declare race uuid := (select v from ctx where k='sara_race')::uuid; res json;
begin
  res := submit_answer(race, 'q6', 6 % 4, 'sara-late');
  assert res->>'status' = 'rejected', 'answer accepted after finish';
  -- 6 attempts + 5 correct + 500 participation, no winner bonus.
  assert (select sum(amount) from reward_ledger where race_id = race) = 1600, 'nonwinner total';
  assert (select correct_count from races where id = race) = 5, 'participation must not complete questions';
  assert (select finished_at is not null from races where id = race), 'Sara race not closed';
end $$;

-- ---------- Teacher room: Omar leaves mid-race and loses participation ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000f');
do $$ declare j json; begin
  j := create_room('20000000-0000-0000-0000-000000000002');
  insert into ctx values ('troom', j->>'room_id'), ('tcode', j->>'code');
end $$;

select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select join_room((select v from ctx where k='tcode'));
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select join_room((select v from ctx where k='tcode'));

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  begin perform start_room((select v from ctx where k='troom')::uuid); assert false, 'student started teacher room';
  exception when others then assert sqlerrm like '%Only the host%', sqlerrm; end;
end $$;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000f');
select start_room((select v from ctx where k='troom')::uuid);  -- teacher starts without Ready
do $$ begin
  assert (room_state((select v from ctx where k='troom')::uuid)->>'my_race_id') is null, 'teacher should not race';
end $$;

select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$
declare rid uuid := (select v from ctx where k='troom')::uuid; race uuid; res json;
begin
  race := (room_state(rid)->>'my_race_id')::uuid;
  insert into ctx values ('omar_race', race);
  perform submit_answer(race, 'q1', 1, 'omar1');
  perform leave_room(rid);
  res := submit_answer(race, 'q2', 2, 'omar2');
  assert res->>'status' = 'rejected', 'answer accepted after leaving';
end $$;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$
declare rid uuid := (select v from ctx where k='troom')::uuid; race uuid; i int;
begin
  race := (room_state(rid)->>'my_race_id')::uuid;
  for i in 1..10 loop perform submit_answer(race, 'q'||i, i % 4, 'st'||i); end loop;
  assert (select sum(amount) from reward_ledger where race_id = race) = 2700, 'teacher-room winner total';
  -- AC08: the teacher set did not touch Sara's friends-set rewards.
  assert (select count(*) from reward_ledger where student_id = auth.uid() and event_key like '%20000000-0000-0000-0000-000000000001%') = 12;
end $$;

select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  assert (select coalesce(sum(amount), 0) from reward_ledger where race_id = (select v from ctx where k='omar_race')::uuid) = 200,
    'leaver keeps answer rewards but no participation';
  assert my_active_room() is null, 'finished room should not be active';
end $$;

-- RLS: as the authenticated role, a student cannot read a room they are not in.
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
set role authenticated;
do $$ begin
  assert (select count(*) from rooms where id = (select v from ctx where k='room')::uuid) = 0, 'outsider sees friends room';
  assert (select count(*) from room_events where room_id = (select v from ctx where k='room')::uuid) = 0, 'outsider sees events';
  assert (select count(*) from rooms where id = (select v from ctx where k='troom')::uuid) = 1, 'member cannot see own room';
end $$;
reset role;
select 'ALL MULTIPLAYER TESTS PASSED' as result;
