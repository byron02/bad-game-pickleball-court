import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const apply = process.argv.includes('--apply');
const firebaseCliAuth = process.argv.includes('--firebase-cli-auth');
if (process.argv.slice(2).some((argument) => !['--apply', '--dry-run', '--firebase-cli-auth'].includes(argument))) {
  throw new Error('Use --dry-run (default) or --apply, optionally with --firebase-cli-auth.');
}
if (!process.env.FIRESTORE_EMULATOR_HOST && !process.env.GOOGLE_APPLICATION_CREDENTIALS && !firebaseCliAuth) {
  throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS or use --firebase-cli-auth.');
}

const projectId = process.env.FIREBASE_PROJECT_ID || 'bad-game-pickleball';
function cliCredential() {
  const require = createRequire(import.meta.url);
  const cliAuth = require('firebase-tools/lib/auth');
  const cliApi = require('firebase-tools/lib/api');
  const account = cliAuth.getProjectDefaultAccount(process.cwd());
  if (!account?.tokens?.refresh_token) throw new Error('Run firebase login before using --firebase-cli-auth.');
  // Firestore Admin accepts ADC credentials. This short-lived file adapts the
  // existing Firebase CLI login without asking for a service account key.
  const temporaryDirectory = join(tmpdir(), 'pickleball-cli-auth-' + randomUUID());
  mkdirSync(temporaryDirectory, { mode: 0o700 });
  const credentialPath = join(temporaryDirectory, 'adc.json');
  writeFileSync(credentialPath, JSON.stringify({
    type: 'authorized_user',
    client_id: cliApi.clientId(),
    client_secret: cliApi.clientSecret(),
    refresh_token: account.tokens.refresh_token,
  }), { mode: 0o600 });
  process.on('exit', () => {
    rmSync(credentialPath, { force: true });
    rmdirSync(temporaryDirectory);
  });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
  return applicationDefault();
}
const app = initializeApp(process.env.FIRESTORE_EMULATOR_HOST
  ? { projectId }
  : { credential: firebaseCliAuth ? cliCredential() : applicationDefault(), projectId });
const db = getFirestore(app);

function closesAt(date) {
  const parsed = typeof date === 'string' ? new Date(date + 'T12:00:00Z') : new Date(NaN);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('A session has an invalid date: ' + String(date));
  }
  return Timestamp.fromDate(new Date(date + 'T16:00:00.000Z'));
}

function searchPrefixes(name) {
  const lower = name.toLocaleLowerCase().trim().replace(/\s+/g, ' ');
  const surname = lower.split(' ').at(-1);
  const prefixes = new Set();
  for (const value of [lower, surname]) {
    for (let length = 2; length <= value.length; length += 1) {
      prefixes.add(value.slice(0, length));
    }
  }
  return [...prefixes];
}

function milliseconds(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

async function backfillEntrySummaries(session, changes, counts) {
  if (session.get('open') !== true) return;
  const games = [];
  for await (const game of session.ref.collection('games').stream()) {
    const data = game.data();
    if (data.status !== 'completed' || !['A', 'B'].includes(data.result?.winnerSide)) continue;
    const sideA = data.lineup?.sideA;
    const sideB = data.lineup?.sideB;
    const completedAt = milliseconds(data.completedAt);
    if (!Array.isArray(sideA) || !Array.isArray(sideB) || !completedAt) continue;
    games.push({ sideA, sideB, winnerSide: data.result.winnerSide, completedAt });
  }
  if (!games.length) return;
  games.sort((a, b) => b.completedAt - a.completedAt);

  const summaries = new Map();
  for (const game of games) {
    for (const [side, teammateIds, opponentIds] of [
      ['A', game.sideA, game.sideB], ['B', game.sideB, game.sideA],
    ]) {
      for (const playerId of teammateIds) {
        const summary = summaries.get(playerId) || { wins: 0, losses: 0, recentMatches: [] };
        if (side === game.winnerSide) summary.wins += 1;
        else summary.losses += 1;
        if (summary.recentMatches.length < 4) summary.recentMatches.push({
          completedAt: new Date(game.completedAt).toISOString(),
          partnerIds: teammateIds.filter((id) => id !== playerId),
          opponentIds: [...opponentIds],
        });
        summaries.set(playerId, summary);
      }
    }
  }

  const latestEntries = new Map();
  for await (const entry of session.ref.collection('entries').stream()) {
    const playerId = entry.get('playerId');
    if (!summaries.has(playerId) ||
        !['confirmed', 'waitlisted', 'waitlist', 'checked_out', 'removed'].includes(entry.get('status'))) continue;
    const previous = latestEntries.get(playerId);
    if (!previous || milliseconds(entry.get('createdAt')) > milliseconds(previous.get('createdAt')) ||
        (milliseconds(entry.get('createdAt')) === milliseconds(previous.get('createdAt')) && entry.id > previous.id)) {
      latestEntries.set(playerId, entry);
    }
  }
  for (const [playerId, entry] of latestEntries) {
    const summary = summaries.get(playerId);
    const current = entry.data();
    const patch = {};
    const wins = Math.max(Number.isInteger(current.wins) && current.wins >= 0 ? current.wins : 0, summary.wins);
    const losses = Math.max(Number.isInteger(current.losses) && current.losses >= 0 ? current.losses : 0, summary.losses);
    if (current.wins !== wins) patch.wins = wins;
    if (current.losses !== losses) patch.losses = losses;
    if (!Array.isArray(current.recentMatches) || current.recentMatches.length < summary.recentMatches.length) {
      patch.recentMatches = summary.recentMatches;
    }
    if (Object.keys(patch).length) {
      changes.push({ kind: 'update', ref: entry.ref, data: patch });
      counts.entries += 1;
    }
  }
}

const changes = [];
const counts = { sessions: 0, players: 0, directory: 0, hiddenOrphans: 0, entries: 0 };

for await (const session of db.collection('sessions').stream()) {
  const wanted = closesAt(session.get('date'));
  const current = session.get('closesAt');
  if (!current?.isEqual?.(wanted)) {
    changes.push({ kind: 'update', ref: session.ref, data: { closesAt: wanted } });
    counts.sessions += 1;
  }
  await backfillEntrySummaries(session, changes, counts);
}

const playerIds = new Set();
for await (const player of db.collection('players').stream()) {
  playerIds.add(player.id);
  const data = player.data();
  if (typeof data.name !== 'string' || !data.name.trim()) {
    throw new Error('A player has no valid name: ' + player.id);
  }
  const nameLower = data.name.toLocaleLowerCase();
  const prefixes = searchPrefixes(data.name);
  if (data.nameLower !== nameLower || !isDeepStrictEqual(data.searchPrefixes, prefixes)) {
    changes.push({ kind: 'update', ref: player.ref, data: {
      nameLower, searchPrefixes: prefixes,
    } });
    counts.players += 1;
  }
  const directoryRef = db.collection('playerDirectory').doc(player.id);
  const directory = await directoryRef.get();
  const publicData = {
    name: data.name,
    nameLower,
    searchPrefixes: prefixes,
    skillLevel: data.skillLevel,
    division: data.division || 'unspecified',
    photoData: data.photoData || null,
    active: data.active !== false,
  };
  if (!directory.exists || !isDeepStrictEqual(directory.data(), publicData)) {
    changes.push({ kind: 'set', ref: directoryRef, data: publicData });
    counts.directory += 1;
  }
}

for await (const directory of db.collection('playerDirectory').stream()) {
  if (!playerIds.has(directory.id) && directory.get('active') !== false) {
    changes.push({ kind: 'update', ref: directory.ref, data: { active: false } });
    counts.hiddenOrphans += 1;
  }
}

console.log(JSON.stringify({ projectId, mode: apply ? 'apply' : 'dry-run', ...counts }, null, 2));
if (apply) {
  const writer = db.bulkWriter();
  for (const change of changes) {
    if (change.kind === 'set') writer.set(change.ref, change.data);
    else writer.update(change.ref, change.data);
  }
  await writer.close();
  console.log('Migration applied. Rerun without --apply to verify zero remaining changes.');
} else {
  console.log('No writes made. Rerun with --apply after reviewing the counts.');
}
