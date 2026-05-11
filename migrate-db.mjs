import pg from 'pg';

const { Client } = pg;

const client = new Client({
  host: 'db.jnfeerxcxxmgjutkfzig.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'BeLlS@20#!'
});

async function migrate() {
  console.log('🔄 Executando Migração SQL...\n');

  try {
    console.log('⏳ Conectando ao banco de dados...');
    await client.connect();
    console.log('✅ Conectado!\n');

    const sql = 'ALTER TABLE public.chat_control ADD COLUMN IF NOT EXISTS skip_followup boolean NOT NULL DEFAULT false;';

    console.log('⏳ Executando SQL:');
    console.log(`   ${sql}\n`);

    await client.query(sql);

    console.log('✅ Coluna skip_followup adicionada com sucesso!\n');

    await client.end();

  } catch (err) {
    console.error('❌ Erro:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

migrate();
