#!/usr/bin/env node
/**
 * Script para adicionar coluna skip_followup à tabela chat_control
 * Uso: node migrate-add-skip-followup.mjs
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://jnfeerxcxxmgjutkfzig.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  db: { schema: 'public' },
});

async function migrate() {
  console.log('🔄 Adicionando coluna skip_followup à tabela chat_control...\n');

  try {
    // Tenta acessar a tabela para testar conexão
    const { count, error: countError } = await supabase
      .from('chat_control')
      .select('*', { count: 'exact', head: true });

    if (countError) {
      console.error('❌ Erro ao conectar ao Supabase:');
      console.error(countError.message);
      process.exit(1);
    }

    console.log(`✅ Conectado ao Supabase (${count} registros em chat_control)\n`);

    // Nota: O cliente Supabase JS não pode executar SQL bruto.
    // Precisamos usar uma abordagem alternativa.
    console.log('⚠️  Limitação: Cliente Supabase JS não executa SQL direto.');
    console.log('');
    console.log('🔧 SOLUÇÃO: Execute no Supabase SQL Editor:');
    console.log('');
    console.log('URL: https://supabase.com/dashboard/project/jnfeerxcxxmgjutkfzig/sql/new');
    console.log('');
    console.log('SQL a executar:');
    console.log('---');
    console.log('ALTER TABLE public.chat_control');
    console.log('ADD COLUMN IF NOT EXISTS skip_followup boolean NOT NULL DEFAULT false;');
    console.log('---');
    console.log('');
    console.log('Depois clique RUN no Supabase.');
    console.log('');

    // Verifica se coluna já existe tentando acessar
    console.log('🔍 Verificando se coluna já existe...');
    const { data, error } = await supabase
      .from('chat_control')
      .select('skip_followup')
      .limit(1)
      .maybeSingle();

    if (error?.code === '42703') {
      console.log('❌ Coluna skip_followup NÃO existe ainda.');
      console.log('   ⚠️  Execute o SQL acima no Supabase SQL Editor.');
      process.exit(1);
    } else if (error) {
      console.log(`⚠️  Erro ao verificar: ${error.message}`);
    } else {
      console.log('✅ Coluna skip_followup já existe!');
      console.log('   Nenhuma ação necessária.');
    }

  } catch (err) {
    console.error('❌ Erro inesperado:');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

migrate();
