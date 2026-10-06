/**
 * Storage-independent tournament schedules and standings. Entrants are
 * { id, playerIds: [one or two player ids], drawOrder? }. Match scores are
 * { games: [{ a: number, b: number }] }; a/b follow the order in `sides`.
 *
 * Each generator produces one round. This keeps even a 512-player event
 * within a manageable Firestore write batch and lets later rounds use actual
 * winners instead of speculative placeholders.
 */

function fail(message) { throw new Error(message); }

function id(value) {
  return typeof value === 'string' && value.trim() && !value.includes('/');
}

function validatedEntrants(entrants, { rotating = false, minCount = rotating ? 4 : 2 } = {}) {
  if (!Array.isArray(entrants) || entrants.length < minCount || entrants.length > 512) {
    fail(`Choose ${minCount} to 512 entrants.`);
  }
  const ids = new Set();
  const players = new Set();
  let teamSize;
  return entrants.map((entrant, index) => {
    const value = typeof entrant === 'string' ? { id: entrant, playerIds: [entrant] } : entrant;
    if (!id(value?.id) || ids.has(value.id)) fail('Entrants need distinct valid ids.');
    ids.add(value.id);
    if (!Array.isArray(value.playerIds) || ![1, 2].includes(value.playerIds.length)) {
      fail('Each entrant needs one or two player ids.');
    }
    if (rotating && value.playerIds.length !== 1) fail('Rotating doubles needs individual players.');
    if (teamSize !== undefined && value.playerIds.length !== teamSize) {
      fail('All entrants must have the same team size.');
    }
    teamSize = value.playerIds.length;
    for (const playerId of value.playerIds) {
      if (!id(playerId) || players.has(playerId)) fail('A player can enter only once.');
      players.add(playerId);
    }
    return { ...value, drawOrder: Number.isInteger(value.drawOrder) ? value.drawOrder : index };
  });
}

function bracketSize(count) { return 2 ** Math.ceil(Math.log2(count)); }

function seededSlots(size) {
  let seeds = [1, 2];
  while (seeds.length < size) {
    const complement = seeds.length * 2 + 1;
    seeds = seeds.flatMap((seed) => [seed, complement - seed]);
  }
  return seeds;
}

function knockoutId(round, slot) { return `KO-R${round}-M${slot}`; }

/** Generate the requested knockout round after the previous one is final. */
export function generateSingleElimination(entrants, { round = 1, priorMatches = [] } = {}) {
  const draw = validatedEntrants(entrants);
  const size = bracketSize(draw.length);
  const roundCount = Math.log2(size);
  if (!Number.isInteger(round) || round < 1 || round > roundCount) fail('Invalid knockout round.');
  const slots = size / 2 ** round;
  let sidesBySlot;
  if (round === 1) {
    const seeds = seededSlots(size);
    sidesBySlot = Array.from({ length: slots }, (_, index) => [
      draw[seeds[index * 2] - 1]?.id ?? null,
      draw[seeds[index * 2 + 1] - 1]?.id ?? null,
    ]);
  } else {
    const previous = new Map(priorMatches.map((match) => [match.id, match]));
    sidesBySlot = Array.from({ length: slots }, (_, index) => {
      const sources = [knockoutId(round - 1, index * 2 + 1), knockoutId(round - 1, index * 2 + 2)];
      return sources.map((sourceId) => {
        const match = previous.get(sourceId);
        if (!match || !['completed', 'bye'].includes(match.status) || !match.winnerId ||
            !match.sides.includes(match.winnerId)) {
          fail('Complete the previous knockout round before generating the next round.');
        }
        return match.winnerId;
      });
    });
  }
  const matches = sidesBySlot.map((sides, index) => {
    const bye = sides.filter(Boolean).length === 1;
    return {
      id: knockoutId(round, index + 1), stage: 'knockout', round, slot: index + 1,
      sourceMatchIds: round === 1 ? [] : [
        knockoutId(round - 1, index * 2 + 1), knockoutId(round - 1, index * 2 + 2),
      ],
      sides, status: bye ? 'bye' : 'ready', winnerId: bye ? sides.find(Boolean) : null,
      score: null,
    };
  });
  return { round, roundCount, matches };
}

/**
 * Complete a knockout match and propagate its winner into an already-created
 * next round. Replays have no effect. Winner corrections are blocked once a
 * dependent match has started, preserving the bracket's causal history.
 */
export function advanceBracket(matches, completedMatchId, winnerId, score = null) {
  if (!Array.isArray(matches)) fail('Matches are required.');
  const current = matches.find((match) => match.id === completedMatchId);
  if (!current || current.stage !== 'knockout' || current.status === 'bye') {
    fail('Choose a playable knockout match.');
  }
  if (!current.sides.includes(winnerId)) fail('Winner must be in the match.');
  const winnerChanged = current.status === 'completed' && current.winnerId !== winnerId;
  if (current.status === 'completed' && current.winnerId === winnerId &&
      JSON.stringify(current.score ?? null) === JSON.stringify(score ?? null)) {
    return { matches, applied: false };
  }
  if (!['ready', 'active', 'completed'].includes(current.status)) fail('Match is not ready.');
  const dependents = matches.filter((match) => match.sourceMatchIds?.includes(completedMatchId));
  if (winnerChanged && dependents.some((match) =>
    ['active', 'completed', 'bye'].includes(match.status))) {
    fail('Clear the dependent match before correcting this winner.');
  }
  return {
    applied: true,
    matches: matches.map((match) => {
      if (match.id === completedMatchId) {
        return { ...match, status: 'completed', winnerId, score };
      }
      const sideIndex = match.sourceMatchIds?.indexOf(completedMatchId) ?? -1;
      if (sideIndex < 0) return match;
      const sides = [...match.sides];
      sides[sideIndex] = winnerId;
      return { ...match, sides, status: sides.every(Boolean) ? 'ready' : 'pending' };
    }),
  };
}

function partitionPools(draw, poolSize) {
  if (!Number.isInteger(poolSize) || poolSize < 2 || poolSize > 32) {
    fail('Pool size must be 2 to 32.');
  }
  const count = Math.ceil(draw.length / poolSize);
  const pools = Array.from({ length: count }, (_, index) => ({ id: `P${index + 1}`, entrantIds: [] }));
  // Seeding spreads early draw positions across pools and balances their sizes.
  draw.forEach((entrant, index) => pools[index % count].entrantIds.push(entrant.id));
  return pools;
}

function circleRound(ids, round) {
  const seats = ids.length % 2 ? [...ids, null] : [...ids];
  const steps = (round - 1) % (seats.length - 1);
  for (let index = 0; index < steps; index += 1) {
    seats.splice(1, 0, seats.pop());
  }
  const pairs = [];
  for (let index = 0; index < seats.length / 2; index += 1) {
    const pair = [seats[index], seats[seats.length - 1 - index]];
    if (pair.every(Boolean)) pairs.push(pair);
  }
  return pairs;
}

/** Generate only one round across all round-robin pools. */
export function generateRoundRobin(entrants, { round = 1, poolSize = 32 } = {}) {
  const draw = validatedEntrants(entrants);
  const pools = partitionPools(draw, poolSize);
  const roundCount = Math.max(...pools.map((pool) =>
    pool.entrantIds.length + pool.entrantIds.length % 2 - 1));
  if (!Number.isInteger(round) || round < 1 || round > roundCount) {
    fail('Invalid round-robin round.');
  }
  const matches = pools.flatMap((pool) => {
    const count = pool.entrantIds.length + pool.entrantIds.length % 2 - 1;
    if (round > count) return [];
    return circleRound(pool.entrantIds, round).map((sides, index) => ({
      id: `RR-${pool.id}-R${round}-M${index + 1}`, stage: 'round_robin',
      round, poolId: pool.id, slot: index + 1, sides,
      status: 'ready', winnerId: null, score: null,
    }));
  });
  return { pools, round, roundCount, matches };
}

function gamePoints(score) {
  const games = Array.isArray(score?.games) ? score.games :
    Number.isFinite(score?.a) && Number.isFinite(score?.b) ? [score] : [];
  return games.reduce((sum, game) => {
    const a = Number(game?.a);
    const b = Number(game?.b);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
      fail('Match scores must contain nonnegative integer points.');
    }
    return { a: sum.a + a, b: sum.b + b };
  }, { a: 0, b: 0 });
}

function rankingRows(ids, matches, drawOrder, sideIds) {
  const rows = new Map(ids.map((id, index) => [id, {
    id, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0,
    pointDifference: 0, drawOrder: drawOrder.get(id) ?? index,
  }]));
  const headToHead = new Map();
  for (const match of matches) {
    if (match.status !== 'completed') continue;
    const sides = sideIds(match);
    if (!Array.isArray(sides) || sides.length !== 2 || sides.some((side) => !side?.length)) continue;
    const winnerSide = match.winnerSide === 'A' ? 0 : match.winnerSide === 'B' ? 1 :
      match.winnerSide ?? sides.findIndex((side) => side.includes(match.winnerId));
    if (![0, 1].includes(winnerSide)) fail('Completed match needs a valid winner.');
    const points = gamePoints(match.score);
    for (const sideIndex of [0, 1]) {
      for (const entrantId of sides[sideIndex]) {
        const row = rows.get(entrantId);
        if (!row) continue;
        row[sideIndex === winnerSide ? 'wins' : 'losses'] += 1;
        row.pointsFor += sideIndex === 0 ? points.a : points.b;
        row.pointsAgainst += sideIndex === 0 ? points.b : points.a;
        row.pointDifference = row.pointsFor - row.pointsAgainst;
      }
    }
    if (sides[0].length === 1 && sides[1].length === 1) {
      const winner = sides[winnerSide][0];
      const loser = sides[1 - winnerSide][0];
      const key = [winner, loser].sort().join('\0');
      const record = headToHead.get(key) || new Map();
      record.set(winner, (record.get(winner) || 0) + 1);
      headToHead.set(key, record);
    }
  }
  const byWins = new Map();
  for (const row of rows.values()) {
    if (!byWins.has(row.wins)) byWins.set(row.wins, []);
    byWins.get(row.wins).push(row);
  }
  const ranked = [];
  for (const wins of [...byWins.keys()].sort((a, b) => b - a)) {
    const group = byWins.get(wins);
    group.sort((a, b) => {
      if (group.length === 2) {
        const record = headToHead.get([a.id, b.id].sort().join('\0'));
        const h2h = (record?.get(b.id) || 0) - (record?.get(a.id) || 0);
        if (h2h) return h2h;
      }
      return b.pointDifference - a.pointDifference ||
        b.pointsFor - a.pointsFor || a.drawOrder - b.drawOrder || a.id.localeCompare(b.id);
    });
    ranked.push(...group);
  }
  return ranked.map((row, index) => ({ ...row, rank: index + 1 }));
}

/** Ranking for singles and fixed doubles; each team is one entrant. */
export function rankStandings(entrants, matches) {
  const draw = validatedEntrants(entrants, { minCount: 0 });
  if (!Array.isArray(matches)) fail('Matches are required.');
  const order = new Map(draw.map((entrant) => [entrant.id, entrant.drawOrder]));
  return rankingRows(draw.map((entrant) => entrant.id), matches, order,
    (match) => match.sides?.map((side) => [side]));
}

function repeats(history, a, b, sameSide) {
  return history.reduce((count, match) => {
    if (match.stage !== 'rotating_doubles' || !Array.isArray(match.sides)) return count;
    const aSide = match.sides.findIndex((side) => side.includes(a));
    const bSide = match.sides.findIndex((side) => side.includes(b));
    return count + Number(aSide >= 0 && bSide >= 0 && (aSide === bSide) === sameSide);
  }, 0);
}

function bestPairing(ids, history) {
  const variants = [
    [[ids[0], ids[1]], [ids[2], ids[3]]],
    [[ids[0], ids[2]], [ids[1], ids[3]]],
    [[ids[0], ids[3]], [ids[1], ids[2]]],
  ];
  return variants.map((sides, index) => ({
    sides, index,
    cost: sides.reduce((sum, side) => sum + repeats(history, side[0], side[1], true) * 10, 0) +
      sides[0].reduce((sum, a) => sum + sides[1].reduce((n, b) =>
        n + repeats(history, a, b, false), 0), 0),
  })).sort((a, b) => a.cost - b.cost || a.index - b.index)[0].sides;
}

/** A fair next round with rotating partners; unmatched players receive a bye. */
export function generateRotatingDoubles(players, { round = 1, history = [] } = {}) {
  const draw = validatedEntrants(players, { rotating: true });
  if (!Number.isInteger(round) || round < 1) fail('Invalid rotating-doubles round.');
  if (!Array.isArray(history)) fail('Match history is required.');
  const gamesPlayed = new Map(draw.map((player) => [player.id, 0]));
  for (const match of history) {
    if (match.stage !== 'rotating_doubles' || match.status === 'cancelled') continue;
    for (const side of match.sides || []) {
      for (const playerId of side || []) {
        if (gamesPlayed.has(playerId)) gamesPlayed.set(playerId, gamesPlayed.get(playerId) + 1);
      }
    }
  }
  const shifted = [...draw.slice((round - 1) % draw.length), ...draw.slice(0, (round - 1) % draw.length)];
  shifted.sort((a, b) => gamesPlayed.get(a.id) - gamesPlayed.get(b.id));
  const playingCount = Math.floor(shifted.length / 4) * 4;
  const byePlayerIds = shifted.slice(playingCount).map((player) => player.id);
  const matches = [];
  for (let index = 0; index < playingCount; index += 4) {
    const ids = shifted.slice(index, index + 4).map((player) => player.id);
    matches.push({
      id: `RD-R${round}-M${index / 4 + 1}`, stage: 'rotating_doubles',
      round, slot: index / 4 + 1, sides: bestPairing(ids, history),
      status: 'ready', winnerSide: null, score: null,
    });
  }
  return { round, matches, byePlayerIds };
}

/** Individual ranking for rotating-partner doubles. */
export function rankRotatingDoubles(players, matches) {
  const draw = validatedEntrants(players, { rotating: true, minCount: 0 });
  if (!Array.isArray(matches)) fail('Matches are required.');
  const order = new Map(draw.map((player) => [player.id, player.drawOrder]));
  return rankingRows(draw.map((player) => player.id), matches, order,
    (match) => match.sides);
}

/** Top four play a final as seeds 1+4 against 2+3. */
export function selectRotatingDoublesFinal(players, matches) {
  const ranking = rankRotatingDoubles(players, matches);
  if (ranking.length < 4) fail('The final needs four players.');
  return {
    id: 'RD-FINAL', stage: 'rotating_doubles_final', round: 'final', slot: 1,
    sides: [[ranking[0].id, ranking[3].id], [ranking[1].id, ranking[2].id]],
    status: 'ready', winnerSide: null, score: null,
  };
}
