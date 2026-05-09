/**
 * Aplica o system_prompt da Flora no Supabase usando o SUPABASE_SERVICE_ROLE_KEY
 * do .env. Lê o conteúdo do prompt extraindo o trecho entre $$...$$ do
 * update-prompt.sql (fonte da verdade local).
 *
 * Uso: node supabase/apply-prompt.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── carrega .env manualmente (sem dependência extra) ────────────────────────
const envPath = resolve(__dirname, '..', '.env');
const envText = readFileSync(envPath, 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
}

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERRO: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes no .env');
  process.exit(1);
}

// ── extrai o prompt do update-prompt.sql ────────────────────────────────────
const sqlPath = resolve(__dirname, 'update-prompt.sql');
const sqlText = readFileSync(sqlPath, 'utf8');

const match = sqlText.match(/set system_prompt = \$\$([\s\S]*?)\$\$,\s*\n\s*updated_at/);
if (!match) {
  console.error('ERRO: não consegui extrair o prompt entre $$...$$ no update-prompt.sql');
  process.exit(1);
}

const systemPrompt = match[1];
console.log(`Prompt extraído: ${systemPrompt.length} caracteres`);

// ── aplica via supabase-js ──────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

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
  console.error('ERRO: nenhuma linha foi atualizada (agent_type=default não existe?)');
  process.exit(1);
}

console.log('✅ Prompt aplicado com sucesso.');
console.log('   agent_type:', data[0].agent_type);
console.log('   updated_at:', data[0].updated_at);
console.log('   tamanho do prompt:', systemPrompt.length, 'chars');
console.log('\nO cache do agent_config tem 30s. Aguarde 30s antes de testar.');
