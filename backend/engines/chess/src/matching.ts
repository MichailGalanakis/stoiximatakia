/** Internal proof helper: maximum number of distinct targets occupied at once. */
export function maximumMatching(
  targets: readonly number[],
  allowed: readonly ReadonlySet<number>[],
): number {
  // One vertex per ORIGINAL mobile piece, even when two pieces share a symbol
  // or reachable region. Each actual simultaneous occupancy is a matching.
  const owners = Array<number>(targets.length).fill(-1);
  function augment(piece: number, seen: boolean[]): boolean {
    for (let target = 0; target < targets.length; target++) {
      if (seen[target] || !allowed[piece]!.has(targets[target]!)) continue;
      seen[target] = true;
      const owner = owners[target]!;
      if (owner === -1 || augment(owner, seen)) {
        owners[target] = piece;
        return true;
      }
    }
    return false;
  }
  let size = 0;
  for (
    let piece = 0;
    piece < allowed.length && size < targets.length;
    piece++
  ) {
    if (augment(piece, Array<boolean>(targets.length).fill(false))) size++;
  }
  return size;
}
