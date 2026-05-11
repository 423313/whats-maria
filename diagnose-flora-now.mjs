#!/usr/bin/env node
/**
 * Diagnóstico rápido do estado atual da Flora
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function main() {
  console.log('🔍 DIAGNÓSTICO RÁPIDO DA FLORA\n');

  // 1. Mensagens pendentes
  console.log('1️⃣  MENSAGENS PENDENTES');
  const { data: pending } = await supabase
    .from('chat_messages')
    .select('session_id, role, content, created_at, status')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(10);

  if (pending?.length) {
    console.log(`   ⚠️  ${pending.length} mensagens com status PENDING\n`);
    for (const msg of pending.slice(0, 5)) {
      console.log(`   - [${msg.created_at}] ${msg.session_id} (${msg.role}): "${msg.content.substring(0, 40)}..."`);
    }
  } else {
    console.log('   ✅ Nenhuma mensagem pendente\n');
  }

  // 2. Sessões bloqueadas
  console.log('2️⃣  SESSÕES BLOQUEADAS');
  const { data: blocked } = await supabase
    .from('chat_control')
    .select('session_id, ai_paused, mariana_last_manual_at, followup_sent_at')
    .or('ai_paused.eq.true,mariana_last_manual_at.not.is.null')
    .limit(10);

  if (blocked?.length) {
    console.log(`   ⚠️  ${blocked.length} sessões com bloqueadores\n`);
    for (const s of blocked.slice(0, 5)) {
      if (s.ai_paused) console.log(`   - ${s.session_id}: ai_paused=true`);
      if (s.mariana_last_manual_at) {
        const ago = Math.round((Date.now() - new Date(s.mariana_last_manual_at).getTime()) / 1000 / 60);
        console.log(`   - ${s.session_id}: mariana_last_manual_at (${ago}min atrás)`);
      }
    }
  } else {
    console.log('   ✅ Nenhuma sessão bloqueada\n');
  }

  // 3. Últimas mensagens
  console.log('3️⃣  ÚLTIMAS MENSAGENS DA FLORA');
  const { data: recent } = await supabase
    .from('chat_messages')
    .select('session_id, role, content, created_at, status')
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(5);

  if (recent?.length) {
    console.log('');
    for (const msg of recent) {
      const status = msg.status === 'sent' ? '✅' : '⏳';
      console.log(`   ${status} [${msg.created_at}] ${msg.session_id}: "${msg.content.substring(0, 50)}..."`);
    }
  } else {
    console.log('   ❌ Nenhuma mensagem recente da Flora\n');
  }

  // 4. Status do buffer de mensagens
  console.log('\n4️⃣  BUFFER DE PROCESSAMENTO');
  const { data: buffer } = await supabase
    .from('chat_messages')
    .select('session_id, role, status')
    .in('status', ['buffered', 'processing'])
    .limit(10);

  if (buffer?.length) {
    console.log(`   ⚠️  ${buffer.length} mensagens no buffer\n`);
    const bySession = {};
    for (const msg of buffer) {
      bySession[msg.session_id] = (bySession[msg.session_id] || 0) + 1;
    }
    for (const [sid, count] of Object.entries(bySession).slice(0, 5)) {
      console.log(`   - ${sid}: ${count} mensagem(ns)`);
    }
  } else {
    console.log('   ✅ Buffer limpo\n');
  }

  console.log('\n' + '='.repeat(60));
  console.log('💡 Próximas ações:');
  if (pending?.length) console.log('   1. Verificar por que há mensagens PENDING não processadas');
  if (blocked?.length) console.log('   2. Analisar bloqueadores em chat_control');
  console.log('   3. Verificar logs do servidor em Railway');
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
