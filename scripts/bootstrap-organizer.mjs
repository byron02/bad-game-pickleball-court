import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Usage: npm run bootstrap:organizer -- organizer@example.com');
  process.exitCode = 1;
} else if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to the private service account JSON path first.');
  process.exitCode = 1;
} else {
  try {
    initializeApp({ credential: applicationDefault() });
    const user = await getAuth().getUserByEmail(email);
    await getFirestore().doc(`organizers/${user.uid}`).set({
      active: true,
      email,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`Organizer access enabled for ${email}.`);
  } catch (error) {
    if (error.code === 'auth/configuration-not-found') {
      console.error('Firebase Authentication is not initialized. In Firebase Console, open Authentication, click Get started, and enable Google or Email/Password sign-in.');
    } else if (error.code === 'auth/user-not-found') {
      console.error(`No Firebase Authentication account exists for ${email}. Sign in with Google once or create the account in Firebase Console, then retry.`);
    } else {
      console.error(`Organizer setup failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}
