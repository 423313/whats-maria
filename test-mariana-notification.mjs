#!/usr/bin/env node
/**
 * Testa envio de notificação para Mariana
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function testNotification() {
  console.log('🧪 TESTE DE NOTIFICAÇÃO MARIANA\n');

  // Busca a configuração do Evolution
  const evolutionUrl = 'https://evolution-api-production-b8ec.up.railway.app';
  const evolutionKey = '840942653ea7ecbb566a5dcf2bedef5c811386208c939722a5f13cdb92e9bb11';
  const evolutionInstance = 'agente';
  const marianaPhone = '554196137916';

  console.log(`📱 Evolution URL: ${evolutionUrl}`);
  console.log(`🔑 Instance: ${evolutionInstance}`);
  console.log(`📞 Destino: ${marianaPhone}\n`);

  try {
    const messages = [
      '🧪 TESTE DE NOTIFICAÇÃO',
      'Se você vê esta mensagem, o sistema de notificação está funcionando!',
      'Hora: ' + new Date().toLocaleString('pt-BR'),
    ];

    for (const msg of messages) {
      console.log(`📤 Enviando: "${msg}"`);

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
            text: msg,
          }),
        }
      );

      const data = await response.json();

      if (data?.messageId) {
        console.log(`   ✅ Enviada com sucesso! ID: ${data.messageId}\n`);
      } else if (response.ok) {
        console.log(`   ✅ Enviada! Resposta: ${JSON.stringify(data)}\n`);
      } else {
        console.log(`   ❌ Erro ${response.status}: ${JSON.stringify(data)}\n`);
      }

      // Delay entre mensagens
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log('✅ TESTE CONCLUÍDO COM SUCESSO!');
    console.log('\n' + '='.repeat(60));

  } catch (err) {
    console.error('❌ ERRO AO ENVIAR:', err.message);
    process.exit(1);
  }
}

async function checkPendingAgendamentos() {
  console.log('\n\n📋 VERIFICANDO AGENDAMENTOS PENDENTES\n');

  const { data: agendamentos } = await supabase
    .from('pending_actions')
    .select('id, session_id, type, client_name, client_phone, created_at, status')
    .eq('type', 'agendamento')
    .order('created_at', { ascending: false })
    .limit(15);

  if (!agendamentos?.length) {
    console.log('✅ Nenhum agendamento pendente encontrado');
    return;
  }

  console.log(`📍 Encontrados ${agendamentos.length} agendamentos:\n`);

  for (const agendamento of agendamentos) {
    const criado = new Date(agendamento.created_at);
    const agora = new Date();
    const minutos = Math.round((agora - criado) / 1000 / 60);

    console.log(`ID: ${agendamento.id}`);
    console.log(`  Cliente: ${agendamento.client_name || agendamento.client_phone}`);
    console.log(`  Status: ${agendamento.status}`);
    console.log(`  Criado: ${agendamento.created_at} (${minutos} min atrás)`);
    console.log(`  Sessão: ${agendamento.session_id}`);
    console.log('');
  }

  console.log('='.repeat(60));
  console.log('\n⚠️  NOTA: Todos os agendamentos acima deveriam ter');
  console.log('   recebido uma notificação WhatsApp para Mariana.');
  console.log('\n💡 Se não recebeu notificação:');
  console.log('   1. Verificar logs em Railway (após o deployment)');
  console.log('   2. Confirmar que MARIANA_NOTIFY_PHONE está configurado');
  console.log('   3. Rodar este script novamente para testar a conexão');
}

async function main() {
  await testNotification();
  await checkPendingAgendamentos();
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
