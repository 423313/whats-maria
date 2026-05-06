-- ============================================================================
--  Template Agente IA WhatsApp — Schema Supabase
--  Rode este arquivo UMA VEZ no seu projeto Supabase (via MCP ou SQL Editor).
--  Depois rode `seed.sql` pra inserir a configuração inicial do agente.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  Extensões
-- ----------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ============================================================================
--  1) agent_configs — configuração do agente (prompt, modelo, timings)
-- ============================================================================
create table if not exists public.agent_configs (
  agent_type              text primary key,
  enabled                 boolean not null default true,
  openai_api_key          text,
  openai_model            text not null default 'gpt-4.1-mini',
  gemini_api_key          text,
  system_prompt           text not null,
  debounce_ms             integer not null default 15000,
  typing_ms               integer not null default 1000,
  inter_message_delay_ms  integer not null default 1000,
  history_limit           integer not null default 30,
  max_output_messages     integer not null default 5,
  updated_at              timestamptz not null default now()
);

-- Atualiza updated_at automaticamente em UPDATE
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists agent_configs_touch on public.agent_configs;
create trigger agent_configs_touch
  before update on public.agent_configs
  for each row execute function public.touch_updated_at();

-- ============================================================================
--  2) chat_messages — histórico de mensagens
-- ============================================================================
create table if not exists public.chat_messages (
  id                    uuid primary key default gen_random_uuid(),
  session_id            text not null,
  instance              text not null,
  role                  text not null check (role in ('user','assistant','system','tool')),
  content               text not null,
  media_type            text,
  transcription         text,
  evolution_message_id  text,
  status                text default 'received',
  model                 text,
  tokens_in             integer,
  tokens_out            integer,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

create index if not exists chat_messages_session_created_idx
  on public.chat_messages (session_id, created_at desc);

create index if not exists chat_messages_pending_assistant_idx
  on public.chat_messages (status, created_at)
  where role = 'assistant' and status = 'pending';

-- Evita duplicação de mensagens idempotentes por ID da Evolution
create unique index if not exists chat_messages_evolution_unique_idx
  on public.chat_messages (evolution_message_id)
  where evolution_message_id is not null;

-- ============================================================================
--  3) chat_control — controle de agente ativo / pause de IA por sessão
-- ============================================================================
create table if not exists public.chat_control (
  session_id   text primary key,
  instance     text not null,
  agent_type   text not null default 'default',
  ai_paused    boolean not null default false,
  paused_at    timestamptz,
  paused_by    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists chat_control_touch on public.chat_control;
create trigger chat_control_touch
  before update on public.chat_control
  for each row execute function public.touch_updated_at();

-- ============================================================================
--  4) message_buffer — buffer de mensagens curtas (debounce)
-- ============================================================================
create table if not exists public.message_buffer (
  id                    uuid primary key default gen_random_uuid(),
  session_id            text not null,
  instance              text not null,
  lead_phone            text not null,
  mensagem              text not null,
  evolution_message_id  text,
  media_type            text,
  media_url             text,
  transcription         text,
  processed_at          timestamptz,
  created_at            timestamptz not null default now()
);

create index if not exists message_buffer_session_pending_idx
  on public.message_buffer (session_id, created_at)
  where processed_at is null;

create unique index if not exists message_buffer_evolution_unique_idx
  on public.message_buffer (evolution_message_id)
  where evolution_message_id is not null;

-- ============================================================================
--  5) RPC is_ai_paused — checa se a IA está pausada pra uma sessão
--     (usado pra permitir que atendente humano assuma manualmente)
-- ============================================================================
create or replace function public.is_ai_paused(p_session_id text)
returns boolean
language sql
stable
as $$
  select coalesce(
    (select ai_paused from public.chat_control where session_id = p_session_id),
    false
  );
$$;

-- ============================================================================
--  Permissões: a app usa SERVICE_ROLE_KEY, que bypassa RLS.
--  RLS fica desativada nessas tabelas porque o acesso é SEMPRE via service role.
--  Se você for expor anon/authenticated, ative RLS e escreva policies.
-- ============================================================================
alter table public.agent_configs    enable row level security;
alter table public.chat_messages    enable row level security;
alter table public.chat_control     enable row level security;
alter table public.message_buffer   enable row level security;

-- Policies mínimas: service_role já bypassa, então ficamos sem policy pros
-- roles anon/authenticated (bloqueio total por padrão).
