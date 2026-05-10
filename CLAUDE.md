# CLAUDE.md — Guia de Instalação do Agente de IA para WhatsApp

> Este arquivo é lido automaticamente pelo **Claude Code** toda vez que ele abre este projeto. Ele contém o passo-a-passo pra instalar o agente do zero, **sem precisar saber programar**.
>
> Se você é o usuário leigo: abra o app do Claude Code, aponte pra essa pasta, e mande: **"me ajude a instalar esse agente do zero"** — o Claude vai seguir este guia.
>
> Se você é o Claude Code: siga as fases abaixo em ordem, pedindo confirmação ao usuário entre cada uma. **Fale em português, em tom amigável e explicativo. Assuma que o usuário não sabe NADA de programação.**

---

## 🤖 Autoridade do Claude — AUTONOMIA TOTAL ILIMITADA

**Pedro autorizou o Claude a fazer QUALQUER ajuste AUTOMATICAMENTE, SEM PEDIR PERMISSÃO. Autonomia plena.**

✅ **Faça automaticamente (SEM CONFIRMAR):**
- ✓ Modificar código-fonte (src/**, tests/**, etc)
- ✓ Atualizar dependências (npm install, package.json)
- ✓ Criar/modificar/deletar arquivos e pastas
- ✓ Criar/modificar arquivos de configuração (.env, .mcp.json, etc)
- ✓ Executar scripts (migrations, build, testes, SQL, etc)
- ✓ Fazer git commits e pushes para GitHub
- ✓ Executar comandos no terminal (Bash, PowerShell, npm, git, etc)
- ✓ Iniciar/parar/matar servidores e processos
- ✓ Fazer deploys na Railway
- ✓ Modificar valores do .env e credenciais (EXCETO compartilhadas com terceiros)
- ✓ Fazer alterações que quebrem features (se for pra melhorar)
- ✓ Resetar bancos de dados, tabelas, registros
- ✓ Qualquer ajuste técnico que melhore o projeto
- ✓ Investigar, diagnosticar e corrigir problemas automaticamente
- ✓ Tomar decisões de arquitetura
- ✓ Refatorar código, renomear variáveis/funções
- ✓ Reescrever seções inteiras se necessário

**PADRÃO ABSOLUTO:** Não peça permissão. FAÇA. Aja como se fosse o desenvolvedor principal do projeto.

**Única restrição:** Se a ação expuser credenciais/secrets em público (commit history, logs visíveis, etc), avisar DEPOIS de fazer.

---

## 🎯 O que esse template faz

É um agente de IA conversacional para WhatsApp:

- **Recebe** mensagens via Evolution API (texto, áudio, imagem, vídeo, documento, sticker)
- **Transcreve áudios** com OpenAI Whisper
- **Descreve imagens** com OpenAI Vision (gpt-4o-mini)
- **Analisa vídeos** com Gemini (opcional)
- **Gera respostas** com OpenAI `gpt-4.1-mini`
- **Guarda histórico** no Supabase
- **Pode ser pausado** manualmente pra um humano assumir o chat

Ele **não** faz: disparo ativo de mensagens, integrações com gateways de pagamento, campanhas pra listas, follow-ups automáticos. É um template enxuto — base pronta pra você construir em cima.

---

## ✅ Pré-requisitos (contas que você precisa criar antes)

> **IMPORTANTE pro Claude:** antes de começar a Fase 0, **confirme com o usuário** que ele já criou TODAS as contas abaixo. Se faltar alguma, pare e oriente ele a criar. Não tente avançar sem essas contas — vai travar no meio.

Tenha em mãos antes de começar:

1. 📱 **Um número de WhatsApp dedicado** pro agente (chip novo ou número secundário). **NÃO use seu WhatsApp pessoal** — risco de banimento permanente. Compre um chip novo (R$15) se precisar.
2. 🤖 **Conta Anthropic + plano Claude Pro ATIVO** — https://claude.ai/login (criar conta) → depois https://claude.com/upgrade (assinar Pro, US$ 20/mês). **Sem o plano pago, o app Claude Code não funciona.**
3. 🧠 **Conta OpenAI com cartão e créditos**:
   - Criar: https://platform.openai.com/signup
   - Adicionar cartão: https://platform.openai.com/settings/organization/billing/payment-methods
   - Comprar créditos: https://platform.openai.com/settings/organization/billing/overview → "Add credit balance" → mínimo US$ 5
   - Gerar API key: https://platform.openai.com/api-keys → "+ Create new secret key" → copiar (começa com `sk-proj-...`) e GUARDAR (não dá pra ver de novo)
4. 🗄️ **Conta Supabase** — https://supabase.com → "Start your project" → login com GitHub é o mais fácil.
5. 🐙 **Conta GitHub** — https://github.com/signup. **Recomendado**: ativar 2FA usando o app Authenticator (NÃO SMS) pra evitar problemas no `gh auth login`.
6. 🚂 **Conta Railway** — https://railway.app → "Login" → "Login with GitHub" (mais rápido). Adicionar cartão em https://railway.app/account/billing pra desbloquear deploy de 3 serviços (free tier limita a 1).
7. 🎬 **Conta Gemini (OPCIONAL)** — só pra analisar **vídeos**. Áudio e imagem usam OpenAI. Chave em https://aistudio.google.com/apikey

**Custo estimado mensal:**
- Claude Pro: US$ 20 (fixo)
- OpenAI: US$ 5–30 (depende do volume — cada conversa custa ~$0.001)
- Railway: US$ 5–10 (free tier inicial cobre 1 mês de teste)
- Supabase: US$ 0 (free tier basta pra começar)
- **Total mês 1: ~US$ 25 / Mês recorrente: ~US$ 30–60**

**Tempo total da instalação:** ~1h30 pra leigo absoluto. ~30min pra quem já mexeu com programação.

---

## 🤖 Fases da instalação

> Claude, execute em ordem. Confirme com o usuário ao terminar cada fase antes de avançar pra próxima.

---

### Fase 0 — Preparar a máquina (instala o que falta)

O usuário pode estar com nada instalado. Você (Claude) vai detectar e instalar.

**ATENÇÃO Claude:** antes de rodar comandos, **avise o usuário** sobre os 2 momentos em que ele vai precisar interagir:

> "Vou instalar algumas coisas no seu computador. Em 2 momentos você vai precisar fazer algo:
>
> 1. **Autorizar a instalação:**
>    - **No Mac**: vai aparecer `Password:` no terminal — digite a senha do seu Mac e aperte Enter. **Você não vai ver os caracteres digitados, é normal.** Aperte Enter mesmo sem ver nada acontecer.
>    - **No Windows**: vai aparecer um popup do Windows ("Quer permitir que esse app faça alterações?") — clique em **Sim**.
> 2. **Browser pra GitHub** — vai abrir uma página do GitHub pra fazer login. Faça login normal."

**Detectar o que tem:**

```bash
node --version
git --version
gh --version
```

Se algum não estiver instalado, instale automaticamente:

#### No Mac

Se Homebrew não estiver instalado:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

> ⚠️ Esse comando vai pedir a **senha de admin do Mac**. Avise o usuário antes.

Depois:
```bash
brew install node git gh
```

> Pode levar 5–10 min na primeira vez.

#### No Windows

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install GitHub.cli
```

> Se aparecer prompt do UAC ("Quer permitir que esse app faça alterações?") → Sim.

**Validar:**
```bash
node --version    # deve mostrar v20 ou superior
git --version
gh --version
```

Diga ao usuário em linguagem simples o que foi instalado e o que cada coisa serve.

#### Se brew install falhar no Mac

Causas comuns:
- **Mac antigo sem Xcode Command Line Tools**: `xcode-select --install` (vai abrir popup pra instalar — pode levar 20min).
- **Permissão negada**: peça ao usuário pra rodar `sudo chown -R $(whoami) $(brew --prefix)/*`.
- **Conexão lenta**: tenta de novo, brew baixa muita coisa.

#### Se winget falhar no Windows

Causas comuns:
- **`winget` não reconhecido**: o Windows é antigo (pré 1809) ou o App Installer está faltando. Solução: instale o **App Installer** pela Microsoft Store: https://apps.microsoft.com/detail/9NBLGGH4NNS1
- **Política bloqueia**: rode o PowerShell como **Administrador** (botão direito → "Executar como administrador") e tente de novo.
- **Plano B (download manual)**: se nada funcionar, baixe os instaladores direto:
  - Node.js LTS: https://nodejs.org/en/download
  - Git for Windows: https://git-scm.com/download/win
  - GitHub CLI: https://cli.github.com (botão Download)
  Rode cada instalador, "Next, Next, Finish" — depois feche e abra o Claude Code de novo pra ele detectar.

---

### Fase 1 — Login no GitHub (CLI)

> **Claude:** o `gh auth login` é interativo (precisa de input no terminal). Se o terminal interno do app travar, use a alternativa abaixo (PAT manual).

#### Opção A — Fluxo recomendado (interativo)

```bash
gh auth login
```

Responda quando o terminal perguntar:
- *What account?* → **GitHub.com**
- *Preferred protocol?* → **HTTPS**
- *Authenticate Git with your GitHub credentials?* → **Yes**
- *How would you like to authenticate?* → **Login with a web browser**

Vai aparecer um código de 8 dígitos (ex: `ABCD-1234`). **Copie esse código** e cole quando o GitHub abrir no browser. Faça login normal e cole o código.

#### Opção B — Se travou (Personal Access Token manual)

1. Vá em https://github.com/settings/tokens/new?scopes=repo,workflow,admin:public_key&description=claude-code
2. Clique em **Generate token** (no fim da página)
3. Copie o token (começa com `ghp_...` ou `github_pat_...`)
4. Cole o token quando rodar:

```bash
gh auth login --with-token
```

Depois confirme: `gh auth status` deve mostrar "Logged in to github.com as ...".

---

### Fase 2 — Preparar o projeto local

1. Instalar dependências do projeto:
   ```bash
   npm install
   ```
2. Validar que compila:
   ```bash
   npm run typecheck
   ```
3. Criar arquivos de configuração local (vão ser preenchidos nas próximas fases). **Claude:** use suas próprias tools `Read` + `Write` pra copiar o conteúdo dos arquivos `.env.example` → `.env` e `.mcp.json.example` → `.mcp.json`. Isso funciona em Mac/Windows/Linux sem depender de comandos shell (`cp` não existe no cmd do Windows).

   Se preferir usar shell, use comandos cross-platform via Node:
   ```bash
   node -e "require('fs').copyFileSync('.env.example', '.env')"
   node -e "require('fs').copyFileSync('.mcp.json.example', '.mcp.json')"
   ```

---

### Fase 3 — Criar projeto no Supabase

> **Claude:** vai pegar **3 valores** do Supabase. Peça **um de cada vez** pro usuário não se confundir.

#### Passo 1 — Criar o projeto

1. Abrir https://supabase.com/dashboard → **New Project**
2. Preencher:
   - **Name**: `agente-whatsapp` (ou outro)
   - **Database Password**: clique em **Generate a password** e SALVE essa senha (você vai usar pra acessar o banco direto, se precisar)
   - **Region**: **South America (São Paulo)**
3. **Create new project**. Aguardar ~2 min até o status virar verde.

#### Passo 2 — Pegar `SUPABASE_URL` (a URL do projeto)

1. No menu esquerdo, clique no ícone de engrenagem ⚙️ → **API** (ou direto em https://supabase.com/dashboard/project/_/settings/api)
2. Em **Project URL**, copie a URL inteira (formato `https://abcdefgh.supabase.co`).
3. **Cole no chat** pro Claude preencher o `.env`.

#### Passo 3 — Pegar `SUPABASE_SERVICE_ROLE_KEY` (a chave certa)

⚠️ **CUIDADO**: nessa tela tem **DUAS chaves** que parecem iguais. Você quer a **`service_role`**, NÃO a **`anon` / `publishable`**.

1. Na mesma tela (Settings → API), role até **Project API keys**.
2. Tem uma chave chamada `anon` (ou `publishable`) — **NÃO É ESSA**.
3. Tem outra chamada **`service_role`** com um botão **"Reveal"** ou olhinho 👁️ — **clique pra revelar** e copie ela.
4. **Cole no chat**.

> A `service_role` é uma chave master. NUNCA mostre ela em vídeo, post, screenshot público, ou suba pro GitHub. Se vazar, gire imediatamente em Settings → API → "Roll service_role secret".

#### Passo 4 — Pegar o `Reference ID` (pro MCP)

1. ⚙️ → **General** (ou https://supabase.com/dashboard/project/_/settings/general)
2. Procure **Reference ID** (string tipo `abcdefghijklmnop`).
3. **Cole no chat**.

Você (Claude) edita os arquivos automaticamente conforme o usuário cola os valores:
- `.env`: preencha `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`.
- `.mcp.json`: substitua `YOUR_PROJECT_REF` pelo Reference ID.

---

### Fase 4 — Conectar o MCP do Supabase ao Claude Code

> O MCP é o que permite o Claude Code criar tabelas, rodar SQL e ver o banco automaticamente.

#### Passo 1 — Confirmar que `.mcp.json` está preenchido

Você (Claude) já editou na Fase 3. Confirme que `YOUR_PROJECT_REF` foi substituído pelo Reference ID real, abrindo o arquivo `.mcp.json` e mostrando ao usuário.

#### Passo 2 — Fechar e abrir o app NA MESMA PASTA

Diga ao usuário, com calma:

> "Agora você precisa fechar o app Claude Code completamente e abrir de novo, **apontando pra essa mesma pasta**. O MCP só carrega quando o app inicia.
>
> Como fazer:
> 1. Feche o app (⌘+Q no Mac, X no Windows). Não é só fechar a janela, é fechar o app.
> 2. Abra o app de novo.
> 3. Vá em **File → Open Recent** e clique no nome dessa pasta. Se não aparecer, vá em **File → Open Folder** e selecione a pasta `imersao-sac-agente-ia-whatsapp-main` de novo.
> 4. Quando reabrir, vai aparecer um popup perguntando se você confia no MCP server do Supabase. **Clique em "Allow"** ou "Trust".
> 5. Depois disso, **me diga 'continuar'** que eu sigo de onde paramos."

#### Passo 3 — Gerar o Personal Access Token (PAT) do Supabase, se for pedido

Se o app pedir um PAT pra autenticar o MCP:

1. Abrir https://supabase.com/dashboard/account/tokens
2. **Generate new token** → nome: `claude-code-mcp` → **Generate**.
3. Copiar o token (começa com `sbp_...`) e colar no popup do Claude Code.

#### Passo 4 — Validar que o MCP funciona

Teste perguntando ao Claude (você mesmo, no chat):

> *"liste as tabelas do meu Supabase"*

Você (Claude) deve usar `mcp__supabase__list_tables`. Se voltar resposta (mesmo vazia, "no tables yet"), o MCP tá vivo. Se der erro de auth/network, refazer Passo 2.

---

### Fase 5 — Entrevista pra montar o system prompt do agente

**ESSA É A FASE MAIS IMPORTANTE.** É onde a personalidade do agente nasce.

Faça as 10 perguntas abaixo **uma de cada vez**, esperando o usuário responder antes de avançar. Use tom de conversa, não de formulário. Você pode reformular a pergunta se sentir que o usuário não entendeu.

#### Perguntas

1. **Qual é o nome do seu agente?** (ex: "Ana", "Lucas da equipe X", "Suporte da Empresa Y")
2. **O que é o negócio / empresa / produto do qual ele fala?** Em 2-3 frases.
3. **Qual é o objetivo principal do agente?**
   - Vender / qualificar leads
   - Atender dúvidas (SAC)
   - Agendar (consultas, visitas, reuniões)
   - Informar / educar
   - Outro (descreva)
4. **Quem é o público-alvo?** (ex: "donos de pequenos e-commerces", "pacientes que já compraram um plano", "alunos da imersão X")
5. **Qual é o tom de voz?** Pode combinar:
   - Formal e profissional
   - Amigável e próximo
   - Direto e objetivo
   - Bem-humorado e leve
   - Técnico e detalhista
6. **Que nível de formalidade no português?** ("você", "tu", gírias? emojis? "oi/olá"?)
7. **O que o agente NÃO pode fazer ou dizer?** (ex: nunca prometer desconto, nunca falar mal de concorrente, não dar diagnóstico médico)
8. **Tem uma ação esperada no final da conversa?** (ex: mandar link do checkout, agendar no Cal.com, pedir e-mail pra enviar proposta, transferir pra humano)
9. **Que informações importantes o agente precisa saber SEMPRE?** (preços, horários, endereço, política de reembolso, FAQ — liste tudo)
10. **Tem palavra-chave que, se o usuário digitar, deve pausar o agente e chamar um humano?** (ex: "atendente", "cancelar", "reclamação")

Pergunte se ele quer ajustar algo antes de salvar. **Mostre o prompt final em markdown e peça aprovação explícita.**

#### Estrutura do prompt final

Monte assim:

```markdown
# Identidade
Você é {{nome}}, {{papel}} da {{empresa}}.

# Contexto do negócio
{{descrição}}

# Objetivo da conversa
{{objetivo}}

# Tom de voz
{{tom + formalidade}}

# Regras (o que NÃO fazer)
- {{restrição 1}}
- {{restrição 2}}

# Informações importantes
{{FAQ / dados que ele precisa saber}}

# Ação esperada
{{CTA no fim da conversa}}

# Comportamento de pausa
Se o usuário digitar palavras como {{palavras-chave}}, responda apenas: "Vou chamar um atendente humano pra te ajudar, só um momento" e pare.

# Formato das respostas (HUMANIZAÇÃO — REGRA CRÍTICA)
SEMPRE divida sua resposta em VÁRIAS mensagens curtas, simulando como
um humano digita no WhatsApp. NUNCA mande um bloco único e longo.

Regras obrigatórias:
- Cada mensagem: 1-3 linhas no máximo (frases curtas, fôlego natural)
- Divida em 2-5 mensagens consecutivas — uma ideia por mensagem
- Mesmo respostas simples ("ok!", "perfeito") podem virar 2 mensagens
  se houver complemento (ex: "perfeito!" + "vou te enviar o link agora")
- Quebra natural: confirmação numa msg, próximo passo na outra,
  detalhe/CTA na terceira
- Pensa em como você mandaria isso pra um amigo no WhatsApp — em
  pedaços, não em parágrafo

Outras regras de formato:
- Não use markdown (negrito, itálico, bullets) — só texto puro
- No máximo 1 emoji por mensagem, e só se combinar com o tom
- Sempre responda em português brasileiro
- Não comece toda resposta com "olá" ou cumprimento — só na primeira
  mensagem da conversa
```

> **Atenção, Claude:** quando montar o prompt final na Fase 5, **reforce essa seção de humanização com exemplos concretos** baseados no negócio do usuário. Ex: se for clínica odontológica, mostre como dividir "agendamento confirmado → vou te enviar localização → qualquer dúvida me chama". A humanização é o que diferencia um bot de um assistente que parece humano — não deixe vago.

---

### Fase 6 — Criar tabelas no Supabase via MCP

Com o prompt aprovado:

1. **Aplicar o schema** — leia `supabase/schema.sql` e execute via `mcp__supabase__apply_migration` (nome: `template_initial_schema`).

2. **Aplicar o seed** — leia `supabase/seed.sql`, substitua os placeholders:
   - `{{SYSTEM_PROMPT}}` → o prompt da Fase 5
   - `{{OPENAI_MODEL}}` → `gpt-4.1-mini`
   - Se o usuário deu chave Gemini, adicione `update agent_configs set gemini_api_key = '...' where agent_type = 'default';`

   Execute via `mcp__supabase__execute_sql`.

3. **Confirmar**: `select agent_type, enabled, openai_model, length(system_prompt) as prompt_chars from agent_configs;`

---

### Fase 7 — Criar repositório no GitHub

Como o repositório do template é PÚBLICO, o usuário precisa criar uma cópia PRIVADA pra ele.

```bash
gh repo create agente-whatsapp --private --source=. --remote=origin --push
```

Substitua `agente-whatsapp` pelo nome que ele preferir.

---

### Fase 8 — Subir Postgres + Evolution API + app na Railway

> 💡 **Atalho opcional:** se você tem a extensão **Claude for Chrome** instalada, pode pular os cliques manuais abaixo e deixar a extensão configurar tudo sozinha. Veja [`docs/RAILWAY_VIA_CHROME.md`](./docs/RAILWAY_VIA_CHROME.md).

Arquitetura final (3 serviços no mesmo projeto Railway):

```
┌─────────────────┐     ┌──────────────────┐     ┌───────────────────┐
│ evolution-      │────▶│ evolution-api    │◀────│ ia-whatsapp-app   │
│ postgres        │     │ (Evolution)      │     │ (este projeto)    │
└─────────────────┘     └──────────────────┘     └───────────────────┘
```

#### 8.1 — Criar projeto na Railway

1. Vá em https://railway.app/new
2. **New Project** → "Empty Project". Nome: `whatsapp-agent`.

#### 8.2 — Postgres do Evolution

1. Dentro do projeto: **+ New** → **Database** → **PostgreSQL**.
2. Renomeie pra `evolution-postgres` (Settings → nome).

#### 8.3 — Evolution API

1. **+ New** → **Docker Image** → `evoapicloud/evolution-api:latest`.
2. Renomeie pra `evolution-api`.
3. **Gere a `AUTHENTICATION_API_KEY`** (chave forte aleatória) usando Node — funciona em Mac/Windows/Linux:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Vai imprimir uma string de 64 caracteres hexadecimais (ex: `3f8a91c2...`). **Copie e guarde** — você vai usar nessa Fase E na Fase 8.4 (no app).

4. Em **Variables**, cole:

   ```
   SERVER_TYPE=http
   SERVER_PORT=8080
   SERVER_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
   AUTHENTICATION_API_KEY=<cole a chave gerada no passo 3>
   DATABASE_ENABLED=true
   DATABASE_PROVIDER=postgresql
   DATABASE_CONNECTION_URI=${{evolution-postgres.DATABASE_URL}}
   DATABASE_CONNECTION_CLIENT_NAME=evolution_exchange
   CACHE_REDIS_ENABLED=false
   CACHE_LOCAL_ENABLED=true
   LOG_LEVEL=ERROR,WARN,INFO
   CONFIG_SESSION_PHONE_CLIENT=Chrome
   CONFIG_SESSION_PHONE_NAME=Chrome
   ```

5. **Settings → Networking → Generate Domain** (URL pública).
6. Aguardar deploy ficar verde (~3 min).

#### 8.3.1 — Conectar o WhatsApp via QR Code

> **Atenção:** o QR Code expira em ~30 segundos. Tenha o celular do número dedicado **na mão** antes de começar.

**Antes de gerar o QR:** no celular do número dedicado, abra o WhatsApp e vá em:
- **Mac/iOS**: WhatsApp → ⚙️ Configurações → **Aparelhos conectados** → **Conectar um aparelho**.
- **Android**: WhatsApp → ⋮ (3 pontinhos) → **Aparelhos conectados** → **Conectar um aparelho**.

A câmera vai abrir aguardando o QR.

**Agora no computador:**

1. Abrir `https://<seu-evolution>.up.railway.app/manager`.
2. Tela de login pede a chave: cole a `AUTHENTICATION_API_KEY` que você gerou.
3. Clicar em **+ Instance** → preencher:
   - **Name**: `agente` (vai pra `EVOLUTION_INSTANCE` no app)
   - **Token**: deixe vazio (a Evolution gera automático)
   - **Integration**: `WHATSAPP-BAILEYS` (ou `Baileys` — é o padrão sem custo)
   - **Auto reload QR Code**: marcado
4. **Save**.
5. A instância aparece na lista. Clique nela → **QR Code** (botão grande).
6. **Escaneie com o celular** (a câmera que você abriu).
7. Quando conectar, o status vira **OPEN** ou **CONNECTED** (verde).

**Se o QR expirar antes de você escanear:** clique em **Refresh** ou **Reload** pra gerar outro. Pode tentar quantas vezes precisar.

**Se conectar mas cair logo depois:** geralmente é o WhatsApp banindo conexões suspeitas. Use um número que tenha sido ativo por pelo menos 1 semana antes — números recém-criados levam ban rápido.

#### 8.4 — App (este projeto)

1. **+ New** → **GitHub Repo** → o repo criado na Fase 7.
2. Renomeie pra `ia-whatsapp-app`.
3. Em **Variables**:

   ```
   NODE_ENV=production
   PORT=3000
   LOG_LEVEL=info
   SUPABASE_URL=<do .env>
   SUPABASE_SERVICE_ROLE_KEY=<do .env>
   EVOLUTION_URL=http://evolution-api.railway.internal:8080
   EVOLUTION_API_KEY=<a AUTHENTICATION_API_KEY do Evolution>
   EVOLUTION_INSTANCE=agente
   OPENAI_API_KEY=<chave OpenAI>
   ```

4. **Settings → Networking → Generate Domain**.
5. Aguardar deploy. Testar: `https://<seu-app>.up.railway.app/health` deve retornar `{"status":"ok"}`.

---

### Fase 9 — Configurar webhook do Evolution

No Evolution Manager, instância → **Webhook**:

- **URL**: `https://<seu-app>.up.railway.app/webhooks/evolution`
- **Events**: `MESSAGES_UPSERT` e `MESSAGES_UPDATE`
- **Enabled**: true

Ou via API:

```bash
curl -X POST "https://<evolution>.up.railway.app/webhook/set/<instancia>" \
  -H "apikey: <AUTH_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"webhook":{"enabled":true,"url":"https://<app>.up.railway.app/webhooks/evolution","events":["MESSAGES_UPSERT","MESSAGES_UPDATE"]}}'
```

---

### Fase 10 — Testar 🎉

1. Manda mensagem pro número do agente de outro WhatsApp.
2. Em ~15s o agente responde (debounce default).
3. Veja os logs do `ia-whatsapp-app` na Railway pra confirmar.
4. Veja a tabela `chat_messages` no Supabase — vai ter os registros.

**Pronto! O agente tá no ar.** 🚀

Se algo deu errado, veja **Troubleshooting** abaixo.

---

## 🧰 Troubleshooting

### O app não responde
- Veja os logs do `ia-whatsapp-app` na Railway.
- Cheque se `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `EVOLUTION_URL`, `EVOLUTION_API_KEY` e `OPENAI_API_KEY` estão preenchidos.
- Healthcheck: `https://<app>.up.railway.app/health` deve retornar ok.

### O Evolution não envia webhook
- No Manager, veja se está **enabled** com `MESSAGES_UPSERT` / `MESSAGES_UPDATE` marcados.
- A URL deve ser **pública** do app (não a `.railway.internal`).
- Logs do `evolution-api` mostram erros de "webhook post failed".

### OpenAI dá erro 401
- Chave errada ou sem créditos. Renove em https://platform.openai.com/api-keys e adicione créditos.

### IA responde no log mas WhatsApp não recebe
- `EVOLUTION_INSTANCE` no `.env` do app deve bater **exatamente** com o nome no Manager.
- Instância pode ter desconectado — reabra o QR Code.

### Pausar a IA pra falar com o usuário manualmente
SQL no Supabase:
```sql
update chat_control
set ai_paused = true, paused_at = now(), paused_by = 'humano'
where session_id = '<numero>@s.whatsapp.net';
```
Pra despausar: `ai_paused = false`.

### Mudar o system prompt depois
SQL no Supabase:
```sql
update agent_configs
set system_prompt = '...novo prompt...'
where agent_type = 'default';
```
A app tem cache de 30s — depois disso o novo prompt entra em vigor.

---

## 📂 Estrutura do projeto

```
src/
├── config/env.ts                    # validação das env vars (Zod)
├── lib/
│   ├── evolution.ts                 # cliente HTTP da Evolution
│   ├── logger.ts                    # Pino com redação de secrets
│   ├── openai.ts                    # factory de clientes OpenAI
│   ├── phone.ts                     # normalização de telefone BR
│   └── supabase.ts                  # cliente Supabase service-role
├── routes/
│   ├── health.ts                    # /health e /health/ready
│   └── webhooks/evolution.ts        # POST /webhooks/evolution
├── services/
│   ├── agent.ts                     # chamada OpenAI com system prompt
│   ├── agent-config.ts              # cache de agent_configs
│   ├── buffer.ts                    # buffer + debounce + sweeper
│   ├── chatbot.ts                   # orquestração principal
│   ├── media.ts                     # áudio/imagem/vídeo/doc processing
│   └── message-parsers.ts           # parsers de tipos WhatsApp
└── server.ts                        # Fastify + bootstrap

supabase/
├── schema.sql                       # tabelas + RPC
└── seed.sql                         # INSERT inicial (modelo)
```

---

## 🔐 Segurança — NUNCA commite

- `.env` (já gitignored)
- `.mcp.json` (já gitignored)
- Tudo dentro de `.claude/`

Se commitar secret por acidente, **gire a chave imediatamente** (OpenAI, Supabase, Evolution).
