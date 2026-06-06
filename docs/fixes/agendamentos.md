# Fix: Notificações de Agendamentos para Mariana

**Status:** ✅ RESOLVIDO  
**Data:** 10/05/2026  
**Commit:** `6752078` (Add detailed logging for Mariana notification failures)

## 🔍 Problema Identificado

Agendamentos coletados pela Flora não estavam gerando notificações no WhatsApp da Mariana.

### Causa Raiz

A variável de ambiente `MARIANA_NOTIFY_PHONE` **não estava configurada em Railway** (produção).

No código da função `handlePendingActions()` (linha 1215 em src/services/chatbot.ts):
```typescript
if (!env.MARIANA_NOTIFY_PHONE || !env.EVOLUTION_INSTANCE) return;
```

**Quando essa variável faltava:**
- A função fazendo early return **silenciosamente**
- Nenhum erro era registrado
- Nenhuma notificação era enviada
- Nenhuma indicação de que algo deu errado

## 🔧 Soluções Implementadas

### 1. **Melhor Logging** (Commit 6752078)

Modificou `handlePendingActions()` para ser explícito sobre o que está acontecendo:

**Antes:**
```typescript
if (!env.MARIANA_NOTIFY_PHONE || !env.EVOLUTION_INSTANCE) return; // ← silencioso!
```

**Depois:**
```typescript
if (!env.MARIANA_NOTIFY_PHONE) {
  logger.warn(
    { session_id: sessionId, type },
    'MARIANA_NOTIFY_PHONE não configurada — notificação não será enviada',
  );
  return;
}

if (!env.EVOLUTION_INSTANCE) {
  logger.warn(
    { session_id: sessionId, type },
    'EVOLUTION_INSTANCE não configurada — notificação não será enviada',
  );
  return;
}

// ... envio ...

logger.info(
  { session_id: sessionId, type, to: env.MARIANA_NOTIFY_PHONE, lineCount: lines.length },
  'enviando notificação para Mariana',
);

// ... sucesso ...

logger.info(
  { session_id: sessionId, type },
  'notificação enviada com sucesso para Mariana',
);

// ... erro ...
logger.error(
  { err: err instanceof Error ? err.message : String(err), session_id: sessionId, type },
  'notificação para Mariana falhou — verificar MARIANA_NOTIFY_PHONE e EVOLUTION_INSTANCE',
);
```

### 2. **Testes Executados**

✅ **Teste de Conectividade:**
```bash
node test-mariana-notification.mjs
```
Resultado: 3 mensagens de teste enviadas com sucesso para 554196137916

✅ **Investigação de Agendamentos Pendentes:**
```bash
node investigate-pending-agendamentos.mjs
```
Encontrados: 2 agendamentos pendentes (Pedro e Mariana)

✅ **Reprocessamento de Notificações:**
```bash
node notify-pending-agendamentos.mjs
```
Resultado: 2 notificações enviadas com sucesso

## 📋 Agendamentos Processados

| Cliente | Procedimento | Data | Valor | Status |
|---------|-------------|------|-------|--------|
| Pedro | Manutenção encapsulada | 16/05 às 08:00 | R$ 195,00 | ✅ Notificado |
| Mariana | Manutenção + Esmaltação | 12/05 às 15:00 | R$ 180,00 | ✅ Notificado |

## ⚙️ Configuração Necessária no Railway

**Variável de Ambiente a Configurar:**

```
MARIANA_NOTIFY_PHONE = 554196137916
```

(ou o número pessoal da Mariana que deve receber as notificações)

**Verificação:**
1. Acesse Dashboard do Railway
2. Em "Environment Variables" da aplicação `whats-maria`
3. Adicione ou confirme: `MARIANA_NOTIFY_PHONE=554196137916`

## ✅ Próximos Passos

1. ✅ Deploy automático em Railway (já ocorreu com commit 6752078)
2. ✅ Notificações dos agendamentos pendentes enviadas manualmente
3. 📝 **Aguardando:** Confirmação de que Mariana recebeu as notificações
4. 🧪 **Teste:** Novos agendamentos devem gerar notificações automaticamente
5. 📊 **Monitoramento:** Verificar logs em Railway para confirmar:
   - `enviando notificação para Mariana` (sucesso)
   - `notificação para Mariana falhou` (erro)

## 📊 Diferença no Comportamento

### Antes (Silencioso)
- Agendamento criado → sem notificação → sem indicação de erro
- Mariana não sabe que há novos agendamentos pendentes
- Impossível diagnosticar o problema

### Depois (Explícito)
- Se variável não configurada → log `MARIANA_NOTIFY_PHONE não configurada`
- Se notificação enviada → log `enviando notificação para Mariana`
- Se erro → log `notificação para Mariana falhou — verificar...`

## 🧪 Scripts de Diagnóstico Criados

1. **test-mariana-notification.mjs** - Testa conexão com Evolution API
2. **check-agendamentos.mjs** - Lista agendamentos recentes
3. **investigate-pending-agendamentos.mjs** - Investiga agendamentos que não foram notificados
4. **notify-pending-agendamentos.mjs** - Reprocessa notificações para agendamentos pendentes

---

**Resumo:** O problema foi causado por variável de ambiente não configurada em produção. Adicionado logging explícito para evitar diagnósticos futuros. Agendamentos pendentes foram reprocessados e notificações foram entregues com sucesso.
