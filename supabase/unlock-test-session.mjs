/**
 * Libera a sessão de teste do Pedro (41999595242) no chat_control:
 *  - remove a janela manual da Mariana (mariana_last_manual_at = null)
 *  - despausa AI (ai_paused = false)
 *
 * Uso: node supabase/unlock-test-session.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envText = readFileSync(resolve(__dirname, '..', '.env'), 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

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

console.log(`Sessões encontradas com '${phoneFragment}':`);
for (const row of before ?? []) {
  console.log(' ', row);
}

if (!before || before.length === 0) {
  console.log('Nenhuma sessão encontrada — nada a fazer.');
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

console.log('\n✅ Sessões liberadas:');
for (const row of after ?? []) {
  console.log(' ', row);
}
