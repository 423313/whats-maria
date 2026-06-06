# src/prompts/

Templates de system prompt para o produto SaaS multi-tenant.

## Estrutura

```
prompts/
├── template-beauty.md       Template padrão para studios beauty (unhas, sobrancelhas, cílios, cabelo)
└── ...                      Outros templates por nicho/vertical, conforme expandirmos
```

## Como funciona

Cada tenant pode usar um template base + dados estruturados do `tenant_configs` (nome do studio, agente, profissionais, preços, horários, chave Pix, etc.). Os placeholders são preenchidos em runtime pela função `renderPrompt(tenantId)` em `src/services/agent-config.ts`.

Se o tenant tem `tenant_configs.custom_prompt` preenchido, ele sobrescreve o template (modo "customização profunda").

## Placeholders padrão

| Placeholder | Origem |
|---|---|
| `{{studio_name}}` | `tenant_configs.studio_name` |
| `{{agent_name}}` | `tenant_configs.agent_name` |
| `{{schedule}}` | `tenant_configs.schedule_config` (renderizado) |
| `{{professionals}}` | `tenant_professionals` (renderizado) |
| `{{pix_key}}` | `tenant_configs.pix_key` |
| `{{notify_phone_label}}` | "Mariana", "Ana", etc. — nome do owner |
