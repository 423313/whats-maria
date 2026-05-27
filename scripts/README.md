# scripts/

Scripts utilitários `.mjs` para operações pontuais (debug, manutenção, migrations, etc).
Tudo aqui são scripts standalone — não fazem parte do build de produção.

## Estrutura

```
scripts/
├── debug/           Diagnóstico e investigação de incidentes
├── maintenance/     Correções pontuais (fix/unblock)
├── migrations/      Migrations de schema executadas manualmente
├── prompt/          Gerenciamento do system_prompt do agente
├── notifications/   Disparos de notificação (Mariana, agendamentos)
└── supabase/        Operações específicas em tabelas Supabase
```

## Como rodar

Sempre rode da **raiz do projeto**:

```bash
node scripts/debug/diagnose-flora.mjs
node scripts/prompt/apply-prompt.mjs
node scripts/migrations/migrate-db.mjs
node scripts/supabase/verify-history.mjs
```

Todos os scripts agora usam o helper compartilhado `scripts/_lib/env.mjs`, que lê
o `.env` da raiz e exporta `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e um
factory `createSupabaseClient()` já configurado em modo service-role.

O único script que precisa de credencial extra é `scripts/migrations/migrate-db.mjs`,
que se conecta direto no Postgres via `SUPABASE_DB_URL` (também lida do `.env`).

## Onde colocar scripts novos

| Tipo do script | Pasta |
|---|---|
| Diagnosticar bug, ler dados pra entender problema | `debug/` |
| Corrigir registro travado, despausar sessão, limpar lixo | `maintenance/` |
| Aplicar mudança de schema (uma única vez) | `migrations/` |
| Mexer no system_prompt do agente | `prompt/` |
| Disparar notificação (WhatsApp, etc) | `notifications/` |
| Operação genérica em tabelas Supabase | `supabase/` |

## Nota de segurança

A versão anterior desses scripts tinha o `SUPABASE_SERVICE_ROLE_KEY` (e a senha do
Postgres) **hardcoded** no código. Tudo foi refatorado pra ler do `.env`.

⚠️ **Se o repo foi commitado em algum momento com as credenciais antigas**,
gire as chaves expostas:
- Service role: Supabase Dashboard → Settings → API → "Roll service_role secret"
- Senha do Postgres: Supabase Dashboard → Settings → Database → "Reset database password"
