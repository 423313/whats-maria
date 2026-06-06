# Atalho — Configurar Railway via Claude for Chrome

Esta é uma **alternativa opcional** à Fase 8 do [`CLAUDE.md`](../CLAUDE.md). Em vez de você clicar manualmente no dashboard da Railway, a extensão **Claude for Chrome** opera o navegador por você e configura os 3 serviços (Postgres, Evolution API, app do agente) sozinha — você só cola valores quando ela pedir.

> **Importante:** este atalho cobre **apenas a Fase 8 (Railway)**. Continue usando o Claude Code app desktop para as outras fases (Supabase, MCP, entrevista do prompt, schema, QR Code, webhook) — a extensão do Chrome não tem acesso ao filesystem nem ao MCP do Supabase.

---

## ✅ Pré-requisitos

1. **Extensão Claude for Chrome** instalada — https://claude.com/chrome (precisa de plano pago Anthropic)
2. **Plano Anthropic**:
   - **Pro ($20/mês)** → funciona, mas só com modelo **Haiku 4.5** (mais cego em UI complexa, pode precisar de 1–2 retries em alguns passos)
   - **Max ($100+/mês)** → escolhe entre Haiku 4.5, Sonnet 4.6 ou **Opus 4.7** (recomendado, lida melhor com modais e telas inesperadas)
3. **Conta Railway** com cartão cadastrado (free tier limita a 1 serviço; o template precisa de 3).
4. **Conta GitHub** logada no navegador.

---

## 🟦 Passo 0 — Subir o template pro SEU GitHub (OBRIGATÓRIO)

A Railway só consegue fazer deploy de repos que **você** controla. Antes de chamar a extensão, **suba uma cópia deste template pra sua conta GitHub**.

Escolha o caminho mais fácil pra você:

### Caminho A — "Use this template" (mais rápido, recomendado)

> *Funciona se este repo estiver marcado como template repository. Se não estiver, vá pro Caminho B.*

1. Vá no topo desta página do GitHub e clique no botão verde **"Use this template"** → **"Create a new repository"**.
2. Em **Repository name**, escolha um nome (ex: `meu-agente-whatsapp`).
3. Marque **Public** ou **Private** (ambos funcionam com Railway).
4. **Create repository**. Pronto — você tem uma cópia limpa no seu GitHub, sem histórico de commits do template.

### Caminho B — Fork

1. No topo desta página, clique em **"Fork"** → **"Create fork"**.
2. Escolha sua conta como destino.
3. **Create fork**. Pronto.

> Diferença: o fork mantém vínculo com o repo original (mostra "forked from..."). O "Use this template" é uma cópia totalmente independente. Pra quem vai customizar pra um cliente, **template é melhor**.

### Caminho C — Baixar zip + criar repo manual (sem Git)

1. Baixe o zip: https://github.com/orodrigobarcelos/imersao-sac-agente-ia-whatsapp/archive/refs/heads/main.zip
2. Extraia.
3. No GitHub, clique em **"+"** (canto superior direito) → **"New repository"**. Nome: `meu-agente-whatsapp`. **Create**.
4. Na página vazia do repo novo, clique em **"uploading an existing file"**.
5. Arraste a pasta extraída (todos os arquivos exceto `node_modules` e `dist` se existirem).
6. **Commit changes**.

### Caminho D — Linha de comando (pra quem mexe com Git)

```bash
gh repo create meu-agente-whatsapp --public --clone --source=.
cd meu-agente-whatsapp
# baixe os arquivos do template aqui (zip ou git clone do template em outra pasta e copie)
git add . && git commit -m "initial: template do agente WhatsApp"
git push -u origin main
```

### ✅ Antes de seguir

Anote o nome do **SEU** repo no formato `seu-usuario-github/nome-do-repo` (ex: `joaosilva/meu-agente-whatsapp`). Você vai precisar dele no Passo 3.

---

## 🚀 Passo 1 — Abrir Railway

Vá em https://railway.com/new e faça login. Crie um **Empty Project** (ou aceite o que aparecer).

---

## 🧩 Passo 2 — Abrir a extensão Claude for Chrome

Clique no ícone do Claude no canto superior direito do Chrome. **Ative a opção "Ask before acting"** (segurança — ela pausa antes de cada ação sensível).

---

## 📋 Passo 3 — Colar o prompt abaixo

Copie tudo entre as linhas tracejadas e cole na conversa da extensão. Aperte enter.

```text
─────────────────────────────────────────────────────────────────
Preciso que você configure 3 serviços neste projeto Railway, na ordem abaixo.
PAUSE e me pergunte SEMPRE que precisar de valor que eu tenha que colar
(chaves, URL, nome de repo). NÃO invente valores.

Confirme cada fase comigo antes de avançar pra próxima.

═══════════════════════════════════════════════════
FASE 0 — Preparação
═══════════════════════════════════════════════════
1. Renomeie o projeto pra "whatsapp-agent" (canto superior esquerdo).
2. Me diga "pronto, qual o nome do repo GitHub do agente?" e aguarde
   minha resposta — vou te passar no formato "owner/repo".

═══════════════════════════════════════════════════
FASE 1 — Postgres do Evolution
═══════════════════════════════════════════════════
1. Clique em "Database" no menu de criação.
2. Escolha "Add PostgreSQL".
3. Quando aparecer, vá em Settings do serviço e renomeie pra "evolution-postgres".
4. Confirme comigo: "evolution-postgres criado, pronto pra Fase 2?"

═══════════════════════════════════════════════════
FASE 2 — Evolution API (Docker Image)
═══════════════════════════════════════════════════
1. Volte ao canvas do projeto. Clique em "+ New" ou "Create" no canvas.
2. Escolha "Docker Image".
3. No campo de imagem, digite EXATAMENTE: evoapicloud/evolution-api:latest
4. Confirme criação. Renomeie o serviço pra "evolution-api".
5. Vá em Variables do "evolution-api" e PAUSE — me peça pra colar a
   AUTHENTICATION_API_KEY (vou gerar e colar uma string hex de 64 chars).
6. Quando eu colar, configure as Variables (use Raw Editor se disponível):

   SERVER_TYPE=http
   SERVER_PORT=8080
   SERVER_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
   AUTHENTICATION_API_KEY=<a chave que eu te passei>
   DATABASE_ENABLED=true
   DATABASE_PROVIDER=postgresql
   DATABASE_CONNECTION_URI=${{evolution-postgres.DATABASE_URL}}
   DATABASE_CONNECTION_CLIENT_NAME=evolution_exchange
   CACHE_REDIS_ENABLED=false
   CACHE_LOCAL_ENABLED=true
   LOG_LEVEL=ERROR,WARN,INFO
   CONFIG_SESSION_PHONE_CLIENT=Chrome
   CONFIG_SESSION_PHONE_NAME=Chrome

7. Vá em Settings → Networking → "Generate Domain" (porta 8080).
8. Aguarde o deploy ficar verde (pode levar até 3 min — me avise quando
   terminar ou se der erro).
9. Confirme comigo antes da Fase 3.

═══════════════════════════════════════════════════
FASE 3 — Agente IA (GitHub Repo)
═══════════════════════════════════════════════════
1. No canvas, "+ New" → "GitHub Repo".
2. Se Railway pedir pra autorizar GitHub, PAUSE e me peça pra completar
   o OAuth (vou clicar nos popups).
3. Selecione o repo que eu te passei na Fase 0.
4. Renomeie o serviço pra "ia-whatsapp-app".
5. Vá em Variables e PAUSE — preciso te passar:
   - SUPABASE_URL
   - SUPABASE_SERVICE_ROLE_KEY
   - OPENAI_API_KEY
   - EVOLUTION_INSTANCE (vou escolher um nome)

6. Quando eu colar tudo, configure as Variables:

   NODE_ENV=production
   PORT=3000
   LOG_LEVEL=info
   SUPABASE_URL=<vou colar>
   SUPABASE_SERVICE_ROLE_KEY=<vou colar>
   EVOLUTION_URL=http://evolution-api.railway.internal:8080
   EVOLUTION_API_KEY=<a MESMA AUTHENTICATION_API_KEY da Fase 2>
   EVOLUTION_INSTANCE=<vou colar>
   OPENAI_API_KEY=<vou colar>
   AGENT_BUFFER_SWEEPER_MS=20000

7. Settings → Networking → "Generate Domain" (porta 3000).
8. Aguarde deploy ficar verde.
9. Quando estiver verde, abra https://<domínio-gerado>/health numa nova
   aba e confirme que retorna {"status":"ok"}.

═══════════════════════════════════════════════════
FASE 4 — Resumo parcial
═══════════════════════════════════════════════════
Me passe e PAUSE até eu confirmar que parei o WhatsApp via QR Code:
- URL pública do evolution-api (vou abrir o /manager e fazer QR Code)
- URL pública do ia-whatsapp-app (vou usar na Fase 5 pra configurar webhook)
- Status verde de TODOS os 3 serviços

NÃO tente configurar webhook ainda — depende do QR estar pareado.

═══════════════════════════════════════════════════
FASE 5 — Webhook do Evolution → app (FAÇA SÓ DEPOIS DE EU CONFIRMAR QR)
═══════════════════════════════════════════════════
Quando eu disser "QR pareado, pode seguir", abra numa nova aba:

   https://<URL pública do evolution-api>/manager

Faça login com a AUTHENTICATION_API_KEY (a mesma da Fase 2).

1. Abra a instância que eu pareei (nome bate com EVOLUTION_INSTANCE).
2. Vá na aba "Webhook" (ou "Eventos" / "Settings → Webhook" — varia).
3. Configure EXATAMENTE assim — NÃO INVENTE nem encurte a URL:

   URL:      https://<URL pública do ia-whatsapp-app>/webhooks/evolution
             (note bem: "webhooks" no plural E "/evolution" no final)
   Events:   MESSAGES_UPSERT  e  MESSAGES_UPDATE  (marque os DOIS)
   Enabled:  true (marcado/ligado)
   Webhook by Events: pode deixar desligado

4. Salvar. Confirme comigo.

═══════════════════════════════════════════════════
REGRAS GERAIS
═══════════════════════════════════════════════════
- Nunca invente chaves ou URLs — sempre PAUSE e pergunte.
- A URL do webhook é SEMPRE no formato /webhooks/evolution (plural + sufixo).
  Se estiver em dúvida, PAUSE e me pergunte.
- Se algum deploy demorar mais de 5 min, PAUSE e me mostre os logs.
- Se Railway pedir cartão de crédito, PAUSE e me avise.
- Se a UI estiver diferente do que eu descrevi, descreva o que você
  está vendo antes de chutar.
─────────────────────────────────────────────────────────────────
```

---

## 🤝 Passo 4 — Responder o que ela pedir

A extensão vai pausar nas Fases 0, 2, 3 pra você colar valores. **Não invente nada** — se você ainda não tem Supabase ou OpenAI configurados, pause aqui, abra o Claude Code desktop, faça as Fases 3, 5 e 6 do CLAUDE.md primeiro (criar Supabase + entrevista do prompt + schema), pegue os valores reais e volte.

**Pra gerar a `AUTHENTICATION_API_KEY` rapidinho**, abra o Terminal (Mac) ou PowerShell (Windows) e rode:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Cole o resultado quando a extensão pedir.

---

## ⚠️ Limitações conhecidas

| O que pode dar errado | Como contornar |
|---|---|
| Haiku 4.5 (Pro) erra clique em modal/dropdown | Refaça o passo manualmente, peça "tente de novo, agora vai em X" |
| Railway muda UI e a extensão fica perdida | Descreva você o que tá na tela e diga onde clicar |
| OAuth do GitHub abre popup que ela não vê | Você completa o OAuth manualmente e diz "pronto, continue" |
| Deploy demora >5min | Espera mais — Evolution API às vezes leva 5–8min |
| Repo não aparece na lista da Railway | Volta no GitHub e dá permissão da Railway acessar seu repo (Settings → Applications → Railway) |

---

## 🔄 Depois que a extensão terminar a Fase 4 (Railway)

A extensão vai pausar e te entregar as duas URLs públicas. Faça nesta ordem:

1. **Conectar WhatsApp via QR Code (você manualmente)** — abra `https://<seu-evolution>.up.railway.app/manager`, faça login com a `AUTHENTICATION_API_KEY`, crie a instância com o mesmo nome do `EVOLUTION_INSTANCE` que você passou pra extensão, gere QR e escaneie com o WhatsApp dedicado (Fase 8.3.1 do CLAUDE.md).

2. **Voltar na extensão e dizer "QR pareado, pode seguir"** — aí ela executa a **Fase 5 do prompt** (configura o webhook apontando pro app, com a URL correta `/webhooks/evolution`).

3. **Testar** mandando uma mensagem de outro WhatsApp (Fase 10 do CLAUDE.md).

> Se preferir configurar o webhook manualmente em vez de deixar a extensão fazer, siga a Fase 9 do [`CLAUDE.md`](../CLAUDE.md#fase-9--configurar-webhook-do-evolution). A URL é sempre `https://<seu-app>.up.railway.app/webhooks/evolution` (plural + sufixo `/evolution`).
