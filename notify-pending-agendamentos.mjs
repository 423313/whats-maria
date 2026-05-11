#!/usr/bin/env node
/**
 * Reprocessa notificações dos agendamentos pendentes
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function sendNotification(marianaPhone, lines) {
  const evolutionUrl = 'https://evolution-api-production-b8ec.up.railway.app';
  const evolutionKey = '840942653ea7ecbb566a5dcf2bedef5c811386208c939722a5f13cdb92e9bb11';
  const evolutionInstance = 'agente';

  for (const line of lines) {
    const response = await fetch(
      `${evolutionUrl}/message/sendText/${evolutionInstance}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': evolutionKey,
        },
        body: JSON.stringify({
          number: marianaPhone,
          text: line,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Erro ${response.status} ao enviar notificação`);
    }

    // Delay entre mensagens
    await new Promise(r => setTimeout(r, 800));
  }
}

async function main() {
  console.log('📤 ENVIANDO NOTIFICAÇÕES DOS AGENDAMENTOS PENDENTES\n');

  const pendingIds = [
    '40113882-5936-4059-8d0c-0d18c40faf91', // Pedro - 554199595242
    '53a97e2c-a281-41d5-9496-d16c1d1a2f53', // Mariana - 554196137916
  ];

  const marianaPhone = '554196137916';

  for (const agendamentoId of pendingIds) {
    // Busca agendamento
    const { data: agendamento } = await supabase
      .from('pending_actions')
      .select('*')
      .eq('id', agendamentoId)
      .single();

    if (!agendamento) {
      console.log(`⚠️  Agendamento ${agendamentoId} não encontrado`);
      continue;
    }

    const fields = agendamento.fields || {};
    const clientName = agendamento.client_name || agendamento.client_phone;
    const phone = agendamento.client_phone;

    console.log(`\n📝 Enviando para: ${clientName}`);
    console.log(`   Sessão: ${agendamento.session_id}`);
    console.log(`   Agendamento: ${agendamento.id}\n`);

    const lines = [
      '📅 Nova solicitação — Agendamento',
      `Cliente: ${clientName}`,
    ];

    if (fields['procedimento']) lines.push(`Serviço: ${fields['procedimento']}`);
    if (fields['data_e_horário_solicitados']) lines.push(`Data: ${fields['data_e_horário_solicitados']}`);
    if (fields['valor']) lines.push(`Valor: ${fields['valor']}`);
    if (fields['cliente']) lines.push(`Cliente: ${fields['cliente']}`);

    lines.push(`WhatsApp: ${phone}`);

    try {
      await sendNotification(marianaPhone, lines);
      console.log(`   ✅ Notificação enviada com sucesso!\n`);

      // Marca como notificado atualizando o status
      await supabase
        .from('pending_actions')
        .update({ status: 'notificado' })
        .eq('id', agendamentoId);

      console.log(`   📌 Status atualizado para "notificado"\n`);
    } catch (err) {
      console.error(`   ❌ ERRO: ${err.message}\n`);
    }
  }

  console.log('='.repeat(60));
  console.log('\n✅ Processamento concluído!');
  console.log('\n📌 Próximas ações:');
  console.log('   1. Verificar se Mariana recebeu as notificações');
  console.log('   2. Responder aos clientes conforme necessário');
  console.log('   3. Confirmar que a configuração MARIANA_NOTIFY_PHONE está');
  console.log('      em Railway para futuros agendamentos');
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
