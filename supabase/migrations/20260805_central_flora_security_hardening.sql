-- Hardening de tabelas legadas usadas somente pelo servidor da Flora.
-- O runtime usa SUPABASE_SERVICE_ROLE_KEY, que continua bypassando RLS.
alter table if exists public.pending_actions enable row level security;
alter table if exists public.weekly_reviews enable row level security;

revoke all on table public.pending_actions from anon, authenticated;
revoke all on table public.weekly_reviews from anon, authenticated;

-- Reaplica explicitamente o isolamento da outbox para evitar drift em rebuilds.
alter table if exists public.crm_request_outbox enable row level security;
revoke all on table public.crm_request_outbox from anon, authenticated;
