# Corte da agenda para o CRM, 2026-08-04

## Problema confirmado

Em 04/08/2026, a Flora ofereceu 05/08/2026 às 11:00, embora esse horário já estivesse ocupado no CRM da Mariana.

O endpoint de ocupação do CRM confirmou os intervalos abaixo no fuso de São Paulo:

- 09:00 às 12:40
- 13:00 às 15:00

## Causa

A camada de disponibilidade da Flora ainda permitia usar o Google Calendar, e `AGENDA_SOURCE` tinha padrão `gcal`. A integração com o CRM existia no código, mas não estava ativada na Railway.

## Correção aplicada

- A Flora passou a usar exclusivamente `fetchBusyFromCrm`.
- `AGENDA_SOURCE` agora aceita somente `crm` e usa `crm` como padrão.
- A checagem auxiliar de duração dos agendamentos também consulta o CRM.
- Falhas do CRM retornam `unverified` e geram aviso para conferência manual, sem assumir que o horário está livre.
- As variáveis antigas `GOOGLE_CALENDAR_ID` e `GOOGLE_SERVICE_ACCOUNT_KEY` foram removidas da Railway.
- Produção recebeu `CRM_BASE_URL`, `CRM_API_SECRET` e `AGENDA_SOURCE=crm`.

## Validação

- Commit: `ff938de fix(agenda): usar somente ocupacao do CRM`
- Deploy da Railway concluído com sucesso.
- `/health` da Flora retornando HTTP 200.
- 13 arquivos de teste, 179 testes aprovados.
- Typecheck e build aprovados.
- CRM confirmou que 05/08 às 11:00 está dentro de um intervalo ocupado.
