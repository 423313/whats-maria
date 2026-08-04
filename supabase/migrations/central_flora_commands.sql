-- Comandos aprovados no CRM, com idempotência persistente na Flora.

create table if not exists public.crm_commands (
  comando_id uuid primary key,
  crm_solicitacao_id uuid not null,
  session_id text not null,
  texto_hash text not null,
  status text not null default 'recebido' check (status in ('recebido', 'enviado', 'erro')),
  evolution_message_id text,
  tentativas integer not null default 0,
  ultimo_erro text,
  criado_em timestamptz not null default now(),
  enviado_em timestamptz
);

create index if not exists crm_commands_solicitacao_idx
  on public.crm_commands (crm_solicitacao_id, criado_em desc);

alter table public.crm_commands enable row level security;
revoke all on public.crm_commands from anon, authenticated;
grant select, insert, update on public.crm_commands to service_role;
