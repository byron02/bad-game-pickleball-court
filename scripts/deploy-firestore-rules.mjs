import { readFile } from 'node:fs/promises';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getSecurityRules } from 'firebase-admin/security-rules';

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS to your private Firebase service account file.');
}

const projectId = process.env.FIREBASE_PROJECT_ID || 'bad-game-pickleball';
const app = initializeApp({ credential: applicationDefault(), projectId });
const rules = getSecurityRules(app);
const source = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');

const released = await rules.releaseFirestoreRulesetFromSource(source);
const current = await rules.getFirestoreRuleset();
if (current.source[0]?.content !== source) {
  throw new Error('The live Firestore rules could not be verified.');
}

console.log(`Firestore rules deployed and verified: ${released.name}`);
