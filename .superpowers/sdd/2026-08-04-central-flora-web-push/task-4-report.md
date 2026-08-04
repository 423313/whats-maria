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
- correção pós-review: `src/services/escalations.ts` deixou de inserir direto em `crm_request_outbox` e passou a usar somente `enqueueCrmRequest()`
- correção pós-review: `src/services/crm-requests.ts` agora trata conflito por `assunto_chave` reutilizando a linha pendente e atualizando payload e `pending_action_id` sem duplicar
- correção pós-review: `supabase/migrations/central_flora_outbox.sql` agora cria o índice único parcial `crm_request_outbox_pending_subject_idx` para garantir idempotência transacional por assunto nas linhas pendentes

## Testes e verificacoes

- `npm.cmd test -- --run tests/escalations.test.ts tests/pending-actions.test.ts`
- `npm.cmd test -- --run tests/escalations.test.ts tests/crm-requests.test.ts tests/pending-actions.test.ts`
- `npm.cmd test`
- `npm.cmd run typecheck`
- `npm.cmd run build`

## Self-review

- a extracao do token e centralizada no novo servico, reduzindo risco de vazar marcador para cliente
- a idempotencia por assunto saiu do padrao `select` + `insert` em `escalations.ts` e foi centralizada na propria outbox, com reforco transacional no schema
- a entrega de escalacao nao interrompe o atendimento: falhas da outbox sao isoladas em log

## Observacao

- o fluxo de atualizacao em conflito depende do indice parcial em `assunto_chave` para serializar a criacao de pendencias por assunto; com isso, replicas concorrentes convergem para uma unica linha pendente por assunto
