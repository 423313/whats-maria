# docs/saas/

Documentação do produto SaaS multi-tenant (transformação da Flora em produto vendável).

## Roadmap de execução

Ver plano mestre: `C:\Users\Pedro\.claude\plans\snazzy-snuggling-lemur.md`

## Estrutura prevista

```
docs/saas/
├── README.md              Este arquivo
├── arquitetura.md         Decisões técnicas de multi-tenancy (a criar)
├── onboarding-cliente.md  Fluxo de cadastro de novo studio (a criar)
├── customizacao.md        O que cliente pode mudar via painel vs serviço pago (a criar)
├── pacotes-precos.md      Tabela comercial (a criar)
└── lgpd.md                Conformidade e contrato de operador de dados (a criar)
```

## Estado atual (fase 1.1 — base multi-tenant)

- [x] Criar tabelas `tenants`, `tenant_configs`, `tenant_professionals`
- [x] Adicionar `tenant_id` em todas as tabelas existentes
- [x] Migrar Studio Mariana como primeiro tenant
- [ ] Refatorar código para resolver tenant a partir do webhook (fase 1.2)
- [ ] Refatorar config global para por tenant (fase 1.3)
- [ ] Migrar hardcodes para dados (fase 1.4)
- [ ] Template de system prompt (fase 1.5)
