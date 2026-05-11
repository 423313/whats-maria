import pg from 'pg';

// Tenta ler a senha do .env
const fs = await import('fs');
const dotenv = await import('dotenv');
const path = await import('path');

const envPath = path.resolve('./. env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const client = new Client({
  // Usa SSL para conexões remotas ao Supabase
  connectionString: 'postgresql://postgres:[PASSWORD]@db.jnfeerxcxxmgjutkfzig.supabase.co:5432/postgres?sslmode=require',
  ssl: {
    rejectUnauthorized: false
  }
});

async function migrate() {
  console.log('🔄 Executando Migração...\n');
  console.log('⚠️  Nota: A senha do banco de dados não está disponível via .env.');
  console.log('        Para executar a migração, use o Supabase SQL Editor.\n');
  
  console.log('🔗 Link direto: https://supabase.com/dashboard/project/jnfeerxcxxmgjutkfzig/sql/new\n');
  
  console.log('📋 SQL a executar:');
  console.log('---');
  console.log('ALTER TABLE public.chat_control ADD COLUMN IF NOT EXISTS skip_followup boolean NOT NULL DEFAULT false;');
  console.log('---\n');
  
  console.log('✅ Instruções:');
  console.log('1. Clique no link acima');
  console.log('2. Cole o SQL');
  console.log('3. Clique RUN');
  console.log('4. Pronto!\n');
}

migrate();
