import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  collection, doc, endAt, getDoc, getDocs, limit, orderBy, query, serverTimestamp,
  setDoc, startAt, updateDoc,
} from 'firebase/firestore';

// Run with:
// npx firebase emulators:exec --only firestore "node --test tests/firebase-rules.test.js"
// npm test skips this suite when no Firestore emulator is running.
const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
let env;
const sessionId = 'random-shared-session-token';
const sessionData = (capacity = 32) => ({
  date: '2026-10-05', cycle: 1, capacity, confirmedCount: 0,
  checkedInCount: 0, waitlistCount: 0, open: true,
  createdAt: new Date(), updatedAt: new Date(), archivedAt: null,
});
const anonymous = { firebase: { sign_in_provider: 'anonymous' } };
const password = { firebase: { sign_in_provider: 'password' } };
const playerData = {
  name: 'Ana Cruz', nameLower: 'ana cruz', skillLevel: 'intermediate',
  division: 'woman', photoData: null, active: true, wins: 0, losses: 0,
  createdAt: new Date(), updatedAt: new Date(),
};

function request(uid, overrides = {}) {
  return {
    sessionId, ownerUid: uid, playerId: null, name: 'New Player',
    skillLevel: 'beginner', division: 'unspecified', photoData: null,
    status: 'pending', checkedIn: false, source: 'public',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    approvedAt: null, reviewedAt: null, checkedInAt: null, checkedOutAt: null,
    ...overrides,
  };
}

before(async () => {
  if (!enabled) return;
  env = await initializeTestEnvironment({
    projectId: `demo-bad-game-rules-${process.pid}`,
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });
});

after(async () => { if (env) await env.cleanup(); });

beforeEach(async () => {
  if (!env) return;
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'sessions', sessionId), sessionData());
    await setDoc(doc(db, 'organizers', 'organizer'), { active: true });
  });
});

test('anonymous player can request a pending place but cannot reserve a slot or alter the request',
  { skip: !enabled }, async () => {
    const db = env.authenticatedContext('player-one', anonymous).firestore();
    const entry = doc(db, 'sessions', sessionId, 'entries', 'player-one');
    await assertSucceeds(setDoc(entry, request('player-one')));
    assert.equal((await getDoc(entry)).data().status, 'pending');
    await assertFails(updateDoc(entry, { status: 'confirmed' }));
    await assertFails(setDoc(entry, request('player-one', { name: 'Another Name' })));
    await assertFails(setDoc(doc(db, 'sessions', sessionId, 'entries', 'someone-else'), request('player-one')));
    await assertFails(setDoc(doc(db, 'sessions', sessionId, 'entries', 'player-two'),
      request('player-one', { status: 'confirmed' })));
  });

test('existing-player claim must match the approved directory and cannot overwrite it',
  { skip: !enabled }, async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'players', 'ana'), playerData);
    });
    const db = env.authenticatedContext('player-two', anonymous).firestore();
    const entry = doc(db, 'sessions', sessionId, 'entries', 'player-two');
    await assertFails(setDoc(entry, request('player-two', {
      playerId: 'ana', name: 'Ana Cruz', skillLevel: 'advanced', division: 'woman',
    })));
    await assertSucceeds(setDoc(entry, request('player-two', {
      playerId: 'ana', name: 'Ana Cruz', skillLevel: 'intermediate', division: 'woman',
    })));
    await assertFails(updateDoc(doc(db, 'players', 'ana'), { skillLevel: 'advanced' }));
  });

test('unapproved users cannot change capacity, organizer access, or private courts',
  { skip: !enabled }, async () => {
    const db = env.authenticatedContext('intruder', password).firestore();
    await assertFails(setDoc(doc(db, 'organizers', 'intruder'), { active: true }));
    await assertFails(updateDoc(doc(db, 'sessions', sessionId), { capacity: 100 }));
    await assertFails(setDoc(doc(db, 'courts', 'court-1'), { name: 'Court 1' }));
    await assertFails(getDoc(doc(db, 'daySessions', '2026-10-05')));
  });

test('organizer can approve within capacity, but invalid aggregate counts are rejected',
  { skip: !enabled }, async () => {
    const db = env.authenticatedContext('organizer', password).firestore();
    const session = doc(db, 'sessions', sessionId);
    const entry = doc(db, 'sessions', sessionId, 'entries', 'approved-player');
    await assertSucceeds(setDoc(entry, request('approved-player', {
      status: 'confirmed', source: 'organizer', ownerUid: null, playerId: 'ana',
    })));
    await assertSucceeds(updateDoc(session, { confirmedCount: 32 }));
    await assertFails(updateDoc(session, { confirmedCount: 33 }));
    await assertFails(updateDoc(session, { checkedInCount: 33 }));
    await assertFails(updateDoc(session, { capacity: 20 }));
  });

test('public search reads only the approved directory; full profiles and sessions stay private',
  { skip: !enabled }, async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'players', 'ana'), playerData);
      await setDoc(doc(context.firestore(), 'players', 'hidden'), {
        ...playerData, name: 'Hidden', nameLower: 'hidden', active: false,
      });
      await setDoc(doc(context.firestore(), 'playerDirectory', 'ana'), {
        name: 'Ana Cruz', nameLower: 'ana cruz', skillLevel: 'intermediate',
        division: 'woman', photoData: null, wins: 2, losses: 1,
      });
    });
    const db = env.authenticatedContext('player-three', anonymous).firestore();
    const found = await assertSucceeds(getDocs(query(
      collection(db, 'playerDirectory'), orderBy('nameLower'),
      startAt('an'), endAt('an\uf8ff'), limit(20),
    )));
    assert.equal(found.docs.length, 1);
    const standings = await assertSucceeds(getDocs(query(
      collection(db, 'playerDirectory'), orderBy('wins', 'desc'), limit(20),
    )));
    assert.equal(standings.docs[0].id, 'ana');
    assert.equal(standings.docs[0].data().wins, 2);
    await assertFails(getDocs(collection(db, 'playerDirectory')));
    await assertFails(setDoc(doc(db, 'playerDirectory', 'intruder'), {
      name: 'Intruder', nameLower: 'intruder', skillLevel: 'advanced', division: 'man', photoData: null,
    }));
    await assertFails(getDocs(collection(db, 'players')));
    await assertFails(getDocs(collection(db, 'sessions')));
    await assertFails(getDocs(collection(db, 'sessions', sessionId, 'entries')));
    await assertFails(getDoc(doc(db, 'courts', 'court-1')));
  });

test('closed signup links reject new requests', { skip: !enabled }, async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await updateDoc(doc(context.firestore(), 'sessions', sessionId), { open: false });
  });
  const db = env.authenticatedContext('late-player', anonymous).firestore();
  await assertFails(setDoc(doc(db, 'sessions', sessionId, 'entries', 'late-player'), request('late-player')));
});

test('organizer can add another email and that account is authorized immediately', { skip: !enabled }, async () => {
  const google = { email: 'owner@example.com', firebase: { sign_in_provider: 'google.com' } };
  const helper = { email: 'helper@example.com', firebase: { sign_in_provider: 'google.com' } };
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'organizers', 'owner'), {
      active: true, email: 'owner@example.com',
    });
  });
  const ownerDb = env.authenticatedContext('owner', google).firestore();
  await assertSucceeds(setDoc(doc(ownerDb, 'organizerEmails', 'helper@example.com'), {
    email: 'helper@example.com',
    active: true,
    addedByUid: 'owner',
    addedByEmail: 'owner@example.com',
  }));
  const helperDb = env.authenticatedContext('helper', helper).firestore();
  await assertSucceeds(updateDoc(doc(helperDb, 'sessions', sessionId), { capacity: 40 }));
  await assertSucceeds(setDoc(doc(helperDb, 'organizers', 'helper'), {
    active: true, email: 'helper@example.com',
  }));
});

test('users not on the organizer email list cannot add themselves', { skip: !enabled }, async () => {
  const google = { email: 'outsider@example.com', firebase: { sign_in_provider: 'google.com' } };
  const db = env.authenticatedContext('outsider', google).firestore();
  await assertFails(setDoc(doc(db, 'organizers', 'outsider'), {
    active: true, email: 'outsider@example.com',
  }));
  await assertFails(setDoc(doc(db, 'organizerEmails', 'outsider@example.com'), {
    email: 'outsider@example.com', active: true,
  }));
  await assertFails(setDoc(doc(db, 'organizerEmails', 'friend@example.com'), {
    email: 'friend@example.com', active: true,
  }));
});
