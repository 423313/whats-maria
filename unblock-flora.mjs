#!/usr/bin/env node
/**
 * Desbloqueia as 13 sessões com janela manual da Mariana ativada
 * por erro (eco do sendMedia interpretado como mensagem manual).
 *
 * IMPORTANTE: marca skip_followup=true para essas sessões para que o
 * follow-up sweeper NÃO dispare mensagens automáticas a essas clientes.
 * Elas só serão atendidas quando elas mesmas mandarem nova mensagem.
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://jnfeerxcxxmgjutkfzig.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZmVlcnhjeHhtZ2p1dGtmemlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEwMjA3NiwiZXhwIjoyMDkzNjc4MDc2fQ.v3S3v8XR4kjyup1gSHRYU_jEnHFhCykeuXE6hr1npD8',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function main() {
  console.log('Buscando sessões bloqueadas...');
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: blocked, error: fetchErr } = await supabase
    .from('chat_control')
    .select('session_id, mariana_last_manual_at')
    .not('mariana_last_manual_at', 'is', null)
    .gte('mariana_last_manual_at', cutoff24h);

  if (fetchErr) {
    console.error('ERRO ao buscar:', fetchErr.message);
    process.exit(1);
  }

  console.log(`Encontradas ${blocked?.length || 0} sessões bloqueadas\n`);

  if (!blocked?.length) {
    console.log('Nenhuma ação necessária.');
    return;
  }

  for (const s of blocked) {
    console.log(`  - ${s.session_id}`);
  }

  console.log('\n[1] Resetando mariana_last_manual_at (destrava Flora)');
  console.log('[2] Setando followup_sent_at e followup_closed_at = agora');
  console.log('    Isso faz o sweeper pular essas sessões — sem disparo automático.');
  console.log('    Flora só atenderá essas clientes quando elas mandarem nova mensagem.\n');

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('chat_control')
    .update({
      mariana_last_manual_at: null,
      followup_sent_at: now,      // impede disparo de follow-up novo
      followup_closed_at: now,     // impede disparo de encerramento
      updated_at: now,
    })
    .not('mariana_last_manual_at', 'is', null);

  if (updateErr) {
    console.error('ERRO ao atualizar:', updateErr.message);
    process.exit(1);
  }

  console.log(`✅ ${blocked.length} sessões desbloqueadas SEM disparo automático.`);
  console.log('   Quando uma dessas clientes mandar nova mensagem, Flora vai atender normalmente.');
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
