import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  connectFirestoreEmulator,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  startAt,
  endAt,
  where,
  increment,
} from 'firebase/firestore';
import { firebaseConfig } from './firebaseConfig.js';

// The Firebase web config is public project metadata. Organizer authorization is
// enforced by Firestore rules and /organizers/{uid}, never by this client code.
let app;
let auth;
let db;
const SKILLS = new Set(['beginner', 'intermediate', 'advanced']);
const DIVISIONS = new Set(['woman', 'man', 'unspecified']);
const MAX_AVATAR_CHARS = 120000;
let publicAuthPromise;

export function initializeClient() {
  if (db) return { app, auth, db };
  const required = ['apiKey', 'authDomain', 'projectId', 'appId'];
  if (required.some((key) => !firebaseConfig?.[key] || /REPLACE|YOUR_|TODO/i.test(firebaseConfig[key]))) {
    throw error('Firebase web config missing. Add the web app apiKey and appId in src/firebaseConfig.js.', 'configuration');
  }
  app = getApps()[0] || initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  if (typeof location !== 'undefined' &&
      ['localhost', '127.0.0.1'].includes(location.hostname) && location.port === '5000') {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
  return { app, auth, db };
}

function error(message, code = 'invalid-argument') {
  const result = new Error(message);
  result.code = code;
  return result;
}

function timestamp(value) {
  if (!value) return null;
  return typeof value.toDate === 'function' ? value.toDate().toISOString() : value;
}

function todayManila() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw error('Choose a valid date.');
  }
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw error('Choose a valid date.');
  }
  return value;
}

function validName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) throw error('Name must be 2 to 60 characters.');
  return name;
}

function validSkill(value) {
  const skill = String(value || '').toLowerCase();
  if (!SKILLS.has(skill)) throw error('Choose beginner, intermediate, or advanced.');
  return skill;
}

function validDivision(value) {
  const division = String(value || 'unspecified').toLowerCase();
  if (!DIVISIONS.has(division)) throw error('Choose woman, man, or unspecified.');
  return division;
}

function validPhoto(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_AVATAR_CHARS ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value)) {
    throw error('Use a small JPEG photo (about 90 KB or less).');
  }
  return value;
}

function sessionRef(sessionId) { initializeClient(); return doc(db, 'sessions', sessionId); }
function dayRef(date) { initializeClient(); return doc(db, 'daySessions', date); }
function playerRef(playerId) { initializeClient(); return doc(db, 'players', playerId); }
function directoryRef(playerId) { initializeClient(); return doc(db, 'playerDirectory', playerId); }
function entryRef(sessionId, entryId) { initializeClient(); return doc(db, 'sessions', sessionId, 'entries', entryId); }
function claimRef(sessionId, playerId) { initializeClient(); return doc(db, 'sessions', sessionId, 'playerClaims', playerId); }
function playerLockRef(sessionId, playerId) { initializeClient(); return doc(db, 'sessions', sessionId, 'playerLocks', playerId); }

function normalizedSession(snapshot) {
  if (!snapshot?.exists()) return null;
  const value = snapshot.data();
  const confirmedCount = value.confirmedCount || 0;
  const capacity = value.capacity || 32;
  const id = snapshot.id;
  return {
    id,
    shareToken: id,
    signupUrl: typeof location === 'undefined' ? `/join?token=${id}` : `${location.origin}/join?token=${id}`,
    date: value.date,
    cycle: value.cycle || 1,
    capacity,
    confirmedCount,
    checkedInCount: value.checkedInCount || 0,
    activeGameCount: value.activeGameCount || 0,
    pendingCount: value.pendingCount || 0,
    waitlistCount: value.waitlistCount || 0,
    spotsLeft: Math.max(0, capacity - confirmedCount),
    open: value.open === true,
    createdAt: timestamp(value.createdAt),
    archivedAt: timestamp(value.archivedAt),
  };
}

function normalizedPlayer(snapshot) {
  const value = snapshot.data();
  return {
    id: snapshot.id,
    name: value.name,
    skillLevel: value.skillLevel,
    division: value.division || 'unspecified',
    photoData: value.photoData || null,
    photoUrl: value.photoData || null,
    active: value.active !== false,
    wins: value.wins || 0,
    losses: value.losses || 0,
    createdAt: timestamp(value.createdAt),
  };
}

function normalizedEntry(snapshot, players = new Map()) {
  const value = snapshot.data();
  const player = value.playerId ? players.get(value.playerId) : null;
  const photoData = value.photoData || player?.photoData || null;
  return {
    id: snapshot.id,
    playerId: value.playerId || null,
    name: player?.name || value.name,
    skillLevel: player?.skillLevel || value.skillLevel,
    division: player?.division || value.division || 'unspecified',
    photoData,
    photoUrl: photoData,
    status: value.status,
    checkedIn: value.checkedIn === true,
    source: value.source,
    ownerUid: value.ownerUid || null,
    createdAt: timestamp(value.createdAt),
    approvedAt: timestamp(value.approvedAt),
    reviewedAt: timestamp(value.reviewedAt),
    checkedInAt: timestamp(value.checkedInAt),
    checkedOutAt: timestamp(value.checkedOutAt),
    partnerPlayerId: value.partnerPlayerId || null,
  };
}

function summarize(session, entries) {
  if (!session) return null;
  const pendingCount = entries.filter((entry) => entry.status === 'pending').length;
  const checkedInCount = entries.filter((entry) => entry.status === 'confirmed' && entry.checkedIn).length;
  return { ...session, pendingCount, checkedInCount };
}

function authReady(timeoutMs = 15000) {
  initializeClient();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(error('Firebase Auth did not respond. Reload the page or check your connection.', 'timeout'));
    }, timeoutMs);
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(user);
    });
  });
}

export async function getCurrentUser() { return authReady(); }
export function watchAuth(callback) {
  try {
    initializeClient();
    return onAuthStateChanged(auth, callback);
  } catch (cause) {
    queueMicrotask(() => callback(null, cause));
    return () => {};
  }
}

async function ensurePublicAuth() {
  const current = await authReady();
  if (current) return current;
  if (!publicAuthPromise) {
    publicAuthPromise = signInAnonymously(auth).then((result) => result.user)
      .finally(() => { publicAuthPromise = null; });
  }
  return publicAuthPromise;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw error('Enter a valid email address.', 'invalid-argument');
  }
  return email;
}

async function readOrganizerPermit(reference) {
  try {
    return await Promise.race([
      getDocFromServer(reference),
      new Promise((_, reject) => {
        setTimeout(() => reject(error('Organizer check timed out.', 'timeout')), 10000);
      }),
    ]);
  } catch (cause) {
    if (cause?.code === 'timeout') {
      try { return await getDoc(reference); } catch { throw cause; }
    }
    return getDoc(reference);
  }
}

async function syncOrganizerUidDoc(user, email) {
  try {
    await setDoc(doc(db, 'organizers', user.uid), {
      active: true,
      email,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    }, { merge: true });
  } catch {
    // Rules or network may block the sync; email access still authorizes the desk.
  }
}

async function ensureOrganizer() {
  const user = await authReady();
  if (!user) throw error('Organizer sign-in is required.', 'auth-required');
  if (user.isAnonymous) throw error('Organizer sign-in is required.', 'auth-required');

  const uidPermit = await readOrganizerPermit(doc(db, 'organizers', user.uid));
  if (uidPermit.exists() && uidPermit.data().active === true) {
    if (user.email) {
      const email = normalizeEmail(user.email);
      try {
        await setDoc(doc(db, 'organizerEmails', email), {
          email,
          active: true,
          updatedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
        }, { merge: true });
      } catch {
        // Already authorized by UID; listing sync is best-effort.
      }
    }
    return user;
  }

  if (user.email) {
    const email = normalizeEmail(user.email);
    const emailPermit = await readOrganizerPermit(doc(db, 'organizerEmails', email));
    if (emailPermit.exists() && emailPermit.data().active === true) {
      await syncOrganizerUidDoc(user, email);
      return user;
    }
  }

  throw error(`The account ${user.email || 'you selected'} is not approved as an organizer.`, 'organizer-not-approved');
}

export async function listOrganizers() {
  await ensureOrganizer();
  const [emailSnaps, uidSnaps] = await Promise.all([
    getDocs(collection(db, 'organizerEmails')),
    getDocs(collection(db, 'organizers')),
  ]);
  const byEmail = new Map();
  for (const item of emailSnaps.docs) {
    const data = item.data();
    if (data.active !== true) continue;
    byEmail.set(item.id, {
      email: item.id,
      active: true,
      uid: null,
      updatedAt: timestamp(data.updatedAt),
    });
  }
  for (const item of uidSnaps.docs) {
    const data = item.data();
    if (data.active !== true) continue;
    const email = data.email ? String(data.email).trim().toLowerCase() : null;
    if (email && byEmail.has(email)) {
      byEmail.get(email).uid = item.id;
      continue;
    }
    if (email) {
      byEmail.set(email, {
        email,
        active: true,
        uid: item.id,
        updatedAt: timestamp(data.updatedAt),
      });
      continue;
    }
    byEmail.set(`uid:${item.id}`, {
      email: null,
      active: true,
      uid: item.id,
      updatedAt: timestamp(data.updatedAt),
    });
  }
  return [...byEmail.values()].sort((a, b) =>
    String(a.email || a.uid).localeCompare(String(b.email || b.uid)));
}

export async function addOrganizer(emailInput) {
  const user = await ensureOrganizer();
  const email = normalizeEmail(emailInput);
  if (user.email && normalizeEmail(user.email) === email) {
    throw error('You are already signed in as an organizer.', 'invalid-argument');
  }
  const existing = await listOrganizers();
  if (existing.some((item) => item.active && item.email === email)) {
    throw error(`${email} is already an organizer.`, 'already-exists');
  }
  await setDoc(doc(db, 'organizerEmails', email), {
    email,
    active: true,
    addedByUid: user.uid,
    addedByEmail: user.email ? normalizeEmail(user.email) : null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, { merge: true });
  return { email };
}

export async function removeOrganizer(emailOrUid) {
  const user = await ensureOrganizer();
  const value = String(emailOrUid || '').trim();
  if (!value) throw error('Choose an organizer to remove.');

  if (value.includes('@')) {
    const email = normalizeEmail(value);
    if (user.email && normalizeEmail(user.email) === email) {
      throw error('You cannot remove your own organizer access.', 'invalid-argument');
    }
    await setDoc(doc(db, 'organizerEmails', email), {
      email,
      active: false,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    const uidSnaps = await getDocs(collection(db, 'organizers'));
    await Promise.all(uidSnaps.docs
      .filter((item) => item.data().active === true
        && String(item.data().email || '').trim().toLowerCase() === email)
      .map((item) => setDoc(item.ref, { active: false, updatedAt: serverTimestamp() }, { merge: true })));
    return { email };
  }

  if (value === user.uid) throw error('You cannot remove your own organizer access.', 'invalid-argument');
  const reference = doc(db, 'organizers', value);
  const existing = await getDoc(reference);
  if (!existing.exists()) throw error('That organizer was not found.', 'not-found');
  const email = existing.data().email ? String(existing.data().email).trim().toLowerCase() : null;
  await setDoc(reference, { active: false, updatedAt: serverTimestamp() }, { merge: true });
  if (email) {
    await setDoc(doc(db, 'organizerEmails', email), {
      email,
      active: false,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  }
  return { uid: value, email };
}

export async function signInOrganizer({ email, password }) {
  initializeClient();
  if (!email || !password) throw error('Enter your email and password.');
  const result = await signInWithEmailAndPassword(auth, email.trim(), password);
  await ensureOrganizer();
  return result.user;
}

export async function signInOrganizerWithGoogle() {
  initializeClient();
  const result = await signInWithPopup(auth, new GoogleAuthProvider());
  await ensureOrganizer();
  return result.user;
}

export async function signOutOrganizer() { initializeClient(); await signOut(auth); }

function newSession(date, cycle, capacity = 32) {
  return {
    date, cycle, capacity, confirmedCount: 0, checkedInCount: 0,
    waitlistCount: 0, activeGameCount: 0, open: true, createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(), archivedAt: null,
  };
}

export async function getCurrentSession(date = todayManila()) {
  await ensureOrganizer();
  validDate(date);
  const pointer = dayRef(date);
  const createdId = await runTransaction(db, async (transaction) => {
    const current = await transaction.get(pointer);
    if (current.exists()) return current.data().currentSessionId;
    const fresh = doc(collection(db, 'sessions'));
    transaction.set(sessionRef(fresh.id), newSession(date, 1));
    transaction.set(pointer, { currentSessionId: fresh.id, cycle: 1, updatedAt: serverTimestamp() });
    return fresh.id;
  });
  const snapshot = await getDoc(sessionRef(createdId));
  return normalizedSession(snapshot);
}

export async function getPublicSession(sessionId) {
  await ensurePublicAuth();
  const snapshot = await getDoc(sessionRef(String(sessionId || '')));
  if (!snapshot.exists()) throw error('This signup link has expired or is closed.', 'not-found');
  return { session: normalizedSession(snapshot) };
}

function directoryPayload(player, overrides = {}) {
  const name = overrides.name || player.name;
  return {
    name,
    nameLower: overrides.nameLower || player.nameLower || String(name || '').toLocaleLowerCase(),
    skillLevel: overrides.skillLevel || player.skillLevel,
    division: overrides.division || player.division || 'unspecified',
    photoData: Object.prototype.hasOwnProperty.call(overrides, 'photoData')
      ? overrides.photoData
      : (player.photoData || null),
    wins: Number(Object.prototype.hasOwnProperty.call(overrides, 'wins') ? overrides.wins : (player.wins || 0)),
    losses: Number(Object.prototype.hasOwnProperty.call(overrides, 'losses') ? overrides.losses : (player.losses || 0)),
  };
}

export async function searchPlayers(text) {
  await ensurePublicAuth();
  const needle = String(text || '').trim().toLocaleLowerCase();
  if (needle.length < 2) return { players: [] };
  const results = await getDocs(query(
    collection(db, 'playerDirectory'),
    orderBy('nameLower'),
    startAt(needle), endAt(`${needle}\uf8ff`), limit(20),
  ));
  return { players: results.docs.map(normalizedPlayer) };
}

/** Public lifetime leaderboard from the approved directory. */
export async function getTopPlayers({ limit: size = 5 } = {}) {
  await ensurePublicAuth();
  const capped = Math.min(Math.max(Number(size) || 5, 1), 10);
  const results = await getDocs(query(
    collection(db, 'playerDirectory'),
    orderBy('wins', 'desc'),
    limit(20),
  ));
  const players = results.docs
    .map(normalizedPlayer)
    .filter((player) => (player.wins + player.losses) > 0)
    .slice(0, capped);
  return { players };
}

export async function submitSignup({ sessionId, playerId = null, name, skillLevel, division = 'unspecified', photoData = null }) {
  const user = await ensurePublicAuth();
  if (!user.isAnonymous) throw error('Open the signup link in a private player browser.', 'auth-required');
  const photo = validPhoto(photoData);
  let selectedName;
  let selectedSkill;
  let selectedDivision;
  if (playerId) {
    const player = await getDoc(playerRef(playerId));
    if (!player.exists() || player.data().active !== true) throw error('Select a listed player.');
    selectedName = player.data().name;
    selectedSkill = player.data().skillLevel;
    selectedDivision = player.data().division || 'unspecified';
  } else {
    selectedName = validName(name);
    selectedSkill = validSkill(skillLevel);
    selectedDivision = validDivision(division);
  }
  const reference = entryRef(sessionId, user.uid);
  const existing = await getDoc(reference);
  if (existing.exists()) throw error('You already sent a signup request for this session.', 'already-exists');
  const payload = {
    sessionId,
    ownerUid: user.uid,
    playerId: playerId || null,
    name: selectedName,
    skillLevel: selectedSkill,
    division: selectedDivision,
    photoData: photo,
    status: 'pending',
    checkedIn: false,
    source: 'public',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    approvedAt: null,
    reviewedAt: null,
    checkedInAt: null,
    checkedOutAt: null,
  };
  // The document ID is the anonymous Auth UID, so the rules allow one request
  // per browser identity for each shared signup link.
  await setDoc(reference, payload);
  return { entry: { id: reference.id, ...payload, createdAt: new Date().toISOString() } };
}

export async function watchMySignup(sessionId, callback) {
  const user = await ensurePublicAuth();
  return onSnapshot(entryRef(sessionId, user.uid), (snapshot) => {
    callback(snapshot.exists() ? normalizedEntry(snapshot) : null);
  }, callback);
}

async function listEntries(sessionId, players = new Map()) {
  const snapshots = await getDocs(query(
    collection(db, 'sessions', sessionId, 'entries'), orderBy('createdAt', 'asc'),
  ));
  return snapshots.docs.map((snapshot) => normalizedEntry(snapshot, players));
}

async function listPlayers() {
  const snapshots = await getDocs(query(collection(db, 'players'), orderBy('nameLower', 'asc')));
  return snapshots.docs.map(normalizedPlayer);
}

export async function getAdminDashboard(date = todayManila()) {
  await ensureOrganizer();
  const session = await getCurrentSession(date);
  const players = await listPlayers();
  const entries = await listEntries(session.id, new Map(players.map((player) => [player.id, player])));
  return { session: summarize(session, entries), entries, players };
}

export async function watchAdminDashboard(callback, date = todayManila()) {
  await ensureOrganizer();
  await getCurrentSession(date);
  let stopSession = () => {};
  let stopEntries = () => {};
  let session = null;
  let entries = [];
  let players = [];
  let currentSessionId = null;
  const emit = () => { if (session) callback({ session: summarize(session, entries), entries, players }); };
  const onError = (cause) => callback({ error: cause });
  const stopPlayers = onSnapshot(query(collection(db, 'players'), orderBy('nameLower', 'asc')),
    (snapshot) => { players = snapshot.docs.map(normalizedPlayer); emit(); }, onError);
  const stopPointer = onSnapshot(dayRef(date), (pointer) => {
    if (!pointer.exists()) return;
    const nextId = pointer.data().currentSessionId;
    if (nextId === currentSessionId) return;
    stopSession(); stopEntries();
    currentSessionId = nextId;
    session = null; entries = [];
    stopSession = onSnapshot(sessionRef(nextId), (snapshot) => {
      session = normalizedSession(snapshot); emit();
    }, onError);
    stopEntries = onSnapshot(query(collection(db, 'sessions', nextId, 'entries'), orderBy('createdAt', 'asc')),
      (snapshot) => {
        const map = new Map(players.map((player) => [player.id, player]));
        entries = snapshot.docs.map((item) => normalizedEntry(item, map));
        emit();
      }, onError);
  }, onError);
  return () => { stopPointer(); stopSession(); stopEntries(); stopPlayers(); };
}

export async function approveEntry(sessionId, entryId, options = {}) {
  await ensureOrganizer();
  const result = await runTransaction(db, async (transaction) => {
    const sRef = sessionRef(sessionId);
    const eRef = entryRef(sessionId, entryId);
    const [session, entry] = await Promise.all([transaction.get(sRef), transaction.get(eRef)]);
    if (!session.exists() || !session.data().open) throw error('This session is closed.');
    if (!entry.exists() || entry.data().status !== 'pending') throw error('This request is no longer pending.');
    const request = entry.data();
    const skillLevel = validSkill(
      Object.prototype.hasOwnProperty.call(options, 'skillLevel')
        ? options.skillLevel
        : request.skillLevel,
    );
    const name = validName(
      Object.prototype.hasOwnProperty.call(options, 'name')
        ? options.name
        : request.name,
    );
    const existingPlayer = request.playerId ? playerRef(request.playerId) : null;
    const freshPlayer = existingPlayer || doc(collection(db, 'players'));
    const player = existingPlayer ? await transaction.get(existingPlayer) : null;
    if (existingPlayer && (!player.exists() || player.data().active !== true)) {
      throw error('The selected player is unavailable.');
    }
    const claim = claimRef(sessionId, freshPlayer.id);
    const currentClaim = existingPlayer ? await transaction.get(claim) : null;
    if (currentClaim?.exists()) throw error('This player already has a reservation or waitlist place.', 'already-exists');
    const confirmed = session.data().confirmedCount < session.data().capacity;
    const status = confirmed ? 'confirmed' : 'waitlisted';
    if (!existingPlayer) {
      const profile = {
        name, nameLower: name.toLocaleLowerCase(), skillLevel,
        division: validDivision(request.division),
        photoData: validPhoto(request.photoData), active: true, wins: 0, losses: 0,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      };
      transaction.set(freshPlayer, profile);
      transaction.set(directoryRef(freshPlayer.id), directoryPayload(profile));
    } else {
      const photoData = request.photoData ? validPhoto(request.photoData) : player.data().photoData || null;
      const playerPatch = {
        name,
        nameLower: name.toLocaleLowerCase(),
        skillLevel,
        updatedAt: serverTimestamp(),
      };
      if (request.photoData) playerPatch.photoData = photoData;
      transaction.update(existingPlayer, playerPatch);
      transaction.set(directoryRef(freshPlayer.id), directoryPayload(player.data(), {
        name, nameLower: name.toLocaleLowerCase(), skillLevel, photoData,
      }), { merge: true });
    }
    transaction.set(claim, { entryId, createdAt: serverTimestamp() });
    transaction.update(eRef, {
      playerId: freshPlayer.id, name, status, skillLevel, approvedAt: serverTimestamp(),
      reviewedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    transaction.update(sRef, {
      confirmedCount: session.data().confirmedCount + (confirmed ? 1 : 0),
      waitlistCount: (session.data().waitlistCount || 0) + (confirmed ? 0 : 1),
      updatedAt: serverTimestamp(),
    });
    return { status, playerId: freshPlayer.id, skillLevel, name };
  });
  return result;
}

async function promoteOldest(sessionId) {
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const candidates = await getDocs(query(
      collection(db, 'sessions', sessionId, 'entries'), orderBy('createdAt', 'asc'),
    ));
    const candidate = candidates.docs.find((item) => item.data().status === 'waitlisted');
    if (!candidate) return null;
    try {
      return await runTransaction(db, async (transaction) => {
        const sRef = sessionRef(sessionId);
        const eRef = entryRef(sessionId, candidate.id);
        const [session, entry] = await Promise.all([transaction.get(sRef), transaction.get(eRef)]);
        if (!session.exists() || !session.data().open || session.data().confirmedCount >= session.data().capacity) return null;
        if (!entry.exists() || entry.data().status !== 'waitlisted') throw error('Waitlist changed.', 'aborted');
        transaction.update(eRef, { status: 'confirmed', updatedAt: serverTimestamp() });
        transaction.update(sRef, {
          confirmedCount: session.data().confirmedCount + 1,
          waitlistCount: Math.max(0, (session.data().waitlistCount || 0) - 1),
          updatedAt: serverTimestamp(),
        });
        return candidate.id;
      });
    } catch (cause) {
      if (cause.code !== 'aborted') throw cause;
    }
  }
  return null;
}

async function fillOpenSpots(sessionId) {
  for (let n = 0; n < 512; n += 1) {
    const promoted = await promoteOldest(sessionId);
    if (!promoted) break;
  }
}

async function closeEntry(sessionId, entryId, status) {
  await ensureOrganizer();
  const freed = await runTransaction(db, async (transaction) => {
    const sRef = sessionRef(sessionId);
    const eRef = entryRef(sessionId, entryId);
    const [session, entry] = await Promise.all([transaction.get(sRef), transaction.get(eRef)]);
    if (!session.exists() || !entry.exists()) throw error('Reservation not found.', 'not-found');
    const prior = entry.data();
    if (!['pending', 'confirmed', 'waitlisted'].includes(prior.status)) {
      throw error('This request is already closed.');
    }
    const wasConfirmed = prior.status === 'confirmed';
    const wasWaitlisted = prior.status === 'waitlisted';
    const claim = prior.playerId && (wasConfirmed || wasWaitlisted) ? claimRef(sessionId, prior.playerId) : null;
    const lock = prior.playerId && wasConfirmed ? await transaction.get(playerLockRef(sessionId, prior.playerId)) : null;
    if (lock?.exists()) throw error('Replace or finish this player\'s game first.');
    const existingClaim = claim ? await transaction.get(claim) : null;
    let partnerEntry = null;
    if (prior.partnerPlayerId) {
      const partnerClaim = await transaction.get(claimRef(sessionId, prior.partnerPlayerId));
      if (partnerClaim.exists()) {
        partnerEntry = await transaction.get(entryRef(sessionId, partnerClaim.data().entryId));
      }
    }
    transaction.update(eRef, {
      status,
      checkedIn: false,
      checkedOutAt: status === 'checked_out' ? serverTimestamp() : prior.checkedOutAt || null,
      reviewedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      partnerPlayerId: null,
    });
    if (existingClaim?.exists() && existingClaim.data().entryId === entryId) transaction.delete(claim);
    if (partnerEntry?.exists() && partnerEntry.data().partnerPlayerId === prior.playerId) {
      transaction.update(partnerEntry.ref, {
        partnerPlayerId: null,
        updatedAt: serverTimestamp(),
      });
    }
    const sessionPatch = {
      confirmedCount: session.data().confirmedCount - (wasConfirmed ? 1 : 0),
      waitlistCount: (session.data().waitlistCount || 0) - (wasWaitlisted ? 1 : 0),
      updatedAt: serverTimestamp(),
    };
    if (wasConfirmed && prior.checkedIn) sessionPatch.checkedInCount = increment(-1);
    transaction.update(sRef, sessionPatch);
    return wasConfirmed;
  });
  if (freed) await promoteOldest(sessionId);
  return { status };
}

export async function rejectEntry(sessionId, entryId) { return closeEntry(sessionId, entryId, 'rejected'); }
export async function removeEntry(sessionId, entryId) { return closeEntry(sessionId, entryId, 'removed'); }
export async function checkOutEntry(sessionId, entryId) { return closeEntry(sessionId, entryId, 'checked_out'); }

/** Lock two confirmed players as a doubles pair for today's draws, or clear the lock. */
export async function setEntryPartner(sessionId, entryId, partnerPlayerId = null) {
  await ensureOrganizer();
  const partnerId = partnerPlayerId ? idOfPlayer(partnerPlayerId) : null;
  await runTransaction(db, async (transaction) => {
    const eRef = entryRef(sessionId, entryId);
    const entry = await transaction.get(eRef);
    if (!entry.exists() || entry.data().status !== 'confirmed') {
      throw error('Only confirmed players can be paired.');
    }
    const prior = entry.data();
    if (!prior.playerId) throw error('Pair players who have a saved profile.');

    const previousPartnerId = prior.partnerPlayerId || null;
    let previousPartnerEntry = null;
    if (previousPartnerId) {
      const previousClaim = await transaction.get(claimRef(sessionId, previousPartnerId));
      if (previousClaim.exists()) {
        previousPartnerEntry = await transaction.get(entryRef(sessionId, previousClaim.data().entryId));
      }
    }

    let nextPartnerEntry = null;
    let nextPartnerPrevious = null;
    if (partnerId) {
      if (partnerId === prior.playerId) throw error('A player cannot pair with themselves.');
      const partnerClaim = await transaction.get(claimRef(sessionId, partnerId));
      if (!partnerClaim.exists()) throw error('Partner is not on today’s roster.');
      nextPartnerEntry = await transaction.get(entryRef(sessionId, partnerClaim.data().entryId));
      if (!nextPartnerEntry.exists() || nextPartnerEntry.data().status !== 'confirmed') {
        throw error('Partner must also be confirmed for today.');
      }
      const nextPriorPartnerId = nextPartnerEntry.data().partnerPlayerId || null;
      if (nextPriorPartnerId && nextPriorPartnerId !== prior.playerId) {
        const otherClaim = await transaction.get(claimRef(sessionId, nextPriorPartnerId));
        if (otherClaim.exists()) {
          nextPartnerPrevious = await transaction.get(entryRef(sessionId, otherClaim.data().entryId));
        }
      }
    }

    if (previousPartnerEntry?.exists() && previousPartnerEntry.data().partnerPlayerId === prior.playerId) {
      transaction.update(previousPartnerEntry.ref, {
        partnerPlayerId: null,
        updatedAt: serverTimestamp(),
      });
    }
    if (nextPartnerPrevious?.exists() &&
        nextPartnerPrevious.data().partnerPlayerId === partnerId) {
      transaction.update(nextPartnerPrevious.ref, {
        partnerPlayerId: null,
        updatedAt: serverTimestamp(),
      });
    }
    transaction.update(eRef, {
      partnerPlayerId: partnerId,
      updatedAt: serverTimestamp(),
    });
    if (nextPartnerEntry) {
      transaction.update(nextPartnerEntry.ref, {
        partnerPlayerId: prior.playerId,
        updatedAt: serverTimestamp(),
      });
    }
  });
  return { partnerPlayerId: partnerId };
}

function idOfPlayer(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('/')) {
    throw error('Player id is invalid.');
  }
  return value.trim();
}

async function withContentionRetries(work) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await work();
    } catch (cause) {
      lastError = cause;
      const code = String(cause?.code || '');
      if (!code.includes('failed-precondition') && !code.includes('aborted')) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 35 * (attempt + 1)));
    }
  }
  throw lastError || error('The session changed while saving. Tap Refresh and try again.', 'aborted');
}

export async function checkInEntry(sessionId, entryId) {
  await ensureOrganizer();
  await withContentionRetries(() => runTransaction(db, async (transaction) => {
    const sRef = sessionRef(sessionId);
    const eRef = entryRef(sessionId, entryId);
    const [session, entry] = await Promise.all([transaction.get(sRef), transaction.get(eRef)]);
    if (!session.exists() || !session.data().open) throw error('This session is closed.');
    if (!entry.exists() || entry.data().status !== 'confirmed') throw error('Only confirmed players can check in.');
    if (entry.data().checkedIn) return;
    transaction.update(eRef, { checkedIn: true, checkedInAt: serverTimestamp(), updatedAt: serverTimestamp() });
    // Use increment so concurrent check-ins do not collide on checkedInCount.
    transaction.update(sRef, {
      checkedInCount: increment(1), updatedAt: serverTimestamp(),
    });
  }));
  return { checkedIn: true };
}

export async function reservePlayer(sessionId, playerId, options = {}) {
  await ensureOrganizer();
  const checkIn = options.checkIn === true;
  const id = doc(collection(db, 'sessions', sessionId, 'entries')).id;
  const result = await withContentionRetries(() => runTransaction(db, async (transaction) => {
    const sRef = sessionRef(sessionId);
    const pRef = playerRef(playerId);
    const claim = claimRef(sessionId, playerId);
    const [session, player, existingClaim] = await Promise.all([
      transaction.get(sRef), transaction.get(pRef), transaction.get(claim),
    ]);
    if (!session.exists() || !session.data().open) throw error('This session is closed.');
    if (!player.exists() || player.data().active !== true) throw error('Player not found.');
    if (existingClaim.exists()) throw error('This player already has a reservation or waitlist place.', 'already-exists');
    const hasOpenSpot = session.data().confirmedCount < session.data().capacity;
    if (checkIn && !hasOpenSpot) {
      throw error('No open confirmed spots left. Reserve to the waitlist instead.');
    }
    const status = hasOpenSpot ? 'confirmed' : 'waitlisted';
    const shouldCheckIn = checkIn && status === 'confirmed';
    transaction.set(entryRef(sessionId, id), {
      sessionId, ownerUid: null, playerId,
      name: player.data().name, skillLevel: player.data().skillLevel,
      division: player.data().division || 'unspecified',
      photoData: player.data().photoData || null,
      status, checkedIn: shouldCheckIn, source: 'organizer',
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      approvedAt: serverTimestamp(), reviewedAt: serverTimestamp(),
      checkedInAt: shouldCheckIn ? serverTimestamp() : null, checkedOutAt: null,
    });
    transaction.set(claim, { entryId: id, createdAt: serverTimestamp() });
    const sessionPatch = { updatedAt: serverTimestamp() };
    if (status === 'confirmed') sessionPatch.confirmedCount = increment(1);
    else sessionPatch.waitlistCount = increment(1);
    if (shouldCheckIn) sessionPatch.checkedInCount = increment(1);
    transaction.update(sRef, sessionPatch);
    return { id, status, checkedIn: shouldCheckIn };
  }));
  return { entry: result };
}

/** Create a new directory player and optionally put them on today's roster. */
export async function createAndReservePlayer(sessionId, {
  name,
  skillLevel,
  division = 'unspecified',
  reserve = true,
  checkIn = false,
} = {}) {
  await ensureOrganizer();
  const playerName = validName(name);
  const skill = validSkill(skillLevel);
  const gender = validDivision(division);
  const playerDoc = doc(collection(db, 'players'));
  const entryId = doc(collection(db, 'sessions', sessionId, 'entries')).id;

  const result = await withContentionRetries(() => runTransaction(db, async (transaction) => {
    const sRef = sessionRef(sessionId);
    const session = await transaction.get(sRef);
    if (!session.exists() || session.data().open !== true) throw error('This session is closed.');

    const profile = {
      name: playerName,
      nameLower: playerName.toLocaleLowerCase(),
      skillLevel: skill,
      division: gender,
      photoData: null,
      active: true,
      wins: 0,
      losses: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      source: 'organizer',
    };
    transaction.set(playerDoc, profile);
    transaction.set(directoryRef(playerDoc.id), directoryPayload(profile));

    if (!reserve) {
      return { playerId: playerDoc.id, entry: null };
    }

    const hasOpenSpot = session.data().confirmedCount < session.data().capacity;
    if (checkIn && !hasOpenSpot) {
      throw error('No open confirmed spots left. Reserve to the waitlist instead.');
    }
    const status = hasOpenSpot ? 'confirmed' : 'waitlisted';
    const shouldCheckIn = checkIn && status === 'confirmed';
    transaction.set(entryRef(sessionId, entryId), {
      sessionId,
      ownerUid: null,
      playerId: playerDoc.id,
      name: playerName,
      skillLevel: skill,
      division: gender,
      photoData: null,
      status,
      checkedIn: shouldCheckIn,
      source: 'organizer',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      approvedAt: serverTimestamp(),
      reviewedAt: serverTimestamp(),
      checkedInAt: shouldCheckIn ? serverTimestamp() : null,
      checkedOutAt: null,
    });
    transaction.set(claimRef(sessionId, playerDoc.id), {
      entryId,
      createdAt: serverTimestamp(),
    });
    const sessionPatch = { updatedAt: serverTimestamp() };
    if (status === 'confirmed') sessionPatch.confirmedCount = increment(1);
    else sessionPatch.waitlistCount = increment(1);
    if (shouldCheckIn) sessionPatch.checkedInCount = increment(1);
    transaction.update(sRef, sessionPatch);
    return {
      playerId: playerDoc.id,
      entry: { id: entryId, status, checkedIn: shouldCheckIn },
    };
  }));

  return result;
}

export async function updatePlayer(playerId, changes, sessionId = null) {
  await ensureOrganizer();
  const patch = { updatedAt: serverTimestamp() };
  if (Object.prototype.hasOwnProperty.call(changes, 'name')) {
    const name = validName(changes.name);
    patch.name = name;
    patch.nameLower = name.toLocaleLowerCase();
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'skillLevel')) {
    patch.skillLevel = validSkill(changes.skillLevel);
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'division')) {
    patch.division = validDivision(changes.division);
  }
  if (Object.keys(patch).length === 1) throw error('Choose a player detail to update.');
  const reference = playerRef(playerId);
  await runTransaction(db, async (transaction) => {
    const player = await transaction.get(reference);
    if (!player.exists()) throw error('Player not found.', 'not-found');
    let entry = null;
    if (sessionId) {
      const claim = await transaction.get(claimRef(sessionId, playerId));
      if (claim.exists()) entry = await transaction.get(entryRef(sessionId, claim.data().entryId));
    }
    transaction.update(reference, patch);
    transaction.set(directoryRef(playerId), directoryPayload(player.data(), patch), { merge: true });
    // Court eligibility is read from the active session entry. Keep that
    // snapshot aligned with an organizer's profile edit for this session.
    if (entry?.exists() && ['confirmed', 'waitlisted'].includes(entry.data().status)) {
      const entryPatch = { updatedAt: serverTimestamp() };
      if (patch.name) entryPatch.name = patch.name;
      if (patch.skillLevel) entryPatch.skillLevel = patch.skillLevel;
      if (patch.division) entryPatch.division = patch.division;
      transaction.update(entry.ref, entryPatch);
    }
  });
  const player = await getDoc(reference);
  return { player: normalizedPlayer(player) };
}

export async function updateSession(sessionId, { capacity }) {
  await ensureOrganizer();
  const size = Number(capacity);
  if (!Number.isInteger(size) || size < 1 || size > 512) throw error('Capacity must be between 1 and 512.');
  await runTransaction(db, async (transaction) => {
    const sRef = sessionRef(sessionId);
    const session = await transaction.get(sRef);
    if (!session.exists() || !session.data().open) throw error('This session is closed.');
    if (size < session.data().confirmedCount) {
      throw error('Capacity cannot be lower than confirmed reservations.');
    }
    transaction.update(sRef, { capacity: size, updatedAt: serverTimestamp() });
  });
  await fillOpenSpots(sessionId);
  return { session: normalizedSession(await getDoc(sessionRef(sessionId))) };
}

export async function resetSession(date = todayManila()) {
  await ensureOrganizer();
  validDate(date);
  const pointer = dayRef(date);
  const before = await getDoc(pointer);
  const oldId = before.exists() ? before.data().currentSessionId : null;
  if (oldId) {
    const activeCourts = await getDocs(query(
      collection(db, 'courts'), where('activeSessionId', '==', oldId),
    ));
    if (activeCourts.docs.some((court) => court.data().activeGameId)) {
      throw error('Finish or cancel active games before resetting signups.');
    }
  }
  const newId = doc(collection(db, 'sessions')).id;
  await runTransaction(db, async (transaction) => {
    const current = await transaction.get(pointer);
    const previousId = current.exists() ? current.data().currentSessionId : null;
    if (previousId !== oldId) throw error('The session changed. Reload and try again.', 'aborted');
    const previous = previousId ? await transaction.get(sessionRef(previousId)) : null;
    const cycle = (current.exists() ? current.data().cycle : 0) + 1;
    const capacity = previous?.exists() ? previous.data().capacity : 32;
    if (previous?.exists()) {
      if ((previous.data().activeGameCount || 0) > 0) {
        throw error('Finish or cancel active games before resetting signups.');
      }
      transaction.update(sessionRef(previousId), {
        open: false, archivedAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
    }
    transaction.set(sessionRef(newId), newSession(date, cycle, capacity));
    transaction.set(pointer, {
      currentSessionId: newId, cycle, updatedAt: serverTimestamp(),
    });
  });
  return { session: normalizedSession(await getDoc(sessionRef(newId))) };
}
