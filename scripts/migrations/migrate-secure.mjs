/**
 * Imprime instrucoes pra rodar a migration manualmente no Supabase SQL Editor,
 * sem precisar conectar via pg client.
 *
 * Uso: node scripts/migrations/migrate-secure.mjs
 */

import { env } from '../_lib/env.mjs';

// Extrai o project ref do SUPABASE_URL (ex: https://abcdefgh.supabase.co)
const supabaseUrl = env.SUPABASE_URL || '';
const refMatch = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/);
const projectRef = refMatch ? refMatch[1] : '<seu-project-ref>';

console.log('Migration via SQL Editor (modo seguro - sem expor senha)');
console.log('Link direto: https://supabase.com/dashboard/project/' + projectRef + '/sql/new');
console.log('');
console.log('SQL a executar:');
console.log('---');
console.log('ALTER TABLE public.chat_control ADD COLUMN IF NOT EXISTS skip_followup boolean NOT NULL DEFAULT false;');
console.log('---');
console.log('');
console.log('Instrucoes:');
console.log('1. Clique no link acima');
console.log('2. Cole o SQL');
console.log('3. Clique RUN');
console.log('4. Pronto.');
