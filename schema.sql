-- =====================================================================
--  تطبيق البوفية — قاعدة البيانات (Supabase / PostgreSQL)
--  طريقة التشغيل: Supabase → SQL Editor → New query → الصق الملف كاملاً → Run
--  آمن لإعادة التشغيل (لا يحذف بيانات موجودة)
-- =====================================================================

-- ---------- 1) المستخدمون (ملف تعريفي مرتبط بحسابات الدخول) ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  role        text not null default 'member' check (role in ('admin','member')),
  created_at  timestamptz not null default now()
);

-- إنشاء ملف تعريفي تلقائياً عند إضافة مستخدم من لوحة Supabase
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    -- أول مستخدم يُضاف يصبح مديراً تلقائياً
    case when not exists (select 1 from public.profiles) then 'admin' else 'member' end
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- لمستخدمين أُضيفوا قبل تشغيل هذا الملف
insert into public.profiles (id, full_name, role)
select u.id, split_part(u.email,'@',1),
       case when row_number() over (order by u.created_at) = 1
             and not exists (select 1 from public.profiles) then 'admin' else 'member' end
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- صلاحيات المستخدم (المدير يملك كل شيء تلقائياً)
-- المستخدم الجديد يبدأ «اطلاع فقط» للأمان، ويفعّل المدير صلاحياته من شاشة المستخدمين
alter table public.profiles add column if not exists can_add         boolean not null default false;
alter table public.profiles add column if not exists can_edit        boolean not null default false;
alter table public.profiles add column if not exists can_delete      boolean not null default false;
alter table public.profiles add column if not exists can_manage_cats boolean not null default false;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.has_perm(p text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and (role = 'admin'
        or (p = 'add'    and can_add)
        or (p = 'edit'   and can_edit)
        or (p = 'delete' and can_delete)
        or (p = 'cats'   and can_manage_cats)));
$$;

-- ---------- 2) البنود ----------
create table if not exists public.categories (
  id          bigint generated always as identity primary key,
  name        text not null,
  kind        text not null check (kind in ('income','expense','account')),
  active      boolean not null default true,
  sort        int not null default 100,
  created_at  timestamptz not null default now()
);

insert into public.categories (name, kind, sort)
select v.name, v.kind, v.sort from (values
  ('مبيعات البوفية','income',1),
  ('خبز','expense',10),
  ('مياه','expense',20),
  ('معلبات','expense',30),
  ('أجبان','expense',40),
  ('خضروات وفواكه','expense',50),
  ('مشروبات','expense',60),
  ('أخرى','expense',90)
) as v(name,kind,sort)
where not exists (select 1 from public.categories);

-- ---------- 3) حركات النقدية ----------
--  sale        بيع           (+)
--  expense     صرف           (−)
--  withdrawal  سحب من النقدية (−)
--  adj_plus    تسوية بالزيادة (+)
--  adj_minus   تسوية بالنقص   (−)
--  opening     رصيد افتتاحي   (+)
create table if not exists public.transactions (
  id           bigint generated always as identity primary key,
  tx_date      date not null default current_date,
  tx_type      text not null check (tx_type in ('sale','expense','withdrawal','adj_plus','adj_minus','opening','receipt')),
  category_id  bigint references public.categories(id) on delete restrict,
  amount       numeric(12,2) not null check (amount > 0),
  note         text not null default '',
  created_by   uuid not null default auth.uid() references public.profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists transactions_date_idx on public.transactions (tx_date);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_tx_touch on public.transactions;
create trigger trg_tx_touch before update on public.transactions
  for each row execute function public.touch_updated_at();

-- ---------- 4) الصلاحيات (RLS) ----------
alter table public.profiles     enable row level security;
alter table public.categories   enable row level security;
alter table public.transactions enable row level security;

-- profiles: الجميع يقرأ — المدير يعدّل — المستخدم يعدّل اسمه فقط
drop policy if exists p_profiles_read  on public.profiles;
drop policy if exists p_profiles_admin on public.profiles;
drop policy if exists p_profiles_self  on public.profiles;
create policy p_profiles_read  on public.profiles for select to authenticated using (true);
create policy p_profiles_admin on public.profiles for update to authenticated using (public.is_admin()) with check (true);
-- المستخدم يعدّل اسمه فقط (لا يستطيع رفع صلاحياته)
create policy p_profiles_self  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and (role, can_add, can_edit, can_delete, can_manage_cats) =
    (select p.role, p.can_add, p.can_edit, p.can_delete, p.can_manage_cats from public.profiles p where p.id = auth.uid()));

-- categories: الجميع يقرأ — الإدارة لمن لديه صلاحية "إدارة البنود"
drop policy if exists p_cat_read  on public.categories;
drop policy if exists p_cat_write on public.categories;
create policy p_cat_read  on public.categories for select to authenticated using (true);
create policy p_cat_write on public.categories for all    to authenticated using (public.has_perm('cats')) with check (public.has_perm('cats'));

-- transactions: الجميع يقرأ — الإضافة/التعديل/الحذف حسب صلاحيات كل مستخدم
drop policy if exists p_tx_read   on public.transactions;
drop policy if exists p_tx_insert on public.transactions;
drop policy if exists p_tx_update on public.transactions;
drop policy if exists p_tx_delete on public.transactions;
create policy p_tx_read   on public.transactions for select to authenticated using (true);
create policy p_tx_insert on public.transactions for insert to authenticated
  with check (created_by = auth.uid() and public.has_perm('add'));
create policy p_tx_update on public.transactions for update to authenticated
  using (public.has_perm('edit')) with check (public.has_perm('edit'));
create policy p_tx_delete on public.transactions for delete to authenticated
  using (public.has_perm('delete'));

-- تحديث لحظي لقائمة المستخدمين أيضاً (عند تغيير الصلاحيات)
do $$ begin
  begin alter publication supabase_realtime add table public.profiles; exception when others then null; end;
end $$;

-- ---------- 5) التحديث اللحظي بين الأجهزة ----------
do $$ begin
  begin alter publication supabase_realtime add table public.transactions; exception when others then null; end;
  begin alter publication supabase_realtime add table public.categories;   exception when others then null; end;
end $$;

-- =====================================================================
--  أوامر مفيدة لاحقاً:
--  جعل مستخدم مديراً:
--    update public.profiles set role='admin'  where id=(select id from auth.users where email='x@mail.com');
--  الصلاحيات التفصيلية (إضافة/تعديل/حذف/البنود) تُدار من داخل التطبيق:
--    الإعدادات ← المستخدمون (للمدير)
-- =====================================================================
