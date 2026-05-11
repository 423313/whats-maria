import { supabase } from './supabase.js';
import { logger } from './logger.js';

/**
 * Executa migrações de banco de dados na inicialização da app
 * Tenta criar colunas/tabelas que possam estar faltando
 */
export async function runMigrations(): Promise<void> {
  logger.info('🔄 Iniciando migrações de banco...');

  const migrations = [
    {
      name: 'add_skip_followup_column',
      description: 'Adiciona coluna skip_followup à tabela chat_control',
      async execute() {
        // Testa se coluna existe tentando fazer uma query
        const { error } = await supabase
          .from('chat_control')
          .select('skip_followup')
          .limit(1);

        if (error?.code === '42703') {
          // Coluna não existe, precisa ser criada
          // Como Supabase não permite SQL direto, registramos o aviso
          logger.warn(
            'skip_followup column not found in chat_control. ' +
            'Please execute this SQL in Supabase SQL Editor: ' +
            'ALTER TABLE public.chat_control ADD COLUMN IF NOT EXISTS skip_followup boolean NOT NULL DEFAULT false;'
          );
          return;
        }

        if (!error) {
          logger.info('✅ Coluna skip_followup já existe');
        }
      },
    },
    {
      name: 'ensure_chat_control_columns',
      description: 'Verifica se as colunas esperadas existem em chat_control',
      async execute() {
        const requiredColumns = [
          'followup_sent_at',
          'followup_context',
          'followup_closed_at',
          'mariana_last_manual_at',
          'skip_followup',
        ];

        const { data, error } = await supabase
          .from('chat_control')
          .select('*')
          .limit(1);

        if (error) {
          logger.error({ err: error }, 'erro ao verificar colunas');
          return;
        }

        if (data && data.length > 0) {
          const row = data[0] as Record<string, unknown>;
          const missingColumns = requiredColumns.filter(col => !(col in row));

          if (missingColumns.length > 0) {
            logger.warn(
              { missing: missingColumns },
              'Colunas faltando em chat_control. ' +
              'Execute a migração em: supabase/migrations/add_followup_columns.sql'
            );
          } else {
            logger.info('✅ Todas as colunas esperadas existem em chat_control');
          }
        }
      },
    },
  ];

  for (const migration of migrations) {
    try {
      logger.info({ migration: migration.name }, '⏳ Executando migração...');
      await migration.execute();
      logger.info({ migration: migration.name }, '✅ Migração OK');
    } catch (err) {
      logger.error(
        { migration: migration.name, err: err instanceof Error ? err.message : String(err) },
        'Erro ao executar migração'
      );
    }
  }

  logger.info('🔄 Migrações concluídas');
}
