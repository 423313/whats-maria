/**
 * Libera a sessao de teste do Pedro (41999595242) no chat_control:
 *  - remove a janela manual da Mariana (mariana_last_manual_at = null)
 *  - despausa AI (ai_paused = false)
 *
 * Uso: node scripts/supabase/unlock-test-session.mjs
 */

import { createSupabaseClient } from '../_lib/env.mjs';

const supabase = createSupabaseClient();

const phoneFragment = '99595242';

// Lista antes
const { data: before, error: errBefore } = await supabase
  .from('chat_control')
  .select('session_id, ai_paused, mariana_last_manual_at, client_name')
  .like('session_id', `%${phoneFragment}%`);

if (errBefore) {
  console.error('ERRO leitura:', errBefore.message);
  process.exit(1);
}

console.log(`Sessoes encontradas com '${phoneFragment}':`);
for (const row of before ?? []) {
  console.log(' ', row);
}

if (!before || before.length === 0) {
  console.log('Nenhuma sessao encontrada - nada a fazer.');
  process.exit(0);
}

const { data: after, error: errUpd } = await supabase
  .from('chat_control')
  .update({
    mariana_last_manual_at: null,
    ai_paused: false,
    updated_at: new Date().toISOString(),
  })
  .like('session_id', `%${phoneFragment}%`)
  .select('session_id, ai_paused, mariana_last_manual_at');

if (errUpd) {
  console.error('ERRO update:', errUpd.message);
  process.exit(1);
}

console.log('Sessoes liberadas:');
for (const row of after ?? []) {
  console.log(' ', row);
}
