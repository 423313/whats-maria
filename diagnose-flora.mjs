#!/usr/bin/env node
/**
 * Diagnóstico: verifica por que Flora pode não estar respondendo.
 * Investiga buffer pendente, janela da Mariana, sessões pausadas.
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const now = Date.now();

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  DIAGNÓSTICO DO ESTADO DA FLORA');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Verifica buffer pendente (mensagens não processadas)
  console.log('[1] Buffer de mensagens pendentes (não processadas):');
  const { data: buffer, error: bufErr } = await supabase
    .from('message_buffer')
    .select('id, session_id, mensagem, created_at, processed_at')
    .is('processed_at', null)
    .order('created_at', { ascending: false })
    .limit(20);

  if (bufErr) {
    console.log('  ERRO:', bufErr.message);
  } else if (!buffer?.length) {
    console.log('  ✅ Nenhuma mensagem presa no buffer');
  } else {
    console.log(`  ⚠️  ${buffer.length} mensagens pendentes:`);
    for (const m of buffer) {
      const age = Math.round((now - new Date(m.created_at).getTime()) / 1000);
      console.log(`    - ${m.session_id} (${age}s atrás): "${(m.mensagem || '').substring(0, 60)}"`);
    }
  }

  // 2. Janela da Mariana ativa (24h)
  console.log('\n[2] Sessões com janela manual da Mariana ATIVA (bloqueando Flora):');
  const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const { data: marianaActive, error: marErr } = await supabase
    .from('chat_control')
    .select('session_id, mariana_last_manual_at')
    .not('mariana_last_manual_at', 'is', null)
    .gte('mariana_last_manual_at', cutoff24h)
    .order('mariana_last_manual_at', { ascending: false });

  if (marErr) {
    console.log('  ERRO:', marErr.message);
  } else if (!marianaActive?.length) {
    console.log('  ✅ Nenhuma sessão com janela manual ativa');
  } else {
    console.log(`  ⚠️  ${marianaActive.length} sessões bloqueadas:`);
    for (const s of marianaActive) {
      const ageMin = Math.round((now - new Date(s.mariana_last_manual_at).getTime()) / 60000);
      const remainingMin = Math.round((24 * 60) - ageMin);
      console.log(`    - ${s.session_id} (ativada ${ageMin}min atrás, ${remainingMin}min restantes)`);
    }
  }

  // 3. Sessões com ai_paused = true (pausadas pelo admin)
  console.log('\n[3] Sessões com AI pausada (via painel admin):');
  const { data: paused, error: pausedErr } = await supabase
    .from('chat_control')
    .select('session_id, paused_at, paused_by')
    .eq('ai_paused', true);

  if (pausedErr) {
    console.log('  ERRO:', pausedErr.message);
  } else if (!paused?.length) {
    console.log('  ✅ Nenhuma sessão pausada');
  } else {
    console.log(`  ⚠️  ${paused.length} sessões pausadas:`);
    for (const p of paused) {
      console.log(`    - ${p.session_id} (paused_by=${p.paused_by}, em ${p.paused_at})`);
    }
  }

  // 4. Mensagens recentes (últimas 2h)
  console.log('\n[4] Últimas 10 mensagens nos últimos 2 horas:');
  const cutoff2h = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const { data: recent, error: recErr } = await supabase
    .from('chat_messages')
    .select('session_id, role, content, status, created_at')
    .gte('created_at', cutoff2h)
    .order('created_at', { ascending: false })
    .limit(10);

  if (recErr) {
    console.log('  ERRO:', recErr.message);
  } else if (!recent?.length) {
    console.log('  ⚠️  Nenhuma mensagem nas últimas 2h');
  } else {
    for (const m of recent) {
      const ageMin = Math.round((now - new Date(m.created_at).getTime()) / 60000);
      const role = m.role.padEnd(10);
      const sess = m.session_id.replace('@s.whatsapp.net', '').padEnd(15);
      const status = (m.status || '').padEnd(8);
      console.log(`    [${ageMin}min] ${sess} | ${role} | ${status} | "${(m.content || '').substring(0, 60)}"`);
    }
  }

  // 5. Mensagens com status 'pending' (Flora tentou enviar mas pode ter travado)
  console.log('\n[5] Mensagens da Flora com status "pending" (possível trava no sendText):');
  const { data: pending, error: penErr } = await supabase
    .from('chat_messages')
    .select('session_id, content, created_at')
    .eq('role', 'assistant')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(10);

  if (penErr) {
    console.log('  ERRO:', penErr.message);
  } else if (!pending?.length) {
    console.log('  ✅ Nenhuma mensagem pending da Flora');
  } else {
    console.log(`  ⚠️  ${pending.length} mensagens pending:`);
    for (const p of pending) {
      const ageMin = Math.round((now - new Date(p.created_at).getTime()) / 60000);
      console.log(`    [${ageMin}min] ${p.session_id}: "${(p.content || '').substring(0, 60)}"`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  DIAGNÓSTICO CONCLUÍDO');
  console.log('═══════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
