# Integração da agenda com o CRM — plano de implementação

## Contexto

A Flora hoje lê disponibilidade de um Google Calendar alimentado pelo `belasis-sync` (raspagem da Belasis a cada 15 min por cookie de sessão). O CRM próprio do studio (`crm-operacional`, Next.js + Supabase, repositório separado) está assumindo a agenda de verdade. Este plano troca a fonte de dados da Flora, mantendo tudo o resto igual: **a Flora continua sem escrever agendamento**, continua fazendo pré-reserva e avisando a Mariana — decisão do Pedro.

O lado CRM (endpoint `GET /api/flora/ocupacao`) está especificado em `crm-operacional/docs/superpowers/specs/2026-08-02-flora-agenda-crm-design.md` e implementado por `crm-operacional/docs/superpowers/plans/2026-08-02-flora-agenda-endpoints.md`.

## Diagnóstico feito em 2026-08-02 (antes de qualquer código de agenda)

A investigação encontrou dois problemas anteriores e independentes da agenda, que precisam ser resolvidos primeiro.

### Achado 1 — eco cruzado WAHA→Flora (confirmado no código, ainda não manifestado em produção)

A Flora e o WAHA (stack de WhatsApp do CRM) estão pareados no mesmo número. Toda mensagem que o WAHA envia chega ao webhook da Flora como `fromMe=true` com `messageId` desconhecido e texto que não bate com resposta recente. Em `src/services/chatbot.ts:341-348` isso cai no `else` e chama `updateMarianaManualAt`, que em `src/services/human-takeover.ts:15-32` abre 24h de silêncio para aquela conversa **e descarta o buffer de mensagens pendentes da cliente**.

**Medido no Supabase da Flora nesta data:**
- `whatsapp_envios` do CRM tem **0 linhas** — o WAHA nunca disparou uma automação real em produção. O bug existe no código mas não sangrou ainda.
- `chat_messages` (3.589 linhas nos últimos 45 dias, consulta paginada — uma consulta sem paginação trouxe só ~1000 e escondia exatamente os dias mais recentes) não mostra colapso na razão assistant/user em torno de 30/07 (data do pareamento do WAHA).
- `chat_control.mariana_last_manual_at` não mostra salto de ativações a partir de 30/07.

**Conclusão: não é emergência de pausar hoje, mas é bloqueante para o corte da Belasis.** Quando a Mariana migrar, o volume de agendamento no CRM cresce e os lembretes/confirmações passam a disparar de verdade — e cada um vai silenciar uma conversa por 24h se isso não for corrigido antes.

### Achado 2 — `belasis-sync` sem piso de segurança (latente, catastrófico)

`computePlan()` em `belasis-sync/src/sync.js` deleta todo evento sincronizado que não veio no payload da Belasis, sem limite mínimo. Uma sessão expirada respondendo 200 com lista vazia apaga o Google Calendar inteiro em até 15 minutos, e a Flora passa a oferecer o mês todo livre. Não depende de nenhuma decisão de arquitetura — é bug isolado, ~20 minutos de correção.

## Decisões

**Não existe conflito de escrita** entre Flora e CRM: a Flora não escreve agendamento (decisão fechada com o Pedro). A superfície de risco desta integração é só leitura.

**O gateway (Evolution↔WAHA) não precisa ser unificado para isso funcionar.** Um número, dois consumidores, é tecnicamente viável — o WhatsApp multi-device suporta até 4 companions, a afirmação da spec anterior de que é "limitação de protocolo" estava errada. O que precisa existir é a Flora reconhecendo **três** remetentes possíveis pelo número (ela mesma, o CRM, a Mariana), não dois. Unificar o gateway não resolveria isso sozinho: mesmo com tudo no WAHA, o CRM continuaria mandando pela sessão e o webhook continuaria dizendo `fromMe=true` com um id que a Flora não gerou. A unificação de gateway (Fase 7) fica como trilha separada, mais arriscada (muda formato de webhook, mídia, áudio, localização) e sem sobreposição de arquivo com este trabalho.

**Fail-open vira fail-closed.** Hoje, sem credencial do Google ou com erro, a Flora cai num fallback e `checkConsecutiveSlotsFree` devolve `{valid:true}` — fail-open deliberado, aceitável quando a única consequência era um aviso perdido para a Mariana. Com fonte externa (CRM), fail-open passa a significar "ofereço horário que pode estar ocupado". Vira fail-closed: falha de configuração ou de rede é comunicada como "preciso confirmar com a Mariana", nunca como disponibilidade inventada.

## Global Constraints

- Nenhuma mudança em `studio-schedule.ts` nesta v1: grade oficial, mínimo de 90 min, trilho de 2h no sábado continuam sendo política de oferta da Flora, não dado do CRM.
- `checkConsecutiveSlotsFree` continua **advisory** — nunca bloqueia a pré-reserva, só ajusta o aviso à Mariana.
- Toda mudança de env var de troca de fonte precisa ter rollback instantâneo (flip de uma variável, sem deploy).
- Testes com Vitest em `tests/`.
- Deploy fora do horário de expediente (ter-sáb 08h-17h) durante o período de corte — um restart nos segundos seguintes a uma resposta perde `void handlePendingActions(...)` (fire-and-forget) e o `echo-registry` em memória.

---

## Status de execução

| Tarefa | Situação |
|---|---|
| Task 0 — Diagnóstico | **Concluída** (2026-08-02, ver seção acima) |
| Task 1 — Guardrail no belasis-sync | **Concluída** (2026-08-03, ver seção abaixo) |
| Task 2 — Blindagem do eco cruzado | **Concluída, atrás de feature flag off** (2026-08-03, ver seção abaixo) |
| Task 3 — Nova camada de fonte em calendar-availability.ts | **Concluída** (2026-08-03, ver seção abaixo) |
| Task 4 — Modo sombra e troca de fonte | **Concluída, atrás de env vars não configuradas** (2026-08-03, ver seção abaixo) |
| Task 5 — Ajustes em pending-actions/studio-schedule | Pendente |
| Task 6 — Consistência de duração/preço | v1.5, não entra no corte |
| Task 7 — Plano de corte | Pendente, depende das tasks acima |

## Task 1 e Task 2 concluídas (2026-08-03)

**Task 1 (`belasis-sync/src/sync.js`, `computePlan`)**: guardrail de encolhimento (`existentes >= 5` e `appointments.length < 50%` disparam `SHRINK_GUARD`) + cap absoluto de 20 deletes por execução, ambos lançando erro em vez de aplicar qualquer mudança. 3 testes novos em `test/sync.test.js` (lista vazia com 30 existentes, 1 cancelamento legítimo passando normal, cap absoluto isolado da proporção). `npm test`: 15/15.

**Task 2 (eco cruzado WAHA→Flora)**: implementada como planejado, com uma simplificação — em vez de tocar os 3 pontos de chamada em `chatbot.ts` individualmente, a checagem de eco externo (`external-echo.ts`: id em `external_outbound_messages` OU conteúdo batendo com um dos 5 templates invariantes do CRM) foi centralizada dentro de `resolveIsFloraEcho` (`chat-repository.ts`), que já é chamada nos 3 pontos. `mariana-monitor.ts:201` ganhou a mesma checagem em lote (`filterExternalEchoIds`), já que ali o filtro é síncrono e não passa por `resolveIsFloraEcho`. Nova tabela `external_outbound_messages` aplicada via MCP no Supabase da Flora (`jnfeerxcxxmgjutkfzig`), `get_advisors` só com o INFO padrão de RLS-sem-policy (mesmo padrão das outras tabelas do projeto). Nova rota `POST /internal/outbound-echo` (auth por `INTERNAL_ECHO_SECRET`, comparação em tempo constante). Lado CRM: `web/src/lib/waha.ts` ganhou `notificarEcoExterno` (fire-and-forget, após `enviarTextoWhatsapp` e `enviarImagemWhatsapp`), variáveis novas `FLORA_INTERNAL_ECHO_URL`/`FLORA_INTERNAL_ECHO_SECRET`.

Feature flag `EXTERNAL_ECHO_ENABLED` (default `off`) controla se a checagem é sequer consultada — hoje desligada, então o comportamento é bit-a-bit o de antes desta mudança. `npm test` (155/155), `npm run typecheck` e `npm run build` limpos na Flora; `npm test` (171/171), `npm run lint` e `npm run build` limpos no CRM.

**Falta para fechar o gate da Task 2** (48h em produção sem ativação de janela correlacionada a cron, conforme o plano):
1. Configurar `INTERNAL_ECHO_SECRET` (Flora, Railway) e `FLORA_INTERNAL_ECHO_URL`/`FLORA_INTERNAL_ECHO_SECRET` (CRM, Vercel) com o mesmo segredo.
2. Deploy dos dois lados.
3. Ligar `EXTERNAL_ECHO_ENABLED=on` na Flora só depois do deploy do CRM confirmado (ordem importa: sem o CRM notificando, ligar o flag não muda nada de errado, mas também não protege nada ainda).
4. Observar 48h em produção.

---

## Task 1: Guardrail antimassacre no belasis-sync

**Files:** `belasis-sync/src/sync.js`, `belasis-sync/test/sync.test.js`

- [x] Antes do `computePlan`, abortar quando o encolhimento for implausível:

```js
// Guardrail: nunca aceitar um encolhimento massivo. Sessao expirada / schema
// quebrado da Belasis pode devolver 200 com lista vazia — sem isso, o diff
// apaga a agenda inteira e a Flora passa a oferecer o mes todo livre.
const existentes = existingByBelasisId.size;
const MIN_RATIO = 0.5;
if (existentes >= 5 && filtered.length < Math.ceil(existentes * MIN_RATIO)) {
  throw new Error(
    `SHRINK_GUARD: Belasis devolveu ${filtered.length} agendamentos mas o Calendar ` +
    `tem ${existentes} sincronizados na janela. Encolhimento > ${(1 - MIN_RATIO) * 100}% ` +
    `— abortando sem aplicar nada. Verifique BELASIS_PINSESSION_TOKEN.`
  );
}
```

- [x] Cap absoluto adicional: `if (toDelete.length > 20) throw`.
- [ ] Confirmar que o GitHub Action falha visivelmente numa notificação (Slack/e-mail em `failure()`). **Pendente**: não há GitHub Action neste repositório ainda para o belasis-sync — checar como ele roda hoje em produção antes de assumir que existe.
- [x] Testes em `test/sync.test.js`: lista vazia com 30 existentes → throw; 1 cancelamento com 30 existentes → passa. (+1 teste extra: cap absoluto isolado da proporção.)
- [x] Commit e deploy imediato — commit feito nesta sessão; deploy (push + Railway) ainda pendente de aprovação.

---

## Task 2: Blindar o eco cruzado WAHA→Flora

**Files:** `src/lib/echo-registry.ts`, `src/services/chatbot.ts`, `src/services/mariana-monitor.ts`, nova rota em `src/routes/`, `src/config/env.ts`, nova migration no Supabase da Flora

- [x] Nova tabela `external_outbound_messages` (`message_id` PK, `remote_jid`, `source`, `created_at`), com limpeza por TTL de 48h. (Limpeza lazy a cada `registerExternalEcho`, não pg_cron — ver `external-echo.ts`.)
- [x] Nova rota autenticada `POST /internal/outbound-echo` (`Authorization: Bearer ${INTERNAL_ECHO_SECRET}`), corpo `{ messageId, remoteJid, source: 'waha-crm' }`. Insere na tabela (`registerExternalEcho`); o registro em `echo-registry.ts` (`registerFloraEcho`) é só para ecos da própria Flora, não usado aqui.
- [x] No CRM (`web/src/lib/waha.ts`): após cada envio bem-sucedido, fire-and-forget para essa rota. Não falha o envio se o eco não registrar, só loga (`notificarEcoExterno`).
- [x] Antes de `updateMarianaManualAt` nos 3 pontos de chamada — **implementado de forma centralizada**: em vez de tocar `chatbot.ts` nos 3 lugares, a checagem foi movida para dentro de `resolveIsFloraEcho` (`chat-repository.ts`), já chamada pelos 3. Consulta `external_outbound_messages` pelo `messageId` OU compara conteúdo com os templates conhecidos; achando qualquer um, não ativa a janela.
- [x] Mesma consulta em batch em `mariana-monitor.ts:201` (`filterExternalEchoIds`, já que ali o filtro é síncrono e não passa por `resolveIsFloraEcho`).
- [x] **Rede de segurança independente do id**: `isKnownCrmTemplate` em `external-echo.ts` casa substrings invariantes dos 5 templates de `lembrete-mensagem.ts` (todos os templates do CRM vivem nesse único arquivo, não em 5 arquivos separados como o plano original supôs — `confirmacao-whatsapp.ts`, `comprovante-whatsapp.ts`, `reativacao.ts`, `fidelidade-whatsapp.ts` só orquestram o envio, o texto está em `lembrete-mensagem.ts`).
- [x] Teste `tests/external-echo.test.ts`: cobre `isKnownCrmTemplate`, `isExternalEcho` (com TTL de 48h), `isExternalAutomationEcho`, `filterExternalEchoIds` e `registerExternalEcho`. `tests/echo-resolution.test.ts` também ajustado (mock de `config/env.js`) porque passou a depender do flag.
- [x] Feature-flag `EXTERNAL_ECHO_ENABLED=on|off`, default `off` — reproduz o comportamento atual exato, rollback instantâneo.
- [ ] **Gate antes de prosseguir para a agenda:** 48h em produção sem nova ativação de janela correlacionada com horário de cron do CRM. **Ainda não iniciado** — depende de: configurar `INTERNAL_ECHO_SECRET`/`FLORA_INTERNAL_ECHO_URL`/`FLORA_INTERNAL_ECHO_SECRET` nos dois lados, deploy dos dois lados, ligar `EXTERNAL_ECHO_ENABLED=on` na Flora, e então observar as 48h.

---

## Task 3 e Task 4 concluídas (2026-08-03)

**Task 3 (`fetchBusyFromCrm`, `fetchBusyFromGcal`, `fetchBusyForSource`)**: implementada exatamente como no plano, com o contrato real de `GET /api/flora/ocupacao` conferido no repositório do CRM antes de codar (`web/src/lib/ocupacao.ts`/`web/src/app/api/flora/ocupacao/route.ts`) — `{ok, ocupados: [{inicio_ms, fim_ms}], fechados}`, header `authorization: Bearer <FLORA_API_SECRET>`, mesmo segredo que vira `CRM_API_SECRET` deste lado. `fetchBusyFromCrm` sempre lança erro (nunca fallback silencioso), igual ao stub do plano. `fetchBusyForSource` decide a fonte por `AGENDA_SOURCE`: em `union`, roda as duas em paralelo (`Promise.allSettled`) e só propaga erro da fonte marcada em `AGENDA_UNION_REQUIRED` — a outra vira warn e segue com o que der certo.

**Task 4 (troca de fonte + sombra + diff)**: `buildAvailabilityContext` foi reescrita para chamar `fetchBusyForSource` em vez de ir direto no Google — com uma ressalva: o caminho `AGENDA_SOURCE=gcal` (o padrão hoje) manteve a checagem de configuração ausente ANTES do `try`, bit-a-bit igual ao comportamento anterior a esta mudança, satisfazendo a invariante "zero risco" do plano. Modo sombra (`AGENDA_SHADOW=on`) só roda quando a fonte ainda é `gcal`: busca o CRM em paralelo (fire-and-forget, `.catch` vira só warn) e loga a divergência via `diffBusySources`, uma função pura nova que compara duas listas de `BusyInterval` slot a slot (30 min) dentro do horário de funcionamento, sem nenhum dado de cliente — só dia (`dateLabel`) e horário (`"09:00"`). `scripts/agenda-diff.ts` criado (roda com `npx tsx scripts/agenda-diff.ts`, fora do processo principal, não depende de `AGENDA_SHADOW` estar ligado) para o uso manual/cron diário previsto no plano, reaproveitando os mesmos `fetchBusyFromGcal`/`fetchBusyFromCrm`/`diffBusySources` exportados.

Novas env vars em `src/config/env.ts` e documentadas em `.env.example`: `CRM_BASE_URL`, `CRM_API_SECRET`, `AGENDA_SOURCE` (default `gcal`), `AGENDA_UNION_REQUIRED` (default `crm`), `AGENDA_SHADOW` (default `off`) — todos os defaults reproduzem o comportamento atual exato, rollback é só trocar a variável, sem deploy.

8 testes novos em `tests/calendar-availability-crm.test.ts` (parse/erro de `fetchBusyFromCrm`, incluindo header de autorização; `diffBusySources` sem divergência/only_gcal/only_crm, com `nowMs` injetável como parâmetro — mesmo padrão de `buildDaySlots`, pra não depender da data real do teste). `npm test` (176/176), `npm run typecheck` e `npm run build` limpos.

**Limitação conhecida, não coberta por esta sessão**: `checkConsecutiveSlotsFree` (usada por `pending-actions.ts` pra avisar a Mariana quando o horário pedido não cabe na duração do serviço) continua só consultando o Google Calendar, independente de `AGENDA_SOURCE`, e continua fail-open (retorna `{valid:true}` em qualquer erro). Isso é escopo da Task 5 (`SlotCheck` com `unverified`, fail-closed), ainda pendente — o risco é baixo porque essa checagem é só advisory (nunca bloqueia a pré-reserva, só ajusta o aviso à Mariana), mas vale fechar antes de `AGENDA_SOURCE` sair de `gcal` de vez.

**O que falta, fora de código, antes de qualquer flip de env var**:
1. Configurar `CRM_BASE_URL`/`CRM_API_SECRET` na Railway com o mesmo segredo do `FLORA_API_SECRET` do CRM na Vercel.
2. Deploy.
3. Ligar `AGENDA_SHADOW=on` (com `AGENDA_SOURCE` continuando `gcal`) e rodar `scripts/agenda-diff.ts` diariamente (manual ou cron próprio) — critério de corte do plano é divergência zero por 7 dias corridos, com dual-entry da Mariana confirmado no período.
4. Só depois disso avaliar Task 5 e então a sequência de corte da Task 7.

---

## Task 3: Nova camada de fonte em `calendar-availability.ts`

**Files:** `src/services/calendar-availability.ts`, `src/config/env.ts`

- [x] Nova função substituindo `fetchBusyIntervals` no caminho CRM:

```ts
async function fetchBusyFromCrm(deMs: number, ateMs: number): Promise<{startMs: number; endMs: number}[]> {
  const url = new URL("/api/flora/ocupacao", process.env.CRM_BASE_URL!);
  url.searchParams.set("de", new Date(deMs).toISOString());
  url.searchParams.set("ate", new Date(ateMs).toISOString());

  const r = await fetch(url, {
    headers: { authorization: `Bearer ${process.env.CRM_API_SECRET!}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`ocupacao ${r.status}`);
  const corpo = await r.json();
  if (corpo?.ok !== true || !Array.isArray(corpo.ocupados)) throw new Error("ocupacao invalida");
  return corpo.ocupados.map((o: {inicio_ms: number; fim_ms: number}) => ({ startMs: o.inicio_ms, endMs: o.fim_ms }));
}
```

  O `throw` é proposital: quem chama cai no caminho fail-closed (Task 4), nunca em lista vazia silenciosa.

- [x] Novas env vars: `CRM_BASE_URL`, `CRM_API_SECRET`, `AGENDA_SOURCE=gcal|union|crm` (default `gcal`), `AGENDA_UNION_REQUIRED=gcal|crm` (só relevante quando `AGENDA_SOURCE=union`).
- [x] Cache: manter o TTL de 60s já existente, aplicado à fonte ativa (o cache continua em cima do resultado de `fetchBusyForSource`, agnóstico de qual fonte foi usada).

---

## Task 4: Modo sombra e troca de fonte com rollback instantâneo

**Files:** `src/services/calendar-availability.ts`, novo `scripts/agenda-diff.ts`

- [x] `AGENDA_SOURCE=gcal` (produção real) + `AGENDA_SHADOW=on` (consulta o CRM em paralelo, loga divergência, nunca usa o resultado). Zero risco: a sombra nunca toca o que a cliente recebe. **Código pronto, ainda não ligado em produção** (depende de `CRM_BASE_URL`/`CRM_API_SECRET` configuradas na Railway).
- [x] `scripts/agenda-diff.ts` criado: compara os intervalos ocupados das duas fontes na janela de 30 dias, reporta `only_gcal`, `only_crm`, sem nenhum dado de cliente — só contagem e horário. **Ainda não agendado pra rodar diariamente** (uso manual via `npx tsx scripts/agenda-diff.ts` até decidir onde colocar o cron).
- [ ] Critério de corte: divergência zero por 7 dias corridos, com a Mariana lançando em duplicidade (Belasis + CRM) confirmada nesse período — sem dual-entry a sombra não mede nada. **Depende da observação em produção começar.**
- [ ] No dia do corte da Belasis: `AGENDA_SOURCE=union`, `AGENDA_UNION_REQUIRED=crm`. A partir daqui, falha do CRM é fail-closed; falha do GCal (congelado) só gera warn e segue. Suporte de código já existe em `fetchBusyForSource`, só falta o flip da variável no dia certo.
- [ ] D+15 (ou quando `only_gcal` — leia-se, o GCal congelado bloqueando horário livre de verdade — passar de ~2 slots/dia): `AGENDA_SOURCE=crm`. Manter o código do caminho `gcal` por mais 30 dias como máquina do tempo.
- [x] Rollback em qualquer etapa: flip de `AGENDA_SOURCE`, sem deploy — nenhuma das três fontes exige mudança de código, só de variável de ambiente.

---

## Task 5: Ajustes em `pending-actions.ts` e `checkConsecutiveSlotsFree`

**Files:** `src/services/calendar-availability.ts`, `src/services/pending-actions.ts`

- [ ] Trocar a assinatura de retorno para distinguir falha de configuração de falha de negócio:

```ts
export type SlotCheck =
  | { status: 'ok';           freeSlots: number }
  | { status: 'insufficient'; freeSlots: number }
  | { status: 'unverified';   reason: string };
```

- [ ] Em `pending-actions.ts`, tratar `unverified` com aviso explícito à Mariana ("não consegui conferir a agenda agora, confira na mão"), em vez do silêncio atual de fail-open.
- [ ] **Sem mudança** em `studio-schedule.ts`, `buildDaySlots`, `buildOfficialGridSlots`, `buildSaturdayGrid` nesta v1.
- [ ] **Ganho de graça:** se o payload de `/api/flora/ocupacao` incluir `fechados` (feriados), basta somar esses intervalos aos ocupados em `formatContext` — a Flora passa a respeitar feriado nacional sem lógica nova.

---

## Task 6 (v1.5, não entra no corte): consistência de duração e preço

- [ ] Duração: `GET /api/flora/servicos` no CRM devolvendo `{nome, duracao_minutos, preco, ativo}[]`; `serviceToMinSlots` passa a consultar por nome antes de cair na regex atual (a regex nunca é removida, vira rede).
- [ ] Preço: **controle detectivo, não automação**. Job semanal comparando os valores em `agent_configs.system_prompt` com `services.preco` do CRM; diverência dispara aviso no WhatsApp da Mariana. Automatizar a geração do bloco de preço no prompt fica para v2, e nunca junto com o corte de agenda.
- [ ] Antes de qualquer coisa aqui: diff entre `scripts/prompt/working-prompt.txt` e `agent_configs.system_prompt` — se já divergirem, não sabemos o que a Flora diz às clientes hoje.

---

## Task 7: Plano de corte

Sequência com gate (⛔) em cada etapa, detalhada na spec do CRM e resumida aqui:

0. Diagnóstico + Task 1 + Task 2 em produção. ⛔ 48h sem ativação de janela correlacionada a cron.
1. CRM expõe o endpoint (preview). ⛔ Testes de contrato passando.
2. Código da Flora em produção, `AGENDA_SOURCE=gcal`, sombra off. ⛔ 24h sem mudança de comportamento.
3. Sombra ligada, 7 dias, dual-entry da Mariana. ⛔ Divergência zero.
4. Corte: desabilitar `belasis-sync`, `AGENDA_SOURCE=union`. ⛔ 48h sem double-booking relatado.
5. Convivência 15 dias, monitorando `only_gcal` crescente.
6. `AGENDA_SOURCE=crm`. ⛔ 72h estável. Só então remover credenciais do Google, arquivar `belasis-sync`, cancelar Belasis.
7. Fase 7 (unificação de gateway), trilha separada, só depois disso.

**Não cancelar a assinatura da Belasis antes da Etapa 6** — ela é o rollback.

---

## Riscos e armadilhas

1. Eco cruzado (Achado 1) — Task 2.
2. `belasis-sync` apagando a agenda (Achado 2) — Task 1.
3. Fuso ±3h se o CRM devolver timestamp sem offset — mitigado por rejeição explícita no parse.
4. Profissional errada na resposta (ex.: agenda da Scarlet junto) — sem forma de a Flora checar (payload é anônimo por design); cobertura só por teste de contrato e sombra.
5. Semântica de status: tudo exceto `cancelado`/`faltou` conta como ocupado.
6. `fim` exclusivo — se o CRM tratar como inclusivo, perde-se 30 min sistematicamente.
7. CRM devolvendo `{ok:true, ocupados:[]}` por bug de deploy — sem guardrail, vira "mês todo livre"; por isso o `throw` na Task 3 é deliberado.
8. Rotação de `FLORA_API_SECRET`/`CRM_API_SECRET` esquecida de um lado — 401 vira fail-closed total; aceitar dois segredos válidos durante rotação.
9. Deploy durante o expediente perdendo pré-reserva (`void handlePendingActions`, fire-and-forget) ou o `echo-registry` em memória — janela de deploy fora de ter-sáb 08h-17h.
10. Prompt editado durante a sombra invalida a medição — congelar edições da Etapa 3 até a Etapa 6.
11. Duas Supabase (`jnfeerxcxxmgjutkfzig` da Flora, `kreltubqfoxrqkndnbtr` do CRM) — copiar env errado troca o banco lido silenciosamente.
12. `POST /webhooks/evolution` sem autenticação de origem (achado A4 anterior) — mesmo caminho de código sendo mexido aqui, vale fechar de carona.

## Verificação

| Etapa | Como validar |
|---|---|
| Task 1 | Teste simulando lista vazia da Belasis → throw |
| Task 2 | 48h de produção sem ativação de janela correlacionada a cron do CRM |
| Task 3-4 | `scripts/agenda-diff.ts` com divergência zero por 7 dias, dual-entry confirmado |
| Corte | 48h sem double-booking relatado, sem bloco de falha (`unverified`) recorrente nos logs |

## Self-Review

1. Cada achado P0 tem task com gate explícito antes de prosseguir para a agenda.
2. Nenhuma mudança em `studio-schedule.ts` ou nas regras de grade oficial nesta v1 — só a fonte de ocupação muda.
3. Todo flip de `AGENDA_SOURCE`/`AGENDA_SHADOW`/`EXTERNAL_ECHO_ENABLED` é rollback instantâneo, sem deploy.
