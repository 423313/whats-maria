# 🎯 Correção: Follow-ups Inteligentes — Evitar Mensagens Fora de Contexto

## Problema Identificado

O agente **Flora** estava enviando mensagens de follow-up para clientes **fora de contexto**, causando experiência ruim. Exemplo: cliente que já finalizou a conversa normalmente (disse "ok", "obrigado") recebia mensagem de follow-up 60 minutos depois.

**Causa:** O serviço `followup.ts` enviava follow-up para TODA conversa inativa por 60+ minutos, sem verificações inteligentes.

---

## ✅ Solução Implementada (Opção 3)

Adicionadas **3 verificações inteligentes** antes de enviar follow-up:

### 1️⃣ **Conversa Muito Recente** (menos de 15 minutos)
```typescript
// Não enviar follow-up se a conversa iniciou há menos de 15 minutos
// Evita disparos em conversas que ainda estão acontecendo
```

### 2️⃣ **Conversa Muito Curta** (menos de 4 mensagens)
```typescript
// Mínimo de 4 mensagens = filtro de apenas "oi"/"olá"
const MIN_MESSAGES_FOR_FOLLOWUP = 4;
// Sem follow-up pra: "oi" → "olá!" → "beleza" (3 msgs)
```

### 3️⃣ **Finalização Natural do Cliente**
```typescript
// Detecta palavras que indicam que o cliente encerrou naturalmente:
// "obrigado", "ok", "perfeito", "fechado", "até mais", etc
const NATURAL_CLOSURE_KEYWORDS = [
  'obrigado', 'valeu', 'ok', 'perfeito', 'fechado',
  'até mais', 'abraço', 'tmj', ...
];

// Se detectar, marca a sessão com skip_followup=true
// Nunca mais envia follow-up pra essa sessão
```

---

## 📋 Mudanças no Código

### Arquivo Modificado: `src/services/followup.ts`

**Adições:**
- `MIN_MESSAGES_FOR_FOLLOWUP` = 4 (limite mínimo)
- `NATURAL_CLOSURE_KEYWORDS` = lista de palavras (obrigado, ok, etc)
- `isTooShort(msgs)` = detecta conversa curta
- `hasNaturalClosure(msgs)` = detecta finalização natural
- Verificação de `skip_followup` na tabela `chat_control`

**Comportamento:**
- Antes: enviava follow-up sim/não
- Depois: verifica 3 condições → bloqueia se qualquer uma ativar → marca `skip_followup=true`

---

## 🗄️ Mudanças no Banco de Dados

### Nova Migração: `supabase/migrations/add_followup_columns.sql`

Adiciona 5 colunas à tabela `chat_control`:

```sql
followup_sent_at timestamptz       -- Quando enviou o follow-up
followup_context text               -- Tipo de conversa (scheduling, course, prices, etc)
followup_closed_at timestamptz     -- Quando encerrou automaticamente
mariana_last_manual_at timestamptz -- Última msg manual da Mariana (janela 24h)
skip_followup boolean              -- Flag: NÃO ENVIAR MAIS FOLLOW-UP NESSA SESSÃO
```

---

## 🚀 Como Aplicar

### Passo 1: Deploy da Nova Versão

```bash
npm run build
git add -A
git commit -m "feat: followup inteligente com 3 verificações para evitar msg fora de contexto"
git push origin main
```

(A Railway vai fazer rebuild + deploy automático)

### Passo 2: Executar a Migração no Supabase

**Opção A — Via MCP do Supabase (recomendado):**

No Claude Code, diga:
> *"Execute a migração em `supabase/migrations/add_followup_columns.sql` no meu Supabase"*

O Claude vai usar a ferramenta MCP pra rodar o SQL automaticamente.

**Opção B — Manual (SQL Editor do Supabase):**

1. Abra https://supabase.com/dashboard → seu projeto → **SQL Editor**
2. Cole o conteúdo de `supabase/migrations/add_followup_columns.sql`
3. Clique **Run**

---

## ✨ Resultado Esperado

Após deploy + migração:

✅ **Conversas muito curtas** (só "oi"/"olá") → ❌ Sem follow-up  
✅ **Cliente disse "obrigado"** → ❌ Sem follow-up, marca `skip_followup=true`  
✅ **Conversa iniciada há 10 minutos** → ⏳ Aguarda 60 min inteiros  
✅ **Conversas legítimas sem resposta** → ✅ Follow-up após 60 min  

---

## 📊 Exemplos Práticos

### Cenário 1: Conversa Curta (Bloqueada)
```
Cliente: Oi
Flora:   Olá! Bem-vinda ao Studio Mariana!
Cliente: Obrigada
[60 min depois...]
→ ❌ Sem follow-up (conversa muito curta: 3 msgs)
```

### Cenário 2: Cliente Finalizou Naturalmente (Bloqueada)
```
Cliente: Quero agendar um serviço
Flora:   Ótimo! Que serviço você gostaria?
Cliente: Alongamento de unhas
Flora:   Perfeito! Dias de semana...
Cliente: Show, vou confirmar e te aviso
[60 min depois...]
→ ❌ Sem follow-up (cliente disse "show" = fechado)
```

### Cenário 3: Interesse Real, Sem Resposta (Permitido ✅)
```
Cliente: Quero agendar
Flora:   Qual data você prefere?
[Cliente leu a msg mas não respondeu...]
[60 min depois...]
→ ✅ Envia follow-up (conversa com >4 msgs, sem fechamento)
```

---

## 🔄 Como Ajustar Depois (Se Necessário)

Se descobrir que precisa ajustar:

**Aumentar tempo de espera de 60 min → 2h:**
```typescript
// src/services/followup.ts, linha 6
const FOLLOWUP_AFTER_MS = 2 * 60 * 60 * 1000; // 2 horas
```

**Adicionar mais palavras de fechamento:**
```typescript
const NATURAL_CLOSURE_KEYWORDS = [
  'obrigado', 'valeu', 'ok', 'perfeito',
  'blz', 'certo', 'show', // ← adicione aqui
];
```

**Aumentar limite mínimo de mensagens (4 → 6):**
```typescript
const MIN_MESSAGES_FOR_FOLLOWUP = 6;
```

---

## 📝 Checklist

- [x] Código modificado em `src/services/followup.ts`
- [x] TypeScript compila sem erros (`npm run typecheck` ✅)
- [x] Migração SQL criada (`supabase/migrations/add_followup_columns.sql`)
- [ ] Migração executada no Supabase (fazer via MCP)
- [ ] Deploy feito na Railway
- [ ] Testar em produção

---

## 🆘 Troubleshooting

**P: Mesmo após deploy, o agente continua mandando follow-ups?**  
R: Verifique:
1. A Railway fez rebuild? (veja logs)
2. A migração rodou? (veja tabela `chat_control` no Supabase — deve ter as 5 colunas novas)
3. Esperou ~30 seg depois do deploy? (cache)

**P: Como "desbloquear" uma sessão que foi marcada com `skip_followup=true`?**  
R: No Supabase, execute:
```sql
UPDATE chat_control SET skip_followup = false WHERE session_id = '55999999999@s.whatsapp.net';
```

**P: Quero enviar follow-up mesmo que cliente tenha dito "ok"?**  
R: Edite `NATURAL_CLOSURE_KEYWORDS` e remova `'ok'` da lista.

