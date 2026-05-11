#!/usr/bin/env node
/**
 * Verifica mensagens pendentes nas sessões desbloqueadas
 * e sua status no chat_control
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function main() {
  console.log('Buscando mensagens pendentes...\n');

  // Busca todas as mensagens com status 'pending'
  const { data: pendingMsgs, error: msgErr } = await supabase
    .from('chat_messages')
    .select('session_id, id, content, created_at, status, role')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (msgErr) {
    console.error('ERRO ao buscar mensagens:', msgErr.message);
    process.exit(1);
  }

  console.log(`📨 Total de mensagens pendentes: ${pendingMsgs?.length || 0}\n`);

  if (!pendingMsgs?.length) {
    console.log('✅ Nenhuma mensagem pendente! Sistema está limpo.');
    return;
  }

  // Agrupa por session_id
  const bySession = new Map();
  for (const msg of pendingMsgs) {
    if (!bySession.has(msg.session_id)) {
      bySession.set(msg.session_id, []);
    }
    bySession.get(msg.session_id).push(msg);
  }

  console.log(`📊 Sessões com mensagens pendentes: ${bySession.size}\n`);

  for (const [sessionId, msgs] of bySession) {
    console.log(`\n🔍 Session: ${sessionId}`);
    console.log(`   Mensagens pendentes: ${msgs.length}`);

    // Mostra as mensagens
    for (const msg of msgs.slice(0, 3)) {
      const preview = msg.content.substring(0, 60).replace(/\n/g, ' ');
      console.log(`   - [${msg.created_at}] ${msg.role}: "${preview}${msg.content.length > 60 ? '...' : ''}"`);
    }
    if (msgs.length > 3) {
      console.log(`   ... e mais ${msgs.length - 3} mensagem(ns)`);
    }

    // Verifica bloqueadores
    const { data: control } = await supabase
      .from('chat_control')
      .select('ai_paused, mariana_last_manual_at, skip_followup, followup_sent_at, followup_closed_at')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (control) {
      console.log(`\n   Status na chat_control:`);
      if (control.ai_paused) console.log(`   ⚠️  ai_paused = true (BLOQUEADO - humano no controle)`);
      if (control.mariana_last_manual_at) {
        const elapsed = Math.round((Date.now() - new Date(control.mariana_last_manual_at).getTime()) / 1000 / 60);
        console.log(`   ⚠️  mariana_last_manual_at = ${control.mariana_last_manual_at} (${elapsed} min atrás, BLOQUEADO se < 24h)`);
      }
      if (control.skip_followup) console.log(`   ℹ️  skip_followup = true`);
      if (control.followup_sent_at) console.log(`   ℹ️  followup_sent_at = ${control.followup_sent_at}`);
      if (control.followup_closed_at) console.log(`   ℹ️  followup_closed_at = ${control.followup_closed_at}`);
      if (!control.ai_paused && !control.mariana_last_manual_at) {
        console.log(`   ✅ Sem bloqueadores - pronta para responder`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('💡 Se não há bloqueadores, as mensagens serão processadas pelo sweeper');
  console.log('   em até 5 minutos. Se precisar forçar agora, execute apply-pending.mjs');
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
