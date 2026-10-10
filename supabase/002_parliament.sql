-- National Assembly tracker (moved from Google Sheets + Apps Script).
-- All objects are prefixed parl_ so they never clash with other apps in this project.
-- Access model (the site uses the anon key, so RLS is what protects the data):
--   * Public data tables: anyone can read, only a logged-in admin/headadmin can write.
--   * parl_users / parl_sessions: never readable from the browser; only the functions below touch them.
--   * The browser sends its login token in the x-app-token header; the database looks up the role itself.

create extension if not exists pgcrypto with schema extensions;

-- ───────────────────────── users & sessions ─────────────────────────
create table if not exists public.parl_users (
  id            bigint generated always as identity primary key,
  pronoun       text not null default '',
  username      text not null,
  discord       text not null default '',
  password_hash text not null,
  link          text not null default '',
  membership    text not null default 'waiting' check (membership in ('headadmin','admin','member','user','waiting')),
  created_at    timestamptz not null default now()
);
create unique index if not exists parl_users_username_ci on public.parl_users (lower(username));

create table if not exists public.parl_sessions (
  token_hash text primary key,
  user_id    bigint not null references public.parl_users(id) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists parl_sessions_user on public.parl_sessions (user_id);

create table if not exists public.parl_login_attempts (
  username text not null,
  at       timestamptz not null default now()
);
create index if not exists parl_login_attempts_idx on public.parl_login_attempts (username, at);

-- ───────────────────────── data tables (one per sheet) ─────────────────────────
create table if not exists public.parl_law (
  id bigint generated always as identity primary key,
  name text not null, type text not null default '', link text not null default '',
  date text not null default '', status text not null default '',
  a_name text not null default '', a_link text not null default '',
  a_date text not null default '', a_status text not null default ''
);

-- VoteRecords and Committee share one table; "sheet" says which one.
create table if not exists public.parl_votes (
  id bigint generated always as identity primary key,
  sheet text not null check (sheet in ('VoteRecords','Committee')),
  law_name text not null, stage text not null default '', bill_side text not null default '',
  draft_link text not null default '',
  pronoun_introducer text not null default '', introducer text not null default '',
  pronoun_voter text not null default '', voter_name text not null default '',
  vote text not null default '', member_pos text not null default '',
  voter_side text not null default '', date text not null default ''
);
create index if not exists parl_votes_law on public.parl_votes (sheet, law_name);
create index if not exists parl_votes_voter on public.parl_votes (voter_name);

create table if not exists public.parl_members (
  id bigint generated always as identity primary key,
  pronoun text not null default '', name text not null, position text not null default '',
  party text not null default '', mp_type text not null default '',
  in_office text not null default '', out_of_office text not null default '',
  picture text not null default '', party_color text not null default ''
);
create index if not exists parl_members_name on public.parl_members (name);

-- Cabinet and ShadowCabinet share one table.
create table if not exists public.parl_cabinet (
  id bigint generated always as identity primary key,
  is_shadow boolean not null default false,
  ministry text not null default '', pronoun text not null default '', name text not null default '',
  position text not null default '', party text not null default '',
  in_office text not null default '', out_of_office text not null default '',
  picture text not null default '', party_color text not null default ''
);

create table if not exists public.parl_questions (
  id bigint generated always as identity primary key,
  pronoun_asker text not null default '', ask_name text not null default '',
  a_role text not null default '', a_ministry text not null default '',
  pronoun_who text not null default '', to_who text not null default '',
  position text not null default '', ministry text not null default '',
  topic text not null default '', stories text not null default '',
  date text not null default '', answer text not null default '', a_date text not null default ''
);

create table if not exists public.parl_petitions (
  id bigint generated always as identity primary key,
  name text not null, type text not null default '', link text not null default '',
  cur integer not null default 0, goal integer not null default 15,
  status text not null default '', pronoun text not null default '', presenter text not null default '',
  pronoun_petitioner text not null default '', petitioners text not null default '',
  approval text not null default 'Waiting'
);

create table if not exists public.parl_agendas (
  id bigint generated always as identity primary key,
  date text not null default '', number text not null default '', session text not null default '',
  chamber text not null default '', stage text not null default '', topic text not null default '',
  pronoun_introducer text not null default '', introducer text not null default '',
  side text not null default '', links text not null default ''
);
create index if not exists parl_agendas_key on public.parl_agendas (date, number, session);

create table if not exists public.parl_hansard (
  id bigint generated always as identity primary key,
  date text not null default '', number text not null default '', session text not null default '',
  chamber text not null default '', pronoun text not null default '', name text not null default '',
  role text not null default '', agenda_ref text not null default '', agenda_stage text not null default '',
  speech_text text not null default '', ts text not null default ''
);
create index if not exists parl_hansard_key on public.parl_hansard (date, number, session);

-- ───────────────────────── who is calling? ─────────────────────────
create or replace function public.parl_cur_id() returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare t text; uid bigint;
begin
  t := nullif(nullif(current_setting('request.headers', true), '')::json ->> 'x-app-token', '');
  if t is null then return null; end if;
  select s.user_id into uid from public.parl_sessions s
   where s.token_hash = encode(extensions.digest(t, 'sha256'), 'hex') and s.expires_at > now();
  return uid;
end $$;

create or replace function public.parl_cur_role() returns text
language sql stable security definer set search_path = '' as $$
  select membership from public.parl_users where id = public.parl_cur_id();
$$;

create or replace function public.parl_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.parl_cur_role() in ('admin','headadmin'), false);
$$;

-- ───────────────────────── row-level security ─────────────────────────
alter table public.parl_users          enable row level security;
alter table public.parl_sessions       enable row level security;
alter table public.parl_login_attempts enable row level security;
revoke all on public.parl_users, public.parl_sessions, public.parl_login_attempts from anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['parl_law','parl_votes','parl_members','parl_cabinet','parl_questions','parl_petitions','parl_agendas','parl_hansard']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to anon', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for all to anon using ((select public.parl_is_admin())) with check ((select public.parl_is_admin()))', t || '_write', t);
    if t <> 'parl_petitions' then
      execute format('drop policy if exists %I on public.%I', t || '_read', t);
      execute format('create policy %I on public.%I for select to anon using (true)', t || '_read', t);
    end if;
  end loop;
end $$;

-- Petitions: visitors see approved ones only; the signer list is never exposed to the browser.
drop policy if exists parl_petitions_read on public.parl_petitions;
create policy parl_petitions_read on public.parl_petitions for select to anon
  using (approval = 'Approved' or (select public.parl_is_admin()));
revoke select on public.parl_petitions from anon;
grant select (id, name, type, link, cur, goal, status, pronoun, presenter, approval) on public.parl_petitions to anon;

do $$
declare sq text;
begin
  for sq in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'S' and c.relname like 'parl\_%' loop
    execute format('grant usage on sequence public.%I to anon', sq);
  end loop;
end $$;

-- ───────────────────────── login / register ─────────────────────────
create or replace function public.parl_login(p_username text, p_password text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u public.parl_users; ok boolean := false; fails int; tok text; pw text;
begin
  p_username := trim(coalesce(p_username, '')); pw := trim(coalesce(p_password, ''));
  select count(*) into fails from public.parl_login_attempts
   where username = lower(p_username) and at > now() - interval '10 minutes';
  if fails >= 8 then
    return jsonb_build_object('ok', false, 'msg', 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอ 10 นาทีแล้วลองใหม่');
  end if;
  select * into u from public.parl_users where lower(username) = lower(p_username);
  if found then
    if u.password_hash like 'sha256:%' then
      -- password carried over from the old sheet; upgrade to bcrypt on first successful login
      ok := u.password_hash = 'sha256:' || encode(extensions.digest(pw, 'sha256'), 'hex');
      if ok then
        update public.parl_users set password_hash = extensions.crypt(pw, extensions.gen_salt('bf')) where id = u.id;
      end if;
    else
      ok := u.password_hash = extensions.crypt(pw, u.password_hash);
    end if;
  end if;
  if not ok then
    insert into public.parl_login_attempts(username) values (lower(p_username));
    return jsonb_build_object('ok', false, 'msg', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  end if;
  if u.membership = 'waiting' then
    return jsonb_build_object('ok', false, 'msg', 'บัญชีของคุณกำลังรอการอนุมัติจากผู้ดูแลระบบ');
  end if;
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.parl_sessions(token_hash, user_id, expires_at)
    values (encode(extensions.digest(tok, 'sha256'), 'hex'), u.id, now() + interval '30 days');
  return jsonb_build_object('ok', true, 'username', u.username, 'membership', u.membership,
                            'pronoun', u.pronoun, 'token', tok);
end $$;

create or replace function public.parl_me() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('ok', true, 'username', username, 'membership', membership, 'pronoun', pronoun)
                     from public.parl_users where id = public.parl_cur_id()),
                  jsonb_build_object('ok', false));
$$;

create or replace function public.parl_logout() returns void
language plpgsql security definer set search_path = '' as $$
declare t text;
begin
  t := nullif(nullif(current_setting('request.headers', true), '')::json ->> 'x-app-token', '');
  if t is not null then
    update public.parl_sessions set expires_at = now() where token_hash = encode(extensions.digest(t, 'sha256'), 'hex');
  end if;
end $$;

create or replace function public.parl_register(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uname text := trim(coalesce(p->>'username', '')); pw text := trim(coalesce(p->>'password', '')); lnk text := trim(coalesce(p->>'link', ''));
begin
  if uname = '' then return jsonb_build_object('ok', false, 'msg', 'กรุณากรอกชื่อผู้ใช้'); end if;
  if length(uname) > 60 or length(pw) > 200 or length(lnk) > 300 then return jsonb_build_object('ok', false, 'msg', 'ข้อมูลยาวเกินไป'); end if;
  if length(pw) < 6 then return jsonb_build_object('ok', false, 'msg', 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร'); end if;
  if position('roblox.com' in lnk) = 0 then return jsonb_build_object('ok', false, 'msg', 'กรุณาใส่ลิงก์โปรไฟล์ Roblox ที่ถูกต้อง (ต้องมีส่วนของ roblox.com)'); end if;
  if exists (select 1 from public.parl_users where lower(username) = lower(uname)) then
    return jsonb_build_object('ok', false, 'msg', 'ชื่อผู้ใช้นี้มีอยู่แล้วในระบบ');
  end if;
  insert into public.parl_users(pronoun, username, discord, password_hash, link, membership)
    values (trim(coalesce(p->>'pronoun', '')), uname, trim(coalesce(p->>'discord', '')),
            extensions.crypt(pw, extensions.gen_salt('bf')), lnk, 'waiting');
  return jsonb_build_object('ok', true);
end $$;

-- ───────────────────────── user administration ─────────────────────────
create or replace function public.parl_admin_list_users() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.parl_is_admin() then
    coalesce((select jsonb_agg(jsonb_build_object('rowIndex', id, 'pronoun', pronoun, 'username', username,
              'discord', discord, 'link', link, 'membership', membership, 'hasPass', true) order by id)
              from public.parl_users), '[]'::jsonb)
  else '[]'::jsonb end;
$$;

create or replace function public.parl_admin_pending() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.parl_is_admin() then
    coalesce((select jsonb_agg(jsonb_build_object('rowIndex', id, 'pronoun', pronoun, 'username', username,
              'discord', discord, 'link', link, 'membership', 'Waiting') order by id)
              from public.parl_users where membership = 'waiting'), '[]'::jsonb)
  else '[]'::jsonb end;
$$;

create or replace function public.parl_admin_set_role(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me bigint := public.parl_cur_id(); myrole text := public.parl_cur_role();
        t public.parl_users; newrole text := lower(coalesce(p->>'newMembership', ''));
begin
  if myrole not in ('admin','headadmin') then return jsonb_build_object('ok', false, 'msg', '❌ ไม่มีสิทธิ์ในการจัดการผู้ใช้'); end if;
  select * into t from public.parl_users where id = (p->>'rowIndex')::bigint;
  if not found then return jsonb_build_object('ok', false, 'msg', 'ไม่พบผู้ใช้'); end if;
  if t.id = me then return jsonb_build_object('ok', false, 'msg', '❌ คุณไม่สามารถเปลี่ยนสิทธิ์ของตัวเองได้ที่นี่'); end if;
  if newrole not in ('headadmin','admin','member','user','waiting') then return jsonb_build_object('ok', false, 'msg', '❌ บทบาทไม่ถูกต้อง'); end if;
  if myrole = 'headadmin' then
    if newrole = 'headadmin' then return jsonb_build_object('ok', false, 'msg', '❌ ห้ามเพิ่มผู้ใช้ใหม่เป็น HeadAdmin (ติดต่อเจ้าของระบบ)'); end if;
    if t.membership = 'headadmin' then return jsonb_build_object('ok', false, 'msg', '❌ ห้ามแก้ไขบัญชี HeadAdmin อื่น'); end if;
  else
    if newrole not in ('member','user') then return jsonb_build_object('ok', false, 'msg', '❌ Admin สามารถเปลี่ยนสิทธิ์ได้เฉพาะระหว่าง Member และ User เท่านั้น'); end if;
    if t.membership in ('admin','headadmin') then return jsonb_build_object('ok', false, 'msg', '❌ Admin ไม่สามารถแก้ไขบัญชีระดับสูง'); end if;
  end if;
  update public.parl_users set membership = newrole where id = t.id;
  update public.parl_sessions set expires_at = now() where user_id = t.id;   -- role changed: force a fresh login
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.parl_admin_reset_password(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me bigint := public.parl_cur_id(); myrole text := public.parl_cur_role();
        t public.parl_users; np text := coalesce(p->>'newPassword', '');
begin
  if myrole not in ('admin','headadmin') then return jsonb_build_object('ok', false, 'msg', '❌ ไม่มีสิทธิ์'); end if;
  select * into t from public.parl_users where id = (p->>'rowIndex')::bigint;
  if not found then return jsonb_build_object('ok', false, 'msg', 'ไม่พบผู้ใช้'); end if;
  if t.id = me then return jsonb_build_object('ok', false, 'msg', '❌ คุณไม่สามารถรีเซ็ตรหัสผ่านของตัวเองได้ที่นี่'); end if;
  if myrole = 'headadmin' and t.membership = 'headadmin' then return jsonb_build_object('ok', false, 'msg', '❌ ห้ามรีเซ็ตรหัสผ่านของ HeadAdmin อื่น'); end if;
  if myrole = 'admin' and t.membership in ('admin','headadmin') then return jsonb_build_object('ok', false, 'msg', '❌ Admin สามารถรีเซ็ตรหัสผ่านเฉพาะ Member และ User เท่านั้น'); end if;
  if length(np) < 4 then return jsonb_build_object('ok', false, 'msg', 'รหัสผ่านต้องยาวอย่างน้อย 4 ตัวอักษร'); end if;
  update public.parl_users set password_hash = extensions.crypt(np, extensions.gen_salt('bf')) where id = t.id;
  update public.parl_sessions set expires_at = now() where user_id = t.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.parl_admin_create_user(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare myrole text := public.parl_cur_role(); raw text := trim(coalesce(p->>'username', '')); clean text;
        role text := coalesce(p->>'membership', 'user'); pw text := coalesce(p->>'password', ''); pre text;
begin
  if myrole not in ('admin','headadmin') then return jsonb_build_object('ok', false, 'msg', '❌ สิทธิ์ไม่อนุญาต'); end if;
  if role not in ('headadmin','admin','member','user') then role := 'user'; end if;
  if role in ('admin','headadmin') and myrole <> 'headadmin' then return jsonb_build_object('ok', false, 'msg', '❌ สิทธิ์ไม่อนุญาต'); end if;
  clean := raw;
  foreach pre in array array['นางสาว','นาง','นาย','ดร.','ศาสตราจารย์','รองศาสตราจารย์','ผู้ช่วยศาสตราจารย์'] loop
    if left(raw, length(pre)) = pre then clean := trim(substr(raw, length(pre) + 1)); exit; end if;
  end loop;
  if clean = '' then return jsonb_build_object('ok', false, 'msg', '❌ ชื่อผู้ใช้ว่างเปล่า'); end if;
  if length(pw) < 4 then return jsonb_build_object('ok', false, 'msg', 'รหัสผ่านต้องยาวอย่างน้อย 4 ตัวอักษร'); end if;
  if exists (select 1 from public.parl_users where lower(username) = lower(clean)) then
    return jsonb_build_object('ok', false, 'msg', 'ชื่อผู้ใช้นี้มีอยู่แล้ว');
  end if;
  insert into public.parl_users(pronoun, username, password_hash, membership)
    values (trim(coalesce(p->>'pronoun', '')), clean, extensions.crypt(pw, extensions.gen_salt('bf')), role);
  return jsonb_build_object('ok', true);
end $$;

-- ───────────────────────── petitions ─────────────────────────
create or replace function public.parl_admin_waiting_petitions() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.parl_is_admin() then
    coalesce((select jsonb_agg(jsonb_build_object('rowIndex', id, 'name', name, 'type', type, 'link', link, 'cur', cur,
              'goal', goal, 'status', status, 'pronoun', pronoun, 'user', presenter, 'petitioners', petitioners) order by id)
              from public.parl_petitions where approval = 'Waiting'), '[]'::jsonb)
  else '[]'::jsonb end;
$$;

create or replace function public.parl_submit_petition(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare u public.parl_users; ttl text := trim(coalesce(p->>'title', ''));
begin
  select * into u from public.parl_users where id = public.parl_cur_id();
  if not found or u.membership <> 'user' then return 'DENIED'; end if;
  if ttl = '' or length(ttl) > 300 then return 'INVALID'; end if;
  insert into public.parl_petitions(name, type, link, cur, goal, status, pronoun, presenter, approval)
    values (ttl, left(coalesce(p->>'type', ''), 100), left(coalesce(p->>'link', ''), 500), 0, 15, 'เปิดให้ลงชื่อเสนอ', u.pronoun, u.username, 'Waiting');
  return 'OK';
end $$;

create or replace function public.parl_sign_petition(p_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare u public.parl_users; pt public.parl_petitions; lst text[];
begin
  select * into u from public.parl_users where id = public.parl_cur_id();
  if not found or u.membership <> 'user' then return 'DENIED'; end if;
  select * into pt from public.parl_petitions where trim(name) = trim(p_name) and approval = 'Approved' order by id limit 1 for update;
  if not found then return 'NOTFOUND'; end if;
  if pt.cur >= pt.goal then return 'CLOSED'; end if;
  lst := case when pt.petitioners = '' then '{}'::text[] else string_to_array(pt.petitioners, ',') end;
  if u.username = any(lst) then return 'DUP'; end if;
  update public.parl_petitions set cur = pt.cur + 1, petitioners = array_to_string(lst || u.username, ',') where id = pt.id;
  return 'OK';
end $$;

-- ───────────────────────── questions ─────────────────────────
create or replace function public.parl_submit_question(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u public.parl_users; ament text := ''; pa text := ''; arole text := ''; pw text := '';
        r record; lastpos text := ''; found_inc boolean := false;
        chambers text[] := array['สมาชิกสภาผู้แทนราษฎร','สมาชิกวุฒิสภา','สมาชิกสมัชชาแห่งชาติ'];
begin
  select * into u from public.parl_users where id = public.parl_cur_id();
  if not found or u.membership <> 'member' then return jsonb_build_object('ok', false, 'msg', 'เฉพาะสมาชิกรัฐสภาเท่านั้น'); end if;
  if trim(coalesce(p->>'toWho', '')) = '' or trim(coalesce(p->>'topic', '')) = '' or trim(coalesce(p->>'stories', '')) = '' then
    return jsonb_build_object('ok', false, 'msg', 'กรุณากรอกข้อมูลให้ครบ');
  end if;
  select ministry into ament from public.parl_cabinet
   where is_shadow and trim(name) = trim(u.username) and trim(ministry) <> '' and (trim(out_of_office) in ('', 'undefined'))
   order by id limit 1;
  ament := coalesce(ament, '');
  for r in select * from public.parl_members where trim(name) = trim(u.username) order by id loop
    if pa = '' then pa := trim(r.pronoun); end if;
    if exists (select 1 from unnest(chambers) c where position(c in r.position) > 0) then
      lastpos := trim(r.position);
      if not found_inc and trim(r.out_of_office) in ('', 'undefined') then arole := trim(r.position); found_inc := true; end if;
    end if;
  end loop;
  if not found_inc then arole := lastpos; end if;
  select trim(pronoun) into pw from public.parl_members where trim(name) = trim(p->>'toWho') order by id limit 1;
  insert into public.parl_questions(pronoun_asker, ask_name, a_role, a_ministry, pronoun_who, to_who, position, ministry, topic, stories, date, answer, a_date)
    values (pa, u.username, arole, ament, coalesce(pw, ''), trim(p->>'toWho'), coalesce(p->>'position', ''), coalesce(p->>'ministry', ''),
            trim(p->>'topic'), trim(p->>'stories'), coalesce(p->>'date', ''), '', '');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.parl_answer_question(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u public.parl_users; q public.parl_questions; ans text := trim(coalesce(p->>'answer', ''));
begin
  select * into u from public.parl_users where id = public.parl_cur_id();
  if not found or u.membership <> 'member' then return jsonb_build_object('ok', false, 'msg', 'เฉพาะสมาชิกรัฐสภาเท่านั้น'); end if;
  select * into q from public.parl_questions where id = (p->>'rowIndex')::bigint for update;
  if not found then return jsonb_build_object('ok', false, 'msg', 'ไม่พบกระทู้ถาม'); end if;
  if trim(q.to_who) <> trim(u.username) then return jsonb_build_object('ok', false, 'msg', 'กระทู้ถามนี้ไม่ได้ถามถึงคุณ'); end if;
  if trim(q.answer) <> '' then return jsonb_build_object('ok', false, 'msg', 'กระทู้ถามนี้มีคำตอบแล้ว'); end if;
  if ans = '' then return jsonb_build_object('ok', false, 'msg', 'กรุณากรอกคำตอบ'); end if;
  update public.parl_questions set answer = ans, a_date = coalesce(p->>'aDate', '') where id = q.id;
  return jsonb_build_object('ok', true);
end $$;

-- ───────────────────────── atomic "replace this vote record" (admin edit) ─────────────────────────

-- ───────────────────────── execute rights ─────────────────────────
-- Only touch our own functions (other apps in this project keep their existing rights).
revoke execute on function
  public.parl_cur_id(), public.parl_cur_role(), public.parl_is_admin(),
  public.parl_login(text, text), public.parl_me(), public.parl_logout(), public.parl_register(jsonb),
  public.parl_admin_list_users(), public.parl_admin_pending(), public.parl_admin_set_role(jsonb),
  public.parl_admin_reset_password(jsonb), public.parl_admin_create_user(jsonb),
  public.parl_admin_waiting_petitions(), public.parl_submit_petition(jsonb), public.parl_sign_petition(text),
  public.parl_submit_question(jsonb), public.parl_answer_question(jsonb)
from public;
grant execute on function
  public.parl_cur_id(), public.parl_cur_role(), public.parl_is_admin(),
  public.parl_login(text, text), public.parl_me(), public.parl_logout(), public.parl_register(jsonb),
  public.parl_admin_list_users(), public.parl_admin_pending(), public.parl_admin_set_role(jsonb),
  public.parl_admin_reset_password(jsonb), public.parl_admin_create_user(jsonb),
  public.parl_admin_waiting_petitions(), public.parl_submit_petition(jsonb), public.parl_sign_petition(text),
  public.parl_submit_question(jsonb), public.parl_answer_question(jsonb)
to anon;
