import test from 'node:test';
import assert from 'node:assert/strict';
import {
  proposeLineup,
  recordGameResult,
  validateCourtConfig,
  validateLineup,
  courtPoolSummary,
} from '../src/domain/courts.js';

const player = (id, skill, gender, extra = {}) => ({
  id, skill, gender, checkedIn: true, waitMinutes: 20, gamesPlayed: 0, ...extra,
});
const court = (id, allowedSkills, division = 'open', format = 'doubles') => ({
  id, allowedSkills, division, format,
});
const IDs = (lineup) => [...lineup.sideA, ...lineup.sideB];

test('per-court skill rules allow advanced-only beside beginner/intermediate courts', () => {
  const advanced = court('court-1', ['advanced']);
  const learning = court('court-2', ['beginner', 'intermediate']);
  const players = [
    player('a1', 'advanced', 'woman'), player('a2', 'advanced', 'woman'),
    player('a3', 'advanced', 'man'), player('a4', 'advanced', 'man'),
    player('b1', 'beginner', 'woman'), player('b2', 'beginner', 'man'),
    player('i1', 'intermediate', 'woman'), player('i2', 'intermediate', 'man'),
    player('late', 'advanced', 'man', { checkedIn: false, waitMinutes: 999 }),
  ];

  assert.deepEqual(validateCourtConfig(advanced), { valid: true, errors: [] });
  assert.deepEqual(new Set(IDs(proposeLineup({ court: advanced, players, random: () => 0.5 }))),
    new Set(['a1', 'a2', 'a3', 'a4']));
  assert.deepEqual(new Set(IDs(proposeLineup({ court: learning, players, random: () => 0.5 }))),
    new Set(['b1', 'b2', 'i1', 'i2']));
  assert.equal(validateLineup({
    court: advanced,
    lineup: { sideA: ['a1', 'b1'], sideB: ['a3', 'a4'] },
    players,
  }).valid, false);
  assert.deepEqual(courtPoolSummary({
    players,
    activeGames: [{ status: 'active', lineup: { sideA: ['a1', 'a2'], sideB: ['a3', 'a4'] } }],
  }), { waiting: 4, onCourt: 4, checkedIn: 8 });
});

test('women, men, and mixed divisions constrain every team independently', () => {
  const players = [
    player('w1', 'advanced', 'woman'), player('w2', 'advanced', 'female'),
    player('w3', 'advanced', 'woman'), player('w4', 'advanced', 'woman'),
    player('m1', 'advanced', 'man'), player('m2', 'advanced', 'male'),
    player('m3', 'advanced', 'man'), player('m4', 'advanced', 'man'),
  ];
  const women = court('women-court', ['advanced'], 'women');
  const men = court('men-court', ['advanced'], 'men');
  const mixed = court('mixed-court', ['advanced'], 'mixed');

  assert.deepEqual(new Set(IDs(proposeLineup({ court: women, players, random: () => 0.5 }))),
    new Set(['w1', 'w2', 'w3', 'w4']));
  assert.deepEqual(new Set(IDs(proposeLineup({ court: men, players, random: () => 0.5 }))),
    new Set(['m1', 'm2', 'm3', 'm4']));
  const lineup = proposeLineup({ court: mixed, players, random: () => 0.5 });
  for (const ids of [lineup.sideA, lineup.sideB]) {
    assert.deepEqual(new Set(ids.map((id) => players.find((p) => p.id === id).gender)
      .map((gender) => gender === 'female' ? 'woman' : gender === 'male' ? 'man' : gender)),
    new Set(['woman', 'man']));
  }
  assert.equal(validateLineup({
    court: mixed,
    lineup: { sideA: ['w1', 'w2'], sideB: ['m1', 'm2'] },
    players,
  }).valid, false);
});

test('only checked-in, unassigned players can start; another court can start independently', () => {
  const players = [
    player('a', 'beginner', 'woman'), player('b', 'beginner', 'man'),
    player('c', 'beginner', 'woman'), player('d', 'beginner', 'man'),
    player('e', 'beginner', 'woman'), player('f', 'beginner', 'man'),
    player('g', 'beginner', 'woman'), player('h', 'beginner', 'man'),
    player('reserved', 'beginner', 'woman', { checkedIn: false, waitMinutes: 1000 }),
  ];
  const court1 = court('court-1', ['beginner']);
  const court2 = court('court-2', ['beginner']);
  const game1 = { id: 'game-1', courtId: 'court-1', status: 'active',
    lineup: { sideA: ['a', 'b'], sideB: ['c', 'd'] } };

  assert.equal(proposeLineup({ court: court1, players, activeGames: [game1] }), null);
  const lineup2 = proposeLineup({ court: court2, players, activeGames: [game1], random: () => 0.5 });
  assert.deepEqual(new Set(IDs(lineup2)), new Set(['e', 'f', 'g', 'h']));
  assert.equal(validateLineup({
    court: court2,
    lineup: { sideA: ['a', 'e'], sideB: ['f', 'g'] },
    players,
    activeGames: [game1],
  }).valid, false);
  assert.equal(validateLineup({
    court: court2,
    lineup: { sideA: ['reserved', 'e'], sideB: ['f', 'g'] },
    players,
    activeGames: [game1],
  }).valid, false);
  assert.equal(validateLineup({ court: court2, lineup: lineup2, players, activeGames: [game1] }).valid, true);
});

test('confirmed reservations become eligible only after check-in', () => {
  const roster = [
    player('a', 'advanced', 'woman', { status: 'confirmed', checkedIn: true }),
    player('b', 'advanced', 'woman', { status: 'confirmed', checkedIn: true }),
    player('c', 'advanced', 'man', { status: 'confirmed', checkedIn: true }),
    player('d', 'advanced', 'man', { status: 'confirmed', checkedIn: true }),
    player('late', 'advanced', 'man', { status: 'confirmed', checkedIn: false }),
  ];
  const lineup = proposeLineup({ court: court('court-1', ['advanced']), players: roster, random: () => 0.5 });
  assert.deepEqual(new Set(IDs(lineup)), new Set(['a', 'b', 'c', 'd']));
});

test('sitting out keeps a checked-in player reserved but out of draws', () => {
  const players = [
    player('a', 'beginner', 'woman'),
    player('b', 'beginner', 'man'),
    player('c', 'beginner', 'woman'),
    player('d', 'beginner', 'man'),
    player('resting', 'beginner', 'woman', { sittingOut: true, waitMinutes: 999 }),
  ];
  const lineup = proposeLineup({ court: court('court-1', ['beginner']), players, random: () => 0.5 });
  assert.deepEqual(new Set(IDs(lineup)), new Set(['a', 'b', 'c', 'd']));
  assert.equal(validateLineup({
    court: court('court-1', ['beginner']),
    lineup: { sideA: ['resting', 'a'], sideB: ['b', 'c'] },
    players,
  }).valid, false);
  assert.deepEqual(courtPoolSummary({ players, activeGames: [] }), {
    waiting: 4, onCourt: 0, checkedIn: 5,
  });
});

test('pending partner requests do not lock doubles until both sides match', () => {
  const players = [
    player('me', 'intermediate', 'man', { waitMinutes: 40 }),
    player('stef', 'intermediate', 'woman', { waitMinutes: 40 }),
    player('a', 'intermediate', 'man', { waitMinutes: 10 }),
    player('b', 'intermediate', 'woman', { waitMinutes: 10 }),
  ];
  const unlocked = proposeLineup({ court: court('court-1', ['intermediate']), players, random: () => 0.5 });
  assert.ok(unlocked);
  const locked = [
    player('me', 'intermediate', 'man', { partnerId: 'stef', waitMinutes: 40 }),
    player('stef', 'intermediate', 'woman', { partnerId: 'me', waitMinutes: 40 }),
    player('a', 'intermediate', 'man', { waitMinutes: 10 }),
    player('b', 'intermediate', 'woman', { waitMinutes: 10 }),
  ];
  const lineup = proposeLineup({ court: court('court-1', ['intermediate']), players: locked, random: () => 0.5 });
  const withMe = lineup.sideA.includes('me') ? lineup.sideA : lineup.sideB;
  assert.ok(withMe.includes('me') && withMe.includes('stef'));
});

test('a confirmed reservation with checkedIn true is eligible', () => {
  const players = [
    player('a', 'beginner', 'woman', { status: 'confirmed' }),
    player('b', 'beginner', 'man', { status: 'confirmed' }),
  ];
  const singles = court('court-1', ['beginner'], 'open', 'singles');
  assert.equal(validateLineup({
    court: singles, lineup: { sideA: ['a'], sideB: ['b'] }, players,
  }).valid, true);
});

test('locked doubles partners stay on the same side', () => {
  const players = [
    player('me', 'intermediate', 'man', { partnerId: 'stef', waitMinutes: 40 }),
    player('stef', 'intermediate', 'woman', { partnerId: 'me', waitMinutes: 40 }),
    player('a', 'intermediate', 'man', { waitMinutes: 10 }),
    player('b', 'intermediate', 'woman', { waitMinutes: 10 }),
    player('c', 'intermediate', 'man', { waitMinutes: 5 }),
    player('d', 'intermediate', 'woman', { waitMinutes: 5 }),
  ];
  const lineup = proposeLineup({ court: court('court-1', ['intermediate']), players, random: () => 0.5 });
  assert.ok(lineup);
  const withMe = lineup.sideA.includes('me') ? lineup.sideA : lineup.sideB;
  assert.ok(withMe.includes('me') && withMe.includes('stef'));
});

test('when one locked partner sits out, the other can still be drawn solo', () => {
  const players = [
    player('nathan', 'intermediate', 'man', { partnerId: 'rivamonte', waitMinutes: 50, sittingOut: true }),
    player('rivamonte', 'intermediate', 'woman', { partnerId: 'nathan', waitMinutes: 50 }),
    player('a', 'intermediate', 'man', { waitMinutes: 10 }),
    player('b', 'intermediate', 'woman', { waitMinutes: 10 }),
    player('c', 'intermediate', 'man', { waitMinutes: 10 }),
  ];
  const lineup = proposeLineup({ court: court('court-1', ['intermediate']), players, random: () => 0.5 });
  assert.ok(lineup);
  const ids = IDs(lineup);
  assert.ok(ids.includes('rivamonte'));
  assert.ok(!ids.includes('nathan'));
});

test('waiting longer and playing fewer games affect the proposed four', () => {
  const players = [
    player('waited', 'intermediate', 'man', { waitMinutes: 50, gamesPlayed: 3 }),
    player('fresh', 'intermediate', 'man', { waitMinutes: 20, gamesPlayed: 0 }),
    player('two', 'intermediate', 'man', { waitMinutes: 20, gamesPlayed: 0 }),
    player('three', 'intermediate', 'man', { waitMinutes: 20, gamesPlayed: 0 }),
    player('played-more', 'intermediate', 'man', { waitMinutes: 20, gamesPlayed: 3 }),
  ];
  const lineup = proposeLineup({ court: court('court-1', ['intermediate']), players, random: () => 0.5 });
  assert.ok(IDs(lineup).includes('waited'));
  assert.ok(!IDs(lineup).includes('played-more'));
});

test('the draw avoids a recent partner when a balanced alternative exists', () => {
  const players = [
    player('a', 'intermediate', 'woman', { recentPartnerIds: ['b'] }),
    player('b', 'intermediate', 'man', { recentPartnerIds: ['a'] }),
    player('c', 'intermediate', 'woman'), player('d', 'intermediate', 'man'),
  ];
  const lineup = proposeLineup({ court: court('court-1', ['intermediate']), players, random: () => 0.5 });
  assert.ok(!lineup.sideA.includes('a') || !lineup.sideA.includes('b'));
  assert.ok(!lineup.sideB.includes('a') || !lineup.sideB.includes('b'));
});

test('Joemari and Stef gain one win; Jina and Ana gain one loss exactly once', () => {
  const game = { id: 'game-1', courtId: 'court-1', status: 'active',
    lineup: { sideA: ['Jina', 'Ana'], sideB: ['Joemari', 'Stef'] } };
  const recorded = recordGameResult({ game, winnerSide: 'B' });

  assert.equal(recorded.applied, true);
  assert.deepEqual(recorded.statDeltas, {
    Joemari: { wins: 1, losses: 0 }, Stef: { wins: 1, losses: 0 },
    Jina: { wins: 0, losses: 1 }, Ana: { wins: 0, losses: 1 },
  });
  assert.equal(recorded.game.status, 'completed');
  assert.deepEqual(recorded.game.result, { winnerSide: 'B' });
  assert.equal(game.status, 'active');
  assert.equal(game.result, undefined);

  const replay = recordGameResult({ game: recorded.game, winnerSide: 'B' });
  assert.equal(replay.applied, false);
  assert.deepEqual(replay.statDeltas, {});
  assert.throws(() => recordGameResult({ game: recorded.game, winnerSide: 'A' }),
    /different result/);
});

test('singles can run independently; mixed singles is rejected', () => {
  const singles = court('court-1', ['beginner'], 'open', 'singles');
  const players = [player('a', 'beginner', 'woman'), player('b', 'beginner', 'man')];
  const lineup = proposeLineup({ court: singles, players, random: () => 0.5 });
  assert.equal(lineup.sideA.length, 1);
  assert.equal(lineup.sideB.length, 1);
  assert.equal(validateLineup({ court: singles, lineup, players }).valid, true);
  assert.equal(validateCourtConfig(court('court-2', ['beginner'], 'mixed', 'singles')).valid, false);
});
