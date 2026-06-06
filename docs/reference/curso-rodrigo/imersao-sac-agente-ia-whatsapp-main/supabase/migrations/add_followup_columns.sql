-- Migração: Adicionar colunas de follow-up inteligente à tabela chat_control
-- Data: 2026-05-10
-- Objetivo: Implementar verificações inteligentes para evitar follow-ups fora de contexto

BEGIN;

-- Adiciona coluna followup_sent_at (rastreia quando o follow-up foi enviado)
ALTER TABLE public.chat_control
ADD COLUMN IF NOT EXISTS followup_sent_at timestamptz;

-- Adiciona coluna followup_context (tipo de contexto detectado na conversa)
ALTER TABLE public.chat_control
ADD COLUMN IF NOT EXISTS followup_context text;

-- Adiciona coluna followup_closed_at (quando a conversa foi encerrada)
ALTER TABLE public.chat_control
ADD COLUMN IF NOT EXISTS followup_closed_at timestamptz;

-- Adiciona coluna mariana_last_manual_at (rastreia última mensagem manual da Mariana)
-- Usado pra implementar "janela de 24h" onde a Flora não responde
ALTER TABLE public.chat_control
ADD COLUMN IF NOT EXISTS mariana_last_manual_at timestamptz;

-- Adiciona coluna skip_followup (marca sessões que não devem ter follow-up automático)
-- Usado quando: conversa muito curta, cliente finalizou naturalmente, etc
ALTER TABLE public.chat_control
ADD COLUMN IF NOT EXISTS skip_followup boolean NOT NULL DEFAULT false;

COMMIT;
