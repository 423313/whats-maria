-- ============================================================================
--  Sprint 1 — Versionamento do system_prompt da Flora
--
--  Cria tabela `agent_configs_history` que arquiva CADA versão do prompt
--  antes de uma alteração ser aplicada na tabela principal `agent_configs`.
--
--  Fluxo:
--    1. Trigger antes de UPDATE em agent_configs salva versão atual em history
--    2. Painel admin permite listar histórico e reverter pra qualquer versão
--
--  Como aplicar:
--    Supabase Dashboard → SQL Editor → cole tudo → Run
--    (idempotente — pode rodar várias vezes sem problema)
-- ============================================================================

-- Tabela de histórico
create table if not exists public.agent_configs_history (
  id bigserial primary key,
  agent_type text not null,
  system_prompt text not null,
  openai_model text,
  saved_at timestamptz not null default now(),
  saved_by text default 'admin',
  prompt_chars int generated always as (length(system_prompt)) stored,
  notes text
);

create index if not exists agent_configs_history_agent_type_saved_at_idx
  on public.agent_configs_history (agent_type, saved_at desc);

-- Função que arquiva a versão antiga em history antes de UPDATE
create or replace function public.archive_agent_config_on_update()
returns trigger
language plpgsql
as $func$
begin
  -- Só arquiva se o system_prompt realmente mudou
  if old.system_prompt is distinct from new.system_prompt then
    insert into public.agent_configs_history (
      agent_type, system_prompt, openai_model, saved_by, notes
    ) values (
      old.agent_type, old.system_prompt, old.openai_model, 'auto-trigger', null
    );
  end if;
  return new;
end;
$func$;

-- Trigger
drop trigger if exists agent_configs_archive_trigger on public.agent_configs;
create trigger agent_configs_archive_trigger
  before update on public.agent_configs
  for each row
  execute function public.archive_agent_config_on_update();

-- Snapshot da versão atual (caso ainda não tenha nenhum histórico)
insert into public.agent_configs_history (agent_type, system_prompt, openai_model, saved_by, notes)
select agent_type, system_prompt, openai_model, 'initial-snapshot', 'Snapshot tirado ao criar o histórico'
from public.agent_configs
where agent_type = 'default'
  and not exists (
    select 1 from public.agent_configs_history
    where agent_type = 'default'
  );

-- ============================================================================
--  Verificação:
--    select count(*) from public.agent_configs_history;
--    select agent_type, length(system_prompt), saved_at, saved_by
--    from public.agent_configs_history order by saved_at desc limit 5;
-- ============================================================================
