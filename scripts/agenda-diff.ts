/**
 * Compara a ocupação da agenda entre Google Calendar e CRM ao longo dos
 * próximos 30 dias, e reporta a divergência (only_gcal, only_crm) — sem
 * nenhum dado de cliente, só contagem e dia/horário.
 *
 * Task 4 do plano docs/melhorias/2026-08-02-integracao-agenda-crm.md:
 * critério de corte é divergência zero por 7 dias corridos, com a Mariana
 * lançando em duplicidade (Belasis + CRM) confirmada nesse período.
 *
 * Uso: npx tsx scripts/agenda-diff.ts
 * Roda independente de AGENDA_SOURCE/AGENDA_SHADOW — não depende do modo
 * sombra estar ligado em produção, útil pra rodar manualmente ou num cron
 * diário próprio (fora do processo principal da Flora).
 */

import { env } from '../src/config/env.js';
import { diffBusySources, fetchBusyFromCrm, fetchBusyFromGcal } from '../src/services/calendar-availability.js';

const DAYS_AHEAD = 30;
const TIMEZONE = 'America/Sao_Paulo';

function spDayStart(now: Date): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value ?? '0');
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? '0');
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? '0');
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00-03:00`;
  return new Date(iso);
}

async function main(): Promise<void> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_KEY || !env.GOOGLE_CALENDAR_ID) {
    console.error('ERRO: GOOGLE_SERVICE_ACCOUNT_KEY/GOOGLE_CALENDAR_ID ausentes no .env');
    process.exit(1);
  }
  if (!env.CRM_BASE_URL || !env.CRM_API_SECRET) {
    console.error('ERRO: CRM_BASE_URL/CRM_API_SECRET ausentes no .env');
    process.exit(1);
  }

  const startSp = spDayStart(new Date());
  const endSp = new Date(startSp.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);
  const deMs = startSp.getTime();
  const ateMs = endSp.getTime();

  console.log(`[agenda-diff] janela: ${new Date(deMs).toISOString()} até ${new Date(ateMs).toISOString()}`);

  const [gcalBusy, crmBusy] = await Promise.all([
    fetchBusyFromGcal(deMs, ateMs),
    fetchBusyFromCrm(deMs, ateMs),
  ]);

  console.log(`[agenda-diff] eventos brutos: gcal=${gcalBusy.length} crm=${crmBusy.length}`);

  const diff = diffBusySources(startSp, gcalBusy, crmBusy);

  console.log(`[agenda-diff] only_gcal=${diff.onlyGcal.length} only_crm=${diff.onlyCrm.length}`);

  if (diff.onlyGcal.length > 0) {
    console.log('[agenda-diff] slots ocupados só no Google (o CRM acha livre):');
    for (const s of diff.onlyGcal) console.log(`  ${s.day} ${s.slot}`);
  }
  if (diff.onlyCrm.length > 0) {
    console.log('[agenda-diff] slots ocupados só no CRM (o Google acha livre):');
    for (const s of diff.onlyCrm) console.log(`  ${s.day} ${s.slot}`);
  }
  if (diff.onlyGcal.length === 0 && diff.onlyCrm.length === 0) {
    console.log('[agenda-diff] sem divergência.');
  }

  process.exit(diff.onlyGcal.length === 0 && diff.onlyCrm.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[agenda-diff] falhou:', err);
  process.exit(1);
});
