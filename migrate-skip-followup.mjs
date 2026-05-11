#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

(async () => {
  console.log('🔍 Verificando coluna skip_followup...\n');
  
  const { data, error } = await supabase
    .from('chat_control')
    .select('skip_followup')
    .limit(1)
    .maybeSingle();

  if (error?.code === '42703') {
    console.log('❌ Coluna skip_followup NÃO existe');
    console.log('\n🔗 Link direto para SQL Editor:');
    console.log('https://supabase.com/dashboard/project/jnfeerxcxxmgjutkfzig/sql/new\n');
    console.log('Cole este SQL:');
    console.log('ALTER TABLE public.chat_control ADD COLUMN IF NOT EXISTS skip_followup boolean NOT NULL DEFAULT false;');
  } else if (error) {
    console.log('⚠️  Erro:', error.message);
  } else {
    console.log('✅ Coluna skip_followup JÁ existe!');
  }
})();
