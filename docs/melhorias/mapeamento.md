# Mapeamento de melhorias, ajustes e gaps — Projeto Flora

> Gerado em 2026-06-06 a partir de análise profunda de todo o código (~5.300 linhas TS, schema SQL, painel admin, testes).
> Objetivo do produto: transformar a Flora (agente do Studio Mariana Castro) em SaaS multi-tenant para studios beauty.
> Plano mestre: `~/.claude/plans/snazzy-snuggling-lemur.md`.

---

## Resumo executivo

O código funciona em produção e está bem documentado, mas tem **dois eixos de problema**:

1. **Dívida técnica de qualidade** (existe independentemente do SaaS): bugs de concorrência, código morto, fuso horário frágil, falhas silenciosas, falta de testes nos invariantes críticos.
2. **Bloqueio estrutural pro multi-tenant**: o código está ~72% acoplado ao Studio Mariana. A migração SQL (`multitenant_base.sql`) criou as tabelas, mas é **só metade do trabalho** — o código não usa `tenant_id`, as PKs continuam globais, e o isolamento entre clientes ainda não existe. Há risco real de **vazamento de dados entre tenants** no dia em que entrar o 2º cliente.

**Veredito:** antes de aceitar o 2º tenant, há um conjunto de bloqueadores que, se ignorados, causam vazamento de PII entre clientes e quebras de runtime.

---

## CRÍTICOS — resolver antes de qualquer escala

| # | Achado | Local | Impacto |
|---|---|---|---|
| C1 | Senha admin `studio2024` em texto plano no CLAUDE.md versionado; é Bearer permanente, sem expiração/rotação | `CLAUDE.md`, `admin.ts:35-40,61-67` | Acesso vitalício a TODAS as conversas/PII de TODOS os clientes |
| C2 | `checkAuth` faz **fail-open**: se `ADMIN_PASSWORD` ausente, painel fica 100% aberto | `admin.ts:36` | Painel anônimo em deploy mal provisionado |
| C3 | App inteiro usa `service_role` (bypassa RLS). Isolamento depende 100% do código lembrar de filtrar `tenant_id` | `supabase.ts:4-16` | Um `select` esquecido vaza dados entre studios |
| C4 | **Nenhuma query do admin filtra por `tenant_id`** (sessions, messages, pause, config, reviews) | `admin.ts:73,126,144,159,181` | IDOR cross-tenant: tenant A lê conversa do tenant B |
| C5 | Buffer reivindicado **depois** do `runAgent` (peek+mark tardio); `claimPendingBuffer` atômica existe mas é código morto | `chatbot.ts:896,1037`; `buffer.ts:117` | Resposta duplicada ao cliente em deploy multi-réplica |
| C6 | Regex de bloco de agendamento **diverge** entre remoção e detecção | `chatbot.ts:991-992` vs `1163-1166` | Bloco some do texto mas pendência nunca é criada → agendamento perdido silenciosamente |
| C7 | Fuso de Brasília calculado via `getTimezoneOffset()` do servidor — só funciona por acaso no Railway (UTC) | `weekly-review.ts:264-271,153-158` | Viola regra 10 do projeto; quebra em qualquer servidor não-UTC |
| C8 | Project ref do Supabase + URLs de imagem hardcoded no código | `chatbot.ts:974-985` | Impossível atender outro studio sem editar e redeployar |
| C9 | System prompt inteiro (nome, endereço, Pix `41998187167`, preços, profissionais) hardcoded no `seed.sql`, tabela global | `seed.sql:27-328` | Rodar seed em multi-tenant zera prompt de todos; sem prompt por tenant |
| C10 | PKs/uniques globais: `agent_configs(agent_type)`, `chat_control(session_id)`, unique `evolution_message_id` | `schema.sql:15,82,74` | 2º tenant não consegue config própria; mesmo número em 2 studios colide; dedup descarta msg legítima |
| C11 | Request logging do Fastify ativo + redact sem cobertura de body → conteúdo de conversa nos logs | `server.ts:25`, `logger.ts:10-19` | PII de clientes em logs (LGPD) |

---

## ALTOS — resolver na fase de refactor

| # | Achado | Local |
|---|---|---|
| A1 | Singleton `getEvolutionClient()` lê env global → serve 1 tenant só (ou mistura WhatsApp de clientes) | `evolution.ts:318-332` |
| A2 | Horários do studio **duplicados e divergentes** entre `agent.ts` e `calendar-availability.ts` (Scarlet some na agenda) | `agent.ts:84-92` vs `calendar-availability.ts:32-52` |
| A3 | OpenAI sem timeout/retry; chamada principal sem try/catch → flush trava segurando slot inflight | `openai.ts:8`, `agent.ts:199` |
| A4 | Webhook sem autenticação de origem (qualquer POST forja mensagens) | `webhooks/evolution.ts:5-17` |
| A5 | Webhook fire-and-forget responde 200; falha = mensagem perdida sem fila durável | `webhooks/evolution.ts:12-16` |
| A6 | Erros de persistência (`persistIncoming/Assistant`) só logam `warn` e seguem como se gravou | `chatbot.ts:689-691,709-711` |
| A7 | Echo detectado por **conteúdo exato** + 60s → mensagem manual curta da Mariana ("ok!") vira eco e some | `chatbot.ts:407-440` |
| A8 | PII (telefone, `session_id`, conteúdo) logada em texto plano; redact do Pino não cobre | `evolution.ts:75,126,234`; `agent.ts:214`; `followup.ts:300,372` |
| A9 | Sem retry/backoff nas chamadas Evolution; sem circuit breaker | `evolution.ts:53-229` |
| A10 | Sweepers fazem SELECT amplo sem `limit`/paginação a cada ciclo (full scan recorrente) | `followup.ts:181,392`; `mariana-monitor.ts:237` |
| A11 | Bloco de agenda gigante (14 dias) injetado em TODO prompt → desperdício de tokens em volume | `agent.ts:184`, `calendar-availability.ts:269-318` |
| A12 | Nomes Mariana/Scarlet/"aluno" hardcoded na lógica (não só texto) | `agent.ts`, `mariana-monitor.ts`, `media.ts`, `message-parsers.ts` |
| A13 | Sem rate-limit (login e `/admin/reviews/run` — job GPT caro), sem CORS, sem helmet/CSP | `admin.ts:61-67`, `server.ts:30-33` |
| A14 | Senha persistida em `localStorage` (= senha, não token); `escapeHtml` não escapa aspas → XSS DOM em conteúdo de cliente | `admin/index.html:321,748` |
| A15 | Backfill do `multitenant_base.sql` assume 100% sem lock; app insere sem `tenant_id` durante o ALTER → `SET NOT NULL` pode abortar | `multitenant_base.sql:233-299` |

---

## MÉDIOS / dívida organizada

- **`chatbot.ts` é um god file de 1373 linhas** com 7 responsabilidades. Quebrar em: `webhook-router`, `outgoing-handler`, `message-routing`, `chat-repository`, `mariana-window` (→ `human-takeover`), `flush`, `pending-actions`.
- **Código morto do follow-up ativo**: `sweepFollowups`/`sweepCloseSessions`/builders nunca chamados (`followup.ts:169-380`). Decidir: remover ou pôr atrás de flag `agent_configs.followup_enabled`.
- **`notifyMarianaEscalation` + Map `recentEscalations`** desabilitados mas vivos (`chatbot.ts:1300`). Map vaza se reabilitado (sem expiração).
- `JSON.parse` sem try/catch na revisão semanal (`weekly-review.ts:96-97`).
- `runMigrations()` no boot é só "detector" (loga warning, não aplica DDL) → app sobe com schema incompleto. Mover migração pro pipeline CI/CD.
- `/health/ready` consulta tabela `leads` que pode não existir no schema atual (`health.ts:14-16`).
- `migrations.ts` no boot com múltiplas réplicas = corrida sem lock.
- Segredos em `tenant_configs` em texto plano (dívida consciente; cifrar com pgcrypto antes do 2º tenant).
- Branding hardcoded no SPA ("Maria" vs "Flora", paleta `#8b1a2e`, "Studio Mariana Castro").

---

## Gaps de teste (cobertura atual: 2 arquivos)

| Prioridade | O que NÃO está testado |
|---|---|
| CRÍTICO | Isolamento multi-tenant (nenhum teste garante filtro por `tenant_id`) |
| CRÍTICO | Autenticação do admin (incl. fail-open do C2) |
| ALTO | Concorrência do buffer (1 flush inflight, zombie detection) |
| ALTO | Janela manual da Mariana + echo-registry (núcleo do produto) |
| ALTO | Dedup `23505` |
| MÉDIO | Tokens especiais (`[TABELA_PRECOS]`, `[CARDS_CURSO]`, blocos de agendamento) + `findMissingTokens` |

Bem testado hoje: `buildDateContext`/status por dia (`agent-date.test.ts`), cooldown 24h e helpers de follow-up (`followup.test.ts`). Há 1 teste-placeholder (`expect(true).toBe(true)`) a remover.

---

## Sequência recomendada (alinhada ao plano SaaS)

**Onda 0 — Higiene imediata (1-2 dias, sem depender do SaaS):**
- Rotacionar `ADMIN_PASSWORD` e removê-la do CLAUDE.md (C1).
- Fail-closed no `checkAuth` (C2).
- Corrigir fuso da revisão semanal pra `Intl`/`America/Sao_Paulo` (C7).
- Unificar regex de bloco de agendamento (C6).
- Desligar log de body / cobrir PII no redact (C11, A8).
- Echo por messageId, não por conteúdo (A7).

**Onda 1 — Correção de concorrência + limpeza (alinha 1.x do plano):**
- Usar `claimPendingBuffer` antes do `runAgent` (C5).
- Quebrar `chatbot.ts` nos 7 módulos.
- Remover código morto (follow-up, escalação) ou pôr atrás de flag.
- Fonte única de horários (A2).

**Onda 2 — Fundação multi-tenant (Fase 1 do plano):**
- PKs/uniques compostas com `tenant_id` (C10).
- `getEvolutionClient(tenantId)` + config por tenant (A1).
- Resolução de tenant a partir do webhook + auth de origem (A4).
- Template de prompt + `renderPrompt(tenantId)` (C8, C9).
- Backfill seguro com default temporário (A15).

**Onda 3 — Segurança production-ready (Fase 3 do plano):**
- RLS por `tenant_id` + abandonar service-role no caminho de request (C3, C4).
- JWT por tenant + super-admin pro Pedro (C1).
- pgcrypto nos segredos de `tenant_configs`.
- Fila durável (BullMQ) pro webhook + retry/backoff (A5, A9).
- Rate-limit/CORS/helmet (A13).

**Contínuo — Testes:** subir cobertura dos invariantes críticos integrada ao CI (Git Actions) como gate.
