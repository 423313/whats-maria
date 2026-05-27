/**
 * Migration manual via conexao Postgres direta.
 * Adiciona a coluna skip_followup em chat_control.
 *
 * Le a connection string do .env (variavel SUPABASE_DB_URL).
 * Formato esperado: postgresql://postgres:<senha>@db.<ref>.supabase.co:5432/postgres
 *
 * Uso: node scripts/migrations/migrate-db.mjs
 */

import pg from 'pg';
import { env } from '../_lib/env.mjs';

const { Client } = pg;

const connectionString = env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error('ERRO: SUPABASE_DB_URL ausente no .env');
  console.error('Adicione no .env (formato):');
  console.error('  SUPABASE_DB_URL=postgresql://postgres:<senha>@db.<ref>.supabase.co:5432/postgres');
  process.exit(1);
}

const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  console.log('Executando migration SQL...');

  try {
    console.log('Conectando ao banco de dados...');
    await client.connect();
    console.log('Conectado.');

    const sql = 'ALTER TABLE public.chat_control ADD COLUMN IF NOT EXISTS skip_followup boolean NOT NULL DEFAULT false;';

    console.log('Executando SQL:');
    console.log('  ' + sql);

    await client.query(sql);

    console.log('Coluna skip_followup adicionada com sucesso.');

    await client.end();
  } catch (err) {
    console.error('Erro:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

migrate();
