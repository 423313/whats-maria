#!/usr/bin/env node
/**
 * Reseta mariana_last_manual_at nas 5 sessões que foram bloqueadas incorretamente
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function main() {
  const sessionsToFix = [
    '55418503178865@s.whatsapp.net',
    '554199044844@s.whatsapp.net',
    '554185031788@s.whatsapp.net',
    '558179032080@s.whatsapp.net',
    '554196137916@s.whatsapp.net',
  ];

  console.log('🔧 RESETANDO SESSÕES BLOQUEADAS INCORRETAMENTE\n');
  console.log(`Sessões a desbloquear: ${sessionsToFix.length}\n`);

  const now = new Date().toISOString();

  for (const sessionId of sessionsToFix) {
    console.log(`  - ${sessionId}`);
    const { error } = await supabase
      .from('chat_control')
      .update({
        mariana_last_manual_at: null,
        updated_at: now,
      })
      .eq('session_id', sessionId);

    if (error) {
      console.log(`    ❌ Erro: ${error.message}`);
    } else {
      console.log(`    ✅ Desbloqueada`);
    }
  }

  console.log('\n✅ Todas as sessões foram resetadas!');
  console.log('   Flora pode responder normalmente agora.');
}

main().catch((err) => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
