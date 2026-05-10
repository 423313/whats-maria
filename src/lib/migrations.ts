import { supabase } from './supabase.js';
import { logger } from './logger.js';

export async function runMigrations(): Promise<void> {
  logger.info('🔄 Iniciando migrações de banco...');

  const migrations = [
    {
      name: 'add_skip_followup_column',
      description: 'Adiciona coluna skip_followup à tabela chat_control',
      async execute() {
        const { error } = await supabase
          .from('chat_control')
          .select('skip_followup')
          .limit(1);

        if (error?.code === '42703') {
          logger.warn(
            'skip_followup column not found. Execute: ALTER TABLE public.chat_control ADD COLUMN IF NOT EXISTS skip_followup boolean NOT NULL DEFAULT false;'
          );
          return;
        }

        if (!error) {
          logger.info('✅ skip_followup column exists');
        }
      },
    },
  ];

  for (const migration of migrations) {
    try {
      await migration.execute();
    } catch (err) {
      logger.error(
        { migration: migration.name, err: err instanceof Error ? err.message : String(err) },
        'Erro em migração'
      );
    }
  }

  logger.info('✅ Migrações concluídas');
}
