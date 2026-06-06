-- ============================================================================
--  Multi-tenant Base — Fase 1.1 do plano de produto SaaS
--
--  Cria a estrutura básica de isolamento multi-tenant:
--    1. Tabela `tenants` (studios clientes)
--    2. Tabela `tenant_configs` (credenciais e config por tenant)
--    3. Tabela `tenant_professionals` (profissionais de cada studio)
--    4. Cria o tenant "studio-mariana-castro" como primeiro cliente
--    5. Adiciona `tenant_id` em TODAS as tabelas existentes
--    6. Faz backfill (todas as linhas existentes pertencem ao tenant da Mariana)
--    7. Aplica NOT NULL + FK + índices compostos
--
--  Como aplicar:
--    Supabase Dashboard → SQL Editor → cole tudo → Run
--    (idempotente — pode rodar várias vezes sem problema)
--
--  Segurança:
--    Operação compatível com produção. Não quebra a Flora porque:
--      - Tenant ID novo é adicionado como nullable, populado, depois NOT NULL.
--      - O código atual não usa tenant_id ainda — vai funcionar igual.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  1) Tabela tenants — cada studio cliente é um tenant
-- ----------------------------------------------------------------------------
create table if not exists public.tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  plan        text not null default 'starter' check (plan in ('starter','pro','premium','custom')),
  status      text not null default 'active' check (status in ('active','suspended','trial','canceled')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists tenants_touch on public.tenants;
create trigger tenants_touch
  before update on public.tenants
  for each row execute function public.touch_updated_at();

create index if not exists tenants_status_idx on public.tenants(status);

-- ----------------------------------------------------------------------------
--  2) Tabela tenant_configs — credenciais e configuração por tenant
--
--  Tudo que hoje está em env (.env do Pedro) e é específico de UM studio
--  vai morar aqui. O código vai migrar de `env.X` pra `tenantConfig.X`
--  em fases posteriores (1.3+).
--
--  Credenciais sensíveis (evolution_api_key, openai_api_key, google_*,
--  belasis_*) devem ser criptografadas no app antes de gravar (pgcrypto)
--  na Fase 3 (segurança production-ready). Por enquanto ficam em texto
--  porque só Pedro acessa via service_role.
-- ----------------------------------------------------------------------------
create table if not exists public.tenant_configs (
  tenant_id                   uuid primary key references public.tenants(id) on delete cascade,

  -- Identidade do studio/agente (exposto no prompt)
  studio_name                 text not null,
  agent_name                  text not null default 'Atendente',

  -- Evolution API (WhatsApp)
  evolution_url               text,
  evolution_api_key           text,
  evolution_instance          text,

  -- OpenAI
  openai_api_key              text,
  openai_model                text default 'gpt-4.1-mini',

  -- Notificações operacionais (dono do studio)
  notify_phone                text,
  review_notify_phone         text,

  -- Google Calendar
  google_calendar_id          text,
  google_service_account_key  text,
  google_oauth_refresh_token  text,

  -- Belasis (opcional por tenant)
  belasis_pinsession_token    text,
  belasis_employee_id         text,

  -- Painel admin
  admin_password_hash         text,

  -- Dados de negócio
  pix_key                     text,
  schedule_config             jsonb not null default '{}'::jsonb,  -- horários do studio por dia
  media_urls                  jsonb not null default '{}'::jsonb,  -- imagens (tabela preços, cards)
  features                    jsonb not null default '{}'::jsonb,  -- flags de features ativas

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

drop trigger if exists tenant_configs_touch on public.tenant_configs;
create trigger tenant_configs_touch
  before update on public.tenant_configs
  for each row execute function public.touch_updated_at();

-- Lookup reverso: webhook chega com `instance` e precisa achar o tenant
create unique index if not exists tenant_configs_evolution_instance_idx
  on public.tenant_configs (evolution_instance)
  where evolution_instance is not null;

-- ----------------------------------------------------------------------------
--  3) Tabela tenant_professionals — profissionais de cada studio
--
--  Substitui a duplicação Mariana/Scarlet que hoje está hardcoded em
--  src/services/agent.ts e src/services/calendar-availability.ts.
-- ----------------------------------------------------------------------------
create table if not exists public.tenant_professionals (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  name         text not null,
  specialties  text[] not null default '{}'::text[],
  schedule     jsonb not null default '{}'::jsonb,  -- horários por dia da semana
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists tenant_professionals_touch on public.tenant_professionals;
create trigger tenant_professionals_touch
  before update on public.tenant_professionals
  for each row execute function public.touch_updated_at();

create index if not exists tenant_professionals_tenant_active_idx
  on public.tenant_professionals(tenant_id, active);

-- ============================================================================
--  4) Cria o tenant inicial: "studio-mariana-castro"
-- ============================================================================
insert into public.tenants (slug, name, plan, status)
values ('studio-mariana-castro', 'Studio Mariana Castro', 'premium', 'active')
on conflict (slug) do nothing;

-- ----------------------------------------------------------------------------
--  4.1) Configuração do Studio Mariana (espelha o .env atual + dados do prompt)
-- ----------------------------------------------------------------------------
insert into public.tenant_configs (
  tenant_id,
  studio_name,
  agent_name,
  evolution_instance,
  notify_phone,
  pix_key,
  schedule_config,
  features
)
select
  t.id,
  'Studio Mariana Castro',
  'Flora',
  'agente',                       -- EVOLUTION_INSTANCE atual
  '554196137916',                 -- MARIANA_NOTIFY_PHONE atual
  '41998187167',                  -- chave Pix que está no prompt hoje
  jsonb_build_object(
    'monday',    jsonb_build_object('closed', true),
    'tuesday',   jsonb_build_object('open', '09:00', 'close', '16:00', 'slots', jsonb_build_array('09:00','11:00','13:00','15:00')),
    'wednesday', jsonb_build_object('open', '09:00', 'close', '16:00', 'slots', jsonb_build_array('09:00','11:00','13:00','15:00')),
    'thursday',  jsonb_build_object('open', '09:00', 'close', '16:00', 'slots', jsonb_build_array('09:00','11:00','13:00','15:00')),
    'friday',    jsonb_build_object('open', '09:00', 'close', '16:00', 'slots', jsonb_build_array('09:00','11:00','13:00','15:00')),
    'saturday',  jsonb_build_object('open', '08:00', 'close', '12:00', 'slots', jsonb_build_array('08:00','10:00')),
    'sunday',    jsonb_build_object('closed', true)
  ),
  jsonb_build_object(
    'google_calendar', true,
    'belasis_sync',    true,
    'weekly_review',   true,
    'follow_up',       true
  )
from public.tenants t
where t.slug = 'studio-mariana-castro'
on conflict (tenant_id) do nothing;

-- ----------------------------------------------------------------------------
--  4.2) Profissionais do Studio Mariana
-- ----------------------------------------------------------------------------
insert into public.tenant_professionals (tenant_id, name, specialties, schedule, active)
select
  t.id,
  'Mariana',
  array['unhas']::text[],
  jsonb_build_object(
    'tuesday',   jsonb_build_object('start', '09:00', 'end', '16:00'),
    'wednesday', jsonb_build_object('start', '09:00', 'end', '16:00'),
    'thursday',  jsonb_build_object('start', '09:00', 'end', '16:00'),
    'friday',    jsonb_build_object('start', '09:00', 'end', '16:00'),
    'saturday',  jsonb_build_object('start', '08:00', 'end', '12:00')
  ),
  true
from public.tenants t
where t.slug = 'studio-mariana-castro'
  and not exists (
    select 1 from public.tenant_professionals tp
    where tp.tenant_id = t.id and tp.name = 'Mariana'
  );

insert into public.tenant_professionals (tenant_id, name, specialties, schedule, active)
select
  t.id,
  'Scarlet',
  array['sobrancelhas','cilios']::text[],
  jsonb_build_object(
    'thursday',  jsonb_build_object('start', '13:30', 'end', '21:00'),
    'saturday',  jsonb_build_object('start', '08:00', 'end', '18:00')
  ),
  true
from public.tenants t
where t.slug = 'studio-mariana-castro'
  and not exists (
    select 1 from public.tenant_professionals tp
    where tp.tenant_id = t.id and tp.name = 'Scarlet'
  );

-- ============================================================================
--  5) Adiciona tenant_id em todas as tabelas existentes
--     (nullable temporariamente pra permitir backfill antes de NOT NULL)
-- ============================================================================
alter table public.agent_configs         add column if not exists tenant_id uuid references public.tenants(id);
alter table public.chat_messages         add column if not exists tenant_id uuid references public.tenants(id);
alter table public.chat_control          add column if not exists tenant_id uuid references public.tenants(id);
alter table public.message_buffer        add column if not exists tenant_id uuid references public.tenants(id);
alter table public.pending_actions       add column if not exists tenant_id uuid references public.tenants(id);
alter table public.weekly_reviews        add column if not exists tenant_id uuid references public.tenants(id);
alter table public.agent_configs_history add column if not exists tenant_id uuid references public.tenants(id);

-- ============================================================================
--  6) Backfill: tudo que existe hoje pertence ao tenant da Mariana
-- ============================================================================
do $$
declare
  v_mariana_id uuid;
begin
  select id into v_mariana_id from public.tenants where slug = 'studio-mariana-castro';

  if v_mariana_id is null then
    raise exception 'Tenant studio-mariana-castro não foi criado — aborta backfill';
  end if;

  update public.agent_configs         set tenant_id = v_mariana_id where tenant_id is null;
  update public.chat_messages         set tenant_id = v_mariana_id where tenant_id is null;
  update public.chat_control          set tenant_id = v_mariana_id where tenant_id is null;
  update public.message_buffer        set tenant_id = v_mariana_id where tenant_id is null;
  update public.pending_actions       set tenant_id = v_mariana_id where tenant_id is null;
  update public.weekly_reviews        set tenant_id = v_mariana_id where tenant_id is null;
  update public.agent_configs_history set tenant_id = v_mariana_id where tenant_id is null;
end $$;

-- ============================================================================
--  7) Aplica NOT NULL em tenant_id (todas as tabelas)
--     Só roda se a coluna ainda for nullable (idempotência).
-- ============================================================================
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='agent_configs'
               and column_name='tenant_id' and is_nullable='YES') then
    alter table public.agent_configs alter column tenant_id set not null;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='chat_messages'
               and column_name='tenant_id' and is_nullable='YES') then
    alter table public.chat_messages alter column tenant_id set not null;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='chat_control'
               and column_name='tenant_id' and is_nullable='YES') then
    alter table public.chat_control alter column tenant_id set not null;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='message_buffer'
               and column_name='tenant_id' and is_nullable='YES') then
    alter table public.message_buffer alter column tenant_id set not null;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='pending_actions'
               and column_name='tenant_id' and is_nullable='YES') then
    alter table public.pending_actions alter column tenant_id set not null;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='weekly_reviews'
               and column_name='tenant_id' and is_nullable='YES') then
    alter table public.weekly_reviews alter column tenant_id set not null;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='agent_configs_history'
               and column_name='tenant_id' and is_nullable='YES') then
    alter table public.agent_configs_history alter column tenant_id set not null;
  end if;
end $$;

-- ============================================================================
--  8) Índices compostos para queries por tenant
-- ============================================================================
create index if not exists chat_messages_tenant_session_created_idx
  on public.chat_messages (tenant_id, session_id, created_at desc);

create index if not exists chat_control_tenant_idx
  on public.chat_control (tenant_id);

create index if not exists message_buffer_tenant_session_idx
  on public.message_buffer (tenant_id, session_id, created_at)
  where processed_at is null;

create index if not exists pending_actions_tenant_status_idx
  on public.pending_actions (tenant_id, status, created_at desc);

create index if not exists weekly_reviews_tenant_idx
  on public.weekly_reviews (tenant_id, week_start desc);

create index if not exists agent_configs_history_tenant_idx
  on public.agent_configs_history (tenant_id, saved_at desc);

-- ============================================================================
--  9) RLS — habilita nas novas tabelas (mantemos service_role bypass por enquanto)
-- ============================================================================
alter table public.tenants              enable row level security;
alter table public.tenant_configs       enable row level security;
alter table public.tenant_professionals enable row level security;

-- ============================================================================
--  Verificação
--    select slug, name, plan, status from public.tenants;
--    select tenant_id, studio_name, agent_name, evolution_instance, notify_phone
--      from public.tenant_configs;
--    select name, specialties, active from public.tenant_professionals;
--
--    -- Confere backfill (todas devem retornar 0):
--    select 'agent_configs'         as t, count(*) from public.agent_configs         where tenant_id is null
--    union all select 'chat_messages',          count(*) from public.chat_messages         where tenant_id is null
--    union all select 'chat_control',           count(*) from public.chat_control          where tenant_id is null
--    union all select 'message_buffer',         count(*) from public.message_buffer        where tenant_id is null
--    union all select 'pending_actions',        count(*) from public.pending_actions       where tenant_id is null
--    union all select 'weekly_reviews',         count(*) from public.weekly_reviews        where tenant_id is null
--    union all select 'agent_configs_history',  count(*) from public.agent_configs_history where tenant_id is null;
-- ============================================================================
