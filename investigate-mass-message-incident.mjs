#!/usr/bin/env node
/**
 * Investiga o incidente de disparo de mensagens em massa
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const FOLLOWUP_PHRASES = [
  'sumiu',
  'sem contato aqui',
  'notei que faz um tempinho',
  'Ainda aqui caso tenha ficado alguma dúvida',
  'Ainda por aqui caso precise de ajuda',
  'Vou encerrar o atendimento',
  'Vou encerrar por aqui',
  'Até mais!',
  'Posso encerrar nosso atendimento',
];

async function main() {
  console.log('🚨 INVESTIGANDO INCIDENTE DE DISPARO EM MASSA\n');
  console.log('='.repeat(70));

  // 1. Quantas mensagens ASSISTANT nas últimas 12h?
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const { data: recentAssistant, count: totalAssistant } = await supabase
    .from('chat_messages')
    .select('*', { count: 'exact' })
    .eq('role', 'assistant')
    .gte('created_at', twelveHoursAgo)
    .order('created_at', { ascending: false });

  console.log(`\n📊 MENSAGENS ASSISTANT (últimas 12h): ${totalAssistant ?? 0}\n`);

  // 2. Quantos clientes únicos receberam mensagens?
  const uniqueSessions = new Set(recentAssistant?.map(m => m.session_id) ?? []);
  console.log(`👥 Clientes únicos que receberam mensagens: ${uniqueSessions.size}\n`);

  // 3. Quantas dessas são mensagens de follow-up/encerramento?
  let followupCount = 0;
  const followupSessions = new Set();

  for (const msg of recentAssistant ?? []) {
    const content = (msg.content || '').toLowerCase();
    const isFollowup = FOLLOWUP_PHRASES.some(p => content.includes(p.toLowerCase()));
    if (isFollowup) {
      followupCount++;
      followupSessions.add(msg.session_id);
    }
  }

  console.log(`🤖 Mensagens FOLLOW-UP/ENCERRAMENTO: ${followupCount}`);
  console.log(`👥 Clientes que receberam follow-up automático: ${followupSessions.size}\n`);

  // 4. Distribuição por hora
  console.log('⏰ DISTRIBUIÇÃO POR HORA (últimas 12h):\n');
  const byHour = new Map();

  for (const msg of recentAssistant ?? []) {
    const hour = new Date(msg.created_at).toISOString().substring(0, 13);
    byHour.set(hour, (byHour.get(hour) || 0) + 1);
  }

  const sortedHours = [...byHour.entries()].sort();
  for (const [hour, count] of sortedHours) {
    const bar = '█'.repeat(Math.min(count, 50));
    console.log(`   ${hour}:00  ${bar} ${count}`);
  }

  // 5. Sessões com follow-up registrado em chat_control
  const { data: controlsWithFollowup, count: controlCount } = await supabase
    .from('chat_control')
    .select('session_id, followup_sent_at, followup_closed_at, followup_context', { count: 'exact' })
    .not('followup_sent_at', 'is', null)
    .gte('followup_sent_at', twelveHoursAgo)
    .order('followup_sent_at', { ascending: false });

  console.log(`\n📌 SESSÕES COM FOLLOW-UP REGISTRADO (12h): ${controlCount ?? 0}`);

  // 6. Lista as últimas 20 sessões afetadas
  console.log('\n📋 ÚLTIMAS SESSÕES QUE RECEBERAM FOLLOW-UP/ENCERRAMENTO:\n');
  const recentFollowupSessions = [...followupSessions].slice(0, 20);

  for (const sessionId of recentFollowupSessions) {
    const msgs = recentAssistant?.filter(m => m.session_id === sessionId) ?? [];
    const fuMsgs = msgs.filter(m => {
      const content = (m.content || '').toLowerCase();
      return FOLLOWUP_PHRASES.some(p => content.includes(p.toLowerCase()));
    });

    if (fuMsgs.length > 0) {
      const first = fuMsgs[fuMsgs.length - 1];
      console.log(`   ${sessionId}`);
      console.log(`     Quando: ${first.created_at}`);
      console.log(`     Mensagens automáticas: ${fuMsgs.length}`);
      console.log(`     Exemplo: "${(first.content || '').substring(0, 60)}..."`);
      console.log('');
    }
  }

  console.log('='.repeat(70));
  console.log('\n💡 RESUMO:');
  console.log(`   - ${totalAssistant} mensagens da Flora em 12h`);
  console.log(`   - ${uniqueSessions.size} clientes únicos receberam mensagens`);
  console.log(`   - ${followupCount} mensagens automáticas (follow-up/encerramento)`);
  console.log(`   - ${followupSessions.size} clientes receberam disparos automáticos`);
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
