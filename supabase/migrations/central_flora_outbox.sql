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
