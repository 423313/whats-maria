/**
 * Helper compartilhado pelos scripts em scripts/**.
 *
 * Lê o .env da raiz do projeto e expõe:
 *   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (constantes)
 *   - createSupabaseClient(): client já configurado em modo service-role
 *
 * Uso:
 *   import { createSupabaseClient } from '../_lib/env.mjs';
 *   const supabase = createSupabaseClient();
 *
 * Premissa: scripts vivem em scripts/<categoria>/<arquivo>.mjs (2 níveis acima do .env).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '..', '.env');

let envText;
try {
  envText = readFileSync(envPath, 'utf8');
} catch (err) {
  console.error(`ERRO: não consegui ler ${envPath}`);
  console.error('Verifique se o arquivo .env existe na raiz do projeto.');
  process.exit(1);
}

const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
}

export const SUPABASE_URL = env.SUPABASE_URL;
export const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
export const OPENAI_API_KEY = env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERRO: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes no .env');
  process.exit(1);
}

export function createSupabaseClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export { env };
