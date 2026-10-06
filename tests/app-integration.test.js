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
    const date = '2099-01-01';
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

    const directAdd = await signup.createAndReservePlayer({
      sessionId: firstSession.id, name: 'Ana', skillLevel: 'advanced', division: 'woman',
    });
    assert.equal(directAdd.entry.status, 'confirmed');
    assert.equal((await adminDb.doc(`players/${directAdd.playerId}`).get()).data().name, 'Ana');
    assert.equal((await adminDb.doc(`playerDirectory/${directAdd.playerId}`).get()).data().active, true);
    for (const [name, division] of [['Joemari', 'man'], ['Stef', 'man']]) {
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
    let resolveCourtUpdate;
    const courtUpdated = new Promise((resolve) => { resolveCourtUpdate = resolve; });
    const stopWatchingCourts = await courts.watchCourts((snapshot) => {
      if (snapshot.courts?.some((court) => court.id === court2.id && court.name === 'Updated by second organizer')) {
        resolveCourtUpdate();
      }
    });
    await adminDb.doc('courts/' + court2.id).update({ name: 'Updated by second organizer' });
    await Promise.race([
      courtUpdated,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Court listener did not receive the other organizer update.')), 5000)),
    ]);
    stopWatchingCourts();
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
      sessionId: firstSession.id, name: 'Casey Rivera', skillLevel: 'intermediate', division: 'woman',
    });
    await signup.signOutOrganizer();
    await signup.signInOrganizer({ email, password });
    dashboard = await signup.getAdminDashboard(date);
    assert.equal(dashboard.session.confirmedCount, 4, 'unreviewed signup does not take a spot');
    const caseyRequest = dashboard.entries.find((entry) => entry.name === 'Casey Rivera');
    await signup.approveEntry(firstSession.id, caseyRequest.id);
    dashboard = await signup.getAdminDashboard(date);
    assert.equal(dashboard.entries.find((entry) => entry.name === 'Casey Rivera').status, 'waitlisted');
    assert.equal(dashboard.session.confirmedCount, 4, 'the original four hold their reservations');
    assert.equal(dashboard.session.waitlistCount, 1);
    await signup.signOutOrganizer();
    const search = await signup.searchPlayers('cas');
    assert.equal(search.players.length, 1);
    assert.equal(search.players[0].name, 'Casey Rivera');
    assert.equal((await signup.searchPlayers('riv')).players[0].name, 'Casey Rivera');
    assert.equal((await signup.searchPlayers('casey r')).players[0].name, 'Casey Rivera');
    await signup.signOutOrganizer();
    await signup.signInOrganizer({ email, password });
    await signup.checkOutEntry(firstSession.id, jinaEntry.id);
    dashboard = await signup.getAdminDashboard(date);
    assert.equal(dashboard.entries.find((entry) => entry.name === 'Casey Rivera').status, 'confirmed');
    assert.equal(dashboard.session.confirmedCount, 4);
    assert.equal(dashboard.session.checkedInCount, 3);
    assert.equal(dashboard.session.waitlistCount, 0);

    // A prior checked-out entry must not mask this player's new reservation
    // when the next court draw builds its eligible roster.
    await signup.updateSession(firstSession.id, { capacity: 5 });
    await signup.signOutOrganizer();
    const repeatRequest = await signup.submitSignup({
      sessionId: firstSession.id, playerId: playerIds.Jina,
    });
    await signup.signOutOrganizer();
    await signup.signInOrganizer({ email, password });
    await signup.approveEntry(firstSession.id, repeatRequest.entry.id);
    await signup.checkInEntry(firstSession.id, repeatRequest.entry.id);
    const openCourt = (await courts.saveCourt({
      name: `Open Court ${Date.now()}`, allowedSkills: ['beginner', 'intermediate', 'advanced'],
      division: 'open', format: 'doubles',
    })).court;
    const nextDraw = await courts.proposeCourtLineup({ sessionId: firstSession.id, courtId: openCourt.id });
    assert.ok(nextDraw.lineup);
    assert.ok([...nextDraw.lineup.sideA, ...nextDraw.lineup.sideB].includes(playerIds.Jina));

    // Simulate an older client that committed a checkout but stopped before
    // promoting the waitlist; loading/reconciling must repair the open spot.
    const waitingPlayer = adminDb.collection('players').doc();
    await waitingPlayer.set({
      name: 'Mila', nameLower: 'mila', skillLevel: 'advanced',
      division: 'woman', photoData: null, active: true, wins: 0, losses: 0,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const waiting = await signup.reservePlayer(firstSession.id, waitingPlayer.id);
    assert.equal(waiting.entry.status, 'waitlisted');
    const anaEntry = dashboard.entries.find((entry) => entry.name === 'Ana');
    await adminDb.runTransaction(async (transaction) => {
      transaction.update(adminDb.doc('sessions/' + firstSession.id + '/entries/' + anaEntry.id), {
        status: 'checked_out', checkedIn: false, checkedOutAt: new Date(),
      });
      transaction.delete(adminDb.doc('sessions/' + firstSession.id + '/playerClaims/' + playerIds.Ana));
      transaction.update(adminDb.doc('sessions/' + firstSession.id), {
        confirmedCount: 4, checkedInCount: 3,
      });
    });
    assert.equal((await signup.reconcileWaitlist(firstSession.id)).promotedCount, 1);
    assert.equal((await signup.reconcileWaitlist(firstSession.id)).promotedCount, 0);
    assert.equal((await adminDb.doc('sessions/' + firstSession.id + '/entries/' + waiting.entry.id).get()).data().status, 'confirmed');

    const concurrentWaiters = [];
    for (const name of ['Nora', 'Olive']) {
      const player = adminDb.collection('players').doc();
      await player.set({
        name, nameLower: name.toLowerCase(), skillLevel: 'advanced',
        division: 'woman', photoData: null, active: true, wins: 0, losses: 0,
        createdAt: new Date(), updatedAt: new Date(),
      });
      concurrentWaiters.push((await signup.reservePlayer(firstSession.id, player.id)).entry.id);
    }
    const beforeConcurrentClose = await signup.getAdminDashboard(date);
    const closingIds = ['Joemari', 'Stef'].map((name) =>
      beforeConcurrentClose.entries.find((entry) => entry.name === name).id);
    await Promise.all(closingIds.map((id) => signup.checkOutEntry(firstSession.id, id)));
    const afterConcurrentClose = await signup.getAdminDashboard(date);
    assert.equal(afterConcurrentClose.session.confirmedCount, 5);
    assert.equal(afterConcurrentClose.session.waitlistCount, 0);
    for (const id of concurrentWaiters) {
      assert.equal((await adminDb.doc(`sessions/${firstSession.id}/entries/${id}`).get()).data().status, 'confirmed');
    }

    const reset = await signup.resetSession(date);
    assert.notEqual(reset.session.id, firstSession.id);
    assert.equal(reset.session.confirmedCount, 0);
    assert.equal((await adminDb.doc(`sessions/${firstSession.id}`).get()).data().open, false);
    assert.equal((await adminDb.doc(`players/${playerIds.Jina}`).get()).exists, true);
  });
