import {
  collection, doc, getDoc, getDocFromServer, getDocs, getDocsFromServer,
  onSnapshot, runTransaction, serverTimestamp, setDoc, Timestamp, writeBatch,
} from 'firebase/firestore';
import { initializeClient, getCurrentUser, ensurePublicAuth, sessionClosesAt } from './firebaseStore.js';
import { validateLineup } from './domain/courts.js';
import {
  generateSingleElimination, generateRoundRobin, generateRotatingDoubles,
  rankStandings, rankRotatingDoubles, selectRotatingDoublesFinal,
} from './domain/tournaments.js';

const { db } = initializeClient();
const SKILLS = new Set(['beginner', 'intermediate', 'advanced']);
const DIVISIONS = new Set(['woman', 'man', 'unspecified']);
const LIVE_REGISTRATIONS = new Set(['confirmed', 'waitlisted']);

function fail(message, code = 'invalid-argument') {
  const result = new Error(message);
  result.code = code;
  return result;
}
function id(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('/')) throw fail('Invalid event id.');
  return value;
}
function eventRef(eventId) { return doc(db, 'events', id(eventId)); }
function publicEventRef(eventId) { return doc(db, 'publicEvents', id(eventId)); }
function sessionRef(eventId) { return doc(db, 'sessions', id(eventId)); }
function registrationRef(eventId, registrationId) { return doc(db, 'events', id(eventId), 'registrations', id(registrationId)); }
function publicRegistrationRef(eventId, registrationId) { return doc(db, 'events', id(eventId), 'publicRegistrations', id(registrationId)); }
function matchRef(eventId, matchId) { return doc(db, 'events', id(eventId), 'matches', id(matchId)); }
function publicMatchRef(eventId, matchId) { return doc(db, 'events', id(eventId), 'publicMatches', id(matchId)); }
function teamRef(eventId, teamId) { return doc(db, 'events', id(eventId), 'teams', id(teamId)); }
function teamClaimRef(eventId, playerId) { return doc(db, 'events', id(eventId), 'teamClaims', id(playerId)); }
function entryRef(eventId, entryId) { return doc(db, 'sessions', id(eventId), 'entries', id(entryId)); }
function claimRef(eventId, playerId) { return doc(db, 'sessions', id(eventId), 'playerClaims', id(playerId)); }
function lockRef(eventId, playerId) { return doc(db, 'sessions', id(eventId), 'playerLocks', id(playerId)); }
function gameRef(eventId, gameId) { return doc(db, 'sessions', id(eventId), 'games', id(gameId)); }
function courtRef(courtId) { return doc(db, 'courts', id(courtId)); }
function playerRef(playerId) { return doc(db, 'players', id(playerId)); }
function directoryRef(playerId) { return doc(db, 'playerDirectory', id(playerId)); }
function auditRef(eventId) { return doc(collection(db, 'events', id(eventId), 'audit')); }
function stamp(value) { return typeof value?.toDate === 'function' ? value.toDate().toISOString() : value || null; }
function millis(value) { return typeof value?.toMillis === 'function' ? value.toMillis() : 0; }
function sorted(snapshots) { return snapshots.docs.sort((a, b) => millis(a.data().createdAt) - millis(b.data().createdAt)); }
function materializeMatch(data) {
  if (!Array.isArray(data.sideAPlayerIds) || !Array.isArray(data.sideBPlayerIds)) return data;
  return {
    ...data,
    sidePlayerIds: [[...data.sideAPlayerIds], [...data.sideBPlayerIds]],
    sides: data.sideIds ? [[...data.sideIds.A], [...data.sideIds.B]] : data.sides,
  };
}
function normalized(snapshot) {
  if (!snapshot.exists()) return null;
  const data = materializeMatch(snapshot.data());
  return { id: snapshot.id, ...data, createdAt: stamp(data.createdAt), updatedAt: stamp(data.updatedAt) };
}
function text(value, min, max, label) {
  const result = String(value || '').trim().replace(/\s+/g, ' ');
  if (result.length < min || result.length > max) throw fail(`${label} must be ${min} to ${max} characters.`);
  return result;
}
function name(value) { return text(value, 2, 60, 'Player name'); }
function skill(value) { if (!SKILLS.has(value)) throw fail('Choose a valid skill level.'); return value; }
function division(value) { if (!DIVISIONS.has(value || 'unspecified')) throw fail('Choose a valid division.'); return value || 'unspecified'; }
function photo(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 120000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value)) throw fail('Use a small JPEG photo.');
  return value;
}
function prefixes(value) {
  const lower = value.toLocaleLowerCase().trim().replace(/\s+/g, ' ');
  const result = new Set();
  for (const part of [lower, lower.split(' ').at(-1)]) for (let n = 2; n <= part.length; n += 1) result.add(part.slice(0, n));
  return [...result];
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw fail('Choose a valid event date.');
  return value;
}
async function organizer() {
  const user = await getCurrentUser();
  if (!user || user.isAnonymous) throw fail('Organizer sign-in is required.', 'auth-required');
  const permit = await getDocFromServer(doc(db, 'organizers', user.uid));
  if (!permit.exists() || permit.data().active !== true) throw fail('This account is not an approved organizer.', 'permission-denied');
  return user;
}
function config(input) {
  const kind = input.kind === 'tournament' ? 'tournament' : 'open_play';
  const discipline = input.discipline === 'singles' ? 'singles' : 'doubles';
  const teamMode = discipline === 'singles' ? 'fixed' : ['fixed', 'draw_once', 'rotating'].includes(input.teamMode) ? input.teamMode : 'fixed';
  const format = kind === 'tournament' ? input.format : null;
  if (kind === 'tournament' && !['single_elimination', 'round_robin'].includes(format)) throw fail('Choose a tournament format.');
  if (format === 'single_elimination' && teamMode === 'rotating') throw fail('Rotating partners require round robin.');
  const roundRobinMode = format === 'round_robin' ? input.roundRobinMode || 'pools' : null;
  if (roundRobinMode && !['full', 'pools'].includes(roundRobinMode)) throw fail('Choose a round robin mode.');
  const capacity = Number(input.capacity || 32);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 512) throw fail('Capacity must be 1 to 512 players.');
  const scoreTarget = Number(input.scoreTarget || 11);
  if (![11, 15, 21].includes(scoreTarget)) throw fail('Score target must be 11, 15, or 21.');
  const bestOf = Number(input.bestOf || 1);
  if (![1, 3].includes(bestOf)) throw fail('Choose best of 1 or best of 3.');
  const rounds = Number(input.rounds || 3);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 32) throw fail('Rounds must be 1 to 32.');
  const poolSize = Number(input.poolSize || 4);
  if (!Number.isInteger(poolSize) || poolSize < 4 || poolSize > 8) throw fail('Pool size must be 4 to 8.');
  const eventDate = date(input.date);
  const startTime = String(input.startTime || '09:00');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) throw fail('Choose a valid start time.');
  return {
    title: text(input.title, 3, 80, 'Event title'), date: eventDate, startTime,
    kind, discipline, teamMode, format, roundRobinMode, capacity,
    scoreTarget, bestOf, rounds, poolSize,
    prize: String(input.prize || '').trim().slice(0, 200),
  };
}
function publicEvent(value, eventId) {
  return {
    id: eventId, title: value.title, date: value.date, startTime: value.startTime,
    kind: value.kind, discipline: value.discipline, teamMode: value.teamMode,
    format: value.format, roundRobinMode: value.roundRobinMode,
    capacity: value.capacity, approvedCount: value.approvedCount || 0,
    waitlistCount: value.waitlistCount || 0,
    open: value.registrationOpen === true && Date.now() < (value.closesAt?.toMillis?.() || Date.parse(value.closesAt || '')),
    scoreTarget: value.scoreTarget, bestOf: value.bestOf,
    champions: value.champions || [], prize: value.prize || '',
    status: value.status, round: value.round || 0,
    phase: value.phase || null, roundCount: value.roundCount || 0,
    rounds: value.rounds || 3, poolSize: value.poolSize || 4,
    drawEntrants: value.drawEntrants || [],
    signupUrl: typeof location === 'undefined' ? `/event?token=${eventId}` : `${location.origin}/event?token=${eventId}`,
  };
}

export async function createEvent(input) {
  const user = await organizer();
  const settings = config(input);
  const reference = doc(collection(db, 'events'));
  const closesAt = Timestamp.fromDate(sessionClosesAt(settings.date));
  await runTransaction(db, async (transaction) => {
    const eventData = {
      ...settings, closesAt, status: 'registration', registrationOpen: true,
      published: true, approvedCount: 0, waitlistCount: 0,
      round: 0, champions: [], createdByUid: user.uid,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    };
    transaction.set(reference, eventData);
    transaction.set(publicEventRef(reference.id), {
      ...publicEvent(eventData, reference.id), registrationOpen: true,
      closesAt, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    transaction.set(sessionRef(reference.id), {
      date: settings.date, closesAt, cycle: 1, capacity: settings.capacity,
      confirmedCount: 0, checkedInCount: 0, waitlistCount: 0,
      activeGameCount: 0, open: true, kind: 'event', eventId: reference.id,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), archivedAt: null,
    });
  });
  return { event: publicEvent((await getDoc(reference)).data(), reference.id) };
}

export async function listEvents() {
  await organizer();
  const snapshots = await getDocs(collection(db, 'events'));
  return { events: snapshots.docs.map((item) => publicEvent(item.data(), item.id))
    .sort((a, b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime)) };
}

export async function getPublicEvent(eventId) {
  await ensurePublicAuth();
  const snapshot = await getDocFromServer(publicEventRef(eventId));
  if (!snapshot.exists()) throw fail('This event link is unavailable.', 'not-found');
  const [registrations, matches] = await Promise.all([
    getDocsFromServer(collection(db, 'events', eventId, 'publicRegistrations')),
    getDocsFromServer(collection(db, 'events', eventId, 'publicMatches')),
  ]);
  const publicRegistrations = sorted(registrations).map(normalized);
  const publicMatches = matches.docs.map(normalized).sort((a, b) => (a.round || 0) - (b.round || 0) || (a.slot || 0) - (b.slot || 0));
  const event = publicEvent(snapshot.data(), eventId);
  return { event, registrations: publicRegistrations,
    matches: publicMatches, standings: standings(event, publicRegistrations, publicMatches) };
}

export async function getAdminEvent(eventId) {
  await organizer();
  const snapshot = await getDocFromServer(eventRef(eventId));
  if (!snapshot.exists()) throw fail('Event not found.', 'not-found');
  const [registrations, matches, teams, entries, audit] = await Promise.all([
    getDocs(collection(db, 'events', eventId, 'registrations')),
    getDocs(collection(db, 'events', eventId, 'matches')),
    getDocs(collection(db, 'events', eventId, 'teams')),
    getDocs(collection(db, 'sessions', eventId, 'entries')),
    getDocs(collection(db, 'events', eventId, 'audit')),
  ]);
  const regs = sorted(registrations).map(normalized);
  const games = matches.docs.map(normalized).sort((a, b) => (a.round || 0) - (b.round || 0) || (a.slot || 0) - (b.slot || 0));
  const event = publicEvent(snapshot.data(), eventId);
  return { event, registrations: regs,
    matches: games, teams: teams.docs.map(normalized), entries: entries.docs.map(normalized),
    standings: standings(event, regs, games), audit: audit.docs.map(normalized).sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0)) };
}

function standings(event, registrations, matches) {
  if (event.kind === 'tournament' && event.drawEntrants.length) {
    const ranked = event.teamMode === 'rotating'
      ? rankRotatingDoubles(event.drawEntrants, matches.filter((match) => match.stage === 'rotating_doubles'))
      : rankStandings(event.drawEntrants, matches.filter((match) =>
        ['round_robin', 'knockout'].includes(match.stage)));
    const names = new Map(event.drawEntrants.map((entrant) => [entrant.id, entrant.name]));
    return ranked.map((row) => ({ id: row.id, name: names.get(row.id) || 'Entrant',
      playerIds: event.drawEntrants.find((entrant) => entrant.id === row.id)?.playerIds || [],
      wins: row.wins, losses: row.losses, pointDiff: row.pointDifference,
      pointsFor: row.pointsFor, rank: row.rank }));
  }
  const byPlayer = new Map();
  for (const registration of registrations) {
    if (!LIVE_REGISTRATIONS.has(registration.status)) continue;
    for (const player of registration.players || []) {
      const playerId = player.playerId || player.id;
      if (!playerId) continue;
      byPlayer.set(playerId, { id: playerId, name: player.name, playerIds: [playerId], wins: 0, losses: 0, pointDiff: 0, pointsFor: 0 });
    }
  }
  for (const match of matches) {
    if (match.status !== 'completed' || !match.winnerSide) continue;
    const totals = (match.score?.games || []).reduce((acc, game) => [acc[0] + Number(game.a || 0), acc[1] + Number(game.b || 0)], [0, 0]);
    for (let side = 0; side < 2; side += 1) for (const playerId of match.sidePlayerIds?.[side] || []) {
      const row = byPlayer.get(playerId);
      if (!row) continue;
      if (match.winnerSide === (side === 0 ? 'A' : 'B')) row.wins += 1;
      else row.losses += 1;
      row.pointsFor += totals[side];
      row.pointDiff += totals[side] - totals[1 - side];
    }
  }
  return [...byPlayer.values()].sort((a, b) => b.wins - a.wins || b.pointDiff - a.pointDiff || b.pointsFor - a.pointsFor || a.name.localeCompare(b.name))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export async function submitEventSignup({ eventId, players, teamName = '' }) {
  const user = await ensurePublicAuth();
  if (!user.isAnonymous) throw fail('Open the event link in a private player browser.', 'auth-required');
  if (!Array.isArray(players) || players.length < 1 || players.length > 2) throw fail('Choose one or two players.');
  const event = await getDocFromServer(publicEventRef(eventId));
  if (!event.exists() || event.data().registrationOpen !== true ||
      Date.now() >= event.data().closesAt.toMillis()) throw fail('Event signup is closed.');
  const settings = event.data();
  if (settings.discipline === 'singles' && players.length !== 1) throw fail('Singles signup takes one player.');
  if (settings.teamMode !== 'fixed' && players.length !== 1) throw fail('This event uses individual signup.');
  const selected = [];
  for (const input of players) {
    if (input.playerId) {
      const player = await getDocFromServer(directoryRef(input.playerId));
      if (!player.exists() || player.data().active !== true) throw fail('Select an approved player.');
      selected.push({ playerId: player.id, name: player.data().name,
        skillLevel: player.data().skillLevel, division: player.data().division,
        photoData: player.data().photoData || null });
    } else {
      selected.push({ playerId: null, name: name(input.name), skillLevel: skill(input.skillLevel),
        division: division(input.division), photoData: photo(input.photoData) });
    }
  }
  const ids = selected.map((item) => item.playerId).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw fail('Select two different players.');
  const reference = registrationRef(eventId, user.uid);
  await setDoc(reference, {
    ownerUid: user.uid, eventId, players: selected,
    teamName: String(teamName || '').trim().slice(0, 60),
    status: 'pending', checkedIn: false, source: 'public',
    playerIds: [], entryIds: [], createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(), reviewedAt: null,
  });
  return { registration: { id: reference.id, status: 'pending' } };
}

export async function watchMyEventSignup(eventId, callback) {
  const user = await ensurePublicAuth();
  return onSnapshot(registrationRef(eventId, user.uid),
    (snapshot) => callback(normalized(snapshot)), callback);
}

export async function approveEventSignup(eventId, registrationId) {
  const user = await organizer();
  const reference = registrationRef(eventId, registrationId);
  const pending = await getDocFromServer(reference);
  if (!pending.exists() || pending.data().status !== 'pending') throw fail('This request is no longer pending.');
  const requested = pending.data().players;
  const pRefs = requested.map((item) => item.playerId ? playerRef(item.playerId) : doc(collection(db, 'players')));
  const eRefs = requested.map(() => doc(collection(db, 'sessions', eventId, 'entries')));
  const result = await runTransaction(db, async (transaction) => {
    const [event, session, registration, ...players] = await Promise.all([
      transaction.get(eventRef(eventId)), transaction.get(sessionRef(eventId)), transaction.get(reference),
      ...pRefs.map((item) => transaction.get(item)),
    ]);
    if (!event.exists() || event.data().registrationOpen !== true || !session.exists() || !session.data().open) throw fail('Event signup is closed.');
    if (!registration.exists() || registration.data().status !== 'pending') throw fail('This request changed.');
    if (requested.length === 2 &&
        (event.data().discipline !== 'doubles' || event.data().teamMode !== 'fixed')) throw fail('This event uses individual signup.');
    if (JSON.stringify(registration.data().players) !== JSON.stringify(requested)) throw fail('This request changed.');
    const requestedPlayerIds = requested.map((item) => item.playerId).filter(Boolean);
    if (new Set(requestedPlayerIds).size !== requestedPlayerIds.length) throw fail('Select two different players.');
    const claimDocs = await Promise.all(pRefs.map((item) => transaction.get(claimRef(eventId, item.id))));
    if (claimDocs.some((item) => item.exists())) throw fail('A player is already registered in this event.');
    const teamClaims = requested.length === 2 ? await Promise.all(pRefs.map((item) => transaction.get(teamClaimRef(eventId, item.id)))) : [];
    if (teamClaims.some((item) => item.exists())) throw fail('A player is already on a team.');
    if (players.some((item, index) => requested[index].playerId && (!item.exists() || item.data().active !== true))) throw fail('An existing player is unavailable.');
    const available = session.data().capacity - session.data().confirmedCount;
    const confirmed = available >= requested.length;
    const status = confirmed ? 'confirmed' : 'waitlisted';
    const approvedPlayers = requested.map((item, index) => {
      const profile = players[index].exists() ? players[index].data() : item;
      return { playerId: pRefs[index].id, name: profile.name, skillLevel: profile.skillLevel,
        division: profile.division || 'unspecified', photoData: profile.photoData || null };
    });
    for (let index = 0; index < requested.length; index += 1) {
      const item = requested[index];
      const pRef = pRefs[index];
      if (!item.playerId) {
        const profile = { name: item.name, nameLower: item.name.toLocaleLowerCase(),
          searchPrefixes: prefixes(item.name), skillLevel: item.skillLevel,
          division: item.division, photoData: item.photoData,
          active: true, wins: 0, losses: 0,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
        transaction.set(pRef, profile);
        transaction.set(directoryRef(pRef.id), {
          name: profile.name, nameLower: profile.nameLower, searchPrefixes: profile.searchPrefixes,
          skillLevel: profile.skillLevel, division: profile.division,
          photoData: profile.photoData, active: true,
        });
      }
      transaction.set(eRefs[index], {
        sessionId: eventId, registrationId, ownerUid: registration.data().ownerUid,
        playerId: pRef.id, name: approvedPlayers[index].name,
        skillLevel: approvedPlayers[index].skillLevel,
        division: approvedPlayers[index].division, photoData: approvedPlayers[index].photoData,
        status, checkedIn: false, source: 'event', wins: 0, losses: 0, recentMatches: [],
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        approvedAt: serverTimestamp(), reviewedAt: serverTimestamp(),
        checkedInAt: null, checkedOutAt: null,
      });
      transaction.set(claimRef(eventId, pRef.id), { entryId: eRefs[index].id, createdAt: serverTimestamp() });
    }
    transaction.update(reference, {
      status, players: approvedPlayers, playerIds: pRefs.map((item) => item.id),
      entryIds: eRefs.map((item) => item.id), reviewedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    transaction.set(publicRegistrationRef(eventId, registrationId), {
      status, players: approvedPlayers, teamName: registration.data().teamName || '',
      createdAt: registration.data().createdAt, updatedAt: serverTimestamp(),
    });
    if (requested.length === 2 && event.data().discipline === 'doubles' && event.data().teamMode === 'fixed') {
      const team = teamRef(eventId, registrationId);
      transaction.set(team, {
        name: registration.data().teamName || approvedPlayers.map((player) => player.name).join(' + '),
        playerIds: pRefs.map((item) => item.id), createdAt: serverTimestamp(),
        createdByUid: user.uid,
      });
      for (const pRef of pRefs) transaction.set(teamClaimRef(eventId, pRef.id), { teamId: registrationId });
    }
    const confirmedCount = session.data().confirmedCount + (confirmed ? requested.length : 0);
    const waitlistCount = (session.data().waitlistCount || 0) + (confirmed ? 0 : requested.length);
    transaction.update(sessionRef(eventId), { confirmedCount, waitlistCount, updatedAt: serverTimestamp() });
    transaction.update(eventRef(eventId), { approvedCount: confirmedCount, waitlistCount, updatedAt: serverTimestamp() });
    transaction.update(publicEventRef(eventId), { approvedCount: confirmedCount, waitlistCount, updatedAt: serverTimestamp() });
    transaction.set(auditRef(eventId), { action: 'approve_registration', registrationId, status, byUid: user.uid, at: serverTimestamp() });
    return { status, playerIds: pRefs.map((item) => item.id) };
  });
  return result;
}

export async function rejectEventSignup(eventId, registrationId) {
  const user = await organizer();
  await runTransaction(db, async (transaction) => {
    const reference = registrationRef(eventId, registrationId);
    const registration = await transaction.get(reference);
    if (!registration.exists() || registration.data().status !== 'pending') throw fail('This request is no longer pending.');
    transaction.update(reference, { status: 'rejected', reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    transaction.set(auditRef(eventId), { action: 'reject_registration', registrationId, byUid: user.uid, at: serverTimestamp() });
  });
  return { status: 'rejected' };
}

export async function checkInEventSignup(eventId, registrationId, checkedIn = true) {
  const user = await organizer();
  await runTransaction(db, async (transaction) => {
    const reference = registrationRef(eventId, registrationId);
    const [registration, session] = await Promise.all([transaction.get(reference), transaction.get(sessionRef(eventId))]);
    if (!registration.exists() || registration.data().status !== 'confirmed') throw fail('Only confirmed players can check in.');
    if (!session.exists() || !session.data().open) throw fail('This event is closed.');
    if (registration.data().checkedIn === checkedIn) return;
    const eRefs = registration.data().entryIds.map((entryId) => entryRef(eventId, entryId));
    const entries = await Promise.all(eRefs.map((item) => transaction.get(item)));
    if (entries.some((item) => !item.exists() || item.data().status !== 'confirmed')) throw fail('Roster changed. Refresh and retry.');
    if (!checkedIn) {
      const locks = await Promise.all(registration.data().playerIds.map((playerId) => transaction.get(lockRef(eventId, playerId))));
      if (locks.some((lock) => lock.exists())) throw fail('Finish this player’s active match first.');
    }
    for (const entry of entries) transaction.update(entry.ref, {
      checkedIn, checkedInAt: checkedIn ? serverTimestamp() : null,
      checkedOutAt: checkedIn ? null : serverTimestamp(), updatedAt: serverTimestamp(),
    });
    transaction.update(reference, { checkedIn, updatedAt: serverTimestamp() });
    transaction.update(sessionRef(eventId), { checkedInCount: Math.max(0, (session.data().checkedInCount || 0) + (checkedIn ? 1 : -1) * entries.length), updatedAt: serverTimestamp() });
    transaction.set(auditRef(eventId), { action: checkedIn ? 'check_in' : 'check_out', registrationId, byUid: user.uid, at: serverTimestamp() });
  });
  return { checkedIn };
}

export async function addEventPlayers(eventId, players, teamName = '') {
  const user = await organizer();
  if (!Array.isArray(players) || players.length < 1 || players.length > 2) throw fail('Choose one or two players.');
  const event = await getDocFromServer(eventRef(eventId));
  if (!event.exists() || !event.data().registrationOpen) throw fail('Event signup is closed.');
  if ((event.data().discipline === 'singles' || event.data().teamMode !== 'fixed') && players.length !== 1) {
    throw fail('This event uses individual signup.');
  }
  const selected = [];
  for (const input of players) {
    if (input.playerId) {
      const player = await getDocFromServer(playerRef(input.playerId));
      if (!player.exists() || player.data().active !== true) throw fail('Player not found.');
      selected.push({ playerId: player.id, name: player.data().name,
        skillLevel: player.data().skillLevel, division: player.data().division || 'unspecified',
        photoData: player.data().photoData || null });
    } else {
      selected.push({ playerId: null, name: name(input.name), skillLevel: skill(input.skillLevel),
        division: division(input.division), photoData: photo(input.photoData) });
    }
  }
  const reference = doc(collection(db, 'events', eventId, 'registrations'));
  await setDoc(reference, {
    ownerUid: null, eventId, players: selected,
    teamName: String(teamName || '').trim().slice(0, 60),
    status: 'pending', checkedIn: false, source: 'organizer',
    playerIds: [], entryIds: [], createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(), reviewedAt: null, createdByUid: user.uid,
  });
  const result = await approveEventSignup(eventId, reference.id);
  return { registrationId: reference.id, ...result };
}

async function promoteEventWaitlist(eventId) {
  const snapshots = await getDocsFromServer(collection(db, 'events', eventId, 'registrations'));
  const waiting = sorted(snapshots).filter((item) => item.data().status === 'waitlisted');
  let promoted = 0;
  for (const item of waiting) {
    const result = await runTransaction(db, async (transaction) => {
      const rRef = registrationRef(eventId, item.id);
      const [event, session, registration] = await Promise.all([
        transaction.get(eventRef(eventId)), transaction.get(sessionRef(eventId)), transaction.get(rRef),
      ]);
      if (!event.exists() || !session.exists() || !registration.exists() ||
          registration.data().status !== 'waitlisted' || event.data().status !== 'registration') return false;
      const count = registration.data().playerIds.length;
      if (session.data().capacity - session.data().confirmedCount < count) return false;
      const entries = await Promise.all(registration.data().entryIds.map((entryId) => transaction.get(entryRef(eventId, entryId))));
      if (entries.some((entry) => !entry.exists() || entry.data().status !== 'waitlisted')) throw fail('Waitlist changed. Refresh.');
      for (const entry of entries) transaction.update(entry.ref, { status: 'confirmed', updatedAt: serverTimestamp() });
      transaction.update(rRef, { status: 'confirmed', updatedAt: serverTimestamp() });
      transaction.update(publicRegistrationRef(eventId, item.id), { status: 'confirmed', updatedAt: serverTimestamp() });
      const confirmedCount = session.data().confirmedCount + count;
      const waitlistCount = Math.max(0, (session.data().waitlistCount || 0) - count);
      transaction.update(sessionRef(eventId), { confirmedCount, waitlistCount, updatedAt: serverTimestamp() });
      transaction.update(eventRef(eventId), { approvedCount: confirmedCount, waitlistCount, updatedAt: serverTimestamp() });
      transaction.update(publicEventRef(eventId), { approvedCount: confirmedCount, waitlistCount, updatedAt: serverTimestamp() });
      return true;
    });
    if (!result) break; // An older two-person team retains priority over later singles.
    promoted += 1;
  }
  return { promoted };
}

export async function removeEventSignup(eventId, registrationId) {
  const user = await organizer();
  await runTransaction(db, async (transaction) => {
    const rRef = registrationRef(eventId, registrationId);
    const [event, session, registration] = await Promise.all([
      transaction.get(eventRef(eventId)), transaction.get(sessionRef(eventId)), transaction.get(rRef),
    ]);
    if (!event.exists() || event.data().status !== 'registration') throw fail('The draw has started. This roster is locked.');
    if (!session.exists() || !registration.exists() || !LIVE_REGISTRATIONS.has(registration.data().status)) throw fail('Registration not found.');
    const data = registration.data();
    const entries = await Promise.all(data.entryIds.map((entryId) => transaction.get(entryRef(eventId, entryId))));
    const locks = await Promise.all(data.playerIds.map((playerId) => transaction.get(lockRef(eventId, playerId))));
    if (locks.some((lock) => lock.exists())) throw fail('Finish this player’s court match first.');
    const teamClaims = await Promise.all(data.playerIds.map((playerId) => transaction.get(teamClaimRef(eventId, playerId))));
    const teamIds = [...new Set(teamClaims.filter((claim) => claim.exists()).map((claim) => claim.data().teamId))];
    const teams = await Promise.all(teamIds.map((teamId) => transaction.get(teamRef(eventId, teamId))));
    for (const entry of entries) transaction.update(entry.ref, { status: 'removed', checkedIn: false, updatedAt: serverTimestamp() });
    for (const playerId of data.playerIds) transaction.delete(claimRef(eventId, playerId));
    for (const team of teams) if (team.exists()) {
      transaction.delete(team.ref);
      for (const playerId of team.data().playerIds || []) transaction.delete(teamClaimRef(eventId, playerId));
    }
    transaction.update(rRef, { status: 'removed', checkedIn: false, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    transaction.delete(publicRegistrationRef(eventId, registrationId));
    const count = data.playerIds.length;
    const wasConfirmed = data.status === 'confirmed';
    const confirmedCount = session.data().confirmedCount - (wasConfirmed ? count : 0);
    const waitlistCount = (session.data().waitlistCount || 0) - (wasConfirmed ? 0 : count);
    transaction.update(sessionRef(eventId), {
      confirmedCount, waitlistCount,
      checkedInCount: Math.max(0, (session.data().checkedInCount || 0) - (data.checkedIn ? count : 0)),
      updatedAt: serverTimestamp(),
    });
    transaction.update(eventRef(eventId), { approvedCount: confirmedCount, waitlistCount, updatedAt: serverTimestamp() });
    transaction.update(publicEventRef(eventId), { approvedCount: confirmedCount, waitlistCount, updatedAt: serverTimestamp() });
    transaction.set(auditRef(eventId), { action: 'remove_registration', registrationId, byUid: user.uid, at: serverTimestamp() });
  });
  return promoteEventWaitlist(eventId);
}

export async function saveEventTeam(eventId, { playerIds, name: teamName = '' }) {
  const user = await organizer();
  if (!Array.isArray(playerIds) || playerIds.length !== 2 || playerIds[0] === playerIds[1]) throw fail('Choose two different players.');
  playerIds.forEach(id);
  const reference = doc(collection(db, 'events', eventId, 'teams'));
  await runTransaction(db, async (transaction) => {
    const event = await transaction.get(eventRef(eventId));
    if (!event.exists() || event.data().kind !== 'tournament' || event.data().discipline !== 'doubles' ||
        event.data().status !== 'registration') throw fail('Teams can be set before the tournament starts.');
    const claims = await Promise.all(playerIds.map((playerId) => transaction.get(claimRef(eventId, playerId))));
    const teamClaims = await Promise.all(playerIds.map((playerId) => transaction.get(teamClaimRef(eventId, playerId))));
    if (claims.some((claim) => !claim.exists()) || teamClaims.some((claim) => claim.exists())) throw fail('Player is missing or already on a team.');
    const entries = await Promise.all(claims.map((claim) => transaction.get(entryRef(eventId, claim.data().entryId))));
    if (entries.some((entry) => !entry.exists() || entry.data().status !== 'confirmed')) throw fail('Only confirmed players can form a team.');
    const title = String(teamName || '').trim().slice(0, 60) || entries.map((entry) => entry.data().name).join(' + ');
    transaction.set(reference, { name: title, playerIds: [...playerIds], createdAt: serverTimestamp(), createdByUid: user.uid });
    for (const playerId of playerIds) transaction.set(teamClaimRef(eventId, playerId), { teamId: reference.id });
    transaction.set(auditRef(eventId), { action: 'create_team', teamId: reference.id, playerIds, byUid: user.uid, at: serverTimestamp() });
  });
  return { team: normalized(await getDoc(reference)) };
}

export async function drawEventTeams(eventId) {
  await organizer();
  const snapshot = await getAdminEvent(eventId);
  if (snapshot.event.discipline !== 'doubles' || snapshot.event.teamMode === 'rotating' ||
      snapshot.event.status !== 'registration') throw fail('Team draw is unavailable.');
  const paired = new Set(snapshot.teams.flatMap((team) => team.playerIds));
  const available = snapshot.entries.filter((entry) => entry.status === 'confirmed' && !paired.has(entry.playerId))
    .map((entry) => entry.playerId);
  for (let index = available.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [available[index], available[other]] = [available[other], available[index]];
  }
  const teams = [];
  for (let index = 0; index + 1 < available.length; index += 2) {
    try { teams.push((await saveEventTeam(eventId, { playerIds: available.slice(index, index + 2) })).team); }
    catch (cause) { if (cause.code !== 'already-exists') throw cause; }
  }
  return { teams, unpairedPlayerIds: available.length % 2 ? available.slice(-1) : [] };
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function entrantsFor(event, snapshot) {
  const checkedIn = new Map(snapshot.entries.filter((entry) =>
    entry.status === 'confirmed' && entry.checkedIn && entry.playerId)
    .map((entry) => [entry.playerId, entry]));
  let entrants;
  if (event.discipline === 'singles' || event.teamMode === 'rotating') {
    entrants = [...checkedIn.values()].map((entry) => ({
      id: entry.playerId, playerIds: [entry.playerId], name: entry.name,
    }));
  } else {
    const teams = snapshot.teams.filter((team) =>
      team.playerIds?.length === 2 && team.playerIds.every((playerId) => checkedIn.has(playerId)));
    const used = new Set(teams.flatMap((team) => team.playerIds));
    if (used.size !== checkedIn.size) throw fail('Pair every checked-in doubles player before drawing.');
    entrants = teams.map((team) => ({
      id: team.id, playerIds: team.playerIds, name: team.name,
    }));
  }
  if (entrants.length < (event.teamMode === 'rotating' ? 4 : 2)) throw fail('Not enough checked-in entrants to start.');
  return shuffle(entrants).map((entrant, drawOrder) => ({ ...entrant, drawOrder }));
}

function matchData(descriptor, entrants, playerNames) {
  const byId = new Map(entrants.map((entrant) => [entrant.id, entrant]));
  const rotating = Array.isArray(descriptor.sides[0]);
  const sidePlayerIds = rotating ? descriptor.sides.map((side) => [...side]) :
    descriptor.sides.map((side) => side ? [...(byId.get(side)?.playerIds || [])] : []);
  return {
    ...descriptor,
    // Firestore rejects nested arrays, so store each lineup and rotating side separately.
    sides: rotating ? null : [...descriptor.sides],
    sideIds: rotating ? { A: sidePlayerIds[0], B: sidePlayerIds[1] } : null,
    sideAPlayerIds: sidePlayerIds[0], sideBPlayerIds: sidePlayerIds[1],
    sideA: sidePlayerIds[0].map((playerId) => ({ id: playerId, name: playerNames.get(playerId) || 'Player' })),
    sideB: sidePlayerIds[1].map((playerId) => ({ id: playerId, name: playerNames.get(playerId) || 'Player' })),
    winnerSide: null, courtId: null, courtName: null, gameId: null,
    startedAt: null, completedAt: null,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  };
}

async function persistRound(eventId, descriptors, entrants, names) {
  // Two writes per match (private and public). Keep each batch below 500 writes.
  for (let offset = 0; offset < descriptors.length; offset += 200) {
    const batch = writeBatch(db);
    for (const descriptor of descriptors.slice(offset, offset + 200)) {
      const data = matchData(descriptor, entrants, names);
      batch.set(matchRef(eventId, descriptor.id), data);
      batch.set(publicMatchRef(eventId, descriptor.id), data);
    }
    await batch.commit();
  }
}

export async function startEventSchedule(eventId) {
  const user = await organizer();
  const snapshot = await getAdminEvent(eventId);
  const event = snapshot.event;
  if (event.status !== 'registration') throw fail('This event has already started.');
  if (event.kind === 'open_play') {
    await runTransaction(db, async (transaction) => {
      const current = await transaction.get(eventRef(eventId));
      if (!current.exists() || current.data().status !== 'registration') throw fail('Event has already started.');
      transaction.update(eventRef(eventId), { status: 'in_progress', registrationOpen: false, updatedAt: serverTimestamp() });
      transaction.update(publicEventRef(eventId), { status: 'in_progress', registrationOpen: false, updatedAt: serverTimestamp() });
      transaction.set(auditRef(eventId), { action: 'start_open_play', byUid: user.uid, at: serverTimestamp() });
    });
    return { event: (await getAdminEvent(eventId)).event };
  }
  const entrants = entrantsFor(event, snapshot);
  if (event.format === 'round_robin' && event.roundRobinMode === 'full' && entrants.length > 32) {
    throw fail('Full round robin allows up to 32 entrants. Choose pools for a larger event.');
  }
  const names = new Map(snapshot.entries.map((entry) => [entry.playerId, entry.name]));
  const poolSize = event.roundRobinMode === 'full' ? entrants.length : event.poolSize;
  const initial = event.format === 'single_elimination'
    ? generateSingleElimination(entrants)
    : event.teamMode === 'rotating'
      ? generateRotatingDoubles(entrants)
      : generateRoundRobin(entrants, { round: 1, poolSize });
  await runTransaction(db, async (transaction) => {
    const current = await transaction.get(eventRef(eventId));
    if (!current.exists() || current.data().status !== 'registration') throw fail('Event has already started.');
    transaction.update(eventRef(eventId), {
      status: 'scheduling', registrationOpen: false,
      drawEntrants: entrants, phase: event.format === 'single_elimination' ? 'knockout' : 'round_robin',
      round: 0, roundCount: event.format === 'single_elimination' ? initial.roundCount :
        event.teamMode === 'rotating' ? event.rounds : initial.roundCount,
      updatedAt: serverTimestamp(),
    });
    transaction.update(publicEventRef(eventId), { status: 'scheduling', registrationOpen: false,
      drawEntrants: entrants, updatedAt: serverTimestamp() });
    transaction.set(auditRef(eventId), { action: 'start_tournament', entrantCount: entrants.length, byUid: user.uid, at: serverTimestamp() });
  });
  await persistRound(eventId, initial.matches, entrants, names);
  await runTransaction(db, async (transaction) => {
    const current = await transaction.get(eventRef(eventId));
    if (!current.exists() || current.data().status !== 'scheduling') throw fail('Tournament setup changed.');
    transaction.update(eventRef(eventId), { status: 'in_progress', round: 1, updatedAt: serverTimestamp() });
    transaction.update(publicEventRef(eventId), {
      status: 'in_progress', round: 1,
      phase: event.format === 'single_elimination' ? 'knockout' : 'round_robin',
      roundCount: event.format === 'single_elimination' ? initial.roundCount :
        event.teamMode === 'rotating' ? event.rounds : initial.roundCount,
      updatedAt: serverTimestamp(),
    });
  });
  return { event: (await getAdminEvent(eventId)).event, matches: initial.matches };
}

export async function assignEventMatchCourt(eventId, matchId, courtId) {
  await organizer();
  await runTransaction(db, async (transaction) => {
    const [event, match, court] = await Promise.all([
      transaction.get(eventRef(eventId)), transaction.get(matchRef(eventId, matchId)),
      transaction.get(courtRef(courtId)),
    ]);
    if (!event.exists() || event.data().status !== 'in_progress') throw fail('Tournament is not running.');
    if (!match.exists() || match.data().status !== 'ready') throw fail('Only a ready match can be assigned.');
    if (!court.exists()) throw fail('Court not found.');
    const patch = { courtId, courtName: court.data().name, updatedAt: serverTimestamp() };
    transaction.update(matchRef(eventId, matchId), patch);
    transaction.update(publicMatchRef(eventId, matchId), patch);
  });
  return { match: normalized(await getDoc(matchRef(eventId, matchId))) };
}

function lineupOf(match) {
  const sides = materializeMatch(match).sidePlayerIds;
  if (!Array.isArray(sides) || sides.length !== 2 || sides.some((side) => !Array.isArray(side))) throw fail('Match lineup is incomplete.');
  const expected = sides[0].length;
  if (![1, 2].includes(expected) || sides[1].length !== expected) throw fail('Match lineup is incomplete.');
  const ids = [...sides[0], ...sides[1]];
  if (new Set(ids).size !== ids.length) throw fail('A player is listed twice.');
  return { sideA: [...sides[0]], sideB: [...sides[1]], ids };
}

export async function startEventMatch(eventId, matchId) {
  const user = await organizer();
  const game = doc(collection(db, 'sessions', eventId, 'games'));
  await runTransaction(db, async (transaction) => {
    const [event, match, session] = await Promise.all([
      transaction.get(eventRef(eventId)), transaction.get(matchRef(eventId, matchId)),
      transaction.get(sessionRef(eventId)),
    ]);
    if (!event.exists() || event.data().status !== 'in_progress' || !session.exists() || !session.data().open) throw fail('Event is not running.');
    if (!match.exists() || match.data().status !== 'ready') throw fail('Match is not ready.');
    const data = materializeMatch(match.data());
    if (!data.courtId) throw fail('Assign a court first.');
    const lineup = lineupOf(data);
    const court = await transaction.get(courtRef(data.courtId));
    if (!court.exists() || court.data().activeGameId) throw fail('This court is busy.');
    const claims = await Promise.all(lineup.ids.map((playerId) => transaction.get(claimRef(eventId, playerId))));
    if (claims.some((claim) => !claim.exists())) throw fail('A player is no longer registered.');
    const entries = await Promise.all(claims.map((claim) => transaction.get(entryRef(eventId, claim.data().entryId))));
    const locks = await Promise.all(lineup.ids.map((playerId) => transaction.get(lockRef(eventId, playerId))));
    if (locks.some((lock) => lock.exists())) throw fail('A player is already on an active court.');
    if (entries.some((entry) => !entry.exists() || entry.data().status !== 'confirmed' || !entry.data().checkedIn)) throw fail('All players must be checked in.');
    const config = { id: court.id, ...court.data() };
    const validation = validateLineup({
      court: config, lineup: { sideA: lineup.sideA, sideB: lineup.sideB },
      players: entries.map((entry) => ({
        id: entry.data().playerId, name: entry.data().name,
        skill: entry.data().skillLevel, gender: entry.data().division,
        checkedIn: true,
      })),
    });
    if (!validation.valid) throw fail(validation.errors.join(' '));
    const playerSnapshots = Object.fromEntries(entries.map((entry) => [entry.data().playerId, {
      name: entry.data().name, skillLevel: entry.data().skillLevel, division: entry.data().division,
    }]));
    transaction.set(game, {
      sessionId: eventId, eventId, eventMatchId: matchId,
      courtId: court.id, courtName: court.data().name,
      courtConfigSnapshot: { allowedSkills: court.data().allowedSkills,
        division: court.data().division || 'open', format: config.format },
      status: 'active', lineup: { sideA: lineup.sideA, sideB: lineup.sideB },
      playerSnapshots, replacements: [], result: null,
      startedAt: serverTimestamp(), completedAt: null, cancelledAt: null,
      startedByUid: user.uid,
    });
    transaction.update(courtRef(court.id), {
      activeGameId: game.id, activeSessionId: eventId, updatedAt: serverTimestamp(),
    });
    transaction.update(sessionRef(eventId), {
      activeGameCount: (session.data().activeGameCount || 0) + 1, updatedAt: serverTimestamp(),
    });
    for (const playerId of lineup.ids) transaction.set(lockRef(eventId, playerId), {
      gameId: game.id, courtId: court.id, sessionId: eventId,
      createdAt: serverTimestamp(),
    });
    const patch = { status: 'active', gameId: game.id, startedAt: serverTimestamp(), updatedAt: serverTimestamp() };
    transaction.update(matchRef(eventId, matchId), patch);
    transaction.update(publicMatchRef(eventId, matchId), patch);
  });
  return { match: normalized(await getDoc(matchRef(eventId, matchId))), gameId: game.id };
}

/** Release the court and player locks for an active tournament match without a result. */
export async function cancelEventMatch(eventId, matchId) {
  const user = await organizer();
  await runTransaction(db, async (transaction) => {
    const [event, match, session] = await Promise.all([
      transaction.get(eventRef(eventId)), transaction.get(matchRef(eventId, matchId)),
      transaction.get(sessionRef(eventId)),
    ]);
    if (!event.exists() || event.data().status !== 'in_progress' || !session.exists()) throw fail('Event is not running.');
    if (!match.exists() || match.data().status !== 'active' || !match.data().gameId) throw fail('Match is not active.');
    const data = materializeMatch(match.data());
    const lineup = lineupOf(data);
    const [game, court, ...locks] = await Promise.all([
      transaction.get(gameRef(eventId, data.gameId)), transaction.get(courtRef(data.courtId)),
      ...lineup.ids.map((playerId) => transaction.get(lockRef(eventId, playerId))),
    ]);
    if (!game.exists() || game.data().status !== 'active' || game.data().eventMatchId !== matchId ||
        !court.exists() || court.data().activeGameId !== data.gameId ||
        court.data().activeSessionId !== eventId ||
        locks.some((lock) => !lock.exists() || lock.data().gameId !== data.gameId)) {
      throw fail('Court or player assignment changed. Refresh before cancelling.');
    }
    transaction.update(gameRef(eventId, data.gameId), { status: 'cancelled', cancelledAt: serverTimestamp() });
    transaction.update(courtRef(data.courtId), { activeGameId: null, activeSessionId: null, updatedAt: serverTimestamp() });
    transaction.update(sessionRef(eventId), {
      activeGameCount: Math.max(0, (session.data().activeGameCount || 0) - 1), updatedAt: serverTimestamp(),
    });
    for (const playerId of lineup.ids) transaction.delete(lockRef(eventId, playerId));
    const patch = { status: 'ready', gameId: null, startedAt: null, updatedAt: serverTimestamp() };
    transaction.update(matchRef(eventId, matchId), patch);
    transaction.update(publicMatchRef(eventId, matchId), patch);
    transaction.set(auditRef(eventId), { action: 'cancel_match', matchId, gameId: data.gameId,
      byUid: user.uid, at: serverTimestamp() });
  });
  return { match: normalized(await getDoc(matchRef(eventId, matchId))) };
}

function scoreWinner(score, target, bestOf) {
  const games = score?.games;
  if (!Array.isArray(games) || games.length < 1 || games.length > bestOf) throw fail('Enter every played game score.');
  let aWins = 0;
  let bWins = 0;
  for (const [index, game] of games.entries()) {
    const a = Number(game.a);
    const b = Number(game.b);
    const winnerPoints = Math.max(a, b);
    const loserPoints = Math.min(a, b);
    const expectedWinnerPoints = loserPoints <= target - 2 ? target : loserPoints + 2;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 ||
        winnerPoints !== expectedWinnerPoints) throw fail('Each game needs a valid score, winning by at least two points.');
    if (a > b) aWins += 1; else bWins += 1;
    if (index < games.length - 1 && Math.max(aWins, bWins) > bestOf / 2) throw fail('Remove games played after the match was decided.');
  }
  if (Math.max(aWins, bWins) < Math.ceil(bestOf / 2)) throw fail('The match needs a winner.');
  return { games: games.map((game) => ({ a: Number(game.a), b: Number(game.b) })),
    winnerSide: aWins > bWins ? 'A' : 'B' };
}

export async function recordEventMatch(eventId, matchId, score) {
  const user = await organizer();
  const result = await runTransaction(db, async (transaction) => {
    const [event, match, session] = await Promise.all([
      transaction.get(eventRef(eventId)), transaction.get(matchRef(eventId, matchId)),
      transaction.get(sessionRef(eventId)),
    ]);
    if (!event.exists() || !session.exists()) throw fail('Event is unavailable.');
    if (!match.exists()) throw fail('Match not found.');
    const scored = scoreWinner(score, event.data().scoreTarget, event.data().bestOf);
    if (match.data().status === 'completed') {
      if (match.data().winnerSide === scored.winnerSide &&
          JSON.stringify(match.data().score?.games || []) === JSON.stringify(scored.games)) {
        return { applied: false, winnerSide: scored.winnerSide, winnerId: match.data().winnerId || null };
      }
      throw fail('Use Correct result to change a completed match.');
    }
    if (event.data().status !== 'in_progress' || !session.data().open ||
        match.data().status !== 'active' || !match.data().gameId) throw fail('Match is not active.');
    const data = materializeMatch(match.data());
    const lineup = lineupOf(data);
    const [game, court, ...locks] = await Promise.all([
      transaction.get(gameRef(eventId, data.gameId)), transaction.get(courtRef(data.courtId)),
      ...lineup.ids.map((playerId) => transaction.get(lockRef(eventId, playerId))),
    ]);
    if (!game.exists() || game.data().status !== 'active' || !court.exists() ||
        court.data().activeGameId !== data.gameId || court.data().activeSessionId !== eventId ||
        locks.some((lock) => !lock.exists() || lock.data().gameId !== data.gameId)) throw fail('Court or player assignment changed.');
    const claims = await Promise.all(lineup.ids.map((playerId) => transaction.get(claimRef(eventId, playerId))));
    const entries = await Promise.all(claims.map((claim) => transaction.get(entryRef(eventId, claim.data().entryId))));
    const players = await Promise.all(lineup.ids.map((playerId) => transaction.get(playerRef(playerId))));
    if (entries.some((entry) => !entry.exists()) || players.some((player) => !player.exists())) throw fail('A player record is missing.');
    const completedAt = new Date().toISOString();
    const winnerIndex = scored.winnerSide === 'A' ? 0 : 1;
    const winnerId = Array.isArray(data.sides[winnerIndex]) ? null : data.sides[winnerIndex];
    const patch = {
      status: 'completed', score: { games: scored.games }, winnerSide: scored.winnerSide,
      winnerId, completedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    };
    transaction.update(matchRef(eventId, matchId), patch);
    transaction.update(publicMatchRef(eventId, matchId), patch);
    transaction.update(gameRef(eventId, data.gameId), {
      status: 'completed', result: { winnerSide: scored.winnerSide, score: patch.score },
      completedAt: serverTimestamp(),
    });
    transaction.update(courtRef(data.courtId), {
      activeGameId: null, activeSessionId: null, updatedAt: serverTimestamp(),
    });
    transaction.update(sessionRef(eventId), {
      activeGameCount: Math.max(0, (session.data().activeGameCount || 0) - 1),
      updatedAt: serverTimestamp(),
    });
    for (let index = 0; index < lineup.ids.length; index += 1) {
      const playerId = lineup.ids[index];
      const sideIndex = index < lineup.sideA.length ? 0 : 1;
      const won = sideIndex === winnerIndex;
      const player = players[index].data();
      const entry = entries[index].data();
      const teammates = sideIndex === 0 ? lineup.sideA : lineup.sideB;
      const opponents = sideIndex === 0 ? lineup.sideB : lineup.sideA;
      transaction.update(playerRef(playerId), {
        wins: (player.wins || 0) + Number(won),
        losses: (player.losses || 0) + Number(!won), updatedAt: serverTimestamp(),
      });
      transaction.update(entries[index].ref, {
        wins: (entry.wins || 0) + Number(won), losses: (entry.losses || 0) + Number(!won),
        recentMatches: [{ completedAt, partnerIds: teammates.filter((item) => item !== playerId),
          opponentIds: [...opponents] }, ...(entry.recentMatches || [])].slice(0, 4),
        updatedAt: serverTimestamp(),
      });
      transaction.delete(lockRef(eventId, playerId));
    }
    transaction.set(auditRef(eventId), {
      action: 'record_match', matchId, score: patch.score,
      winnerSide: scored.winnerSide, byUid: user.uid, at: serverTimestamp(),
    });
    return { applied: true, winnerSide: scored.winnerSide, winnerId };
  });
  return { match: normalized(await getDoc(matchRef(eventId, matchId))), ...result };
}

function championsFor(match, winnerSide) {
  const side = winnerSide === 'A' ? 0 : 1;
  return (match.sidePlayerIds?.[side] || []).map((playerId) => {
    const person = [...(match.sideA || []), ...(match.sideB || [])].find((item) => item.id === playerId);
    return { playerId, name: person?.name || 'Player' };
  });
}

export async function correctEventMatch(eventId, matchId, score) {
  const user = await organizer();
  const knownMatches = await getDocsFromServer(collection(db, 'events', eventId, 'matches'));
  const dependents = knownMatches.docs.filter((item) => item.data().sourceMatchIds?.includes(matchId));
  const result = await runTransaction(db, async (transaction) => {
    const [event, match] = await Promise.all([
      transaction.get(eventRef(eventId)), transaction.get(matchRef(eventId, matchId)),
    ]);
    if (!event.exists() || !['in_progress', 'completed'].includes(event.data().status)) throw fail('Event is unavailable.');
    if (!match.exists() || match.data().status !== 'completed') throw fail('Only completed matches can be corrected.');
    const before = materializeMatch(match.data());
    if (event.data().phase === 'playoffs' && before.stage === 'round_robin') {
      throw fail('A playoff depends on this round-robin result. Clear the playoff first.');
    }
    const scored = scoreWinner(score, event.data().scoreTarget, event.data().bestOf);
    const changedWinner = scored.winnerSide !== before.winnerSide;
    if (!changedWinner && JSON.stringify(scored.games) === JSON.stringify(before.score?.games || [])) return { applied: false };
    const dependentDocs = await Promise.all(dependents.map((item) => transaction.get(item.ref)));
    if (changedWinner && dependentDocs.some((item) => ['active', 'completed', 'bye'].includes(item.data().status))) {
      throw fail('Clear the dependent match before correcting this winner.');
    }
    const lineup = lineupOf(before);
    const claims = changedWinner ? await Promise.all(lineup.ids.map((playerId) => transaction.get(claimRef(eventId, playerId)))) : [];
    const entries = changedWinner ? await Promise.all(claims.map((claim) => transaction.get(entryRef(eventId, claim.data().entryId)))) : [];
    const players = changedWinner ? await Promise.all(lineup.ids.map((playerId) => transaction.get(playerRef(playerId)))) : [];
    const winnerIndex = scored.winnerSide === 'A' ? 0 : 1;
    const winnerId = Array.isArray(before.sides[winnerIndex]) ? null : before.sides[winnerIndex];
    const patch = { score: { games: scored.games }, winnerSide: scored.winnerSide,
      winnerId, updatedAt: serverTimestamp() };
    transaction.update(matchRef(eventId, matchId), patch);
    transaction.update(publicMatchRef(eventId, matchId), patch);
    if (before.gameId) transaction.update(gameRef(eventId, before.gameId), {
      result: { winnerSide: scored.winnerSide, score: patch.score },
    });
    if (changedWinner) {
      for (let index = 0; index < lineup.ids.length; index += 1) {
        const playerId = lineup.ids[index];
        const sideIndex = index < lineup.sideA.length ? 0 : 1;
        const nowWon = sideIndex === winnerIndex;
        const player = players[index].data();
        const entry = entries[index].data();
        transaction.update(playerRef(playerId), {
          wins: Math.max(0, (player.wins || 0) + (nowWon ? 1 : -1)),
          losses: Math.max(0, (player.losses || 0) + (nowWon ? -1 : 1)),
          updatedAt: serverTimestamp(),
        });
        transaction.update(entries[index].ref, {
          wins: Math.max(0, (entry.wins || 0) + (nowWon ? 1 : -1)),
          losses: Math.max(0, (entry.losses || 0) + (nowWon ? -1 : 1)),
          updatedAt: serverTimestamp(),
        });
      }
      for (const dependent of dependentDocs) {
        const side = dependent.data().sourceMatchIds.indexOf(matchId);
        const sides = [...dependent.data().sides];
        const sidePlayerIds = materializeMatch(dependent.data()).sidePlayerIds;
        sides[side] = winnerId;
        sidePlayerIds[side] = before.sidePlayerIds[winnerIndex];
        const playersOnSide = winnerIndex === 0 ? before.sideA : before.sideB;
        const update = {
          sides, sideAPlayerIds: sidePlayerIds[0], sideBPlayerIds: sidePlayerIds[1],
          sideA: side === 0 ? playersOnSide : dependent.data().sideA,
          sideB: side === 1 ? playersOnSide : dependent.data().sideB,
          status: sides.every(Boolean) ? 'ready' : 'pending',
          updatedAt: serverTimestamp(),
        };
        transaction.update(dependent.ref, update);
        transaction.update(publicMatchRef(eventId, dependent.id), update);
      }
      if (event.data().status === 'completed') {
        const champions = championsFor(before, scored.winnerSide);
        transaction.update(eventRef(eventId), { champions, updatedAt: serverTimestamp() });
        transaction.update(publicEventRef(eventId), { champions, updatedAt: serverTimestamp() });
      }
    }
    transaction.set(auditRef(eventId), {
      action: 'correct_match', matchId,
      before: { score: before.score, winnerSide: before.winnerSide },
      after: { score: patch.score, winnerSide: scored.winnerSide },
      byUid: user.uid, at: serverTimestamp(),
    });
    return { applied: true, changedWinner };
  });
  return { match: normalized(await getDoc(matchRef(eventId, matchId))), ...result };
}

export async function advanceEventRound(eventId) {
  const user = await organizer();
  const snapshot = await getAdminEvent(eventId);
  const event = snapshot.event;
  if (event.kind !== 'tournament' || event.status !== 'in_progress') throw fail('Tournament is not running.');
  const current = snapshot.matches.filter((match) => {
    if (event.phase === 'round_robin') return match.stage === (event.teamMode === 'rotating' ? 'rotating_doubles' : 'round_robin') && match.round === event.round;
    if (event.phase === 'final') return match.stage === 'rotating_doubles_final';
    return match.stage === 'knockout' && match.round === event.round;
  });
  if (!current.length || current.some((match) => !['completed', 'bye'].includes(match.status))) throw fail('Finish every match in this round first.');
  if (event.phase === 'final' || (event.phase === 'knockout' || event.phase === 'playoffs') && event.round >= event.roundCount) {
    return finishEvent(eventId);
  }
  const raw = await getDocFromServer(eventRef(eventId));
  const entrants = raw.data().phase === 'playoffs' ? raw.data().playoffEntrants : raw.data().drawEntrants;
  const names = new Map(snapshot.entries.map((entry) => [entry.playerId, entry.name]));
  let next;
  let nextPhase = raw.data().phase;
  let nextRound = event.round + 1;
  let roundCount = event.roundCount;
  let playoffEntrants = null;
  if (event.phase === 'knockout' || event.phase === 'playoffs') {
    next = generateSingleElimination(entrants, { round: nextRound, priorMatches: current });
  } else if (event.teamMode === 'rotating') {
    if (event.round < event.rounds) {
      next = generateRotatingDoubles(entrants, { round: nextRound, history: snapshot.matches });
    } else {
      next = { matches: [selectRotatingDoublesFinal(entrants, snapshot.matches)] };
      nextPhase = 'final';
      nextRound = event.round + 1;
      roundCount = nextRound;
    }
  } else if (event.round < event.roundCount) {
    const poolSize = event.roundRobinMode === 'full' ? entrants.length : event.poolSize;
    next = generateRoundRobin(entrants, { round: nextRound, poolSize });
  } else {
    const pools = [...new Set(snapshot.matches.filter((match) => match.stage === 'round_robin').map((match) => match.poolId))];
    const qualifiers = pools.length === 1
      ? rankStandings(entrants, snapshot.matches.filter((match) => match.stage === 'round_robin')).slice(0, 2).map((row) => row.id)
      : pools.map((poolId) => rankStandings(entrants.filter((entrant) =>
        snapshot.matches.some((match) => match.poolId === poolId && match.sides.includes(entrant.id))),
      snapshot.matches.filter((match) => match.poolId === poolId))[0]?.id).filter(Boolean);
    playoffEntrants = qualifiers.map((entrantId) => entrants.find((entrant) => entrant.id === entrantId));
    if (playoffEntrants.length < 2) throw fail('Not enough pool qualifiers for a final.');
    next = generateSingleElimination(playoffEntrants);
    nextPhase = 'playoffs';
    nextRound = 1;
    roundCount = next.roundCount;
  }
  await runTransaction(db, async (transaction) => {
    const state = await transaction.get(eventRef(eventId));
    if (!state.exists() || state.data().round !== event.round || state.data().phase !== event.phase) throw fail('Round changed. Refresh.');
    transaction.update(eventRef(eventId), { status: 'scheduling', updatedAt: serverTimestamp() });
    transaction.update(publicEventRef(eventId), { status: 'scheduling', updatedAt: serverTimestamp() });
  });
  await persistRound(eventId, next.matches, playoffEntrants || entrants, names);
  await runTransaction(db, async (transaction) => {
    const state = await transaction.get(eventRef(eventId));
    if (!state.exists() || state.data().status !== 'scheduling') throw fail('Round setup changed.');
    const patch = { status: 'in_progress', phase: nextPhase,
      round: nextRound, roundCount, updatedAt: serverTimestamp() };
    if (playoffEntrants) patch.playoffEntrants = playoffEntrants;
    transaction.update(eventRef(eventId), patch);
    transaction.update(publicEventRef(eventId), {
      status: 'in_progress', phase: nextPhase,
      round: nextRound, roundCount, updatedAt: serverTimestamp(),
    });
    transaction.set(auditRef(eventId), { action: 'advance_round', phase: nextPhase,
      round: nextRound, byUid: user.uid, at: serverTimestamp() });
  });
  return { event: (await getAdminEvent(eventId)).event, matches: next.matches };
}

export async function finishEvent(eventId) {
  const user = await organizer();
  const snapshot = await getAdminEvent(eventId);
  const event = snapshot.event;
  if (event.status !== 'in_progress') throw fail('Event is not running.');
  let champions = [];
  if (event.kind === 'tournament') {
    const final = event.teamMode === 'rotating'
      ? snapshot.matches.find((match) => match.stage === 'rotating_doubles_final')
      : snapshot.matches.find((match) => match.stage === 'knockout' && match.round === event.roundCount && match.slot === 1);
    if (!final || final.status !== 'completed') throw fail('Record the final result first.');
    champions = championsFor(final, final.winnerSide);
  }
  await runTransaction(db, async (transaction) => {
    const [state, session] = await Promise.all([transaction.get(eventRef(eventId)), transaction.get(sessionRef(eventId))]);
    if (!state.exists() || state.data().status !== 'in_progress') throw fail('Event changed. Refresh.');
    if (!session.exists() || (session.data().activeGameCount || 0) > 0) throw fail('Finish active court games first.');
    transaction.update(eventRef(eventId), { status: 'completed', registrationOpen: false, champions, updatedAt: serverTimestamp() });
    transaction.update(publicEventRef(eventId), { status: 'completed', registrationOpen: false, champions, updatedAt: serverTimestamp() });
    transaction.update(sessionRef(eventId), { open: false, archivedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    transaction.set(auditRef(eventId), { action: 'finish_event', champions, byUid: user.uid, at: serverTimestamp() });
  });
  return { event: (await getAdminEvent(eventId)).event };
}
