import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

test('migration backfills public search and expiry without changing player history',
  { skip: !enabled }, async (t) => {
    const projectId = 'demo-bad-game-migration-' + process.pid;
    const app = initializeApp({ projectId }, 'migration-test');
    t.after(() => deleteApp(app));
    const db = getFirestore(app);
    const sessionRef = db.doc('sessions/legacy-session');
    const playerRef = db.doc('players/maria');
    const directoryRef = db.doc('playerDirectory/maria');
    const orphanRef = db.doc('playerDirectory/orphan');
    const entryRef = sessionRef.collection('entries').doc('maria-reservation');
    await sessionRef.set({
      date: '2026-10-06', cycle: 1, capacity: 32, confirmedCount: 0,
      checkedInCount: 0, waitlistCount: 0, open: true,
    });
    await playerRef.set({
      name: 'Maria Santos', nameLower: 'maria santos',
      skillLevel: 'intermediate', division: 'woman', photoData: null,
      active: true, wins: 7, losses: 3,
    });
    await directoryRef.set({
      name: 'Maria Santos', nameLower: 'maria santos',
      skillLevel: 'intermediate', division: 'woman', photoData: null,
    });
    await orphanRef.set({ name: 'Old Listing', active: true });
    await entryRef.set({
      playerId: 'maria', name: 'Maria Santos', status: 'confirmed', checkedIn: true,
      createdAt: new Date('2026-10-06T08:00:00.000Z'),
    });
    const pendingRef = sessionRef.collection('entries').doc('maria-new-request');
    await pendingRef.set({
      playerId: 'maria', name: 'Maria Santos', status: 'pending',
      createdAt: new Date('2026-10-06T10:00:00.000Z'),
    });
    await sessionRef.collection('games').doc('old-game').set({
      status: 'completed', lineup: { sideA: ['maria'], sideB: ['other'] },
      result: { winnerSide: 'A' }, completedAt: new Date('2026-10-06T09:00:00.000Z'),
    });

    const run = (flag) => {
      const result = spawnSync(process.execPath, ['scripts/migrate-firestore.mjs', flag], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, FIREBASE_PROJECT_ID: projectId },
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout.slice(result.stdout.indexOf('{'), result.stdout.indexOf('}') + 1));
    };

    const preview = run('--dry-run');
    assert.equal(preview.sessions, 1);
    assert.equal(preview.directory, 1);
    assert.equal(preview.entries, 1);
    assert.equal((await sessionRef.get()).get('closesAt'), undefined);
    run('--apply');
    assert.equal((await sessionRef.get()).get('closesAt').toDate().toISOString(), '2026-10-06T16:00:00.000Z');
    const player = (await playerRef.get()).data();
    assert.equal(player.wins, 7);
    assert.equal(player.losses, 3);
    assert.ok(player.searchPrefixes.includes('san'));
    const directory = (await directoryRef.get()).data();
    assert.ok(directory.searchPrefixes.includes('santos'));
    assert.equal(directory.active, true);
    assert.equal((await orphanRef.get()).get('active'), false);
    const entry = (await entryRef.get()).data();
    assert.equal(entry.wins, 1);
    assert.equal(entry.losses, 0);
    assert.deepEqual(entry.recentMatches[0].opponentIds, ['other']);
    assert.equal((await pendingRef.get()).get('recentMatches'), undefined);
    const repeated = run('--dry-run');
    assert.deepEqual(
      [repeated.sessions, repeated.players, repeated.directory, repeated.hiddenOrphans, repeated.entries],
      [0, 0, 0, 0, 0],
    );
  });
