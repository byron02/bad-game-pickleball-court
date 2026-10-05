/**
 * Seed ~40 checked-in sim players into today's Manila session so Courts
 * can show a full draw + Next game preview. Uses the Admin SDK.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=... node scripts/simulate-court-draw.mjs
 *   npm run simulate:draw -- 40
 */
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { proposeLineup, courtPoolSummary, eligiblePlayersForCourt } from '../src/domain/courts.js';

const COUNT = Math.min(80, Math.max(4, Number(process.argv[2]) || 40));
const SKILLS = ['beginner', 'intermediate', 'advanced'];
const DIVISIONS = ['man', 'woman'];
const FIRST = [
  'Alex', 'Blake', 'Casey', 'Drew', 'Eden', 'Finn', 'Gray', 'Harper',
  'Indigo', 'Jules', 'Kai', 'Lane', 'Morgan', 'Noel', 'Oakley', 'Parker',
  'Quinn', 'Reese', 'Sage', 'Tatum', 'Uma', 'Vale', 'Wes', 'Xander',
  'Yael', 'Zion', 'Ari', 'Bo', 'Cruz', 'Dani', 'Eli', 'Fran',
  'Gio', 'Hana', 'Ivy', 'Jay', 'Ken', 'Lee', 'Max', 'Nico',
];
const LAST = [
  'Rivera', 'Santos', 'Cruz', 'Reyes', 'Garcia', 'Lopez', 'Torres', 'Flores',
  'Ramos', 'Mendoza', 'Navarro', 'Castillo', 'Jimenez', 'Morales', 'Ortega', 'Perez',
];

function manilaDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function simId(index) {
  return `sim-draw-${String(index).padStart(2, '0')}`;
}

function simName(index) {
  const first = FIRST[(index - 1) % FIRST.length];
  const last = LAST[(index - 1) % LAST.length];
  return `${first} ${last}`;
}

function skillFor(index) {
  return SKILLS[(index - 1) % SKILLS.length];
}

function divisionFor(index) {
  return DIVISIONS[(index - 1) % DIVISIONS.length];
}

function labelFight(lineup, byId) {
  if (!lineup) return '(no lineup)';
  const name = (id) => {
    const player = byId.get(id);
    return player ? `${player.name} (${player.gamesPlayed}g)` : id;
  };
  return `A: ${lineup.sideA.map(name).join(' + ')}  VS  B: ${lineup.sideB.map(name).join(' + ')}`;
}

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to the service account JSON path first.');
  process.exitCode = 1;
} else {
  initializeApp({ credential: applicationDefault() });
  const db = getFirestore();
  const date = manilaDate();
  const dayRef = db.doc(`daySessions/${date}`);

  let sessionId;
  await db.runTransaction(async (transaction) => {
    const day = await transaction.get(dayRef);
    if (day.exists) {
      sessionId = day.data().currentSessionId;
      return;
    }
    const fresh = db.collection('sessions').doc();
    sessionId = fresh.id;
    transaction.set(fresh, {
      date,
      cycle: 1,
      capacity: Math.max(48, COUNT),
      confirmedCount: 0,
      checkedInCount: 0,
      waitlistCount: 0,
      activeGameCount: 0,
      open: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      archivedAt: null,
    });
    transaction.set(dayRef, {
      currentSessionId: sessionId,
      cycle: 1,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  const sessionRef = db.doc(`sessions/${sessionId}`);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    console.error(`Session ${sessionId} missing.`);
    process.exitCode = 1;
  } else {
    const session = sessionSnap.data();

    // Ensure physical courts exist for Next game UI.
    const courtsSnap = await db.collection('courts').get();
    const courts = courtsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    if (!courts.length) {
      for (const [index, name] of [['court-1', 'Court 1'], ['court-2', 'Court 2']]) {
        await db.doc(`courts/${index}`).set({
          name,
          allowedSkills: [...SKILLS],
          division: 'open',
          format: 'doubles',
          activeGameId: null,
          activeSessionId: null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    } else {
      for (const court of courts) {
        await db.doc(`courts/${court.id}`).set({
          allowedSkills: [...SKILLS],
          division: 'open',
          format: court.format || 'doubles',
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }

    const missingIds = [];
    for (let i = 1; i <= COUNT; i += 1) {
      const claim = await db.doc(`sessions/${sessionId}/playerClaims/${simId(i)}`).get();
      if (!claim.exists) missingIds.push(i);
    }
    const neededCapacity = Math.max(
      Number(session.capacity || 32),
      Number(session.confirmedCount || 0) + missingIds.length,
      COUNT,
    );
    if (neededCapacity !== Number(session.capacity || 0)) {
      await sessionRef.set({ capacity: neededCapacity, open: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }

    let added = 0;
    let already = COUNT - missingIds.length;
    const batchSize = 20;
    for (let start = 0; start < missingIds.length; start += batchSize) {
      const slice = missingIds.slice(start, start + batchSize);
      const batch = db.batch();
      for (const i of slice) {
        const playerId = simId(i);
        const name = simName(i);
        const skillLevel = skillFor(i);
        const division = divisionFor(i);
        const playerRef = db.doc(`players/${playerId}`);
        const directoryRef = db.doc(`playerDirectory/${playerId}`);
        const claimRef = db.doc(`sessions/${sessionId}/playerClaims/${playerId}`);
        const entryRef = db.collection(`sessions/${sessionId}/entries`).doc();
        const checkedInAt = new Date(Date.now() - (COUNT - i) * 60_000);

        batch.set(playerRef, {
          name,
          nameLower: name.toLocaleLowerCase(),
          skillLevel,
          division,
          photoData: null,
          wins: (i % 5),
          losses: (i % 3),
          active: true,
          source: 'sim-draw',
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        batch.set(directoryRef, {
          name,
          nameLower: name.toLocaleLowerCase(),
          skillLevel,
          division,
          photoData: null,
          wins: (i % 5),
          losses: (i % 3),
        }, { merge: true });
        batch.set(entryRef, {
          sessionId,
          ownerUid: null,
          playerId,
          name,
          skillLevel,
          division,
          photoData: null,
          status: 'confirmed',
          checkedIn: true,
          source: 'sim-draw',
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          approvedAt: FieldValue.serverTimestamp(),
          reviewedAt: FieldValue.serverTimestamp(),
          checkedInAt,
          checkedOutAt: null,
        });
        batch.set(claimRef, { entryId: entryRef.id, createdAt: FieldValue.serverTimestamp() });
        added += 1;
      }
      batch.update(sessionRef, {
        confirmedCount: FieldValue.increment(slice.length),
        checkedInCount: FieldValue.increment(slice.length),
        open: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
      await batch.commit();
    }

    // Keep directory profiles fresh even when claims already exist.
    if (!missingIds.length) {
      const batch = db.batch();
      for (let i = 1; i <= COUNT; i += 1) {
        const playerId = simId(i);
        const name = simName(i);
        const skillLevel = skillFor(i);
        const division = divisionFor(i);
        batch.set(db.doc(`players/${playerId}`), {
          name,
          nameLower: name.toLocaleLowerCase(),
          skillLevel,
          division,
          active: true,
          source: 'sim-draw',
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        batch.set(db.doc(`playerDirectory/${playerId}`), {
          name,
          nameLower: name.toLocaleLowerCase(),
          skillLevel,
          division,
        }, { merge: true });
      }
      await batch.commit();
    }

    // Seed a few completed games so gamesPlayed varies in Next game priority.
    const historySnap = await db.collection(`sessions/${sessionId}/games`)
      .where('status', '==', 'completed')
      .limit(1)
      .get();
    if (historySnap.empty && COUNT >= 12) {
      const pairs = [
        [[1, 2], [3, 4]],
        [[5, 6], [7, 8]],
        [[1, 5], [9, 10]],
        [[2, 6], [11, 12]],
      ];
      for (const [index, [sideA, sideB]] of pairs.entries()) {
        const a = sideA.map(simId);
        const b = sideB.map(simId);
        const snapshots = {};
        for (const id of [...a, ...b]) {
          const n = Number(id.replace('sim-draw-', ''));
          snapshots[id] = {
            name: simName(n),
            skillLevel: skillFor(n),
            division: divisionFor(n),
          };
        }
        await db.collection(`sessions/${sessionId}/games`).doc(`sim-history-${index + 1}`).set({
          sessionId,
          courtId: 'court-1',
          courtName: 'Court 1',
          courtConfigSnapshot: {
            allowedSkills: [...SKILLS],
            division: 'open',
            format: 'doubles',
          },
          status: 'completed',
          lineup: { sideA: a, sideB: b },
          playerSnapshots: snapshots,
          replacements: [],
          result: { winningSide: 'A', scoreA: 11, scoreB: 7 },
          startedAt: new Date(Date.now() - (pairs.length - index) * 20 * 60_000),
          completedAt: new Date(Date.now() - (pairs.length - index) * 15 * 60_000),
          cancelledAt: null,
          source: 'sim-draw',
        });
      }
    }

    const entriesSnap = await db.collection(`sessions/${sessionId}/entries`).get();
    const gamesSnap = await db.collection(`sessions/${sessionId}/games`).get();
    const refreshedCourts = (await db.collection('courts').get()).docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    const entries = entriesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const games = gamesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const now = Date.now();
    const byId = new Map();
    for (const entry of entries) {
      if (!entry.playerId || entry.status !== 'confirmed' || entry.checkedIn !== true) continue;
      const checkedInAt = entry.checkedInAt?.toDate?.() || entry.checkedInAt;
      byId.set(entry.playerId, {
        id: entry.playerId,
        name: entry.name,
        skill: entry.skillLevel,
        gender: entry.division || 'unspecified',
        checkedIn: true,
        gamesPlayed: 0,
        waitMinutes: checkedInAt
          ? Math.max(0, (now - new Date(checkedInAt).getTime()) / 60000)
          : 20,
        recentPartnerIds: [],
        recentOpponentIds: [],
      });
    }
    for (const game of games.filter((item) => item.status === 'completed' && item.lineup)) {
      for (const [teammates, opponents] of [
        [game.lineup.sideA || [], game.lineup.sideB || []],
        [game.lineup.sideB || [], game.lineup.sideA || []],
      ]) {
        for (const id of teammates) {
          const player = byId.get(id);
          if (!player) continue;
          player.gamesPlayed += 1;
          if (player.gamesPlayed <= 4) {
            player.recentPartnerIds.push(...teammates.filter((other) => other !== id));
            player.recentOpponentIds.push(...opponents);
          }
        }
      }
    }
    const players = [...byId.values()];
    const pool = courtPoolSummary({ players, activeGames: games });
    const refreshed = (await sessionRef.get()).data();

    console.log(`Date: ${date}`);
    console.log(`Session: ${sessionId}`);
    console.log(`Capacity: ${refreshed.capacity} · confirmed ${refreshed.confirmedCount} · checked in ${refreshed.checkedInCount}`);
    console.log(`Sim players: added ${added}, already claimed ${already}, target ${COUNT}`);
    console.log(`Pool: ${pool.waiting} waiting · ${pool.onCourt} on court`);
    console.log('');

    for (const court of refreshedCourts.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }))) {
      const eligible = eligiblePlayersForCourt({ court, players, activeGames: games });
      const lineup = proposeLineup({
        court,
        players,
        activeGames: games,
        random: () => 0.42,
      });
      console.log(`${court.name} (${court.division || 'open'} / ${(court.allowedSkills || []).join(', ') || 'skills'})`);
      console.log(`  eligible: ${eligible.length}`);
      console.log(`  next fight: ${labelFight(lineup, byId)}`);
      console.log('');
    }

    console.log('Open Courts in admin and hard-refresh to see the draw + Next game.');
  }
}
