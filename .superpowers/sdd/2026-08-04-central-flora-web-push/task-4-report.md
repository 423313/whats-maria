# Task 4 Report

Data: 2026-08-04
Task: Estruturar todas as escalacoes da Flora sem interromper o atendimento

## Implementacao

- criado `src/services/escalations.ts` com `extractEscalations()`, `mapEscalationType()` e `handleEscalations()`
- integrada a chamada unica de `handleEscalations()` em `src/services/chatbot.ts` logo apos `runAgent()`, no mesmo ponto de `handlePendingActions()`
- mantida a remocao do token `[ESCALAR_MARIANA:motivo]` antes do envio para a cliente
- removida a deduplicacao antiga em memoria de escalacoes de `src/services/pending-actions.ts`
- protegido o painel admin para rejeitar envio manual e broadcast com marcador interno de escalacao
- atualizado `supabase/update-prompt.sql` para usar apenas os marcadores invisiveis esperados

## Testes e verificacoes

- `npm.cmd test -- --run tests/escalations.test.ts tests/pending-actions.test.ts`
- `npm.cmd run typecheck`
- `npm.cmd run build`

## Self-review

- a extracao do token e centralizada no novo servico, reduzindo risco de vazar marcador para cliente
- a idempotencia por assunto agora reutiliza a outbox pendente encontrada por `sessionId:tipo`
- a entrega de escalacao nao interrompe o atendimento: falhas da outbox sao isoladas em log

## Observacao

- a idempotencia por assunto esta implementada na camada de aplicacao. Sem indice unico em `assunto_chave`, concorrencia extrema entre replicas ainda dependeria de reforco no schema para garantia transacional total
