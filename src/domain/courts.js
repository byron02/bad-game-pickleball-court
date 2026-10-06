/**
 * Storage-independent rules for configuring and running one court at a time.
 *
 * A player is { id, skill, gender, checkedIn, sittingOut?, waitMinutes?, gamesPlayed?,
 * partnerId?, recentPartnerIds?, recentOpponentIds? }.
 * `partnerId` locks two players as a doubles pair for draws (they stay on the
 * same side). `status: "checked_in"` is also accepted instead of
 * `checkedIn: true`. `sittingOut: true` keeps them checked in but out of draws.
 * A lineup is { sideA: [playerId, ...], sideB: [playerId, ...] }.
 */

export const SKILLS = Object.freeze(['beginner', 'intermediate', 'advanced']);
export const DIVISIONS = Object.freeze(['open', 'mixed', 'women', 'men']);
export const FORMATS = Object.freeze(['singles', 'doubles']);

const skillRank = { beginner: 1, intermediate: 2, advanced: 3 };

function skillOf(value) {
  const skill = String(value ?? '').trim().toLowerCase();
  return skill === 'advance' ? 'advanced' : skill;
}

function genderOf(value) {
  const gender = String(value ?? '').trim().toLowerCase();
  if (['woman', 'women', 'female'].includes(gender)) return 'woman';
  if (['man', 'men', 'male'].includes(gender)) return 'man';
  return gender;
}

function formatOf(court) {
  return court?.format ?? 'doubles';
}

function divisionOf(court) {
  return court?.division ?? 'open';
}

function isCheckedIn(player) {
  if (typeof player.checkedIn === 'boolean') return player.checkedIn;
  return player.status === 'checked_in';
}

function isAvailableForDraw(player) {
  return isCheckedIn(player) && player?.sittingOut !== true;
}

function arrayOfIds(value) {
  return Array.isArray(value) ? value : [];
}

function activeGamesOnly(games) {
  return Array.isArray(games) ? games.filter((game) => game?.status === 'active') : [];
}

function activePlayerIds(games) {
  const ids = new Set();
  for (const game of activeGamesOnly(games)) {
    for (const id of [...arrayOfIds(game?.lineup?.sideA), ...arrayOfIds(game?.lineup?.sideB)]) {
      ids.add(id);
    }
  }
  return ids;
}

function allowedSkills(court) {
  return Array.isArray(court?.allowedSkills)
    ? court.allowedSkills.map(skillOf)
    : [];
}

function validId(id) {
  return typeof id === 'string' && id.trim().length > 0;
}

/** Validate one physical court's current play settings. */
export function validateCourtConfig(court) {
  const errors = [];
  if (!court || typeof court !== 'object' || Array.isArray(court)) {
    return { valid: false, errors: ['Court configuration is required.'] };
  }

  if (!validId(court.id)) errors.push('Court id is required.');

  const skills = allowedSkills(court);
  if (skills.length === 0) errors.push('Choose at least one allowed skill.');
  if (skills.some((skill) => !SKILLS.includes(skill))) {
    errors.push('Allowed skills must be beginner, intermediate, or advanced.');
  }
  if (new Set(skills).size !== skills.length) errors.push('Allowed skills must be unique.');

  if (!FORMATS.includes(formatOf(court))) errors.push('Format must be singles or doubles.');
  if (!DIVISIONS.includes(divisionOf(court))) {
    errors.push('Division must be open, mixed, women, or men.');
  }
  if (formatOf(court) === 'singles' && divisionOf(court) === 'mixed') {
    errors.push('Mixed division requires doubles.');
  }
  return { valid: errors.length === 0, errors };
}

function playerById(players) {
  return new Map((Array.isArray(players) ? players : []).map((player) => [player?.id, player]));
}

function lineupIds(lineup) {
  return [...arrayOfIds(lineup?.sideA), ...arrayOfIds(lineup?.sideB)];
}

function teamPassesDivision(team, division) {
  const genders = team.map((player) => genderOf(player.gender));
  if (division === 'women') return genders.every((gender) => gender === 'woman');
  if (division === 'men') return genders.every((gender) => gender === 'man');
  if (division === 'mixed') {
    return genders.length === 2 && genders.includes('woman') && genders.includes('man');
  }
  return true;
}

/**
 * Check a proposed lineup against attendance, court rules, and every active
 * court. Completed games do not block players from new games.
 */
export function validateLineup({ court, lineup, players, activeGames = [] }) {
  const errors = [...validateCourtConfig(court).errors];
  if (errors.length) return { valid: false, errors };

  const teamSize = formatOf(court) === 'singles' ? 1 : 2;
  if (!Array.isArray(lineup?.sideA) || lineup.sideA.length !== teamSize ||
      !Array.isArray(lineup?.sideB) || lineup.sideB.length !== teamSize) {
    errors.push(`Each team needs ${teamSize} player${teamSize === 1 ? '' : 's'}.`);
  }

  const ids = lineupIds(lineup);
  if (ids.some((id) => !validId(id))) errors.push('Every lineup player needs an id.');
  if (new Set(ids).size !== ids.length) errors.push('A player can appear only once in a game.');

  const roster = playerById(players);
  const busy = activePlayerIds(activeGames);
  const skills = new Set(allowedSkills(court));
  for (const id of ids) {
    const player = roster.get(id);
    if (!player) {
      errors.push(`Player ${id} is not in the roster.`);
      continue;
    }
    if (!isCheckedIn(player)) errors.push(`Player ${id} is not checked in.`);
    if (player.sittingOut === true) errors.push(`Player ${id} is sitting out.`);
    if (!skills.has(skillOf(player.skill))) {
      errors.push(`Player ${id} is not eligible for this court's skill setting.`);
    }
    if (busy.has(id)) errors.push(`Player ${id} is already on an active court.`);
  }

  if (activeGamesOnly(activeGames).some((game) => game.courtId === court.id)) {
    errors.push('This court already has an active game.');
  }

  if (ids.every((id) => roster.has(id)) &&
      Array.isArray(lineup?.sideA) && Array.isArray(lineup?.sideB)) {
    const division = divisionOf(court);
    if (!teamPassesDivision(lineup.sideA.map((id) => roster.get(id)), division) ||
        !teamPassesDivision(lineup.sideB.map((id) => roster.get(id)), division)) {
      errors.push(`Teams do not satisfy the ${division} division.`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function nonnegative(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function randomUnit(random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('Random source must return a number from 0 (inclusive) to 1 (exclusive).');
  }
  return value;
}

function priority(player, random) {
  // Fewer games dominate; wait time and a tiny random tie-break follow.
  return nonnegative(player.waitMinutes) - nonnegative(player.gamesPlayed) * 15 +
    randomUnit(random) * 2;
}

/** Checked-in players eligible for this court who are not sitting out or already on a court. */
export function eligiblePlayersForCourt({ court, players, activeGames = [] }) {
  const config = validateCourtConfig(court);
  if (!config.valid) return [];
  const busy = activePlayerIds(activeGames);
  const skills = new Set(allowedSkills(court));
  const division = divisionOf(court);
  return (Array.isArray(players) ? players : [])
    .filter((player) => validId(player?.id) && isAvailableForDraw(player) &&
      skills.has(skillOf(player.skill)) && !busy.has(player.id) &&
      (division === 'open' || division === 'mixed' ||
       genderOf(player.gender) === (division === 'women' ? 'woman' : 'man')));
}

export function courtPoolSummary({ players, activeGames = [] }) {
  const roster = Array.isArray(players) ? players : [];
  const busy = activePlayerIds(activeGames);
  const waiting = roster.filter((player) => isAvailableForDraw(player) && !busy.has(player.id)).length;
  return { waiting, onCourt: busy.size, checkedIn: roster.filter((player) => isCheckedIn(player)).length };
}

function recentIncludes(player, field, id) {
  return Array.isArray(player[field]) && player[field].includes(id);
}

function mutualPartner(player, byId) {
  const partnerId = player?.partnerId;
  if (!validId(partnerId)) return null;
  const partner = byId.get(partnerId);
  if (!partner || partner.partnerId !== player.id) return null;
  return partner;
}

function lockedTogether(a, b) {
  return validId(a?.id) && validId(b?.id) && a.partnerId === b.id && b.partnerId === a.id;
}

function respectsLockedPartners(sideA, sideB) {
  const roster = [...sideA, ...sideB];
  const byId = new Map(roster.map((player) => [player.id, player]));
  const teamOf = new Map();
  for (const player of sideA) teamOf.set(player.id, 'A');
  for (const player of sideB) teamOf.set(player.id, 'B');
  for (const player of roster) {
    const partner = mutualPartner(player, byId);
    if (!partner || !teamOf.has(partner.id)) continue;
    if (teamOf.get(player.id) !== teamOf.get(partner.id)) return false;
  }
  return true;
}

function pairingCost(sideA, sideB) {
  const teamSkillDifference = Math.abs(
    sideA.reduce((sum, player) => sum + skillRank[skillOf(player.skill)], 0) -
    sideB.reduce((sum, player) => sum + skillRank[skillOf(player.skill)], 0)
  );
  let cost = teamSkillDifference * 5;
  for (const side of [sideA, sideB]) {
    for (let i = 0; i < side.length; i += 1) {
      for (let j = i + 1; j < side.length; j += 1) {
        if (lockedTogether(side[i], side[j])) continue;
        if (recentIncludes(side[i], 'recentPartnerIds', side[j].id) ||
            recentIncludes(side[j], 'recentPartnerIds', side[i].id)) cost += 12;
      }
    }
  }
  for (const a of sideA) {
    for (const b of sideB) {
      if (recentIncludes(a, 'recentOpponentIds', b.id) ||
          recentIncludes(b, 'recentOpponentIds', a.id)) cost += 3;
    }
  }
  return cost;
}

function chooseTeams(selected, division, random) {
  if (selected.length === 2) {
    return randomUnit(random) < 0.5
      ? { sideA: [selected[0].id], sideB: [selected[1].id] }
      : { sideA: [selected[1].id], sideB: [selected[0].id] };
  }

  const partitions = [
    [[0, 1], [2, 3]],
    [[0, 2], [1, 3]],
    [[0, 3], [1, 2]],
  ];
  const choices = partitions
    .map(([a, b]) => ({ sideA: a.map((i) => selected[i]), sideB: b.map((i) => selected[i]) }))
    .filter(({ sideA, sideB }) =>
      teamPassesDivision(sideA, division) && teamPassesDivision(sideB, division) &&
      respectsLockedPartners(sideA, sideB))
    .map((choice) => ({ ...choice, cost: pairingCost(choice.sideA, choice.sideB) + randomUnit(random) * 0.1 }))
    .sort((a, b) => a.cost - b.cost);
  if (choices.length === 0) return null;
  const best = choices[0];
  return randomUnit(random) < 0.5
    ? { sideA: best.sideA.map((player) => player.id), sideB: best.sideB.map((player) => player.id) }
    : { sideA: best.sideB.map((player) => player.id), sideB: best.sideA.map((player) => player.id) };
}

function selectForCourt(eligible, size, division) {
  const byId = new Map(eligible.map((player) => [player.id, player]));
  const selected = [];
  const used = new Set();

  if (division === 'mixed') {
    const women = eligible.filter((player) => genderOf(player.gender) === 'woman');
    const men = eligible.filter((player) => genderOf(player.gender) === 'man');
    // Prefer locked mixed pairs (one woman + one man) as ready sides.
    for (const player of eligible) {
      if (selected.length >= size) break;
      if (used.has(player.id)) continue;
      const partner = mutualPartner(player, byId);
      if (!partner || used.has(partner.id)) continue;
      const genders = new Set([genderOf(player.gender), genderOf(partner.gender)]);
      if (!genders.has('woman') || !genders.has('man')) continue;
      selected.push(player, partner);
      used.add(player.id);
      used.add(partner.id);
    }
    for (const pool of [women, men]) {
      for (const player of pool) {
        if (selected.length >= size) break;
        if (used.has(player.id)) continue;
        if (mutualPartner(player, byId) && !used.has(player.partnerId)) {
          // Same-gender locked pair cannot play mixed — leave both out.
          const partner = mutualPartner(player, byId);
          if (genderOf(partner.gender) === genderOf(player.gender)) {
            used.add(player.id);
            used.add(partner.id);
            continue;
          }
        }
        const takenWomen = selected.filter((item) => genderOf(item.gender) === 'woman').length;
        const takenMen = selected.filter((item) => genderOf(item.gender) === 'man').length;
        if (genderOf(player.gender) === 'woman' && takenWomen >= 2) continue;
        if (genderOf(player.gender) === 'man' && takenMen >= 2) continue;
        selected.push(player);
        used.add(player.id);
      }
    }
    return selected.length === size ? selected : null;
  }

  for (const player of eligible) {
    if (selected.length >= size) break;
    if (used.has(player.id)) continue;
    const partner = size === 4 ? mutualPartner(player, byId) : null;
    if (partner && !used.has(partner.id)) {
      if (selected.length + 2 > size) continue;
      selected.push(player, partner);
      used.add(player.id);
      used.add(partner.id);
      continue;
    }
    selected.push(player);
    used.add(player.id);
  }
  return selected.length === size ? selected : null;
}

/**
 * Suggest a game for one idle court. Returns null if its division/skill pool
 * cannot fill both teams. The returned lineup can be previewed and shuffled
 * again; validate it when the organizer actually starts the game.
 */
export function proposeLineup({ court, players, activeGames = [], random = Math.random }) {
  const config = validateCourtConfig(court);
  if (!config.valid) throw new Error(config.errors.join(' '));
  if (typeof random !== 'function') throw new TypeError('random must be a function.');
  if (activeGamesOnly(activeGames).some((game) => game.courtId === court.id)) return null;

  const division = divisionOf(court);
  const size = formatOf(court) === 'singles' ? 2 : 4;
  const eligible = eligiblePlayersForCourt({ court, players, activeGames })
    .map((player) => ({ player, score: priority(player, random) }))
    .sort((a, b) => b.score - a.score ||
      nonnegative(a.player.gamesPlayed) - nonnegative(b.player.gamesPlayed))
    .map(({ player }) => player);

  if (eligible.length < size) return null;
  const selected = selectForCourt(eligible, size, division);
  if (!selected) return null;

  const lineup = chooseTeams(selected, division, random);
  if (!lineup) return null;
  return validateLineup({ court, lineup, players, activeGames }).valid ? lineup : null;
}

/**
 * Return an updated game plus per-player stat deltas, without mutating input.
 * A repeated identical result produces no deltas. Persist game and stat changes
 * in one database transaction to keep this idempotency under concurrent writes.
 */
export function recordGameResult({ game, winnerSide }) {
  if (winnerSide !== 'A' && winnerSide !== 'B') {
    throw new Error('Winner side must be A or B.');
  }
  if (!game || typeof game !== 'object') throw new Error('Game is required.');

  if (game.result) {
    if (game.result.winnerSide !== winnerSide) {
      throw new Error('Game already has a different result.');
    }
    return { game, statDeltas: {}, applied: false };
  }
  if (game.status !== 'active') throw new Error('Only an active game can receive a result.');

  const sideA = game.lineup?.sideA;
  const sideB = game.lineup?.sideB;
  if (!Array.isArray(sideA) || !Array.isArray(sideB) ||
      sideA.length !== sideB.length || ![1, 2].includes(sideA.length)) {
    throw new Error('Game needs valid singles or doubles teams.');
  }
  const ids = [...sideA, ...sideB];
  if (ids.some((id) => !validId(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Game lineup must contain distinct player ids.');
  }

  const winners = winnerSide === 'A' ? sideA : sideB;
  const losers = winnerSide === 'A' ? sideB : sideA;
  const statDeltas = Object.fromEntries([
    ...winners.map((id) => [id, { wins: 1, losses: 0 }]),
    ...losers.map((id) => [id, { wins: 0, losses: 1 }]),
  ]);
  return {
    game: { ...game, status: 'completed', result: { winnerSide } },
    statDeltas,
    applied: true,
  };
}
