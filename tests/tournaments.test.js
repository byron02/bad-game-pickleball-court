import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceBracket,
  generateRotatingDoubles,
  generateRoundRobin,
  generateSingleElimination,
  rankRotatingDoubles,
  rankStandings,
  selectRotatingDoublesFinal,
} from '../src/domain/tournaments.js';

const singles = (count) => Array.from({ length: count }, (_, index) => ({
  id: `p${index + 1}`, playerIds: [`p${index + 1}`],
}));
const teams = (count) => Array.from({ length: count }, (_, index) => ({
  id: `t${index + 1}`, playerIds: [`p${index * 2 + 1}`, `p${index * 2 + 2}`],
}));
const complete = (match, winnerId, a = 11, b = 7) => ({
  ...match, status: 'completed', winnerId, score: { games: [{ a, b }] },
});

test('five-entrant knockout seeds three byes without recording free wins', () => {
  const draw = singles(5);
  const first = generateSingleElimination(draw);
  assert.equal(first.roundCount, 3);
  assert.equal(first.matches.length, 4);
  assert.equal(first.matches.filter((match) => match.status === 'bye').length, 3);
  assert.equal(first.matches.filter((match) => match.status === 'ready').length, 1);
  assert.deepEqual(first.matches[0].sides, ['p1', null]);
  assert.equal(first.matches[0].winnerId, 'p1');

  const firstComplete = first.matches.map((match) =>
    match.status === 'ready' ? complete(match, 'p4') : match);
  const second = generateSingleElimination(draw, { round: 2, priorMatches: firstComplete });
  assert.deepEqual(second.matches.map((match) => match.sides),
    [['p1', 'p4'], ['p2', 'p3']]);
  assert.throws(() => generateSingleElimination(draw, { round: 2, priorMatches: first.matches }),
    /Complete the previous/);
  const final = generateSingleElimination(draw, {
    round: 3,
    priorMatches: [complete(second.matches[0], 'p1'), complete(second.matches[1], 'p2')],
  });
  assert.deepEqual(final.matches[0].sides, ['p1', 'p2']);
});

test('knockout corrections propagate only before a dependent match starts', () => {
  const first = generateSingleElimination(singles(4)).matches;
  const next = { ...generateSingleElimination(singles(4), {
    round: 2, priorMatches: first.map((match) => complete(match, match.sides[0])),
  }).matches[0], sides: [null, null], status: 'pending' };
  const firstResult = advanceBracket([...first, next], first[0].id, 'p1');
  assert.equal(firstResult.applied, true);
  assert.deepEqual(firstResult.matches.at(-1).sides, ['p1', null]);
  assert.equal(advanceBracket(firstResult.matches, first[0].id, 'p1').applied, false);
  const correction = advanceBracket(firstResult.matches, first[0].id, 'p4');
  assert.equal(correction.matches.at(-1).sides[0], 'p4');
  assert.throws(() => advanceBracket([
    ...firstResult.matches.slice(0, -1),
    { ...firstResult.matches.at(-1), status: 'active' },
  ], first[0].id, 'p4'), /Clear the dependent/);
});

test('round robin produces each pairing once and partitions large fields', () => {
  const draw = teams(6);
  const rounds = Array.from({ length: 5 }, (_, index) =>
    generateRoundRobin(draw, { round: index + 1 }));
  assert.ok(rounds.every((round) => round.matches.length === 3));
  const pairings = rounds.flatMap((round) => round.matches.map((match) =>
    [...match.sides].sort().join(':')));
  assert.equal(new Set(pairings).size, 15);

  const field = singles(67);
  const first = generateRoundRobin(field, { round: 1 });
  assert.deepEqual(first.pools.map((pool) => pool.entrantIds.length), [23, 22, 22]);
  assert.equal(first.roundCount, 23);
  assert.equal(first.matches.length, 33);
  assert.equal(first.matches.every((match) => match.poolId && match.status === 'ready'), true);
  const last = generateRoundRobin(field, { round: 23 });
  assert.equal(last.matches.every((match) => match.poolId === 'P1'), true);
});

test('round robin at the 512-player limit emits one manageable round', () => {
  const result = generateRoundRobin(singles(512), { round: 1 });
  assert.equal(result.pools.length, 16);
  assert.equal(result.matches.length, 256);
  assert.equal(result.roundCount, 31);
  assert.throws(() => generateRoundRobin(singles(513)), /512 entrants/);
});

test('two-way ties use head-to-head before point difference', () => {
  const draw = singles(3);
  const matches = [
    { status: 'completed', sides: ['p1', 'p2'], winnerId: 'p1', score: { games: [{ a: 11, b: 10 }] } },
    { status: 'completed', sides: ['p2', 'p3'], winnerId: 'p2', score: { games: [{ a: 11, b: 0 }] } },
  ];
  const ranking = rankStandings(draw, matches);
  assert.deepEqual(ranking.map((row) => row.id), ['p1', 'p2', 'p3']);
  assert.equal(ranking[1].pointDifference, 10);
  assert.equal(ranking[0].pointDifference, 1);
});

test('standings accept stored A/B winner sides as well as numeric sides', () => {
  const draw = singles(4);
  const matches = [
    { status: 'completed', sides: ['p1', 'p2'], winnerSide: 'B', score: { games: [{ a: 8, b: 11 }] } },
    { status: 'completed', sides: ['p3', 'p4'], winnerSide: 0, score: { games: [{ a: 11, b: 7 }] } },
  ];
  const result = rankStandings(draw, matches);
  assert.equal(result.find((row) => row.id === 'p2').wins, 1);
  assert.equal(result.find((row) => row.id === 'p1').losses, 1);
  assert.equal(result.find((row) => row.id === 'p3').wins, 1);
  assert.equal(result.find((row) => row.id === 'p4').losses, 1);
  const rotating = generateRotatingDoubles(draw).matches[0];
  const ranked = rankRotatingDoubles(draw, [{
    ...rotating, status: 'completed', winnerSide: 'A', score: { games: [{ a: 11, b: 9 }] },
  }]);
  assert.equal(ranked.filter((row) => row.wins === 1).length, 2);
});

test('three-way ties use point difference, points scored, then draw order', () => {
  const draw = singles(3);
  const matches = [
    { status: 'completed', sides: ['p1', 'p2'], winnerId: 'p1', score: { games: [{ a: 11, b: 10 }] } },
    { status: 'completed', sides: ['p2', 'p3'], winnerId: 'p2', score: { games: [{ a: 11, b: 9 }] } },
    { status: 'completed', sides: ['p3', 'p1'], winnerId: 'p3', score: { games: [{ a: 11, b: 10 }] } },
  ];
  const ranking = rankStandings(draw, matches);
  assert.deepEqual(ranking.map((row) => row.id), ['p2', 'p1', 'p3']);
  assert.equal(ranking.every((row) => row.wins === 1), true);
  assert.deepEqual(rankStandings(draw, []).map((row) => row.id), ['p1', 'p2', 'p3']);
});

test('rotating doubles avoid repeating partners and select a top-four final', () => {
  const draw = singles(8);
  const first = generateRotatingDoubles(draw);
  assert.equal(first.matches.length, 2);
  assert.equal(first.byePlayerIds.length, 0);
  const results = first.matches.map((match) => ({
    ...match, status: 'completed', winnerSide: 0,
    score: { games: [{ a: 11, b: 7 }] },
  }));
  const second = generateRotatingDoubles(draw, { round: 2, history: results });
  assert.equal(second.matches.length, 2);
  const firstPartners = first.matches.flatMap((match) => match.sides.map((side) => side.sort().join(':')));
  const secondPartners = second.matches.flatMap((match) => match.sides.map((side) => side.sort().join(':')));
  assert.equal(secondPartners.some((pair) => firstPartners.includes(pair)), false);
  const ranking = rankRotatingDoubles(draw, results);
  assert.equal(ranking.filter((row) => row.wins === 1).length, 4);
  const final = selectRotatingDoublesFinal(draw, results);
  assert.deepEqual(final.sides, [[ranking[0].id, ranking[3].id], [ranking[1].id, ranking[2].id]]);
});

test('rotating doubles distribute byes to players with fewer games', () => {
  const draw = singles(6);
  const first = generateRotatingDoubles(draw);
  assert.equal(first.matches.length, 1);
  assert.equal(first.byePlayerIds.length, 2);
  const second = generateRotatingDoubles(draw, { round: 2, history: first.matches });
  const playing = new Set(second.matches[0].sides.flat());
  assert.equal(first.byePlayerIds.every((id) => playing.has(id)), true);
});
