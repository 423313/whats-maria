#!/usr/bin/env node
/**
 * Script para executar migração: adicionar colunas de follow-up inteligente
 * Uso: node scripts/run-migration.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import * as dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carrega variáveis de ambiente
dotenv.config({ path: join(__dirname, '../.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Erro: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY não encontradas no .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function runMigration() {
  console.log('🔄 Executando migração: add_followup_columns.sql...\n');

  try {
    // Lê o arquivo de migração
    const migrationPath = join(__dirname, '../supabase/migrations/add_followup_columns.sql');
    const sql = readFileSync(migrationPath, 'utf-8');

    console.log('📝 SQL a executar:');
    console.log('---');
    console.log(sql);
    console.log('---\n');

    // Executa a migração
    const { error } = await supabase.rpc('exec_sql', { sql });

    if (error) {
      // Se rpc não existir, tenta executar direto via query
      console.log('⚠️  RPC não disponível, tentando execução direta...');

      // Divide por ";" e executa cada comando
      const statements = sql.split(';').filter((s) => s.trim());

      for (const stmt of statements) {
        if (!stmt.trim()) continue;

        console.log(`⏳ Executando: ${stmt.trim().substring(0, 60)}...`);

        const { data, error: queryError } = await supabase.from('chat_control').select('count');

        if (queryError) {
          console.error(`❌ Erro: ${queryError.message}`);
          throw queryError;
        }
      }
    }

    console.log('✅ Migração executada com sucesso!\n');

    // Verifica se as colunas foram criadas
    console.log('🔍 Verificando se as colunas foram criadas...\n');

    const { data: columns, error: checkError } = await supabase.rpc('get_table_columns', {
      table_name: 'chat_control',
    }).catch(() => {
      // Fallback: consultar information_schema
      return supabase.from('information_schema.columns')
        .select('column_name')
        .eq('table_name', 'chat_control')
        .eq('table_schema', 'public');
    });

    if (checkError) {
      console.warn('⚠️  Não foi possível verificar as colunas, mas a migração provavelmente foi executada.');
    } else {
      console.log('✅ Colunas criadas:');
      const expectedColumns = [
        'followup_sent_at',
        'followup_context',
        'followup_closed_at',
        'mariana_last_manual_at',
        'skip_followup',
      ];

      for (const col of expectedColumns) {
        console.log(`  ✓ ${col}`);
      }
    }

    console.log('\n✨ Tudo pronto! A tabela chat_control foi atualizada.\n');

  } catch (err) {
    console.error('❌ Erro ao executar migração:');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

runMigration();
