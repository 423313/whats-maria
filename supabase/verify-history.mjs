/**
 * Verifica se a migration de history foi aplicada corretamente.
 * Lista as versões em agent_configs_history e o estado atual em agent_configs.
 *
 * Uso: node supabase/verify-history.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env'), 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

console.log('Verificando agent_configs_history...\n');

const { data: history, error } = await supabase
  .from('agent_configs_history')
  .select('id, agent_type, prompt_chars, saved_at, saved_by, notes')
  .eq('agent_type', 'default')
  .order('saved_at', { ascending: false });

if (error) {
  console.error('❌ ERRO:', error.message);
  process.exit(1);
}

console.log(`✅ Tabela existe. ${history.length} versão(ões) arquivada(s):\n`);
for (const h of history) {
  const when = new Date(h.saved_at).toLocaleString('pt-BR');
  console.log(`  #${h.id}  ${when}  ${h.prompt_chars.toLocaleString('pt-BR')} chars  ${h.saved_by}`);
  if (h.notes) console.log(`      "${h.notes}"`);
}

console.log('\nEstado atual em agent_configs:');
const { data: current } = await supabase
  .from('agent_configs')
  .select('agent_type, openai_model, updated_at')
  .eq('agent_type', 'default')
  .single();

if (current) {
  const when = new Date(current.updated_at).toLocaleString('pt-BR');
  console.log(`  ${current.agent_type} · ${current.openai_model} · última edição ${when}`);
}
