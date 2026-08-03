/**
 * Blocos estruturados emitidos pelo agente (solicitação de agendamento / lead de curso).
 *
 * FONTE ÚNICA do padrão. O bloco é REMOVIDO do texto enviado à cliente (flushSession)
 * e DETECTADO para criar a pendência + notificar a Mariana (handlePendingActions).
 * As duas operações PRECISAM usar exatamente o mesmo padrão — se divergirem, um bloco
 * pode sumir do texto sem gerar pendência (agendamento perdido silenciosamente).
 *
 * Formato: `--- LABEL ---<corpo>` fechado por uma linha de tracinhos OU pelo fim do texto.
 */

export const PENDING_BLOCK_LABELS = 'SOLICITAÇÃO DE AGENDAMENTO|LEAD DE CURSO';

export function buildPendingBlockRegex(label: string, flags: string): RegExp {
  // Fechamento tolerante: linha de tracinhos OU fim da string testada (com ou
  // sem \n antes). A versão antiga exigia um \n literal antes do fim (`\n\s*$`);
  // a saída do LLM nem sempre termina em \n, e nesse caso o bloco não era
  // removido NEM detectado — o texto cru vazava pra cliente. Ver também
  // chatbot.ts/pending-actions.ts: a detecção roda por mensagem, na MESMA
  // string que a remoção usa, exatamente por essa razão (um bloco que é o
  // último conteúdo da SUA mensagem "termina no fim da string" nela, mas não
  // necessariamente no fim de um texto maior que a engloba).
  return new RegExp(`-{3,}\\s*(?:${label})\\s*-{3,}([\\s\\S]*?)(?:-{3,}|\\s*$)`, flags);
}

/** Regex global (gi) que casa qualquer um dos blocos — usada para remoção do texto. */
export function pendingBlockRemovalRegex(): RegExp {
  return buildPendingBlockRegex(PENDING_BLOCK_LABELS, 'gi');
}
