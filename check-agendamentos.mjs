#!/usr/bin/env node
/**
 * Verifica agendamentos mais recentes e se tentaram notificar Mariana
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function main() {
  console.log('📅 VERIFICANDO AGENDAMENTOS RECENTES\n');

  // Busca agendamentos mais recentes
  const { data: agendamentos } = await supabase
    .from('pending_actions')
    .select('id, session_id, type, client_name, created_at, status')
    .eq('type', 'agendamento')
    .order('created_at', { ascending: false })
    .limit(10);

  if (!agendamentos?.length) {
    console.log('❌ Nenhum agendamento encontrado');
    return;
  }

  console.log(`✅ ${agendamentos.length} agendamentos encontrados\n`);

  for (const agendamento of agendamentos) {
    console.log(`\n📍 Agendamento ID: ${agendamento.id}`);
    console.log(`   Sessão: ${agendamento.session_id}`);
    console.log(`   Cliente: ${agendamento.client_name || '(não registrado)'}`);
    console.log(`   Status: ${agendamento.status}`);
    console.log(`   Criado em: ${agendamento.created_at}`);

    // Busca mensagens ASSISTANT para essa sessão próximas ao tempo do agendamento
    const agendTime = new Date(agendamento.created_at);
    const windowStart = new Date(agendTime.getTime() - 2 * 60 * 1000);
    const windowEnd = new Date(agendTime.getTime() + 2 * 60 * 1000);

    const { data: msgs } = await supabase
      .from('chat_messages')
      .select('role, content, created_at, status')
      .eq('session_id', agendamento.session_id)
      .gte('created_at', windowStart.toISOString())
      .lte('created_at', windowEnd.toISOString())
      .order('created_at', { ascending: false })
      .limit(5);

    if (msgs?.length) {
      console.log(`\n   📨 Mensagens próximas ao agendamento:`);
      for (const msg of msgs) {
        console.log(`   - [${msg.created_at}] ${msg.role} (${msg.status}): "${msg.content.substring(0, 50)}..."`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('\n⚠️  ANÁLISE:');
  console.log('   Se os agendamentos foram criados mas há pouquíssimas');
  console.log('   mensagens ASSISTANT próximas (ou nenhuma),');
  console.log('   significa que handlePendingActions() foi disparada');
  console.log('   mas não conseguiu notificar Mariana.');
  console.log('\n💡 Possíveis causas:');
  console.log('   1. MARIANA_NOTIFY_PHONE não configurado no Railway');
  console.log('   2. EVOLUTION_INSTANCE não configurado no Railway');
  console.log('   3. Erro silencioso na API Evolution');
  console.log('\n✅ Solução: Verificar variáveis de ambiente em Railway');
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
