-- OPTIONAL. Run by hand in the Supabase SQL editor (the assistant's tool refuses statements containing DELETE).
-- Enables "delete user" in the admin tab.

create or replace function public.parl_admin_delete_user(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me bigint := public.parl_cur_id(); myrole text := public.parl_cur_role(); t public.parl_users;
begin
  if myrole not in ('admin','headadmin') then return jsonb_build_object('ok', false, 'msg', '❌ ไม่มีสิทธิ์ลบผู้ใช้'); end if;
  select * into t from public.parl_users where id = (p->>'rowIndex')::bigint;
  if not found then return jsonb_build_object('ok', false, 'msg', 'ไม่พบผู้ใช้'); end if;
  if t.id = me then return jsonb_build_object('ok', false, 'msg', '❌ คุณไม่สามารถลบบัญชีตัวเองได้'); end if;
  if t.membership = 'headadmin' then return jsonb_build_object('ok', false, 'msg', '❌ ห้ามลบบัญชี HeadAdmin อื่น'); end if;
  if myrole = 'admin' and t.membership = 'admin' then return jsonb_build_object('ok', false, 'msg', '❌ Admin ไม่สามารถลบ HeadAdmin หรือ Admin ได้'); end if;
  delete from public.parl_users where id = t.id;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.parl_admin_delete_user(jsonb) from public;
grant execute on function public.parl_admin_delete_user(jsonb) to anon;
