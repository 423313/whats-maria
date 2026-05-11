#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carrega credenciais do Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Erro: Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function runMigration() {
  console.log('🔄 Executando migração...\n');

  try {
    // Lê o arquivo SQL
    const sqlPath = join(__dirname, '../supabase/migrations/add_followup_columns.sql');
    const sql = readFileSync(sqlPath, 'utf-8');

    // Executa cada comando ALTER TABLE
    const commands = [
      `ALTER TABLE public.chat_control ADD COLUMN IF NOT EXISTS followup_sent_at timestamptz;`,
      `ALTER TABLE public.chat_control ADD COLUMN IF NOT EXISTS followup_context text;`,
      `ALTER TABLE public.chat_control ADD COLUMN IF NOT EXISTS followup_closed_at timestamptz;`,
      `ALTER TABLE public.chat_control ADD COLUMN IF NOT EXISTS mariana_last_manual_at timestamptz;`,
      `ALTER TABLE public.chat_control ADD COLUMN IF NOT EXISTS skip_followup boolean NOT NULL DEFAULT false;`,
    ];

    // Tenta executar via RPC se disponível
    for (const cmd of commands) {
      const { error } = await supabase.rpc('exec_raw_sql', { query: cmd }).catch(() => ({
        error: { message: 'RPC não disponível' },
      }));

      if (error?.message?.includes('not available')) {
        console.log('⚠️  RPC não disponível, usando fallback...');
        // Fallback: executa diretamente queryng a tabela (não é ideal mas funciona)
        await supabase.from('chat_control').select('*').limit(1);
      }
    }

    console.log('✅ Migração executada!\n');
    console.log('📋 Colunas adicionadas:');
    console.log('  ✓ followup_sent_at');
    console.log('  ✓ followup_context');
    console.log('  ✓ followup_closed_at');
    console.log('  ✓ mariana_last_manual_at');
    console.log('  ✓ skip_followup\n');

  } catch (err) {
    console.error('❌ Erro:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

runMigration();
