#!/usr/bin/env node
/**
 * Investiga por que agendamentos pendentes não foram notificados
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function main() {
  console.log('🔎 INVESTIGANDO AGENDAMENTOS PENDENTES\n');

  // IDs dos agendamentos pendentes
  const pendingIds = [
    '40113882-5936-4059-8d0c-0d18c40faf91',
    '53a97e2c-a281-41d5-9496-d16c1d1a2f53',
  ];

  for (const agendamentoId of pendingIds) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📍 Agendamento: ${agendamentoId}\n`);

    // Busca detalhes do agendamento
    const { data: agendamento } = await supabase
      .from('pending_actions')
      .select('*')
      .eq('id', agendamentoId)
      .single();

    if (!agendamento) {
      console.log('❌ Agendamento não encontrado');
      continue;
    }

    console.log(`Cliente: ${agendamento.client_name || agendamento.client_phone}`);
    console.log(`Sessão: ${agendamento.session_id}`);
    console.log(`Criado: ${agendamento.created_at}`);
    console.log(`Status: ${agendamento.status}`);
    console.log(`Summary:\n${agendamento.summary.substring(0, 200)}...\n`);

    // Busca mensagens ASSISTANT na sessão próximas ao tempo do agendamento
    const agendTime = new Date(agendamento.created_at);
    const windowStart = new Date(agendTime.getTime() - 5 * 60 * 1000);
    const windowEnd = new Date(agendTime.getTime() + 5 * 60 * 1000);

    const { data: msgs } = await supabase
      .from('chat_messages')
      .select('id, role, content, created_at, status')
      .eq('session_id', agendamento.session_id)
      .gte('created_at', windowStart.toISOString())
      .lte('created_at', windowEnd.toISOString())
      .order('created_at', { ascending: true });

    console.log(`📨 Mensagens próximas (±5min):`);
    if (msgs?.length) {
      for (const msg of msgs) {
        const timeStr = new Date(msg.created_at).toLocaleTimeString('pt-BR');
        console.log(`   [${timeStr}] ${msg.role} (${msg.status}): "${msg.content.substring(0, 40)}..."`);
      }
    } else {
      console.log('   (nenhuma mensagem neste período)');
    }

    // Busca se há mensagens com tokens [SOLICITAÇÃO DE AGENDAMENTO]
    const { data: allMsgs } = await supabase
      .from('chat_messages')
      .select('id, role, content, created_at')
      .eq('session_id', agendamento.session_id)
      .order('created_at', { ascending: false })
      .limit(20);

    const agendamentoMatch = allMsgs?.some(m =>
      m.role === 'assistant' && m.content.includes('SOLICITAÇÃO DE AGENDAMENTO')
    );

    console.log(`\n🔍 Mensagem com "SOLICITAÇÃO DE AGENDAMENTO": ${agendamentoMatch ? '✅ SIM' : '❌ NÃO'}`);

    if (agendamentoMatch) {
      const msg = allMsgs.find(m => m.content.includes('SOLICITAÇÃO DE AGENDAMENTO'));
      console.log(`   Encontrada em: ${msg?.created_at}`);
      console.log(`\n   Conteúdo:\n${msg?.content.substring(0, 300)}...\n`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('\n📝 DIAGNÓSTICO:');
  console.log('\nOs agendamentos foram criados em pending_actions, o que significa');
  console.log('que handlePendingActions() foi executada. Porém, se não houve');
  console.log('notificação, pode ser que:');
  console.log('\n1. MARIANA_NOTIFY_PHONE não estava configurada em Railway naquela época');
  console.log('2. EVOLUTION_INSTANCE não estava configurada em Railway');
  console.log('3. Houve erro silencioso no envio (falta logging no código antigo)');
  console.log('\n✅ SOLUÇÃO: Agora com o novo código, qualquer falha será logada');
  console.log('   em Railway. Configure MARIANA_NOTIFY_PHONE lá e teste com novos agendamentos.');
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
