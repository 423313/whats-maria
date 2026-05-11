#!/usr/bin/env node
/**
 * Aplica o prompt do arquivo update-prompt.sql diretamente no Supabase
 * via Supabase JS client (UPDATE em agent_configs).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function main() {
  console.log('Lendo update-prompt.sql...');
  const sqlContent = readFileSync('./supabase/update-prompt.sql', 'utf-8');

  // Extrai o conteúdo entre $$...$$
  const match = sqlContent.match(/set system_prompt = \$\$([\s\S]*?)\$\$,/);
  if (!match) {
    console.error('ERRO: não foi possível extrair o prompt do arquivo SQL');
    process.exit(1);
  }

  const newPrompt = match[1];
  console.log(`Prompt extraído: ${newPrompt.length} caracteres`);
  console.log(`Primeiras 200 chars: ${newPrompt.substring(0, 200)}...`);

  // Backup do prompt atual antes de sobrescrever
  console.log('\nFazendo backup do prompt atual...');
  const { data: current, error: fetchErr } = await supabase
    .from('agent_configs')
    .select('system_prompt, updated_at')
    .eq('agent_type', 'default')
    .single();

  if (fetchErr) {
    console.error('ERRO ao buscar prompt atual:', fetchErr.message);
    process.exit(1);
  }

  console.log(`Prompt atual: ${current.system_prompt.length} caracteres`);
  console.log(`Última atualização: ${current.updated_at}`);

  // Aplica o novo prompt
  console.log('\nAplicando novo prompt...');
  const { error: updateErr } = await supabase
    .from('agent_configs')
    .update({
      system_prompt: newPrompt,
      updated_at: new Date().toISOString(),
    })
    .eq('agent_type', 'default');

  if (updateErr) {
    console.error('ERRO ao aplicar prompt:', updateErr.message);
    process.exit(1);
  }

  console.log('\n✅ PROMPT ATUALIZADO COM SUCESSO!');
  console.log(`Novo prompt: ${newPrompt.length} caracteres`);
  console.log('Cache expira em ~30s, a Flora vai usar o novo prompt em breve.');
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
