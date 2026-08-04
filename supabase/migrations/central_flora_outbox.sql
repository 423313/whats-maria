create table if not exists public.crm_request_outbox (
  evento_id uuid primary key default gen_random_uuid(),
  assunto_chave text,
  pending_action_id uuid references public.pending_actions(id),
  payload jsonb not null,
  status text not null default 'pendente' check (status in ('pendente','entregue','erro_permanente')),
  crm_solicitacao_id uuid,
  tentativas integer not null default 0,
  proxima_tentativa_em timestamptz not null default now(),
  ultimo_erro text,
  criada_em timestamptz not null default now(),
  entregue_em timestamptz
);
create index crm_request_outbox_retry_idx on public.crm_request_outbox (proxima_tentativa_em) where status = 'pendente';
with pending_subject_duplicates as (
  select
    evento_id,
    row_number() over (
      partition by assunto_chave
      order by criada_em asc, evento_id asc
    ) as duplicate_rank
  from public.crm_request_outbox
  where status = 'pendente'
    and assunto_chave is not null
)
update public.crm_request_outbox as outbox
set
  status = 'erro_permanente',
  ultimo_erro = 'Deduplicacao preventiva: pendencia duplicada por assunto_chave.'
from pending_subject_duplicates
where outbox.evento_id = pending_subject_duplicates.evento_id
  and pending_subject_duplicates.duplicate_rank > 1;
create unique index if not exists crm_request_outbox_pending_subject_idx
  on public.crm_request_outbox (assunto_chave)
  where status = 'pendente' and assunto_chave is not null;
alter table public.crm_request_outbox
  add column if not exists claim_token uuid,
  add column if not exists claim_until timestamptz;
create index if not exists crm_request_outbox_claim_idx
  on public.crm_request_outbox (claim_until) where status = 'pendente';
