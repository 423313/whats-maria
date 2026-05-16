#!/usr/bin/env node
/**
 * Inspeciona a sessão mais afetada para entender por que tantas mensagens
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function inspectSession(sessionId) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📍 SESSÃO: ${sessionId}\n`);

  // Estado do chat_control
  const { data: control } = await supabase
    .from('chat_control')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();

  if (control) {
    console.log('📌 chat_control:');
    console.log(`   ai_paused: ${control.ai_paused}`);
    console.log(`   followup_sent_at: ${control.followup_sent_at}`);
    console.log(`   followup_closed_at: ${control.followup_closed_at}`);
    console.log(`   followup_context: ${control.followup_context}`);
    console.log(`   mariana_last_manual_at: ${control.mariana_last_manual_at}`);
    console.log(`   skip_followup: ${control.skip_followup}`);
    console.log('');
  }

  // Últimas 30 mensagens em ordem cronológica
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const { data: msgs } = await supabase
    .from('chat_messages')
    .select('role, content, created_at, status')
    .eq('session_id', sessionId)
    .gte('created_at', twelveHoursAgo)
    .order('created_at', { ascending: true });

  console.log(`📨 Mensagens das últimas 12h (${msgs?.length ?? 0}):\n`);
  for (const msg of msgs ?? []) {
    const ts = new Date(msg.created_at).toLocaleString('pt-BR');
    const role = msg.role === 'user' ? '👤 USER' : '🤖 FLORA';
    const status = msg.status === 'sent' ? '✓' : msg.status === 'failed' ? '✗' : '·';
    console.log(`   [${ts}] ${role} ${status}: "${(msg.content || '').substring(0, 80)}..."`);
  }
}

async function main() {
  console.log('🔍 INSPECIONANDO SESSÕES AFETADAS\n');

  // As sessões mais afetadas
  const sessions = [
    '554191548710@s.whatsapp.net', // 20 mensagens
    '554199595242@s.whatsapp.net', // 10 mensagens
    '554196137916@s.whatsapp.net', // 6 mensagens (Mariana)
  ];

  for (const sid of sessions) {
    await inspectSession(sid);
  }
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
