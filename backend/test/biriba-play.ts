import type * as rummy from '#engines/rummy';
/** Test/review driver using only the actor's observation, never hidden hands or stock. */
export function biribaMove(
  observation: rummy.RummyObservation,
): rummy.PlayerAction {
  const o = observation,
    legal = o.legalActions;
  if (o.phase === 'round-end') return { type: 'next' };
  if (o.phase === 'draw')
    return (
      (o.ply % 12 >= 8 && o.discard.length >= 3
        ? legal.find((a) => a.type === 'draw' && a.source === 'discard')
        : null) ??
      legal.find((a) => a.type === 'draw' && a.source === 'stock') ??
      legal[0]!
    );
  if (o.viewerSeat === null)
    throw new Error('A participant observation is required');
  const side = o.viewerSeat % 2;
  const points = (c: string) =>
    c.startsWith('JOKER')
      ? 20
      : c.startsWith('A')
        ? 15
        : /^(2|8|9|10|J|Q|K)[CDHS]-/.test(c)
          ? 10
          : 5;
  const score = (a: rummy.MeldAction | rummy.ExtendAction) => {
    const old =
      a.type === 'extend' ? o.melds.find((m) => m.id === a.meld) : null;
    const before = old?.slots.length ?? 0,
      after = before + a.cards.length;
    const picked =
      o.mustUsePickup && a.cards.some((c) => o.pickup.includes(c)) ? 10000 : 0;
    return (
      picked +
      (before < 7 && after >= 7 ? 500 : 0) +
      (before < 13 && after === 13 ? 1000 : 0) +
      (after * after - before * before) * (old ? 2 : 1) +
      a.cards.reduce((n, c) => n + points(c), 0)
    );
  };
  const placements = legal.filter(
    (a) => a.type === 'meld' || a.type === 'extend',
  );
  if (placements.length)
    return placements.reduce((a, b) => (score(b) > score(a) ? b : a));
  const ranks: Record<string, number> = { A: 1, J: 11, Q: 12, K: 13 };
  const rank = (c: string) => ranks[c.slice(0, -3)] ?? Number(c.slice(0, -3));
  const keep = (c: string) => {
    if (c.startsWith('JOKER')) return 1000;
    if (c.startsWith('2')) return 800;
    const r = rank(c),
      s = c.at(-3);
    let n = 0;
    for (const d of o.hand) {
      if (d === c || d.startsWith('JOKER') || d.at(-3) !== s) continue;
      const dist = Math.min(
        Math.abs(rank(d) - r),
        r === 1 ? Math.abs(rank(d) - 14) : 99,
      );
      if (dist === 1) n += 16;
      else if (dist === 2) n += 5;
    }
    for (const m of o.melds.filter(
      (m) => m.owner === side && m.slots[0]!.suit === s,
    )) {
      const lo = m.slots[0]!.rank,
        hi = m.slots.at(-1)!.rank;
      if (r === lo - 1 || r === hi + 1 || (r === 1 && hi === 13)) n += 100;
    }
    return n - points(c) / 10;
  };
  const discards = legal.filter((a) => a.type === 'discard');
  return discards.length
    ? discards.reduce((a, b) => (keep(b.card) < keep(a.card) ? b : a))
    : legal[0]!;
}
