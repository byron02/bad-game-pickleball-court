import { getApps, initializeApp } from 'firebase/app';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { firebaseConfig } from './firebaseConfig.js';
import { getCurrentUser } from './firebaseStore.js';
import {
  proposeLineup,
  recordGameResult,
  validateCourtConfig,
  validateLineup,
  courtPoolSummary,
  eligiblePlayersForCourt,
} from './domain/courts.js';

const app = getApps()[0] || initializeApp(firebaseConfig);
const db = getFirestore(app);

function error(message, code = 'invalid-argument') {
  const result = new Error(message);
  result.code = code;
  return result;
}

function idOf(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('/')) {
    throw error(`${label} is invalid.`);
  }
  return value;
}

function time(value) {
  if (!value) return null;
  return typeof value.toDate === 'function' ? value.toDate().toISOString() : value;
}

function millis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function courtRef(id) { return doc(db, 'courts', idOf(id, 'Court id')); }
function sessionRef(id) { return doc(db, 'sessions', idOf(id, 'Session id')); }
function gameRef(sessionId, gameId) {
  return doc(db, 'sessions', idOf(sessionId, 'Session id'), 'games', idOf(gameId, 'Game id'));
}
function playerRef(id) { return doc(db, 'players', idOf(id, 'Player id')); }
function directoryRef(id) { return doc(db, 'playerDirectory', idOf(id, 'Player id')); }
function entryRef(sessionId, id) {
  return doc(db, 'sessions', idOf(sessionId, 'Session id'), 'entries', idOf(id, 'Entry id'));
}
function claimRef(sessionId, playerId) {
  return doc(db, 'sessions', idOf(sessionId, 'Session id'), 'playerClaims', idOf(playerId, 'Player id'));
}
function lockRef(sessionId, playerId) {
  return doc(db, 'sessions', idOf(sessionId, 'Session id'), 'playerLocks', idOf(playerId, 'Player id'));
}

async function ensureOrganizer() {
  const user = await getCurrentUser();
  if (!user || user.isAnonymous) throw error('Organizer sign-in is required.', 'auth-required');
  const permit = await getDoc(doc(db, 'organizers', user.uid));
  if (!permit.exists() || permit.data().active !== true) {
    throw error('This account is not an approved organizer.', 'permission-denied');
  }
  return user;
}

function normalizedCourt(snapshot) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    name: data.name,
    allowedSkills: data.allowedSkills || [],
    division: data.division || 'open',
    format: data.format || 'doubles',
    activeGameId: data.activeGameId || null,
    activeSessionId: data.activeSessionId || null,
    createdAt: time(data.createdAt),
    updatedAt: time(data.updatedAt),
  };
}

function normalizedGame(snapshot) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    sessionId: data.sessionId,
    courtId: data.courtId,
    courtName: data.courtName,
    courtConfigSnapshot: data.courtConfigSnapshot,
    status: data.status,
    lineup: data.lineup,
    playerSnapshots: data.playerSnapshots || {},
    replacements: data.replacements || [],
    result: data.result || null,
    startedAt: time(data.startedAt),
    completedAt: time(data.completedAt),
    cancelledAt: time(data.cancelledAt),
  };
}

function sortedCourts(snapshots) {
  return snapshots.docs.map(normalizedCourt).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function sortedGames(snapshots) {
  return snapshots.docs.map(normalizedGame).sort((a, b) =>
    (b.startedAt || '').localeCompare(a.startedAt || ''));
}

/** Reusable physical courts; all access is organizer-only. */
export async function listCourts() {
  await ensureOrganizer();
  return { courts: sortedCourts(await getDocs(collection(db, 'courts'))) };
}

export async function watchCourts(callback) {
  await ensureOrganizer();
  return onSnapshot(collection(db, 'courts'),
    (snapshot) => callback({ courts: sortedCourts(snapshot) }),
    (cause) => callback({ error: cause }));
}

export async function saveCourt(settings) {
  await ensureOrganizer();
  const id = settings?.id ? idOf(settings.id, 'Court id') : doc(collection(db, 'courts')).id;
  const name = String(settings?.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 50) throw error('Court name must be 1 to 50 characters.');
  const config = {
    id,
    name,
    allowedSkills: Array.isArray(settings?.allowedSkills)
      ? settings.allowedSkills.map((skill) => skill === 'advance' ? 'advanced' : skill)
      : [],
    division: settings?.division || 'open',
    format: settings?.format || 'doubles',
  };
  const result = validateCourtConfig(config);
  if (!result.valid) throw error(result.errors.join(' '));

  const reference = courtRef(id);
  await runTransaction(db, async (transaction) => {
    const existing = await transaction.get(reference);
    if (existing.exists()) {
      transaction.update(reference, { ...config, updatedAt: serverTimestamp() });
    } else {
      transaction.set(reference, {
        ...config,
        activeGameId: null,
        activeSessionId: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  });
  return { court: normalizedCourt(await getDoc(reference)) };
}

export async function deleteCourt(courtId) {
  await ensureOrganizer();
  const reference = courtRef(courtId);
  await runTransaction(db, async (transaction) => {
    const court = await transaction.get(reference);
    if (!court.exists()) throw error('Court not found.', 'not-found');
    if (court.data().activeGameId) throw error('Finish or cancel this court\'s game first.');
    transaction.delete(reference);
  });
  return { deleted: true };
}

/** Current and historical games for a single day session. */
export async function listCourtGames(sessionId) {
  await ensureOrganizer();
  return { games: sortedGames(await getDocs(collection(db, 'sessions', idOf(sessionId, 'Session id'), 'games'))) };
}

export async function watchCourtGames(sessionId, callback) {
  await ensureOrganizer();
  return onSnapshot(collection(db, 'sessions', idOf(sessionId, 'Session id'), 'games'),
    (snapshot) => callback({ games: sortedGames(snapshot) }),
    (cause) => callback({ error: cause }));
}

function domainPlayer(entry) {
  return {
    id: entry.playerId,
    name: entry.name,
    skill: entry.skillLevel,
    gender: entry.division || 'unspecified',
    checkedIn: entry.status === 'confirmed' && entry.checkedIn === true,
    partnerId: entry.partnerPlayerId || null,
  };
}

function playerSnapshot(entry) {
  return {
    name: entry.name,
    skillLevel: entry.skillLevel,
    division: entry.division || 'unspecified',
  };
}

function idsOf(lineup) {
  if (!Array.isArray(lineup?.sideA) || !Array.isArray(lineup?.sideB)) {
    throw error('Choose both teams before starting.');
  }
  const ids = [...lineup.sideA, ...lineup.sideB];
  ids.forEach((id) => idOf(id, 'Player id'));
  if (new Set(ids).size !== ids.length) throw error('A player can appear only once in a game.');
  return ids;
}

function statsFromGames(entries, games, now = Date.now()) {
  const byId = new Map(entries.filter((entry) => entry.playerId).map((entry) => [entry.playerId, {
    ...domainPlayer(entry),
    gamesPlayed: 0,
    waitMinutes: Math.max(0, (now - millis(entry.checkedInAt)) / 60000),
    recentPartnerIds: [],
    recentOpponentIds: [],
    lastPlayedAt: 0,
  }]));
  const completed = games.filter((game) => game.status === 'completed' && game.lineup)
    .sort((a, b) => millis(b.completedAt) - millis(a.completedAt));
  for (const game of completed) {
    const a = game.lineup.sideA || [];
    const b = game.lineup.sideB || [];
    const ended = millis(game.completedAt);
    for (const [teammates, opponents] of [[a, b], [b, a]]) {
      for (const id of teammates) {
        const player = byId.get(id);
        if (!player) continue;
        player.gamesPlayed += 1;
        player.lastPlayedAt = Math.max(player.lastPlayedAt, ended);
        if (player.gamesPlayed <= 4) {
          player.recentPartnerIds.push(...teammates.filter((other) => other !== id));
          player.recentOpponentIds.push(...opponents);
        }
      }
    }
  }
  for (const player of byId.values()) {
    if (player.lastPlayedAt) player.waitMinutes = Math.max(0, (now - player.lastPlayedAt) / 60000);
    delete player.lastPlayedAt;
  }
  return [...byId.values()];
}

/** Suggest (and re-suggest) teams without writing a game. */
export async function proposeCourtLineup({ sessionId, courtId, random = Math.random }) {
  await ensureOrganizer();
  const [court, session, entries, games] = await Promise.all([
    getDoc(courtRef(courtId)),
    getDoc(sessionRef(sessionId)),
    getDocs(collection(db, 'sessions', idOf(sessionId, 'Session id'), 'entries')),
    getDocs(collection(db, 'sessions', sessionId, 'games')),
  ]);
  if (!court.exists()) throw error('Court not found.', 'not-found');
  if (!session.exists() || session.data().open !== true) throw error('This session is closed.');
  const roster = entries.docs.map((snapshot) => snapshot.data());
  const history = games.docs.map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }));
  const players = statsFromGames(roster, history);
  const pool = courtPoolSummary({ players, activeGames: history });
  const eligible = eligiblePlayersForCourt({
    court: { id: court.id, ...court.data() },
    players,
    activeGames: history,
  });
  const lineup = proposeLineup({
    court: { id: court.id, ...court.data() },
    players,
    activeGames: history,
    random,
  });
  const selected = lineup ? new Set(idsOf(lineup)) : new Set();
  const byId = new Map(players.map((player) => [player.id, player]));
  return {
    lineup,
    players: roster.filter((entry) => selected.has(entry.playerId)).map((entry) => ({
      id: entry.playerId,
      name: entry.name,
      skillLevel: entry.skillLevel,
      division: entry.division || 'unspecified',
      photoUrl: entry.photoData || null,
      gamesPlayed: byId.get(entry.playerId)?.gamesPlayed || 0,
    })),
    pool: {
      ...pool,
      eligible: eligible.length,
      needed: court.data().format === 'singles' ? 2 : 4,
    },
  };
}

async function readLineupEntries(transaction, sessionId, playerIds) {
  const claims = await Promise.all(playerIds.map((id) => transaction.get(claimRef(sessionId, id))));
  if (claims.some((claim) => !claim.exists())) throw error('A selected player no longer has a reservation.');
  const refs = claims.map((claim) => entryRef(sessionId, claim.data().entryId));
  const entries = await Promise.all(refs.map((reference) => transaction.get(reference)));
  if (entries.some((entry) => !entry.exists())) throw error('A selected reservation no longer exists.');
  for (let i = 0; i < playerIds.length; i += 1) {
    if (entries[i].data().playerId !== playerIds[i]) {
      throw error('A selected reservation has changed.');
    }
  }
  return entries;
}

/** Start only this court; the court and four player locks are claimed atomically. */
export async function startCourtGame({ sessionId, courtId, lineup }) {
  const user = await ensureOrganizer();
  const ids = idsOf(lineup);
  const reference = doc(collection(db, 'sessions', idOf(sessionId, 'Session id'), 'games'));
  await runTransaction(db, async (transaction) => {
    const [session, court] = await Promise.all([
      transaction.get(sessionRef(sessionId)), transaction.get(courtRef(courtId)),
    ]);
    if (!session.exists() || session.data().open !== true) throw error('This session is closed.');
    if (!court.exists()) throw error('Court not found.', 'not-found');
    if (court.data().activeGameId) throw error('This court already has an active game.');

    const entries = await readLineupEntries(transaction, sessionId, ids);
    const locks = await Promise.all(ids.map((id) => transaction.get(lockRef(sessionId, id))));
    if (locks.some((lock) => lock.exists())) {
      throw error('A selected player is already on an active court. Shuffle and try again.');
    }
    const data = entries.map((entry) => entry.data());
    const config = { id: court.id, ...court.data() };
    const check = validateLineup({ court: config, lineup, players: data.map(domainPlayer) });
    if (!check.valid) throw error(check.errors.join(' '));

    const playerSnapshots = Object.fromEntries(data.map((entry) => [entry.playerId, playerSnapshot(entry)]));
    transaction.set(reference, {
      sessionId,
      courtId,
      courtName: court.data().name,
      courtConfigSnapshot: {
        id: courtId,
        allowedSkills: court.data().allowedSkills,
        division: court.data().division || 'open',
        format: court.data().format || 'doubles',
      },
      status: 'active',
      lineup: { sideA: [...lineup.sideA], sideB: [...lineup.sideB] },
      playerSnapshots,
      replacements: [],
      result: null,
      startedAt: serverTimestamp(),
      completedAt: null,
      cancelledAt: null,
      startedByUid: user.uid,
    });
    transaction.update(courtRef(courtId), {
      activeGameId: reference.id,
      activeSessionId: sessionId,
      updatedAt: serverTimestamp(),
    });
    transaction.update(sessionRef(sessionId), {
      activeGameCount: (session.data().activeGameCount || 0) + 1,
      updatedAt: serverTimestamp(),
    });
    for (const id of ids) {
      transaction.set(lockRef(sessionId, id), {
        gameId: reference.id,
        courtId,
        sessionId,
        createdAt: serverTimestamp(),
      });
    }
  });
  return { game: normalizedGame(await getDoc(reference)) };
}

/**
 * Replace one active game's player with an eligible checked-in player who is
 * not on another court. Results count only the final lineup.
 */
export async function replaceCourtPlayer({ sessionId, gameId, outgoingPlayerId, incomingPlayerId }) {
  await ensureOrganizer();
  idOf(outgoingPlayerId, 'Outgoing player id');
  idOf(incomingPlayerId, 'Incoming player id');
  if (outgoingPlayerId === incomingPlayerId) throw error('Choose a different replacement player.');
  const reference = gameRef(sessionId, gameId);
  await runTransaction(db, async (transaction) => {
    const game = await transaction.get(reference);
    if (!game.exists() || game.data().status !== 'active') throw error('Active game not found.');
    const current = game.data();
    const oldIds = idsOf(current.lineup);
    if (!oldIds.includes(outgoingPlayerId)) throw error('Outgoing player is not in this game.');
    if (oldIds.includes(incomingPlayerId)) throw error('Replacement player is already in this game.');
    const nextLineup = {
      sideA: current.lineup.sideA.map((id) => id === outgoingPlayerId ? incomingPlayerId : id),
      sideB: current.lineup.sideB.map((id) => id === outgoingPlayerId ? incomingPlayerId : id),
    };
    const nextIds = idsOf(nextLineup);
    const [session, court, outgoingLock, incomingLock] = await Promise.all([
      transaction.get(sessionRef(sessionId)),
      transaction.get(courtRef(current.courtId)),
      transaction.get(lockRef(sessionId, outgoingPlayerId)),
      transaction.get(lockRef(sessionId, incomingPlayerId)),
    ]);
    if (!session.exists() || session.data().open !== true) throw error('This session is closed.');
    if (!court.exists() || court.data().activeGameId !== gameId ||
        court.data().activeSessionId !== sessionId) throw error('Court game has changed.');
    if (!outgoingLock.exists() || outgoingLock.data().gameId !== gameId) {
      throw error('Outgoing player lock has changed.');
    }
    if (incomingLock.exists()) throw error('Replacement player is already on an active court.');
    const entries = await readLineupEntries(transaction, sessionId, nextIds);
    const data = entries.map((entry) => entry.data());
    const check = validateLineup({
      court: current.courtConfigSnapshot,
      lineup: nextLineup,
      players: data.map(domainPlayer),
    });
    if (!check.valid) throw error(check.errors.join(' '));
    const replacement = data.find((entry) => entry.playerId === incomingPlayerId);
    const playerSnapshots = {
      ...current.playerSnapshots,
      [incomingPlayerId]: playerSnapshot(replacement),
    };
    transaction.update(reference, {
      lineup: nextLineup,
      playerSnapshots,
      replacements: [
        ...(current.replacements || []),
        { outgoingPlayerId, incomingPlayerId, replacedAt: new Date().toISOString() },
      ],
    });
    transaction.delete(lockRef(sessionId, outgoingPlayerId));
    transaction.set(lockRef(sessionId, incomingPlayerId), {
      gameId,
      courtId: current.courtId,
      sessionId,
      createdAt: serverTimestamp(),
    });
  });
  return { game: normalizedGame(await getDoc(reference)) };
}

/** Award final-lineup W/L counters and free the court in one transaction. */
export async function completeCourtGame({ sessionId, gameId, winnerSide }) {
  await ensureOrganizer();
  const reference = gameRef(sessionId, gameId);
  const result = await runTransaction(db, async (transaction) => {
    const game = await transaction.get(reference);
    if (!game.exists()) throw error('Game not found.', 'not-found');
    const recorded = recordGameResult({
      game: { id: game.id, ...game.data() }, winnerSide,
    });
    if (!recorded.applied) return { applied: false, statDeltas: {} };

    const data = game.data();
    const ids = idsOf(data.lineup);
    const [session, court, ...locks] = await Promise.all([
      transaction.get(sessionRef(sessionId)),
      transaction.get(courtRef(data.courtId)),
      ...ids.map((id) => transaction.get(lockRef(sessionId, id))),
    ]);
    if (!session.exists() || !session.data().open) throw error('This session is closed.');
    if (!court.exists() || court.data().activeGameId !== gameId ||
        court.data().activeSessionId !== sessionId) {
      throw error('Court game has changed. Refresh before recording the result.');
    }
    if (locks.some((lock) => !lock.exists() || lock.data().gameId !== gameId)) {
      throw error('Player assignment changed. Refresh before recording the result.');
    }
    const entries = await readLineupEntries(transaction, sessionId, ids);
    const players = await Promise.all(ids.map((id) => transaction.get(playerRef(id))));
    if (players.some((player) => !player.exists())) throw error('A player record is missing.');

    transaction.update(reference, {
      status: 'completed',
      result: { winnerSide },
      completedAt: serverTimestamp(),
    });
    transaction.update(courtRef(data.courtId), {
      activeGameId: null,
      activeSessionId: null,
      updatedAt: serverTimestamp(),
    });
    transaction.update(sessionRef(sessionId), {
      activeGameCount: Math.max(0, (session.data().activeGameCount || 0) - 1),
      updatedAt: serverTimestamp(),
    });
    for (let i = 0; i < ids.length; i += 1) {
      const delta = recorded.statDeltas[ids[i]];
      const player = players[i].data();
      const entry = entries[i].data();
      const wins = (player.wins || 0) + delta.wins;
      const losses = (player.losses || 0) + delta.losses;
      transaction.update(playerRef(ids[i]), {
        wins, losses, updatedAt: serverTimestamp(),
      });
      transaction.set(directoryRef(ids[i]), {
        name: player.name,
        nameLower: player.nameLower || String(player.name || '').toLocaleLowerCase(),
        skillLevel: player.skillLevel,
        division: player.division || 'unspecified',
        photoData: player.photoData || null,
        wins,
        losses,
      }, { merge: true });
      transaction.update(entries[i].ref, {
        wins: (entry.wins || 0) + delta.wins,
        losses: (entry.losses || 0) + delta.losses,
        updatedAt: serverTimestamp(),
      });
      transaction.delete(lockRef(sessionId, ids[i]));
    }
    return { applied: true, statDeltas: recorded.statDeltas };
  });
  return { game: normalizedGame(await getDoc(reference)), ...result };
}

/** Cancel a stuck or unwanted game without giving either side a result. */
export async function cancelCourtGame({ sessionId, gameId }) {
  await ensureOrganizer();
  const reference = gameRef(sessionId, gameId);
  const cancelled = await runTransaction(db, async (transaction) => {
    const game = await transaction.get(reference);
    if (!game.exists()) throw error('Game not found.', 'not-found');
    if (game.data().status === 'cancelled') return false;
    if (game.data().status !== 'active') throw error('A completed game cannot be cancelled.');
    const data = game.data();
    const ids = idsOf(data.lineup);
    const [session, court, ...locks] = await Promise.all([
      transaction.get(sessionRef(sessionId)),
      transaction.get(courtRef(data.courtId)),
      ...ids.map((id) => transaction.get(lockRef(sessionId, id))),
    ]);
    if (!session.exists() || !session.data().open) throw error('This session is closed.');
    if (!court.exists() || court.data().activeGameId !== gameId ||
        court.data().activeSessionId !== sessionId) throw error('Court game has changed.');
    if (locks.some((lock) => !lock.exists() || lock.data().gameId !== gameId)) {
      throw error('Player assignment changed.');
    }
    transaction.update(reference, { status: 'cancelled', cancelledAt: serverTimestamp() });
    transaction.update(courtRef(data.courtId), {
      activeGameId: null, activeSessionId: null, updatedAt: serverTimestamp(),
    });
    transaction.update(sessionRef(sessionId), {
      activeGameCount: Math.max(0, (session.data().activeGameCount || 0) - 1),
      updatedAt: serverTimestamp(),
    });
    for (const id of ids) transaction.delete(lockRef(sessionId, id));
    return true;
  });
  return { game: normalizedGame(await getDoc(reference)), cancelled };
}
