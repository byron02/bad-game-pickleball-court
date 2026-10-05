import test from 'node:test';
import assert from 'node:assert/strict';

// Run with Firebase Auth and Firestore emulators, never against production:
// firebase emulators:exec --only auth,firestore --project bad-game-pickleball
//   "node --test tests/app-integration.test.js"
const enabled = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST);

test('signup approval, independent court start, and idempotent wins/losses',
  { skip: !enabled }, async (t) => {
    globalThis.location = { hostname: 'localhost', port: '5000', origin: 'http://localhost:5000' };
    const { initializeApp, deleteApp: deleteAdminApp } = await import('firebase-admin/app');
    const { getApps, deleteApp } = await import('firebase/app');
    const { getAuth: getAdminAuth } = await import('firebase-admin/auth');
    const { getFirestore: getAdminDb } = await import('firebase-admin/firestore');
    const signup = await import('../src/firebaseStore.js');
    const courts = await import('../src/courtStore.js');

    const adminApp = initializeApp({ projectId: 'bad-game-pickleball' });
    t.after(async () => {
      await signup.signOutOrganizer().catch(() => {});
      await Promise.all(getApps().map((app) => deleteApp(app)));
      await deleteAdminApp(adminApp);
      delete globalThis.location;
    });
    const adminAuth = getAdminAuth();
    const adminDb = getAdminDb();
    const email = `organizer-${Date.now()}@example.com`;
    const password = 'Test-password-123!';
    const organizer = await adminAuth.createUser({ email, password });
    await adminDb.doc(`organizers/${organizer.uid}`).set({ active: true, email });

    await signup.signInOrganizer({ email, password });
    const date = '2026-10-05';
    const firstSession = await signup.getCurrentSession(date);
    await signup.updateSession(firstSession.id, { capacity: 4 });
    await signup.signOutOrganizer();

    await signup.submitSignup({
      sessionId: firstSession.id, name: 'Jina', skillLevel: 'advanced', division: 'woman',
    });
    await signup.signOutOrganizer();
    await signup.signInOrganizer({ email, password });
    let dashboard = await signup.getAdminDashboard(date);
    assert.equal(dashboard.session.confirmedCount, 0);
    assert.equal(dashboard.entries.filter((entry) => entry.status === 'pending').length, 1);
    await signup.approveEntry(firstSession.id, dashboard.entries[0].id);

    for (const [name, division] of [['Ana', 'woman'], ['Joemari', 'man'], ['Stef', 'man']]) {
      const ref = adminDb.collection('players').doc();
      await ref.set({
        name, nameLower: name.toLowerCase(), skillLevel: 'advanced', division,
        photoData: null, active: true, wins: 0, losses: 0,
        createdAt: new Date(), updatedAt: new Date(),
      });
      await signup.reservePlayer(firstSession.id, ref.id);
    }
    dashboard = await signup.getAdminDashboard(date);
    assert.equal(dashboard.session.confirmedCount, 4);
    assert.equal(dashboard.session.spotsLeft, 0);
    for (const entry of dashboard.entries) await signup.checkInEntry(firstSession.id, entry.id);
    dashboard = await signup.getAdminDashboard(date);
    assert.equal(dashboard.session.checkedInCount, 4);

    const playerIds = Object.fromEntries(dashboard.entries.map((entry) => [entry.name, entry.playerId]));
    const court1 = (await courts.saveCourt({
      name: `Advanced Court ${Date.now()}`, allowedSkills: ['advanced'],
      division: 'open', format: 'doubles',
    })).court;
    const court2 = (await courts.saveCourt({
      name: `Other Court ${Date.now()}`, allowedSkills: ['advanced'],
      division: 'open', format: 'doubles',
    })).court;
    const lineup = {
      sideA: [playerIds.Jina, playerIds.Ana],
      sideB: [playerIds.Joemari, playerIds.Stef],
    };
    const started = await courts.startCourtGame({ sessionId: firstSession.id, courtId: court1.id, lineup });
    assert.equal((await adminDb.doc(`sessions/${firstSession.id}`).get()).data().activeGameCount, 1);
    await assert.rejects(signup.resetSession(date), /active games/);
    await assert.rejects(courts.startCourtGame({ sessionId: firstSession.id, courtId: court2.id, lineup }),
      /active court/);
    const result = await courts.completeCourtGame({ sessionId: firstSession.id, gameId: started.game.id, winnerSide: 'B' });
    assert.equal(result.applied, true);
    assert.equal((await adminDb.doc(`sessions/${firstSession.id}`).get()).data().activeGameCount, 0);
    const replay = await courts.completeCourtGame({ sessionId: firstSession.id, gameId: started.game.id, winnerSide: 'B' });
    assert.equal(replay.applied, false);
    for (const name of ['Joemari', 'Stef']) {
      const player = (await adminDb.doc(`players/${playerIds[name]}`).get()).data();
      assert.equal(player.wins, 1);
      assert.equal(player.losses, 0);
    }
    for (const name of ['Jina', 'Ana']) {
      const player = (await adminDb.doc(`players/${playerIds[name]}`).get()).data();
      assert.equal(player.wins, 0);
      assert.equal(player.losses, 1);
    }

    await signup.updatePlayer(playerIds.Jina, { skillLevel: 'intermediate' }, firstSession.id);
    const jinaEntry = dashboard.entries.find((entry) => entry.name === 'Jina');
    assert.equal((await adminDb.doc(`sessions/${firstSession.id}/entries/${jinaEntry.id}`).get()).data().skillLevel, 'intermediate');
    assert.equal((await adminDb.doc(`playerDirectory/${playerIds.Jina}`).get()).data().skillLevel, 'intermediate');

    await signup.signOutOrganizer();
    await signup.submitSignup({
      sessionId: firstSession.id, name: 'Casey', skillLevel: 'intermediate', division: 'woman',
    });
    await signup.signOutOrganizer();
    await signup.signInOrganizer({ email, password });
    dashboard = await signup.getAdminDashboard(date);
    assert.equal(dashboard.session.confirmedCount, 4, 'unreviewed signup does not take a spot');
    const caseyRequest = dashboard.entries.find((entry) => entry.name === 'Casey');
    await signup.approveEntry(firstSession.id, caseyRequest.id);
    dashboard = await signup.getAdminDashboard(date);
    assert.equal(dashboard.entries.find((entry) => entry.name === 'Casey').status, 'waitlisted');
    assert.equal(dashboard.session.confirmedCount, 4, 'the original four hold their reservations');
    assert.equal(dashboard.session.waitlistCount, 1);
    await signup.signOutOrganizer();
    const search = await signup.searchPlayers('cas');
    assert.equal(search.players.length, 1);
    assert.equal(search.players[0].name, 'Casey');
    await signup.signOutOrganizer();
    await signup.signInOrganizer({ email, password });
    await signup.checkOutEntry(firstSession.id, jinaEntry.id);
    dashboard = await signup.getAdminDashboard(date);
    assert.equal(dashboard.entries.find((entry) => entry.name === 'Casey').status, 'confirmed');
    assert.equal(dashboard.session.confirmedCount, 4);
    assert.equal(dashboard.session.checkedInCount, 3);
    assert.equal(dashboard.session.waitlistCount, 0);

    const reset = await signup.resetSession(date);
    assert.notEqual(reset.session.id, firstSession.id);
    assert.equal(reset.session.confirmedCount, 0);
    assert.equal((await adminDb.doc(`sessions/${firstSession.id}`).get()).data().open, false);
    assert.equal((await adminDb.doc(`players/${playerIds.Jina}`).get()).exists, true);
  });
