# Auditoria da agenda Flora e CRM, Plano de execução

> **Para agentes:** executar as etapas em ordem, mantendo testes automatizados e validação de produção.

**Objetivo:** identificar por que a Flora ainda pode oferecer um horário ocupado e eliminar o caminho que permite esse erro.

**Arquitetura:** rastrear a ocupação desde `appointments` no CRM até o endpoint `/api/flora/ocupacao`, depois até `fetchBusyFromCrm`, geração da grade, prompt e pré-reserva. A fonte oficial é exclusivamente o CRM, com falha segura quando a consulta não puder ser confirmada.

**Tecnologias:** TypeScript, Vitest, Fastify, Next.js, Supabase e Railway.

## Restrições globais

- Não reativar Google Calendar como fonte de disponibilidade.
- Não considerar horário livre sem resposta válida do CRM.
- Preservar fuso `America/Sao_Paulo`.
- Não expor dados pessoais nos logs ou na documentação.

## Etapas

### Etapa 1: Reproduzir o relato

- [x] Extrair do print a data, hora, serviço e texto exato oferecido.
- [x] Consultar o endpoint do CRM para a mesma janela.
- [x] Consultar o banco do CRM para confirmar profissional, status, início e fim do agendamento.

### Etapa 2: Rastrear o caminho da ocupação

- [x] Revisar filtro de profissional e status em `web/src/app/api/flora/ocupacao/route.ts`.
- [x] Revisar conversão de timestamps e fuso em `web/src/lib/ocupacao.ts`.
- [x] Revisar autenticação, janela consultada e resposta recebida pela Flora.
- [x] Revisar cache, geração de slots, grade oficial e duração em `src/services/calendar-availability.ts`.

### Etapa 3: Criar reproduções automatizadas

- [x] Adicionar teste para o intervalo exato do print.
- [x] Adicionar teste de sobreposição parcial e intervalo que cruza a hora oferecida.
- [x] Adicionar teste para todos os status ocupados e para `cancelado`/`faltou`.
- [x] Adicionar teste para erro, resposta vazia inválida, fuso e cache.

### Etapa 4: Corrigir somente após confirmar a causa

- [ ] Implementar a menor correção na camada que originou o valor incorreto.
- [ ] Rodar o teste falho antes e depois da correção.
- [ ] Rodar a suíte completa, typecheck e build.

### Etapa 5: Validar produção

- [x] Confirmar variáveis da Railway e deploy ativo.
- [x] Confirmar health check.
- [x] Consultar novamente o CRM para o caso reproduzido.
- [x] Registrar a causa, correção e evidências em `docs/melhorias/` e no `CONTEXTO.md` do CRM.
