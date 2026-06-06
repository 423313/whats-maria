/**
 * FONTE ÚNICA de horários do Studio Mariana Castro.
 *
 * Antes, três estruturas viviam em dois arquivos e precisavam ser editadas em
 * sincronia manual (causa de divergência — ex.: status dizia 16h e a agenda 16h30):
 *   - STUDIO_STATUS_BY_WEEKDAY   (era em agent.ts)        → texto de status pro prompt
 *   - WORKING_HOURS_BY_WEEKDAY   (era em calendar-availability.ts) → cruza com Calendar
 *   - OFFICIAL_GRID_BY_WEEKDAY   (era em calendar-availability.ts) → slots oferecidos
 *
 * Agora estão co-localizadas aqui. Ao mudar horário do studio, edite SÓ este arquivo.
 *
 * NOTA sobre a Scarlet: o texto de status menciona horários da Scarlet (sobrancelhas/
 * cílios), mas WORKING_HOURS e a grade oficial são da MARIANA (a agenda integrada só
 * lê o calendário dela). Ou seja: a Flora informa o horário da Scarlet mas só oferece
 * slots da Mariana. Isso é intencional hoje (decisão de produto) — quando a agenda da
 * Scarlet for integrada, adicionar working-hours/grade dela aqui.
 *
 * Índices: 0=domingo, 1=segunda, ... 6=sábado.
 */

export interface StudioDayStatus {
  aberto: boolean;
  horario: string;
  profissionais: string;
}

// Texto de status por dia (injetado no contexto do prompt via buildDateContext)
export const STUDIO_STATUS_BY_WEEKDAY: Record<number, StudioDayStatus> = {
  0: { aberto: false, horario: 'FECHADO', profissionais: 'nenhum' },
  1: { aberto: false, horario: 'FECHADO', profissionais: 'nenhum' },
  2: { aberto: true, horario: '09h às 16h30', profissionais: 'Mariana (unhas)' },
  3: { aberto: true, horario: '09h às 16h30', profissionais: 'Mariana (unhas)' },
  4: { aberto: true, horario: '09h às 16h30 (Mariana) e 13h30 às 21h (Scarlet)', profissionais: 'Mariana (unhas) e Scarlet (sobrancelhas/cílios)' },
  5: { aberto: true, horario: '09h às 16h30', profissionais: 'Mariana (unhas)' },
  6: { aberto: true, horario: '08h às 12h (Mariana) e 08h às 18h (Scarlet)', profissionais: 'Mariana (unhas) e Scarlet (sobrancelhas/cílios)' },
};

// Horário de funcionamento da Mariana (unhas), usado pra cruzar com o Calendar.
// Dias úteis: fim em 16:30 (não 16:00) para que o slot das 16:00 seja gerado como
// disponível, permitindo que o slot oficial das 15:00 passe na checagem de 3 slots.
export const WORKING_HOURS_BY_WEEKDAY: Record<number, { start: number; end: number } | null> = {
  0: null,                            // domingo: fechado
  1: null,                            // segunda: fechada
  2: { start: 9, end: 16.5 },         // terça
  3: { start: 9, end: 16.5 },         // quarta
  4: { start: 9, end: 16.5 },         // quinta
  5: { start: 9, end: 16.5 },         // sexta
  6: { start: 8, end: 12 },           // sábado
};

// Grade oficial de horários que podem ser oferecidos pra cliente.
// Pré-filtrada pelo código antes de injetar no prompt — o modelo não decide.
export const OFFICIAL_GRID_BY_WEEKDAY: Record<number, string[]> = {
  0: [],
  1: [],
  2: ['09:00', '11:00', '13:00', '15:00'],
  3: ['09:00', '11:00', '13:00', '15:00'],
  4: ['09:00', '11:00', '13:00', '15:00'],
  5: ['09:00', '11:00', '13:00', '15:00'],
  6: ['08:00', '10:00'],
};

// Janela mínima (em slots de 30 min) exigida para um horário aparecer na grade.
// 3 slots = 90 min — cobre alongamento, manutenção encapsulada e os demais serviços.
export const OFFICIAL_GRID_MIN_SLOTS = 3;
