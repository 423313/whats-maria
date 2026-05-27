/**
 * Verifica se a migration de history foi aplicada corretamente.
 * Lista as versoes em agent_configs_history e o estado atual em agent_configs.
 *
 * Uso: node scripts/supabase/verify-history.mjs
 */

import { createSupabaseClient } from '../_lib/env.mjs';

const supabase = createSupabaseClient();

console.log('Verificando agent_configs_history...');

const { data: history, error } = await supabase
  .from('agent_configs_history')
  .select('id, agent_type, prompt_chars, saved_at, saved_by, notes')
  .eq('agent_type', 'default')
  .order('saved_at', { ascending: false });

if (error) {
  console.error('ERRO:', error.message);
  process.exit(1);
}

console.log(`Tabela existe. ${history.length} versao(oes) arquivada(s):`);
for (const h of history) {
  const when = new Date(h.saved_at).toLocaleString('pt-BR');
  console.log(`  #${h.id}  ${when}  ${h.prompt_chars.toLocaleString('pt-BR')} chars  ${h.saved_by}`);
  if (h.notes) console.log(`      "${h.notes}"`);
}

console.log('Estado atual em agent_configs:');
const { data: current } = await supabase
  .from('agent_configs')
  .select('agent_type, openai_model, updated_at')
  .eq('agent_type', 'default')
  .single();

if (current) {
  const when = new Date(current.updated_at).toLocaleString('pt-BR');
  console.log(`  ${current.agent_type} | ${current.openai_model} | ultima edicao ${when}`);
}
