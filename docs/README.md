# Documentação — Agente Flora (Studio Mariana Castro)

Índice da documentação do projeto. A referência técnica principal (arquitetura,
regras de negócio, invariantes) fica no [`CLAUDE.md`](../CLAUDE.md) na raiz.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| [`deploy/`](deploy/) | Guias de deploy e infraestrutura (Railway) |
| [`prompt/`](prompt/) | Construção e manutenção do system prompt da Flora |
| [`fixes/`](fixes/) | Histórico de correções relevantes (post-mortems) |
| [`melhorias/`](melhorias/) | Mapeamento de gaps e plano de melhorias |
| [`saas/`](saas/) | Documentação do produto SaaS multi-tenant (em construção) |
| [`reference/`](reference/) | Material de referência externo (curso, exemplos) |

## Documentos principais

- [`melhorias/mapeamento.md`](melhorias/mapeamento.md) — mapa completo de melhorias, gaps e bloqueadores (qualidade, segurança/LGPD, multi-tenant)
- [`deploy/railway-via-chrome.md`](deploy/railway-via-chrome.md) — subir os 3 serviços na Railway via extensão Claude for Chrome
- [`prompt/build-prompt.md`](prompt/build-prompt.md) — guia de construção do system prompt
- [`fixes/agendamentos.md`](fixes/agendamentos.md) — correção do fluxo de agendamentos
- [`saas/README.md`](saas/README.md) — roadmap do produto SaaS multi-tenant
