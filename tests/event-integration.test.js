import test from 'node:test';
import assert from 'node:assert/strict';

// Run with Firebase Auth and Firestore emulators. Never point this test at live data.
const enabled = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST);

test('event registrations, tournament lifecycle, corrections, and private records',
  { skip: !enabled }, async (t) => {
    globalThis.location = { hostname: 'localhost', port: '5000', origin: 'http://localhost:5000' };
    const { initializeApp: initializeAdmin, deleteApp: deleteAdmin } = await import('firebase-admin/app');
    const { getApps, deleteApp } = await import('firebase/app');
    const { getAuth: getAdminAuth } = await import('firebase-admin/auth');
    const { getFirestore: getAdminDb } = await import('firebase-admin/firestore');
    const { doc, getDoc, setDoc } = await import('firebase/firestore');
    const auth = await import('../src/firebaseStore.js');
    const events = await import('../src/eventStore.js');
    const courts = await import('../src/courtStore.js');

    const adminApp = initializeAdmin({ projectId: 'bad-game-pickleball' }, `events-${process.pid}`);
    t.after(async () => {
      await auth.signOutOrganizer().catch(() => {});
      await Promise.all(getApps().map((app) => deleteApp(app)));
      await deleteAdmin(adminApp);
      delete globalThis.location;
    });
    const adminAuth = getAdminAuth(adminApp);
    const adminDb = getAdminDb(adminApp);
    const email = `event-organizer-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const password = 'Test-password-123!';
    const organizer = await adminAuth.createUser({ email, password });
    await adminDb.doc(`organizers/${organizer.uid}`).set({ active: true, email });
    await auth.signInOrganizer({ email, password });

    await t.test('a singles knockout records one match win, corrects it once, and saves champion', async () => {
      const created = await events.createEvent({
        title: 'Singles Championship', date: '2099-01-02', startTime: '09:00',
        kind: 'tournament', discipline: 'singles', format: 'single_elimination',
        capacity: 4, scoreTarget: 11, bestOf: 1,
      });
      const eventId = created.event.id;
      assert.equal((await events.getAdminEvent(eventId)).event.title, 'Singles Championship');
      for (const name of ['Ana', 'Jina', 'Stef', 'Joemari']) {
        const added = await events.addEventPlayers(eventId, [{
          name, skillLevel: 'intermediate', division: 'unspecified',
        }]);
        assert.equal(added.status, 'confirmed');
      }
      let snapshot = await events.getAdminEvent(eventId);
      assert.equal(snapshot.event.approvedCount, 4);
      for (const registration of snapshot.registrations) {
        await events.checkInEventSignup(eventId, registration.id, true);
      }
      snapshot = await events.getAdminEvent(eventId);
      assert.equal(snapshot.registrations.filter((entry) => entry.checkedIn).length, 4);
      const court = (await courts.saveCourt({
        name: `Event Singles ${Date.now()}`, allowedSkills: ['beginner', 'intermediate', 'advanced'],
        division: 'open', format: 'singles',
      })).court;
      await events.startEventSchedule(eventId);
      snapshot = await events.getAdminEvent(eventId);
      assert.equal(snapshot.event.status, 'in_progress');
      const semi = snapshot.matches.filter((match) => match.round === 1);
      assert.equal(semi.length, 2);
      assert.ok(semi.every((match) => match.status === 'ready'));

      const first = semi[0];
      await events.assignEventMatchCourt(eventId, first.id, court.id);
      await events.startEventMatch(eventId, first.id);
      await events.assignEventMatchCourt(eventId, semi[1].id, court.id);
      await assert.rejects(events.startEventMatch(eventId, semi[1].id), /court|busy/i);
      const activeMatch = (await events.getAdminEvent(eventId)).matches.find((match) => match.id === first.id);
      await assert.rejects(courts.completeCourtGame({
        sessionId: eventId, gameId: activeMatch.gameId, winnerSide: 'A',
      }), /event desk/i);
      await assert.rejects(courts.cancelCourtGame({
        sessionId: eventId, gameId: activeMatch.gameId,
      }), /event desk/i);
      await events.cancelEventMatch(eventId, first.id);
      assert.equal((await adminDb.doc(`sessions/${eventId}`).get()).data().activeGameCount, 0);
      assert.equal((await adminDb.doc(`courts/${court.id}`).get()).data().activeGameId, null);
      for (const playerId of first.sidePlayerIds.flat()) {
        assert.equal((await adminDb.doc(`sessions/${eventId}/playerLocks/${playerId}`).get()).exists, false);
        const player = (await adminDb.doc(`players/${playerId}`).get()).data();
        assert.equal(player.wins + player.losses, 0);
      }
      assert.equal((await events.getAdminEvent(eventId)).matches.find((match) => match.id === first.id).status, 'ready');
      await events.startEventMatch(eventId, first.id);
      await assert.rejects(events.recordEventMatch(eventId, first.id, { games: [{ a: 11, b: 10 }] }),
        /two points/i);
      await assert.rejects(events.recordEventMatch(eventId, first.id, { games: [{ a: 25, b: 0 }] }),
        /valid score/i, 'winning points cannot exceed the target before deuce');
      await assert.rejects(events.recordEventMatch(eventId, first.id, { games: [{ a: 13, b: 10 }] }),
        /valid score/i, 'a deuce game ends at a two-point lead');
      await events.recordEventMatch(eventId, first.id, { games: [{ a: 11, b: 8 }] });
      const [firstA, firstB] = first.sidePlayerIds.map((side) => side[0]);
      assert.equal((await adminDb.doc(`players/${firstA}`).get()).data().wins, 1);
      assert.equal((await adminDb.doc(`players/${firstB}`).get()).data().losses, 1);
      assert.equal((await events.recordEventMatch(eventId, first.id, { games: [{ a: 11, b: 8 }] })).applied, false);
      assert.equal((await adminDb.doc(`players/${firstA}`).get()).data().wins, 1);

      await events.correctEventMatch(eventId, first.id, { games: [{ a: 12, b: 10 }] });
      assert.equal((await adminDb.doc(`players/${firstA}`).get()).data().wins, 1,
        'a valid deuce score correction still counts as one match win');
      await events.correctEventMatch(eventId, first.id, { games: [{ a: 11, b: 7 }] });
      assert.equal((await adminDb.doc(`players/${firstA}`).get()).data().wins, 1,
        'changing points with the same winner does not add a second win');
      await events.correctEventMatch(eventId, first.id, { games: [{ a: 8, b: 11 }] });
      assert.equal((await adminDb.doc(`players/${firstA}`).get()).data().wins, 0);
      assert.equal((await adminDb.doc(`players/${firstA}`).get()).data().losses, 1);
      assert.equal((await adminDb.doc(`players/${firstB}`).get()).data().wins, 1);
      assert.equal((await adminDb.doc(`players/${firstB}`).get()).data().losses, 0);
      snapshot = await events.getAdminEvent(eventId);
      assert.ok(snapshot.audit.some((entry) => entry.action === 'correct_match'));

      const second = semi[1];
      await events.assignEventMatchCourt(eventId, second.id, court.id);
      await events.startEventMatch(eventId, second.id);
      await events.recordEventMatch(eventId, second.id, { games: [{ a: 11, b: 9 }] });
      await events.advanceEventRound(eventId);
      snapshot = await events.getAdminEvent(eventId);
      const final = snapshot.matches.find((match) => match.round === 2);
      assert.ok(final);
      assert.deepEqual(final.sides,
        [snapshot.matches.find((match) => match.id === first.id).winnerId,
          snapshot.matches.find((match) => match.id === second.id).winnerId]);
      await events.assignEventMatchCourt(eventId, final.id, court.id);
      await events.startEventMatch(eventId, final.id);
      await assert.rejects(events.correctEventMatch(eventId, first.id, { games: [{ a: 11, b: 8 }] }),
        /dependent|started|later/i, 'a semifinal winner cannot change after the final starts');
      await events.recordEventMatch(eventId, final.id, { games: [{ a: 11, b: 5 }] });
      await events.finishEvent(eventId);
      snapshot = await events.getAdminEvent(eventId);
      assert.equal(snapshot.event.status, 'completed');
      assert.deepEqual(snapshot.event.champions.map((champion) => champion.playerId), final.sidePlayerIds[0]);
      assert.equal((await adminDb.doc(`sessions/${eventId}`).get()).data().open, false);
      assert.ok(snapshot.audit.some((entry) => entry.action === 'finish_event'));
    });

    await t.test('a knockout bye advances without a free win', async () => {
      const created = await events.createEvent({
        title: 'Three Player Singles', date: '2099-01-05', startTime: '08:00',
        kind: 'tournament', discipline: 'singles', format: 'single_elimination', capacity: 3,
      });
      const eventId = created.event.id;
      for (const name of ['Alex', 'Blair', 'Casey']) {
        await events.addEventPlayers(eventId, [{ name, skillLevel: 'beginner', division: 'unspecified' }]);
      }
      for (const registration of (await events.getAdminEvent(eventId)).registrations) {
        await events.checkInEventSignup(eventId, registration.id);
      }
      const court = (await courts.saveCourt({
        name: `Bye Court ${Date.now()}`, allowedSkills: ['beginner'],
        division: 'open', format: 'singles',
      })).court;
      await events.startEventSchedule(eventId);
      let snapshot = await events.getAdminEvent(eventId);
      const opening = snapshot.matches.filter((match) => match.round === 1);
      const bye = opening.find((match) => match.status === 'bye');
      const playable = opening.find((match) => match.status === 'ready');
      assert.ok(bye && playable);
      assert.equal((await adminDb.doc(`players/${bye.winnerId}`).get()).data().wins, 0);
      await events.assignEventMatchCourt(eventId, playable.id, court.id);
      await events.startEventMatch(eventId, playable.id);
      await events.recordEventMatch(eventId, playable.id, { games: [{ a: 11, b: 7 }] });
      await events.advanceEventRound(eventId);
      snapshot = await events.getAdminEvent(eventId);
      const final = snapshot.matches.find((match) => match.round === 2);
      assert.ok(final.sides.includes(bye.winnerId));
      assert.ok(final.sides.includes(playable.sides[0]));
      assert.equal((await adminDb.doc(`players/${bye.winnerId}`).get()).data().wins, 0);
      await events.assignEventMatchCourt(eventId, final.id, court.id);
      await events.startEventMatch(eventId, final.id);
      await events.recordEventMatch(eventId, final.id, { games: [{ a: 11, b: 8 }] });
      await events.finishEvent(eventId);
      assert.equal((await events.getAdminEvent(eventId)).event.status, 'completed');
    });

    await t.test('round-robin pools produce qualifiers and a recorded playoff final', async () => {
      const created = await events.createEvent({
        title: 'Pool Singles Cup', date: '2099-01-06', startTime: '11:00',
        kind: 'tournament', discipline: 'singles', format: 'round_robin',
        roundRobinMode: 'pools', poolSize: 4, capacity: 6,
      });
      const eventId = created.event.id;
      for (const name of ['Avery', 'Bailey', 'Cameron', 'Drew', 'Ellis', 'Frankie']) {
        await events.addEventPlayers(eventId, [{ name, skillLevel: 'intermediate', division: 'unspecified' }]);
      }
      for (const registration of (await events.getAdminEvent(eventId)).registrations) {
        await events.checkInEventSignup(eventId, registration.id);
      }
      const court = (await courts.saveCourt({
        name: `Pool Court ${Date.now()}`, allowedSkills: ['intermediate'],
        division: 'open', format: 'singles',
      })).court;
      await events.startEventSchedule(eventId);
      for (let round = 1; round <= 3; round += 1) {
        const snapshot = await events.getAdminEvent(eventId);
        assert.equal(snapshot.event.phase, 'round_robin');
        const matches = snapshot.matches.filter((match) =>
          match.stage === 'round_robin' && match.round === round);
        assert.equal(matches.length, 2);
        assert.deepEqual(new Set(matches.map((match) => match.poolId)), new Set(['P1', 'P2']));
        for (const match of matches) {
          await events.assignEventMatchCourt(eventId, match.id, court.id);
          await events.startEventMatch(eventId, match.id);
          await events.recordEventMatch(eventId, match.id, { games: [{ a: 11, b: 7 }] });
        }
        await events.advanceEventRound(eventId);
      }
      let snapshot = await events.getAdminEvent(eventId);
      assert.equal(snapshot.event.phase, 'playoffs');
      const final = snapshot.matches.find((match) => match.stage === 'knockout');
      assert.ok(final);
      assert.equal(final.sides.filter(Boolean).length, 2);
      await events.assignEventMatchCourt(eventId, final.id, court.id);
      await events.startEventMatch(eventId, final.id);
      await events.recordEventMatch(eventId, final.id, { games: [{ a: 11, b: 9 }] });
      await events.finishEvent(eventId);
      snapshot = await events.getAdminEvent(eventId);
      assert.equal(snapshot.event.status, 'completed');
      assert.equal(snapshot.event.champions.length, 1);
      assert.ok(snapshot.audit.some((entry) => entry.action === 'advance_round' && entry.phase === 'playoffs'));
    });

    await t.test('rotating doubles selects four finalists and co-champions', async () => {
      const created = await events.createEvent({
        title: 'Rotating Doubles Cup', date: '2099-01-04', startTime: '09:30',
        kind: 'tournament', discipline: 'doubles', teamMode: 'rotating',
        format: 'round_robin', roundRobinMode: 'full', capacity: 4, rounds: 1,
        scoreTarget: 11, bestOf: 3,
      });
      const eventId = created.event.id;
      for (const name of ['Maya', 'Lia', 'Noah', 'Kai']) {
        await events.addEventPlayers(eventId, [{
          name, skillLevel: 'intermediate', division: 'unspecified',
        }]);
      }
      for (const registration of (await events.getAdminEvent(eventId)).registrations) {
        await events.checkInEventSignup(eventId, registration.id);
      }
      const court = (await courts.saveCourt({
        name: `Event Doubles ${Date.now()}`, allowedSkills: ['beginner', 'intermediate', 'advanced'],
        division: 'open', format: 'doubles',
      })).court;
      await events.startEventSchedule(eventId);
      let snapshot = await events.getAdminEvent(eventId);
      const opening = snapshot.matches.find((match) => match.stage === 'rotating_doubles');
      assert.ok(opening);
      assert.equal(opening.sidePlayerIds.flat().length, 4);
      await events.assignEventMatchCourt(eventId, opening.id, court.id);
      await events.startEventMatch(eventId, opening.id);
      await events.recordEventMatch(eventId, opening.id, { games: [{ a: 11, b: 6 }, { a: 11, b: 8 }] });
      await events.advanceEventRound(eventId);
      snapshot = await events.getAdminEvent(eventId);
      const final = snapshot.matches.find((match) => match.stage === 'rotating_doubles_final');
      assert.ok(final);
      assert.equal(final.sidePlayerIds.flat().length, 4);
      await events.assignEventMatchCourt(eventId, final.id, court.id);
      await events.startEventMatch(eventId, final.id);
      await events.recordEventMatch(eventId, final.id, { games: [
        { a: 11, b: 9 }, { a: 8, b: 11 }, { a: 11, b: 9 },
      ] });
      await events.finishEvent(eventId);
      snapshot = await events.getAdminEvent(eventId);
      assert.deepEqual(snapshot.event.champions.map((champion) => champion.playerId), final.sidePlayerIds[0]);
      for (const playerId of final.sidePlayerIds.flat()) {
        const player = (await adminDb.doc(`players/${playerId}`).get()).data();
        assert.equal(player.wins + player.losses, 2, 'each completed match counts once per player');
      }
    });

    await t.test('fixed doubles reserve both spots together and waitlist teams together', async () => {
      const created = await events.createEvent({
        title: 'Doubles Winner Takes All', date: '2099-01-03', startTime: '10:00',
        kind: 'tournament', discipline: 'doubles', teamMode: 'fixed',
        format: 'single_elimination', capacity: 3, prize: 'Winner takes all',
      });
      const eventId = created.event.id;
      const player = (name) => ({ name, skillLevel: 'intermediate', division: 'unspecified', photoData: null });
      await auth.signOutOrganizer();
      const anon = await auth.ensurePublicAuth();
      const db = auth.initializeClient().db;
      assert.equal((await getDoc(doc(db, 'publicEvents', eventId))).exists(), true);
      await assert.rejects(getDoc(doc(db, 'events', eventId)), /permission/i,
        'private event records must stay organizer-only');
      await assert.rejects(setDoc(doc(db, 'events', eventId, 'matches', 'fake'), { winnerSide: 'A' }), /permission/i);
      const request1 = await events.submitEventSignup({
        eventId, players: [player('Jina'), player('Ana')], teamName: 'First Pair',
      });
      assert.equal(request1.registration.status, 'pending');
      await auth.signOutOrganizer();
      await auth.signInOrganizer({ email, password });
      assert.equal((await events.getAdminEvent(eventId)).event.approvedCount, 0,
        'a pending request does not hold a spot');
      const first = await events.approveEventSignup(eventId, request1.registration.id);
      assert.equal(first.status, 'confirmed');
      await events.checkInEventSignup(eventId, request1.registration.id, true);
      assert.equal((await adminDb.doc(`sessions/${eventId}`).get()).data().checkedInCount, 2);
      await events.checkInEventSignup(eventId, request1.registration.id, false);
      assert.equal((await adminDb.doc(`sessions/${eventId}`).get()).data().checkedInCount, 0);

      await auth.signOutOrganizer();
      const request2 = await events.submitEventSignup({
        eventId, players: [player('Joemari'), player('Stef')], teamName: 'Second Pair',
      });
      await auth.signOutOrganizer();
      await auth.signInOrganizer({ email, password });
      const second = await events.approveEventSignup(eventId, request2.registration.id);
      assert.equal(second.status, 'waitlisted', 'one free spot must not split a doubles team');
      await auth.signOutOrganizer();
      const troll = await events.submitEventSignup({
        eventId, players: [player('Suspicious'), player('Request')], teamName: 'Troll team',
      });
      await auth.signOutOrganizer();
      await auth.signInOrganizer({ email, password });
      await events.rejectEventSignup(eventId, troll.registration.id);
      assert.equal((await events.getAdminEvent(eventId)).registrations.find((item) =>
        item.id === troll.registration.id).status, 'rejected');
      let snapshot = await events.getAdminEvent(eventId);
      assert.equal(snapshot.event.approvedCount, 2);
      assert.equal(snapshot.event.waitlistCount, 2);
      assert.equal(snapshot.registrations.find((item) => item.id === request2.registration.id).checkedIn, false);
      await assert.rejects(events.checkInEventSignup(eventId, request2.registration.id, true), /confirmed/i);
      await events.removeEventSignup(eventId, request1.registration.id);
      snapshot = await events.getAdminEvent(eventId);
      assert.equal(snapshot.registrations.find((item) => item.id === request2.registration.id).status, 'confirmed');
      assert.equal(snapshot.event.approvedCount, 2);
      assert.equal(snapshot.event.waitlistCount, 0);
      assert.equal(snapshot.teams.some((team) => team.name === 'Second Pair'), true);
    });

    await t.test('approval rejects a forged team containing one player twice', async () => {
      const { event } = await events.createEvent({
        title: 'Duplicate Player Guard', date: '2099-01-05', startTime: '10:00',
        kind: 'tournament', discipline: 'doubles', teamMode: 'fixed',
        format: 'single_elimination', capacity: 4,
      });
      const playerId = `duplicate-${Date.now()}`;
      const profile = {
        playerId, name: 'Ana Cruz', skillLevel: 'intermediate',
        division: 'woman', photoData: null,
      };
      await adminDb.doc(`players/${playerId}`).set({
        ...profile, active: true, wins: 0, losses: 0,
      });
      await adminDb.doc(`events/${event.id}/registrations/forged-team`).set({
        eventId: event.id, ownerUid: 'forged-owner', players: [profile, profile],
        teamName: 'Impossible team', status: 'pending', checkedIn: false,
        source: 'public', playerIds: [], entryIds: [], createdAt: new Date(),
      });
      await assert.rejects(events.approveEventSignup(event.id, 'forged-team'), /different players/i);
      assert.equal((await adminDb.doc(`sessions/${event.id}`).get()).data().confirmedCount, 0);
    });
  });
