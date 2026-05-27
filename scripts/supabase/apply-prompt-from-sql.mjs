/**
 * Aplica o system_prompt da Flora no Supabase usando o SUPABASE_SERVICE_ROLE_KEY
 * do .env. Le o conteudo do prompt extraindo o trecho entre $$...$$ do
 * update-prompt.sql (fonte da verdade local).
 *
 * Uso: node scripts/supabase/apply-prompt-from-sql.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSupabaseClient } from '../_lib/env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Extrai o prompt do update-prompt.sql
const sqlPath = resolve(__dirname, '..', '..', 'supabase', 'update-prompt.sql');
const sqlText = readFileSync(sqlPath, 'utf8');

const match = sqlText.match(/set system_prompt = \$\$([\s\S]*?)\$\$,\s*\n\s*updated_at/);
if (!match) {
  console.error('ERRO: nao consegui extrair o prompt entre $$...$$ no update-prompt.sql');
  process.exit(1);
}

const systemPrompt = match[1];
console.log('Prompt extraido: ' + systemPrompt.length + ' caracteres');

// Aplica via supabase-js
const supabase = createSupabaseClient();

console.log('Atualizando agent_configs.system_prompt...');

const { data, error } = await supabase
  .from('agent_configs')
  .update({
    system_prompt: systemPrompt,
    updated_at: new Date().toISOString(),
  })
  .eq('agent_type', 'default')
  .select('agent_type, updated_at');

if (error) {
  console.error('ERRO Supabase:', error.message);
  process.exit(1);
}

if (!data || data.length === 0) {
  console.error('ERRO: nenhuma linha foi atualizada (agent_type=default nao existe?)');
  process.exit(1);
}

console.log('Prompt aplicado com sucesso.');
console.log('  agent_type:', data[0].agent_type);
console.log('  updated_at:', data[0].updated_at);
console.log('  tamanho do prompt:', systemPrompt.length, 'chars');
console.log('O cache do agent_config tem 30s. Aguarde 30s antes de testar.');
