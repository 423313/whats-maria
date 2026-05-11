#!/usr/bin/env node
/**
 * Busca o prompt atual da Flora no Supabase
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function main() {
  console.log('Buscando prompt atual da Flora...\n');

  const { data, error } = await supabase
    .from('agent_configs')
    .select('system_prompt')
    .eq('agent_name', 'flora')
    .single();

  if (error) {
    console.error('ERRO:', error.message);
    process.exit(1);
  }

  if (!data?.system_prompt) {
    console.log('Nenhum prompt encontrado');
    return;
  }

  // Salva em arquivo para inspecionar
  console.log('✅ Prompt encontrado. Salvando em arquivo...\n');
  const fs = await import('fs/promises');
  await fs.writeFile('current-prompt.txt', data.system_prompt, 'utf-8');

  // Mostra primeiras 2000 caracteres
  const preview = data.system_prompt.substring(0, 2000);
  console.log('PRIMEIROS 2000 CARACTERES:');
  console.log('='.repeat(60));
  console.log(preview);
  console.log('='.repeat(60));
  console.log(`\n📄 Arquivo completo salvo em: current-prompt.txt (${data.system_prompt.length} caracteres)`);

  // Busca por palavras-chave perigosas
  const keywords = ['painel', 'admin', 'railway', 'url', 'link', 'https://', 'http://', 'interno', 'operacional'];
  const found = [];
  for (const kw of keywords) {
    if (data.system_prompt.toLowerCase().includes(kw)) {
      found.push(kw);
    }
  }

  if (found.length > 0) {
    console.log(`\n⚠️  Palavras-chave encontradas que podem ser problemáticas: ${found.join(', ')}`);
  }
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
