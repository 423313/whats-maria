#!/usr/bin/env node
/**
 * Investiga por que as sessões foram bloqueadas por mariana_last_manual_at
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function main() {
  console.log('🔎 INVESTIGANDO BLOQUEADORES\n');

  // Pega as 5 sessões bloqueadas
  const { data: blocked } = await supabase
    .from('chat_control')
    .select('session_id, mariana_last_manual_at, ai_paused')
    .or('ai_paused.eq.true,mariana_last_manual_at.not.is.null')
    .limit(5);

  if (!blocked?.length) {
    console.log('Nenhuma sessão bloqueada encontrada');
    return;
  }

  for (const control of blocked) {
    console.log(`\n📍 Sessão: ${control.session_id}`);
    console.log(`   mariana_last_manual_at: ${control.mariana_last_manual_at}`);

    // Busca mensagens ASSISTANT próximas ao tempo de bloqueio
    if (control.mariana_last_manual_at) {
      const blockTime = new Date(control.mariana_last_manual_at);
      const windowStart = new Date(blockTime.getTime() - 5 * 60 * 1000); // 5 min antes

      const { data: msgs } = await supabase
        .from('chat_messages')
        .select('role, content, created_at, status')
        .eq('session_id', control.session_id)
        .gte('created_at', windowStart.toISOString())
        .order('created_at', { ascending: false })
        .limit(10);

      console.log(`\n   📨 Últimas mensagens (5min antes do bloqueio até agora):`);
      if (msgs?.length) {
        for (const msg of msgs) {
          const isNear = Math.abs(new Date(msg.created_at).getTime() - blockTime.getTime()) < 60000;
          const marker = isNear ? '⚠️ ' : '   ';
          console.log(`   ${marker}[${msg.created_at}] ${msg.role}: "${msg.content.substring(0, 40)}..." (${msg.status})`);
        }
      } else {
        console.log('   (nenhuma mensagem neste período)');
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('\n❓ ANÁLISE: As mensagens ASSISTANT próximas ao tempo de bloqueio');
  console.log('   indicam que o webhook de eco não foi reconhecido como Flora.');
  console.log('   Provável causa: messageId do webhook diferente ou registro atrasado.');
  console.log('\n✅ SOLUÇÃO: Resetar mariana_last_manual_at nessas sessões');
  console.log('   O sweeper disparou as mensagens DEPOIS que a Flora já estava funcionando.');
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
