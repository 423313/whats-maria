# Prompt — Construir o Agente de IA WhatsApp do Zero

> Cole esse prompt inteiro no Claude Code (em uma pasta vazia) pra reconstruir o projeto do zero. O Claude vai criar todos os arquivos, validar typecheck, e te entregar um repositório pronto pra deploy.

---

## 🎯 Sua missão

Construir um **template de agente de IA conversacional para WhatsApp** em TypeScript/Node.js, do zero, com a stack e a arquitetura especificadas abaixo. O resultado final deve ser um repositório limpo, sem secrets hardcoded, que compile sem erros (`npm run typecheck`) e que rode em produção na Railway.

**Não invente requisitos.** Siga estritamente o que está aqui. Se algo for ambíguo, escolha a opção mais simples e documente em comentário.

**Não pergunte por confirmação a cada arquivo.** Construa em sequência, valide no fim, e me reporte o resultado consolidado.

---

## 📦 Stack obrigatória

- **Linguagem**: TypeScript 5.6+ (strict mode)
- **Runtime**: Node.js 20.11+
- **Framework HTTP**: Fastify 5.x (com `@fastify/sensible`)
- **Validação**: Zod 3.x
- **Database**: Supabase (PostgreSQL 17+) — cliente `@supabase/supabase-js` 2.x
- **Logger**: Pino 9.x + pino-pretty 11.x (com redação de secrets)
- **LLM**: OpenAI SDK 4.x — modelos `gpt-4.1-mini` (texto), `whisper-1` (áudio), `gpt-4o-mini` (imagens), `gpt-4o` (documentos)
- **Vídeo (opcional)**: Google Gemini API REST — `gemini-2.5-flash`
- **WhatsApp**: Evolution API (cliente HTTP custom — não tem SDK oficial)
- **Module system**: ES modules (`"type": "module"` no package.json)
- **Build**: `tsc` puro (sem bundler)
- **Container**: Dockerfile multistage com Node 20 alpine
- **Deploy**: Railway

**Não use:** Express, ts-node, nodemon, jest, mongoose, prisma, dotenv (Zod faz validação direto).

---

## 📂 Estrutura de diretórios esperada

```
.
├── .dockerignore
├── .env.example
├── .gitignore
├── .mcp.json.example
├── CLAUDE.md
├── Dockerfile
├── README.md
├── package.json
├── railway.json
├── tsconfig.json
├── src/
│   ├── server.ts
│   ├── config/
│   │   └── env.ts
│   ├── lib/
│   │   ├── evolution.ts
│   │   ├── logger.ts
│   │   ├── openai.ts
│   │   ├── phone.ts
│   │   └── supabase.ts
│   ├── routes/
│   │   ├── health.ts
│   │   └── webhooks/
│   │       └── evolution.ts
│   └── services/
│       ├── agent-config.ts
│       ├── agent.ts
│       ├── buffer.ts
│       ├── chatbot.ts
│       ├── media.ts
│       └── message-parsers.ts
└── supabase/
    ├── schema.sql
    └── seed.sql
```

---

## 🗄️ Schema do Supabase (`supabase/schema.sql`)

Implementar exatamente essas 4 tabelas + 1 RPC + extensão `pgcrypto`:

### Tabela `agent_configs`
- `agent_type text PRIMARY KEY`
- `enabled boolean NOT NULL DEFAULT true`
- `openai_api_key text` (nullable — se preenchido, sobrescreve env var)
- `openai_model text NOT NULL DEFAULT 'gpt-4.1-mini'`
- `gemini_api_key text` (nullable — opcional)
- `system_prompt text NOT NULL`
- `debounce_ms integer NOT NULL DEFAULT 15000`
- `typing_ms integer NOT NULL DEFAULT 1000`
- `inter_message_delay_ms integer NOT NULL DEFAULT 1000`
- `history_limit integer NOT NULL DEFAULT 30`
- `max_output_messages integer NOT NULL DEFAULT 5`
- `updated_at timestamptz NOT NULL DEFAULT now()` (com trigger `touch_updated_at`)

### Tabela `chat_messages`
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `session_id text NOT NULL`
- `instance text NOT NULL`
- `role text NOT NULL CHECK (role IN ('user','assistant','system','tool'))`
- `content text NOT NULL`
- `media_type text` (audioMessage, imageMessage, etc — null pra texto)
- `transcription text` (transcrição/descrição da mídia)
- `evolution_message_id text` (UNIQUE quando não-null)
- `status text DEFAULT 'received'` ('received', 'pending', 'sent', 'failed')
- `model text`
- `tokens_in integer`
- `tokens_out integer`
- `metadata jsonb NOT NULL DEFAULT '{}'::jsonb`
- `created_at timestamptz NOT NULL DEFAULT now()`

Índices:
- `(session_id, created_at desc)` — leitura de histórico
- `(status, created_at) WHERE role='assistant' AND status='pending'` — detector de zumbis
- `UNIQUE(evolution_message_id) WHERE evolution_message_id IS NOT NULL` — idempotência

### Tabela `chat_control`
- `session_id text PRIMARY KEY`
- `instance text NOT NULL`
- `agent_type text NOT NULL DEFAULT 'default'`
- `ai_paused boolean NOT NULL DEFAULT false`
- `paused_at timestamptz`
- `paused_by text`
- `created_at`, `updated_at` (com trigger touch)

### Tabela `message_buffer`
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `session_id text NOT NULL`
- `instance text NOT NULL`
- `lead_phone text NOT NULL`
- `mensagem text NOT NULL`
- `evolution_message_id text` (UNIQUE quando não-null)
- `media_type text`, `media_url text`, `transcription text`
- `processed_at timestamptz` (null = pendente; preenchido = consumido)
- `created_at timestamptz NOT NULL DEFAULT now()`

Índice: `(session_id, created_at) WHERE processed_at IS NULL`

### RPC `is_ai_paused(p_session_id text) returns boolean`
SQL stable que retorna `coalesce((select ai_paused from chat_control where session_id = p_session_id), false)`.

### RLS
Habilite RLS em todas as tabelas. Não crie policies pra anon/authenticated — a app SEMPRE acessa via service_role (que bypassa RLS).

---

## 🔧 Arquivos de configuração

### `package.json`
- Nome: `template-agente-ia-whatsapp`
- `"type": "module"`
- Engines: `"node": ">=20.11.0"`
- Scripts: `dev` (tsx watch src/server.ts), `build` (tsc -p tsconfig.json), `start` (node dist/server.js), `typecheck` (tsc --noEmit)
- Dependências exatas listadas na stack obrigatória.

### `tsconfig.json`
- Target: ES2022
- Module: NodeNext
- ModuleResolution: NodeNext
- Strict: true
- SourceMap: true
- OutDir: `dist`
- RootDir: `src`
- Include: `src/**/*`
- Exclude: `node_modules`, `dist`

### `Dockerfile` (multistage Alpine)
- **Stage 1 (deps)**: `node:20-alpine`, copia `package*.json`, `npm ci --omit=dev`
- **Stage 2 (build)**: `node:20-alpine`, copia tudo, `npm ci`, `npm run build`
- **Stage 3 (runtime)**: `node:20-alpine`, usuário `node`, copia `node_modules` do stage 1 e `dist` do stage 2, `EXPOSE 3000`, `CMD ["node", "dist/server.js"]`

### `railway.json`
```json
{
  "build": { "builder": "DOCKERFILE" },
  "deploy": {
    "startCommand": "node dist/server.js",
    "healthcheckPath": "/health",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

### `.gitignore`
```
node_modules
dist
.env
.env.local
.env.*.local
*.log
.DS_Store
.railway/
coverage/
.mcp.json
.claude/
```

### `.dockerignore`
```
node_modules
dist
.env
.env.local
*.log
.git
.claude
```

### `.env.example`
Documentar todas as env vars obrigatórias e opcionais (ver seção "Variáveis de ambiente" abaixo). **Sem nenhum valor real preenchido.**

### `.mcp.json.example`
```json
{
  "mcpServers": {
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp?project_ref=YOUR_PROJECT_REF&features=docs%2Caccount%2Cdatabase%2Cdebugging%2Cdevelopment%2Cbranching%2Cstorage%2Cfunctions"
    }
  }
}
```

---

## 🌐 Variáveis de ambiente (`src/config/env.ts`)

Use Zod pra validar:

| Variável | Tipo | Obrigatória? | Default |
|---|---|---|---|
| `NODE_ENV` | enum('development','production','test') | não | development |
| `PORT` | number positivo | não | 3000 |
| `LOG_LEVEL` | enum(fatal/error/warn/info/debug/trace) | não | info |
| `SUPABASE_URL` | URL | **sim** | — |
| `SUPABASE_SERVICE_ROLE_KEY` | string min 1 | **sim** | — |
| `EVOLUTION_URL` | URL | não | — |
| `EVOLUTION_API_KEY` | string | não | — |
| `EVOLUTION_INSTANCE` | string | não | `default` |
| `OPENAI_API_KEY` | string | não (vem de agent_configs também) | — |
| `AGENT_BUFFER_SWEEPER_MS` | number positivo | não | 20000 |

Se validação falhar, imprimir issues formatadas e `process.exit(1)`.

Exporte `export const env = loadEnv()`.

---

## 📚 Bibliotecas internas (`src/lib/`)

### `lib/logger.ts` — Pino com redação
- Pino 9.x, level vem de `env.LOG_LEVEL`
- Em dev: pretty print (`pino-pretty`)
- Em prod: JSON estruturado
- **Redact paths obrigatórios** (censor `[REDACTED]`):
  - `req.headers.authorization`
  - `req.headers["x-app-secret"]`
  - `req.headers.apikey`
  - `*.SUPABASE_SERVICE_ROLE_KEY`
  - `*.OPENAI_API_KEY`
  - `*.EVOLUTION_API_KEY`

### `lib/supabase.ts` — Cliente service-role
```typescript
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
```

### `lib/openai.ts` — Factory cacheada por chave
- `getOpenAIClient(apiKey: string): OpenAI` — cria/retorna cliente cacheado por `apiKey`
- Cache em `Map<string, OpenAI>` (chaves diferentes podem coexistir — uma por agent)

### `lib/phone.ts` — Normalização Brasil
- `normalizePhone(raw: string): string` — extrai só dígitos. Se começar com '0', remove. Se não tiver DDI 55 e tiver 10-11 dígitos, prepend '55'.
- `phoneToSessionId(phoneOrJid: string): string` — retorna `<digits>@s.whatsapp.net` (formato Evolution)

### `lib/evolution.ts` — Cliente HTTP da Evolution
- Classe `EvolutionClient` com:
  - `sendText(instance, to, text): Promise<{messageId, raw}>` → POST `/message/sendText/{instance}` com body `{number, text}` e header `apikey`
  - `sendPresence(instance, to, presence, delayMs): Promise<void>` → POST `/chat/sendPresence/{instance}`
- Classe de erro `EvolutionError` (extends Error, `status`, `body`)
- Timeout default 15000ms via AbortController
- `getEvolutionClient()` cacheado — lazy, throw se `EVOLUTION_URL` ou `EVOLUTION_API_KEY` faltarem

---

## 🧠 Lógica de domínio (`src/services/`)

### `services/agent-config.ts`
- Interface `AgentConfig` com todos os campos da tabela `agent_configs`
- `loadAgentConfig(agentType: string): Promise<AgentConfig>` — busca no Supabase, **cache em memória de 30s** (Map com `expiresAt`)
- `invalidateAgentConfigCache(agentType?: string): void`
- `resolveOpenAIKey(config: AgentConfig): string` — retorna `config.openai_api_key` se preenchido, senão `env.OPENAI_API_KEY`, senão throw

### `services/agent.ts`
- `runAgent({agentType, sessionId, userText, config?}): Promise<AgentReply>`
  - Carrega config (do parâmetro ou via `loadAgentConfig`)
  - Throw se `!config.enabled`
  - Carrega histórico via `loadHistory(sessionId, config.history_limit)` — últimas N msgs role IN ('user','assistant'), ordem cronológica
  - Constrói messages: `[{role:'system', content: config.system_prompt}, ...history, {role:'user', content: userText}]`
  - Chama `client.chat.completions.create` com `response_format: json_schema` (strict)
  - Schema da resposta: `{mensagens: string[1..5]}` — array de strings, mínimo 1, máximo 5, cada uma `minLength: 1`
  - Parse JSON, sanitiza (strip whitespace, drop empties), aplica `slice(0, max_output_messages)`
  - Retorna `{mensagens, model, tokens_in, tokens_out}`
- Constante `MEDIA_FALLBACK = 'oi, ainda não consigo ouvir áudios ou ver imagens por aqui, pode me escrever em texto?'`

### `services/buffer.ts` — Buffer + debounce
- `addToBuffer(input)` — INSERT em `message_buffer`. Se erro 23505 (dup), log debug e return. Carrega `debounce_ms` da config e chama `scheduleFlush(sessionId, debounceMs)`.
- `scheduleFlush(sessionId, debounceMs)` — reseta timeout existente, agenda novo `setTimeout(() => safeFlush(sessionId, 'debounce'), debounceMs)`. Mantém em `Map<sessionId, {timer}>`
- `safeFlush(sessionId, trigger)` — protege contra concorrência via `Map<sessionId, Promise>`. Skip se já inflight.
- `peekPendingBuffer(sessionId)` — SELECT WHERE processed_at IS NULL ORDER BY created_at ASC
- `markBufferProcessed(rowIds)` — UPDATE processed_at = now() WHERE id IN (...) AND processed_at IS NULL. Retorna `count` claimed.
- `registerFlushHandler(handler)` — singleton que `chatbot.ts` registra
- `startBufferSweeper()` — `setInterval(env.AGENT_BUFFER_SWEEPER_MS)`. Por tick: detecta mensagens assistant zumbis (status pending > 120s → marca failed), e força flush de sessões com buffer não-processado > debounce+5s
- `stopBufferSweeper()`, `awaitInflightFlushes(timeoutMs)` — pra graceful shutdown

### `services/media.ts` — Processamento de mídia
- `isProcessableMedia(messageType): boolean` — true pra `audioMessage`, `imageMessage`, `stickerMessage`, `documentMessage`, `videoMessage`
- `mediaLabel(messageType): string` — label em português ('áudio', 'imagem', 'vídeo', 'documento', 'figurinha', 'sticker')
- `processMedia({instance, messageId, messageType, message, openaiKey, geminiKey?})`:
  - Baixa base64 via `POST {evolution}/chat/getBase64FromMediaMessage/{instance}` com `{message: {key: {id: messageId}}}`. Retorna `{base64, mimeType}`
  - **Áudio** (`audioMessage`): chama Whisper `audio.transcriptions.create({file, model:'whisper-1'})`, retorna `{text: '[áudio transcrito] ...', transcription, mediaUrl: null}`
  - **Imagem/sticker** (`imageMessage`/`stickerMessage`): chama `chat.completions.create({model: 'gpt-4o-mini', messages: [{role:'user', content: [{type:'text', text: VISION_PROMPT}, {type:'image_url', image_url:{url: dataUrl}}]}]})`. Sticker tem prompt mais curto.
  - **Vídeo** (`videoMessage`): se `geminiKey` ausente, retorna fallback. Senão, POST `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={geminiKey}` com `inline_data`. Retorna descrição.
  - **Documento** (`documentMessage`): chama `gpt-4o` (mais robusto pra docs longos) descrevendo o conteúdo extraído (caption + filename).
- Fallback genérico se qualquer parte falhar: retorna `{text: '[<label> enviado pelo usuário, não consegui processar agora]', transcription: null, mediaUrl: null}`

### `services/message-parsers.ts` — Parsers de tipos exotic
Funções puras (sem I/O) que recebem `message: Record<string, unknown>` e retornam `string`:
- `unwrapEphemeral(messageType, message)` — se for `ephemeralMessage`, desce 1 nível em `message.ephemeralMessage.message` e retorna `{messageType, message}` reais
- `parseContact(message)` — extrai nome + número do `contactMessage.vcard`
- `parseContactsArray(message)` — itera `contactsArrayMessage.contacts[]`
- `parseLocation(message, isLive)` — `[Localização ${live ? '(ao vivo)' : ''}: lat,lng]`
- `parseReaction(message)` — `[Reagiu com {emoji} a uma mensagem anterior]`
- `parseInteractive(message)` — extrai `nativeFlowMessage.buttons_reply.display_text` ou similar

### `services/chatbot.ts` — Orquestrador principal
Esse é o coração. Implementação:

#### `handleEvolutionWebhook(payload): Promise<{status, reason?}>`
1. Se `event === 'messages.update'`:
   - Se `status === 'SERVER_ACK' && editedMessage && fromMe !== true` → tratar como edição (`handleEditedMessage`)
   - Se status em IGNORED_STATUSES (DELIVERY_ACK/READ/PLAYED/ERROR) → ignored
2. Se `event !== 'messages.upsert'` → ignored
3. Se `data.key.fromMe === true` → `handleOutgoingMessage(data, instance)` (promove pending → sent OU persiste como mensagem manual humana)
4. Validar `remoteJid.endsWith('@s.whatsapp.net')` (ignora @lid, @g.us, etc)
5. Extrair `phone`, `sessionId`, `evolutionMessageId`, `pushName`
6. `unwrapEphemeral(messageType, message)`. Se `templateMessage` → ignored.
7. `routeMessage(...)` retorna `{text, mediaType, transcription} | null`
8. Persiste em `chat_messages` (role='user', status='received'). Tratar erro 23505 silenciosamente.
9. `ensureChatControl(sessionId, instance, 'default')` — UPSERT
10. Se `isAIPaused(sessionId)` → log info, segue mas não vai flushear
11. `addToBuffer(...)` → retorna `{status: 'buffered'}`

#### `handleOutgoingMessage(data, instance)`
- Verificar idempotência por `evolution_message_id` em `chat_messages`
- Buscar pending assistant com mesmo `content` últimos 60s → promover pra `sent`
- Senão, persistir como mensagem manual humana (`role: 'assistant', status: 'sent'`)

#### `handleEditedMessage(data, instance)`
- Marcar `[Mensagem editada]` no content, `mediaType: 'edited'`
- Mesma lógica de persist + ensureChatControl + addToBuffer

#### `flushSession(sessionId)` — registrado no buffer como FlushHandler
1. Em paralelo: `isAIPaused`, `peekPendingBuffer`, `resolveAgentType`
2. Se pausado ou buffer vazio → return
3. Carregar config (try/catch, defaults se falhar)
4. Concatenar `mensagens` separadas por `\n\n`
5. `runAgent(...)` — em try/catch. Se falhar, fallback `'oi, tive um probleminha agora pra te responder, me dá só um instante que eu já volto'`
6. Pra cada msg de saída:
   - `persistAssistantPending` (status='pending')
   - **Na primeira msg apenas**: `markBufferProcessed(bufferIds)` atomicamente. Se claimed === 0, abortar (outro flush ganhou a corrida) → marca pending como failed e return
   - `evolution.sendPresence(instance, sessionId, 'composing', typingMs)` + `delay(typingMs)`
   - `evolution.sendText(...)` → `markAssistantSent(pendingId, evolutionMessageId)`
   - `delay(interMessageMs)` entre msgs
   - Em erro de envio → `markAssistantFailed`, break loop

#### `initChatbot()` — chama `registerFlushHandler(flushSession)`

### Comportamentos críticos a NÃO esquecer
- **Idempotência**: `chat_messages.evolution_message_id` é UNIQUE (parcial). Insert duplicado → log debug, não crash.
- **Atomicidade do claim**: `markBufferProcessed` retorna `count` — se 0, outro processo ganhou, abortar.
- **Anti-reentrância**: `safeFlush` mantém Map de inflight Promises por sessionId.
- **Sweeper**: detecta zumbis (assistant pending > 120s → marca failed) e flusha buffers órfãos.
- **Pause de IA**: respeitado em `flushSession` E em `addToBuffer` (continua buferizando, só não flusha).

---

## 🚪 Rotas HTTP (`src/routes/`)

### `routes/health.ts`
- `GET /health` → `{status: 'ok'}` 200
- `GET /health/ready` → `{status: 'ok', supabase: 'ok'}` 200 se conseguir um query simples no Supabase, 503 senão

### `routes/webhooks/evolution.ts`
- `POST /webhooks/evolution`
- Validar body é objeto. Senão 400.
- Chamar `handleEvolutionWebhook(body)` em **fire-and-forget** (`.catch` log error). **NÃO await** — retornar 200 imediatamente. Evolution faz retry agressivo se demorar.

---

## 🚀 Bootstrap (`src/server.ts`)

```typescript
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
// ... imports

async function main() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    requestIdHeader: 'x-request-id',
    bodyLimit: 5 * 1024 * 1024, // 5MB
  });

  await app.register(sensible);
  await app.register(healthRoutes);
  await app.register(evolutionWebhookRoutes);

  initChatbot();
  startBufferSweeper();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ port: env.PORT }, 'server listening');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown signal received');
    await app.close();
    stopBufferSweeper();
    await awaitInflightFlushes(25_000);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
void main();
```

---

## 📄 Documentação (`README.md`, `CLAUDE.md`)

### `README.md`
- Título + descrição em 1 parágrafo
- Seção "Como instalar" em 4 passos visuais (baixar app Claude Code, baixar zip, abrir pasta, conversar)
- Seção "Stack" listando tecnologias
- Seção "Você vai precisar de" listando contas necessárias com emojis
- Seção "O que esse template NÃO faz" (define escopo)
- Licença MIT

### `CLAUDE.md`
Guia ponta-a-ponta pra Claude Code conduzir um usuário leigo. Estrutura:
1. **Pré-requisitos** (contas + custos estimados + tempo)
2. **Fase 0** — Detectar stack + instalar (brew/winget/Node/Git/gh) com avisos sobre senha sudo / UAC
3. **Fase 1** — `gh auth login` (com fallback PAT manual)
4. **Fase 2** — Preparar projeto local (`npm install`, copy `.env.example` → `.env` via Read+Write, não `cp`)
5. **Fase 3** — Criar projeto Supabase (passo-a-passo com cuidado em `service_role` vs `anon`)
6. **Fase 4** — Conectar MCP Supabase (fechar+abrir app na MESMA pasta)
7. **Fase 5** — Entrevista 10 perguntas pra montar system_prompt (nome do agente, negócio, objetivo, tom, formalidade, restrições, CTA, FAQ, palavras-chave de pause)
8. **Fase 6** — Aplicar `schema.sql` via `mcp__supabase__apply_migration` + `seed.sql` via `mcp__supabase__execute_sql`
9. **Fase 7** — Criar repo GitHub (`gh repo create --private --source=. --push`)
10. **Fase 8** — Subir Postgres + Evolution + app na Railway (com `${{evolution-postgres.DATABASE_URL}}`, `node -e crypto.randomBytes(32).toString('hex')` pra AUTH_KEY, fluxo do QR Code)
11. **Fase 9** — Configurar webhook Evolution → app
12. **Fase 10** — Testar
13. Troubleshooting (não responde, webhook não chega, OpenAI 401, IA responde mas WhatsApp não recebe, como pausar manualmente, como mudar prompt)
14. Estrutura do projeto

---

## ✅ Critérios de aceitação

Ao terminar, o repositório deve:

1. ✅ `npm install` sem erros
2. ✅ `npm run typecheck` passa limpo (zero warnings, zero erros)
3. ✅ `npm run build` gera `dist/` válido
4. ✅ `node dist/server.js` sobe na porta 3000 (com `.env` mínimo válido)
5. ✅ `GET /health` retorna `{"status":"ok"}` 200
6. ✅ Zero secrets hardcoded — fazer `grep -rn "sk-\|AIza\|eyJ\|.supabase.co" src/` e não retornar nada real (só placeholders em comentários ok)
7. ✅ `.gitignore` contém `node_modules`, `dist`, `.env`, `.mcp.json`, `.claude/`
8. ✅ Pino redacta corretamente — testar localmente que `logger.info({SUPABASE_SERVICE_ROLE_KEY: 'leak'}, 'test')` imprime `[REDACTED]`
9. ✅ Schema SQL aplica sem erro num Supabase fresh (sem dependências de tabelas pré-existentes)
10. ✅ Documentação cobre Mac e Windows (sem comandos só-Mac sem equivalente)

---

## 🚫 Anti-padrões a evitar

- ❌ Usar `dotenv` (Zod já valida `process.env`)
- ❌ Hardcodar URL do Supabase, API keys, telefones de teste
- ❌ Logar conteúdo bruto sem passar pelo Pino redactor
- ❌ Fazer `await handleEvolutionWebhook(...)` na rota — Evolution faz retry agressivo, sempre fire-and-forget
- ❌ Inserir em `chat_messages` sem tratar erro 23505 (idempotência)
- ❌ Marcar buffer como processado ANTES de tentar enviar (perde mensagem se envio falhar)
- ❌ Adicionar feature flags pra coisas hipotéticas — só implemente o que está no escopo
- ❌ Inventar tabelas extras (leads, tickets, customers) — escopo é só as 4 listadas
- ❌ Configurar RLS policies para anon/authenticated — service_role bypassa, deixe fechado por padrão
- ❌ Comentários óbvios (`// inicializa o cliente`, `// importa fastify`) — só comente o WHY não-óbvio

---

## 📋 Ordem de implementação sugerida

1. `package.json` + `tsconfig.json` + `.gitignore` + `.dockerignore`
2. `src/config/env.ts` (define o contrato com env vars)
3. `src/lib/logger.ts` + `src/lib/supabase.ts` + `src/lib/openai.ts` + `src/lib/phone.ts` + `src/lib/evolution.ts`
4. `supabase/schema.sql` + `supabase/seed.sql`
5. `src/services/agent-config.ts` + `src/services/agent.ts`
6. `src/services/message-parsers.ts` + `src/services/media.ts`
7. `src/services/buffer.ts`
8. `src/services/chatbot.ts` (depende de tudo acima)
9. `src/routes/health.ts` + `src/routes/webhooks/evolution.ts`
10. `src/server.ts`
11. `Dockerfile` + `railway.json`
12. `.env.example` + `.mcp.json.example`
13. `README.md` + `CLAUDE.md`
14. Rodar `npm install && npm run typecheck && npm run build` pra validar
15. Reportar resultado consolidado (arquivos criados, validações passadas, próximos passos pro usuário)

---

## 📞 Quando me reportar

Ao final, me mande:
- Total de arquivos criados (esperado: ~25)
- Output de `npm run typecheck` (deve ser silencioso)
- Output de `npm run build` (deve ser silencioso)
- Confirmação de que zero secrets foram hardcodados
- Lista de próximas ações pro usuário (criar conta Supabase, etc — referenciando o `CLAUDE.md`)

**Não me peça permissão a cada passo.** Construa em sequência. Eu confio na sua execução. Se travar em algo ambíguo, escolha a opção mais simples e me avise no relatório final.

🚀 Boa construção.
