-- TaskForce Agenda: gedeelde agenda (alle tabellen beginnen met tfa_, zodat ze niet botsen met andere apps in hetzelfde project)
-- Plak dit hele script in Supabase → SQL Editor → New query → Run.
-- Het script kan veilig opnieuw worden uitgevoerd.

-- ============ Tabellen ============
create table if not exists public.tfa_spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  invite_code text not null unique default replace(gen_random_uuid()::text, '-', ''),
  created_by uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.tfa_members (
  space_id uuid not null references public.tfa_spaces on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  joined_at timestamptz not null default now(),
  primary key (space_id, user_id)
);
-- Eigen kleur per persoon: de maker rood, de eerste genodigde blauw, daarna de volgende vrije kleur
alter table public.tfa_members add column if not exists color text not null default 'blue'
  check (color in ('red', 'blue', 'amber', 'violet', 'teal', 'pink'));

create table if not exists public.tfa_tasks (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.tfa_spaces on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  date date,
  days smallint[] not null default '{}' check (days <@ array[0,1,2,3,4,5,6]::smallint[]),
  time text check (time is null or time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  notify boolean not null default true,
  lead smallint not null default 0 check (lead in (0, 5, 10, 15, 30, 60)),
  from_date date,
  assignee uuid references auth.users on delete set null,
  created_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now(),
  check (date is not null or cardinality(days) > 0)
);
create index if not exists tasks_space_idx on public.tfa_tasks (space_id);

create table if not exists public.tfa_done (
  task_id uuid not null references public.tfa_tasks on delete cascade,
  day date not null,
  space_id uuid not null references public.tfa_spaces on delete cascade,
  done_by uuid default auth.uid() references auth.users on delete set null,
  primary key (task_id, day)
);
create index if not exists task_done_space_idx on public.tfa_done (space_id, day);

create table if not exists public.tfa_skip (
  task_id uuid not null references public.tfa_tasks on delete cascade,
  day date not null,
  space_id uuid not null references public.tfa_spaces on delete cascade,
  primary key (task_id, day)
);
create index if not exists task_skip_space_idx on public.tfa_skip (space_id, day);

create table if not exists public.tfa_push_subs (
  endpoint text primary key check (endpoint ~ '^https://'),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  space_id uuid not null references public.tfa_spaces on delete cascade,
  p256dh text not null,
  auth text not null,
  device text,
  created_at timestamptz not null default now()
);

-- Alleen voor de meldingen-Action (geen toegang vanuit de app)
create table if not exists public.tfa_sent (
  task_id uuid not null references public.tfa_tasks on delete cascade,
  day date not null,
  sent_at timestamptz not null default now(),
  primary key (task_id, day)
);

-- ============ Hulpfuncties ============
create or replace function public.tfa_is_member(s uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tfa_members where space_id = s and user_id = auth.uid());
$$;

create or replace function public.tfa_task_in_space(t uuid, s uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tfa_tasks where id = t and space_id = s);
$$;

create or replace function public.tfa_is_member_of(s uuid, u uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tfa_members where space_id = s and user_id = u);
$$;

-- ============ Beveiliging (Row Level Security) ============
alter table public.tfa_spaces    enable row level security;
alter table public.tfa_members   enable row level security;
alter table public.tfa_tasks     enable row level security;
alter table public.tfa_done enable row level security;
alter table public.tfa_skip enable row level security;
alter table public.tfa_push_subs enable row level security;
alter table public.tfa_sent      enable row level security;   -- geen policies: alleen de service-sleutel

drop policy if exists "leden lezen agenda" on public.tfa_spaces;
create policy "leden lezen agenda" on public.tfa_spaces for select to authenticated using (public.tfa_is_member(id));
drop policy if exists "leden hernoemen agenda" on public.tfa_spaces;
create policy "leden hernoemen agenda" on public.tfa_spaces for update to authenticated using (public.tfa_is_member(id)) with check (public.tfa_is_member(id));

drop policy if exists "leden zien elkaar" on public.tfa_members;
create policy "leden zien elkaar" on public.tfa_members for select to authenticated using (public.tfa_is_member(space_id));
drop policy if exists "eigen naam wijzigen" on public.tfa_members;
create policy "eigen naam wijzigen" on public.tfa_members for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "vertrekken of verwijderen" on public.tfa_members;
create policy "vertrekken of verwijderen" on public.tfa_members for delete to authenticated using (
  user_id = auth.uid() or exists (select 1 from public.tfa_spaces s where s.id = space_id and s.created_by = auth.uid())
);

drop policy if exists "leden beheren taken" on public.tfa_tasks;
create policy "leden beheren taken" on public.tfa_tasks for all to authenticated
  using (public.tfa_is_member(space_id))
  with check (public.tfa_is_member(space_id) and (assignee is null or public.tfa_is_member_of(space_id, assignee)));

drop policy if exists "leden vinken af" on public.tfa_done;
create policy "leden vinken af" on public.tfa_done for all to authenticated
  using (public.tfa_is_member(space_id))
  with check (public.tfa_is_member(space_id) and public.tfa_task_in_space(task_id, space_id));

drop policy if exists "leden slaan over" on public.tfa_skip;
create policy "leden slaan over" on public.tfa_skip for all to authenticated
  using (public.tfa_is_member(space_id))
  with check (public.tfa_is_member(space_id) and public.tfa_task_in_space(task_id, space_id));

drop policy if exists "eigen toestellen" on public.tfa_push_subs;
create policy "eigen toestellen" on public.tfa_push_subs for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.tfa_is_member(space_id));

-- ============ Acties (aanmaken, uitnodigen, deelnemen) ============
create or replace function public.tfa_create_space(space_name text, my_name text)
returns public.tfa_spaces language plpgsql security definer set search_path = '' as $$
declare s public.tfa_spaces;
begin
  if auth.uid() is null then raise exception 'Niet ingelogd'; end if;
  if (select count(*) from public.tfa_spaces where created_by = auth.uid()) >= 5 then raise exception 'Te veel agenda''s'; end if;
  insert into public.tfa_spaces (name, created_by) values (left(trim(space_name), 60), auth.uid()) returning * into s;
  insert into public.tfa_members (space_id, user_id, name, color) values (s.id, auth.uid(), left(trim(my_name), 40), 'red');
  return s;
end $$;

create or replace function public.tfa_invite_info(code text)
returns table (space_name text, inviter text) language sql stable security definer set search_path = '' as $$
  select s.name, m.name from public.tfa_spaces s
  left join public.tfa_members m on m.space_id = s.id and m.user_id = s.created_by
  where s.invite_code = code;
$$;

create or replace function public.tfa_join_space(code text, my_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare sid uuid; c text;
begin
  if auth.uid() is null then raise exception 'Niet ingelogd'; end if;
  select id into sid from public.tfa_spaces where invite_code = code;
  if sid is null then raise exception 'Deze uitnodiging is niet (meer) geldig'; end if;
  if (select count(*) from public.tfa_members where space_id = sid) >= 12 then raise exception 'Deze agenda zit vol'; end if;
  select x into c from unnest(array['blue', 'amber', 'violet', 'teal', 'pink', 'red']) with ordinality as a(x, i)
   where x not in (select color from public.tfa_members where space_id = sid) order by i limit 1;
  insert into public.tfa_members (space_id, user_id, name, color) values (sid, auth.uid(), left(trim(my_name), 40), coalesce(c, 'blue'))
  on conflict (space_id, user_id) do update set name = excluded.name;
  return sid;
end $$;

create or replace function public.tfa_new_invite(s uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare c text;
begin
  if not public.tfa_is_member(s) then raise exception 'Geen toegang'; end if;
  update public.tfa_spaces set invite_code = replace(gen_random_uuid()::text, '-', '') where id = s returning invite_code into c;
  return c;
end $$;

revoke execute on function public.tfa_create_space(text, text), public.tfa_invite_info(text), public.tfa_join_space(text, text), public.tfa_new_invite(uuid),
  public.tfa_is_member(uuid), public.tfa_is_member_of(uuid, uuid), public.tfa_task_in_space(uuid, uuid) from public, anon;
grant execute on function public.tfa_create_space(text, text), public.tfa_invite_info(text), public.tfa_join_space(text, text), public.tfa_new_invite(uuid),
  public.tfa_is_member(uuid), public.tfa_is_member_of(uuid, uuid), public.tfa_task_in_space(uuid, uuid) to authenticated;

-- ============ Live bijwerken ============
do $$
declare t text;
begin
  foreach t in array array['tfa_tasks', 'tfa_done', 'tfa_skip', 'tfa_members'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
