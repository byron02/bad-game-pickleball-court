import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
let env;
const google = { firebase: { sign_in_provider: 'google.com' } };
const ownerAuth = { ...google, email: 'owner@example.com' };
const coachAuth = { ...google, email: 'coach@example.com' };
const strangerAuth = { ...google, email: 'stranger@example.com' };

const teamSeed = {
  name: "Ada's team playbook",
  ownerUid: 'owner',
  memberUids: ['owner'],
  members: { owner: { name: 'Ada', email: 'owner@example.com' } },
  inviteEmails: ['coach@example.com'],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z')
};

function playDoc(overrides = {}) {
  return {
    name: 'Horns',
    category: 'offense',
    court: 'half',
    json: '{"id":"horns","name":"Horns","category":"offense","steps":[]}',
    revision: 1,
    createdBy: 'owner',
    updatedBy: 'owner',
    updatedByName: 'Ada',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides
  };
}

before(async () => {
  if (!enabled) return;
  env = await initializeTestEnvironment({
    projectId: `demo-courtside-rules-${process.pid}`,
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }
  });
});

after(async () => { if (env) await env.cleanup(); });

beforeEach(async () => {
  if (!env) return;
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'courtsideTeams', 'team-one'), teamSeed);
  });
});

test('owner can create a team playbook; unsigned and anonymous cannot', { skip: !enabled }, async () => {
  const owner = env.authenticatedContext('owner', ownerAuth).firestore();
  const unsigned = env.unauthenticatedContext().firestore();
  const anon = env.authenticatedContext('anon', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
  const payload = {
    name: "Byron's team playbook",
    ownerUid: 'owner',
    memberUids: ['owner'],
    members: { owner: { name: 'Byron', email: 'owner@example.com' } },
    inviteEmails: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  await assertSucceeds(setDoc(doc(collection(owner, 'courtsideTeams')), payload));
  await assertFails(setDoc(doc(collection(unsigned, 'courtsideTeams')), payload));
  await assertFails(setDoc(doc(collection(anon, 'courtsideTeams')), { ...payload, ownerUid: 'anon' }));
});

test('invitee can read and join; stranger cannot', { skip: !enabled }, async () => {
  const coach = env.authenticatedContext('coach', coachAuth).firestore();
  const stranger = env.authenticatedContext('stranger', strangerAuth).firestore();
  const team = doc(coach, 'courtsideTeams', 'team-one');
  await assertSucceeds(getDoc(team));
  await assertFails(getDoc(doc(stranger, 'courtsideTeams', 'team-one')));
  await assertSucceeds(updateDoc(team, {
    name: teamSeed.name,
    ownerUid: 'owner',
    memberUids: ['owner', 'coach'],
    members: { ...teamSeed.members, coach: { name: 'Coach', email: 'coach@example.com' } },
    inviteEmails: [],
    createdAt: teamSeed.createdAt,
    updatedAt: serverTimestamp()
  }));
  await assertSucceeds(getDoc(doc(coach, 'courtsideTeams', 'team-one', 'plays', 'missing')));
});

test('members save plays; stale revisions fail; only creator or owner can delete', { skip: !enabled }, async () => {
  const createdAt = new Date('2026-01-02T00:00:00.000Z');
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'courtsideTeams', 'team-one'), {
      ...teamSeed,
      memberUids: ['owner', 'coach'],
      members: { ...teamSeed.members, coach: { name: 'Coach', email: 'coach@example.com' } },
      inviteEmails: []
    });
    await setDoc(doc(db, 'courtsideTeams', 'team-one', 'plays', 'play-one'), {
      name: 'Horns', category: 'offense', court: 'half',
      json: '{"id":"horns","name":"Horns","category":"offense","steps":[]}',
      revision: 1, createdBy: 'owner', updatedBy: 'owner', updatedByName: 'Ada',
      createdAt, updatedAt: createdAt
    });
  });
  const owner = env.authenticatedContext('owner', ownerAuth).firestore();
  const coach = env.authenticatedContext('coach', coachAuth).firestore();
  const stranger = env.authenticatedContext('stranger', strangerAuth).firestore();
  await assertSucceeds(setDoc(doc(owner, 'courtsideTeams', 'team-one', 'plays', 'play-two'), playDoc()));
  await assertFails(setDoc(doc(stranger, 'courtsideTeams', 'team-one', 'plays', 'sneak'), playDoc({ createdBy: 'stranger', updatedBy: 'stranger' })));
  await assertSucceeds(updateDoc(doc(coach, 'courtsideTeams', 'team-one', 'plays', 'play-one'), playDoc({
    revision: 2, updatedBy: 'coach', updatedByName: 'Coach', createdAt
  })));
  await assertFails(updateDoc(doc(coach, 'courtsideTeams', 'team-one', 'plays', 'play-one'), playDoc({
    revision: 2, updatedBy: 'coach', updatedByName: 'Coach', createdAt
  })));
  await assertFails(deleteDoc(doc(stranger, 'courtsideTeams', 'team-one', 'plays', 'play-one')));
  await assertSucceeds(deleteDoc(doc(owner, 'courtsideTeams', 'team-one', 'plays', 'play-one')));
});
