# CLAUDE.md — Referência técnica do projeto

> Este arquivo é lido automaticamente pelo Claude Code em toda sessão. Contém a arquitetura, regras de negócio, invariantes críticos e contexto do projeto. **Não é um guia de instalação** — é um mapa do código para o Claude.

---

## Autonomia do Claude

Pedro autorizou o Claude a fazer QUALQUER ajuste AUTOMATICAMENTE, SEM PEDIR PERMISSÃO.

Pode fazer livremente: modificar código, criar/deletar arquivos, rodar scripts, fazer commits e pushes, deploys na Railway, resetar tabelas do banco, alterar `.env`, refatorar qualquer coisa.

Única restrição: se expuser secrets publicamente (commit history, logs), avisar DEPOIS.

---

## O que é esse projeto

Agente de IA chamado **Flora** que atende clientes no WhatsApp do **Studio Mariana Castro** (studio de unhas e cursos em Curitiba/PR). Flora responde dúvidas, informa preços, verifica disponibilidade da agenda e coleta solicitações de agendamento. A dona do studio (Mariana) pode assumir o atendimento manualmente a qualquer momento.

---

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20+, TypeScript, ESM |
| Framework HTTP | Fastify 5 |
| IA | OpenAI `gpt-4.1-mini` (respostas) + Whisper (áudio) + Vision (imagem) |
| Banco | Supabase (Postgres) |
| WhatsApp | Evolution API (instância `agente`) |
| Deploy | Railway (3 serviços: `evolution-postgres`, `evolution-api`, `ia-whatsapp-app`) |
| Agenda | Google Calendar (leitura via service account) |
| Log | Pino |

---

## Estrutura de arquivos

```
src/
├── config/env.ts                  # Zod — valida e exporta env vars
├── lib/
│   ├── echo-registry.ts           # Registry in-memory de IDs enviados pela Flora (evita auto-bloqueio)
│   ├── evolution.ts               # Cliente HTTP da Evolution API (sendText, sendMedia, findMessages, sendPresence)
│   ├── logger.ts                  # Pino com redação de secrets
│   ├── migrations.ts              # Migrações de banco na inicialização
│   ├── openai.ts                  # Factory de clientes OpenAI
│   ├── phone.ts                   # Normalização de telefone BR
│   └── supabase.ts                # Cliente Supabase service-role
├── routes/
│   ├── health.ts                  # GET /health e /health/ready
│   ├── admin.ts                   # Painel admin (prompt, sessões, pendências, métricas, revisões)
│   └── webhooks/evolution.ts      # POST /webhooks/evolution
├── services/
│   ├── agent.ts                   # Chamada OpenAI com structured output (JSON schema)
│   ├── agent-config.ts            # Cache 30s da agent_configs do Supabase
│   ├── buffer.ts                  # Buffer + debounce (15s) + sweeper (20s) de mensagens
│   ├── calendar-availability.ts   # Lê Google Calendar e gera bloco de slots livres pro prompt
│   ├── chatbot.ts                 # Orquestração principal do webhook + flushSession
│   ├── followup.ts                # Sweeper de follow-up e encerramento automático
│   ├── mariana-monitor.ts         # Polling (30s) de mensagens manuais da Mariana não entregues via webhook
│   ├── media.ts                   # Processa áudio (Whisper), imagem (Vision), vídeo/documento
│   ├── message-parsers.ts         # Parsers de tipos de mensagem WhatsApp (contato, reação, localização, etc.)
│   └── weekly-review.ts           # Revisão semanal automática com GPT-4 (toda segunda às 08h)
└── server.ts                      # Bootstrap Fastify + inicializa todos os sweepers

src/admin/index.html               # SPA do painel admin (HTML/JS vanilla)

belasis-sync/                      # Serviço separado (Node.js) que sincroniza agenda do Belasis com Google Calendar
supabase/
├── schema.sql                     # DDL das tabelas
└── seed.sql                       # INSERT inicial (agent_configs)
```

---

## Banco de dados (Supabase)

Projeto: `jnfeerxcxxmgjutkfzig` (`https://jnfeerxcxxmgjutkfzig.supabase.co`)

### Tabelas principais

**`agent_configs`** — configuração do agente (1 linha, `agent_type = 'default'`)
- `system_prompt` — prompt da Flora (editável pelo painel admin)
- `openai_model` — modelo atual: `gpt-4.1-mini`
- `debounce_ms` — 15.000 (espera acumular mensagens antes de responder)
- `typing_ms` — 1.000 (simula digitação)
- `inter_message_delay_ms` — 1.000 (pausa entre mensagens consecutivas)
- `history_limit` — 30 (últimas mensagens carregadas no contexto)
- `max_output_messages` — 5 (máximo de mensagens por resposta)
- Cache em memória: 30s. Para forçar reload: `invalidateAgentConfigCache()`.

**`agent_configs_history`** — histórico de versões do prompt (via trigger no banco). Permite rollback pelo painel.

**`chat_messages`** — todas as mensagens da conversa
- `session_id` — formato: `5541999990000@s.whatsapp.net`
- `role` — `user` (cliente) | `assistant` (Flora ou Mariana manual) | `system` | `tool`
- `status` — `received` | `pending` | `sent` | `failed`
- `evolution_message_id` — ID único da Evolution (usado para dedup e para o echo registry)
- `metadata` — JSONB: `push_name`, `sender` (quando é Mariana manual), `error` (quando failed)
- Mensagens com `status = 'pending'` por mais de 120s são marcadas como `failed` pelo sweeper (zombies).

**`chat_control`** — estado de controle por sessão (1 linha por cliente)
- `ai_paused` — Flora silenciada manualmente (painel admin)
- `mariana_last_manual_at` — timestamp da última mensagem manual da Mariana. Janela ativa = últimas 24h.
- `followup_sent_at` — quando o follow-up foi enviado. Null = ainda não enviou. Cooldown: 24h.
- `followup_closed_at` — quando a mensagem de encerramento foi enviada.
- `followup_context` — contexto detectado: `scheduling` | `course` | `prices` | `greeting` | `generic`
- `skip_followup` — true quando cliente encerrou naturalmente ("obrigado", "ok", "tchau", etc.)
- `client_name` — nome explícito (prioridade sobre pushName do WhatsApp)

**`message_buffer`** — fila de mensagens aguardando processamento
- `processed_at` — null = pendente, preenchido = processado
- O sweeper verifica a cada 20s mensagens com mais de 20s sem `processed_at` (stranded).

**`pending_actions`** — solicitações de agendamento e leads de curso detectados pela Flora
- `type` — `agendamento` | `curso`
- `status` — `pendente` | `confirmado` | `recusado`
- `fields` — JSONB com dados estruturados extraídos da conversa
- `summary` — bloco raw `--- SOLICITAÇÃO DE AGENDAMENTO ---` detectado

**`weekly_reviews`** — resultados da revisão semanal automática
- Roda toda segunda às 08h BRT
- Analisa conversas da semana com GPT-4
- Pode atualizar o system_prompt automaticamente se encontrar problemas

---

## Fluxo principal de uma mensagem recebida

```
Webhook POST /webhooks/evolution
  └── handleEvolutionWebhook (chatbot.ts)
       ├── fromMe=true? → detecta eco Flora (echo-registry) ou mensagem manual da Mariana
       │    ├── echo Flora → ignora janela
       │    └── Mariana manual → ativa janela 24h + descarta buffer pendente
       ├── messages.update? → atualiza mensagem editada ou ignora status
       ├── Persiste mensagem em chat_messages
       ├── resetFollowupState (se cliente respondeu)
       ├── isWithinMarianaManualWindow? → salva no histórico, NÃO bufferiza
       └── addToBuffer → agenda debounce (15s) → flushSession
            └── flushSession (chatbot.ts)
                 ├── Verifica novamente: ai_paused? janela Mariana?
                 ├── runAgent (agent.ts) — chama OpenAI com histórico + contexto de agenda
                 ├── Para cada mensagem da resposta:
                 │    ├── Verifica janela Mariana (pode ter mudado durante o runAgent)
                 │    ├── sendPresence "composing" + delay typing
                 │    ├── sendText → registra ID no echo-registry
                 │    ├── [TABELA_PRECOS] → sendMedia com imagem de preços
                 │    └── [CARDS_CURSO] → envia 8 imagens do curso
                 └── handlePendingActions — detecta blocos estruturados e notifica Mariana
```

---

## Sweepers em background

| Sweeper | Arquivo | Intervalo | O que faz |
|---|---|---|---|
| Buffer Sweeper | `buffer.ts` | 20s (`AGENT_BUFFER_SWEEPER_MS`) | Reprocessa mensagens travadas no buffer + marca zombies |
| Followup Sweeper | `followup.ts` | 5min | Encerramento silencioso por inatividade (180 min sem resposta do cliente) |
| Mariana Monitor | `mariana-monitor.ts` | 30s | Polling via `/chat/findMessages` pra detectar mensagens da Mariana não entregues via webhook |
| Weekly Review | `weekly-review.ts` | 30min (verifica se é segunda 08h) | Revisão semanal com GPT-4 |

**IMPORTANTE:** O follow-up ativo (60 min sem resposta → envia "Oi, tudo bem?") está **DESABILITADO**. O `startFollowupSweeper` só roda o `sweepInactiveSessions` (encerramento silencioso). O `sweepFollowups` e `sweepCloseSessions` existem no código mas não são chamados.

---

## Detecção de eco da Flora (echo-registry)

Problema: a Evolution dispara `fromMe=true` para CADA mensagem que a Flora envia. Sem distinguir, o sistema ativaria a janela da Mariana nas próprias respostas da Flora.

Solução em duas camadas:
1. **In-memory** (`echo-registry.ts`): registra o `messageId` retornado por `sendText`/`sendMedia` por 90s. `isFloraEcho(id)` consulta esse registry.
2. **Fallback via DB** (`hasRecentPendingFloraReply`): consulta `chat_messages` por mensagens `assistant` com status `pending`/`sent` nos últimos 90s para a sessão.

Ambas as camadas são verificadas antes de ativar a janela da Mariana.

---

## Janela manual da Mariana (24h)

Quando Mariana envia qualquer mensagem manual pelo celular:
1. `mariana_last_manual_at` é atualizado em `chat_control`
2. O timer de debounce pendente é cancelado (`cancelPendingFlush`)
3. O buffer pendente é descartado (`discardPendingBuffer`)
4. Por 24h: novas mensagens do cliente são salvas no histórico mas NÃO entram no buffer
5. A cada mensagem enviada, `flushSession` re-verifica a janela antes de enviar

Fontes que ativam a janela:
- Webhook `messages.upsert` com `fromMe=true` (caminho principal)
- Webhook `messages.update` com `fromMe=true` (belt-and-suspenders)
- Kill-switch global no início de `handleEvolutionWebhook` (antes de qualquer filtragem)
- `mariana-monitor.ts` via polling (fallback para webhooks não entregues)

---

## Tokens especiais no system prompt

Esses tokens são detectados no texto retornado pelo agente e têm comportamento especial em `flushSession`:

| Token | Comportamento |
|---|---|
| `[TABELA_PRECOS]` | Removido do texto + envia imagem de preços via `sendMedia` |
| `[CARDS_CURSO]` | Removido do texto + envia 8 imagens do curso |
| `[ESCALAR_MARIANA:motivo]` | Removido do texto (notificação desabilitada no momento) |
| `--- SOLICITAÇÃO DE AGENDAMENTO ---...---` | Removido do texto + cria `pending_action` + notifica Mariana via WhatsApp |
| `--- LEAD DE CURSO ---...---` | Idem para leads de curso |

URLs das imagens hospedadas no Supabase Storage:
- Tabela de preços: `https://jnfeerxcxxmgjutkfzig.supabase.co/storage/v1/object/public/imagens/precos.jpeg`
- Cards do curso: `1.jpeg` a `7.jpeg` + `investimento.jpeg` (mesmo bucket)

**CRÍTICO:** Ao editar o system prompt no painel, o sistema verifica se esses tokens foram removidos. Se sim, exige `force=true` para confirmar. Nunca remova esses tokens sem querer.

---

## Disponibilidade da agenda (Google Calendar)

`calendar-availability.ts` lê o Google Calendar da Mariana (sincronizado pelo `belasis-sync`) e gera um bloco de texto injetado no system prompt a cada chamada do agente.

- Grade oficial oferecida: ter/qua/qui/sex 09h, 11h, 13h, 15h | sáb 08h, 10h
- Slots de 30 min cruzados com eventos do Calendar para identificar livres
- Cache: 60s em memória
- Fallback: se Calendar indisponível, injeta mensagem pedindo para aguardar a Mariana confirmar
- Requer: `GOOGLE_SERVICE_ACCOUNT_KEY` (JSON do service account) e `GOOGLE_CALENDAR_ID`

O `belasis-sync` é um serviço separado (pasta `belasis-sync/`) que sincroniza dados do sistema Belasis (agendamento usado pelo studio) para o Google Calendar.

---

## Revisão semanal automática

`weekly-review.ts` roda toda segunda-feira às 08h BRT:
1. Busca todas as mensagens da semana anterior
2. Analisa com GPT-4.1-mini buscando problemas e oportunidades
3. Se encontrar melhorias, atualiza o `system_prompt` automaticamente (adiciona seção ao final)
4. Salva resultado em `weekly_reviews`
5. Envia relatório via WhatsApp para `REVIEW_NOTIFY_PHONE` (se configurado)

Pode ser disparado manualmente: `POST /admin/reviews/run`

---

## Painel admin

URL de produção: `https://ia-whatsapp-app-production-d07a.up.railway.app/admin`

Senha: variável `ADMIN_PASSWORD` (atualmente `studio2024`)

Autenticação: header `Authorization: Bearer <senha>` em todas as rotas da API.

Endpoints relevantes:
- `GET /admin/sessions` — lista sessões com último contato e status de pausa
- `GET /admin/sessions/:id/messages` — histórico de uma sessão
- `POST /admin/sessions/:id/pause` — pausa/retoma a Flora numa sessão
- `GET/PUT /admin/config` — lê/atualiza o system prompt
- `GET /admin/config/history` — versões anteriores do prompt
- `POST /admin/config/restore/:id` — reverte para uma versão anterior
- `GET /admin/pending` — lista pendências (agendamentos/leads)
- `PATCH /admin/pending/:id` — confirma ou recusa uma pendência (envia mensagem automática pro cliente)
- `GET /admin/metrics` — métricas via RPC `get_dashboard_metrics`
- `GET /admin/availability` — bloco de disponibilidade atual injetado no prompt (debug)
- `GET /admin/reviews` — revisões semanais
- `POST /admin/reviews/run` — dispara revisão manual

---

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `SUPABASE_URL` | Sim | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Sim | Chave service-role do Supabase |
| `EVOLUTION_URL` | Sim | URL pública da Evolution API |
| `EVOLUTION_API_KEY` | Sim | Chave de autenticação da Evolution |
| `EVOLUTION_INSTANCE` | Sim | Nome da instância (`agente`) |
| `OPENAI_API_KEY` | Sim | Chave da OpenAI (fallback se não configurada em `agent_configs`) |
| `MARIANA_NOTIFY_PHONE` | Recomendada | Número da Mariana para notificações de agendamento (`554196137916`) |
| `ADMIN_PASSWORD` | Recomendada | Senha do painel admin |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Opcional | JSON do service account Google (para agenda) |
| `GOOGLE_CALENDAR_ID` | Opcional | ID do calendário da Mariana |
| `REVIEW_NOTIFY_PHONE` | Opcional | Número para receber relatório semanal |
| `AGENT_BUFFER_SWEEPER_MS` | Opcional | Intervalo do buffer sweeper (padrão: 20.000ms) |
| `PORT` | Opcional | Porta HTTP (padrão: 3000) |
| `LOG_LEVEL` | Opcional | Nível de log Pino (padrão: `info`) |

---

## Deploy (Railway)

3 serviços no mesmo projeto Railway (`whatsapp-agent`):

| Serviço | Imagem/Fonte | Porta |
|---|---|---|
| `evolution-postgres` | PostgreSQL | interno |
| `evolution-api` | `evoapicloud/evolution-api:latest` | 8080 |
| `ia-whatsapp-app` | GitHub (este repo, branch `main`) | 3000 |

O app usa `EVOLUTION_URL=http://evolution-api.railway.internal:8080` (rede interna Railway).

Webhook configurado na Evolution: `POST https://ia-whatsapp-app-production-d07a.up.railway.app/webhooks/evolution`
Eventos: `MESSAGES_UPSERT` e `MESSAGES_UPDATE`

Healthcheck: `GET /health` retorna `{"status":"ok"}`

---

## Regras de negócio críticas

1. **Dedup de mensagens:** `evolution_message_id` tem constraint unique em `chat_messages`. Inserção duplicada retorna erro código `23505` e é ignorada silenciosamente.

2. **Buffer por sessão:** apenas 1 flush por sessão pode estar inflight ao mesmo tempo (`inflight` Map em `buffer.ts`). Tentativas concorrentes são descartadas.

3. **Cooldown de follow-up:** máximo 1 ciclo de follow-up por sessão a cada 24h. `resetFollowupState` só reseta se `followup_sent_at` existe E foi há mais de 24h.

4. **Sem follow-up para:** conversas muito curtas (< 4 mensagens), cliente que encerrou naturalmente ("obrigado", "ok", "tchau", etc.), sessões com `skip_followup=true`, sessões com `ai_paused=true`, sessões dentro da janela de 24h da Mariana.

5. **Janela de 48h no sweeper:** o sweeper de follow-up/inatividade só considera mensagens das últimas 48h para evitar reativar históricos antigos após restart/deploy.

6. **Zombie detection:** mensagens `assistant` com `status='pending'` por mais de 120s são marcadas como `failed` pelo buffer sweeper.

7. **Nome da cliente:** `saveClientNameIfMissing` (pushName) só grava se `client_name IS NULL`. `saveClientName` (nome explícito da conversa) sobrescreve sempre e tem prioridade máxima.

8. **Histórico carregado:** últimas 30 mensagens (`role IN ('user', 'assistant')`). Mensagens de `system` e `tool` não entram no histórico da OpenAI.

9. **Resposta estruturada:** o agente usa `response_format.json_schema` com schema estrito (`mensagens: string[]`, 1-2 items, max 5 via `max_output_messages`). Falha de parse lança exceção.

10. **Fuso horário:** toda lógica de hora usa `America/Sao_Paulo` via `Intl.DateTimeFormat`. O servidor roda em UTC (Railway). Nunca usar `new Date().getHours()` diretamente.

---

## Horários do studio (hardcoded em `agent.ts`)

| Dia | Status | Horário | Profissionais |
|---|---|---|---|
| Domingo | Fechado | | |
| Segunda | Fechado | | |
| Terça | Aberto | 09h-16h | Mariana (unhas) |
| Quarta | Aberto | 09h-16h | Mariana (unhas) |
| Quinta | Aberto | 09h-16h (Mariana) e 13h30-21h (Scarlet) | Mariana + Scarlet (sobrancelhas/cílios) |
| Sexta | Aberto | 09h-16h | Mariana (unhas) |
| Sábado | Aberto | 08h-12h (Mariana) e 08h-18h (Scarlet) | Mariana + Scarlet |

Grade oficial de slots oferecidos: ter/qua/qui/sex: 09h, 11h, 13h, 15h | sáb: 08h, 10h

---

## Scripts e comandos úteis

```bash
npm run dev          # Desenvolvimento com hot-reload (tsx watch)
npm run build        # Compilação TypeScript + copia src/admin para dist/admin
npm start            # Produção (dist/server.js)
npm run typecheck    # Verifica tipos sem compilar
npm run test         # Roda testes (Vitest)
```

Diagnósticos via SQL no Supabase:
```sql
-- Sessões ativas (últimas 48h)
SELECT cc.session_id, cc.client_name, cc.ai_paused, cc.mariana_last_manual_at,
       MAX(cm.created_at) AS ultimo_contato
FROM chat_control cc JOIN chat_messages cm ON cm.session_id = cc.session_id
WHERE cm.created_at > NOW() - INTERVAL '48h'
GROUP BY cc.session_id, cc.client_name, cc.ai_paused, cc.mariana_last_manual_at
ORDER BY MAX(cm.created_at) DESC;

-- Pendências abertas
SELECT session_id, type, client_name, status, created_at, summary
FROM pending_actions WHERE status = 'pendente' ORDER BY created_at DESC;

-- Buffer travado
SELECT * FROM message_buffer WHERE processed_at IS NULL ORDER BY created_at;

-- Mensagens com falha
SELECT session_id, content, metadata, created_at FROM chat_messages
WHERE status = 'failed' ORDER BY created_at DESC LIMIT 20;

-- Pausar Flora numa sessão manualmente
UPDATE chat_control SET ai_paused = true, paused_at = now(), paused_by = 'manual'
WHERE session_id = '554199990000@s.whatsapp.net';

-- Mudar o system prompt
UPDATE agent_configs SET system_prompt = '...novo prompt...', updated_at = now()
WHERE agent_type = 'default';
```

---

## Segredos — NUNCA commitar

- `.env`
- `.mcp.json`
- Qualquer arquivo dentro de `.claude/`

Se commitar por acidente, girar as chaves imediatamente: OpenAI, Supabase service-role, Evolution API key.
