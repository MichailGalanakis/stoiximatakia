export const GAME_IDS = [
  'chess',
  'tichu',
  'biriba',
  'thanasis',
  'koumkan',
  'diloti',
  'xeri',
] as const;
export type GameId = (typeof GAME_IDS)[number];
export const GAME_CONFIG: Record<
  GameId,
  { seats: number; team: boolean; formats: Record<string, string> }
> = {
  chess: { seats: 2, team: false, formats: { standard: 'Μία παρτίδα' } },
  tichu: {
    seats: 4,
    team: true,
    formats: {
      single: 'Μονή διανομή',
      '500': '500 πόντοι',
      '1000': '1.000 πόντοι',
    },
  },
  biriba: { seats: 4, team: true, formats: { standard: '2.005 πόντοι' } },
  thanasis: {
    seats: 2,
    team: false,
    formats: { standard: '5 διανομές · λιγότεροι πόντοι' },
  },
  koumkan: {
    seats: 2,
    team: false,
    formats: { standard: 'Όριο 100 · λιγότεροι πόντοι' },
  },
  diloti: { seats: 2, team: false, formats: { standard: '61 πόντοι' } },
  xeri: { seats: 2, team: false, formats: { standard: '151 πόντοι' } },
};
export const ENTRY_FEE_MINOR = 90;
export const CONTRIBUTIONS_MINOR = [100, 500, 1500, 3000];
