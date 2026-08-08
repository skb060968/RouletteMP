import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

const AUTH_TIMEOUT_MS = 15000;

/**
 * The single authentication readiness boundary for startup and Firebase APIs.
 * It resolves only after Firebase has established a real authenticated session.
 */
export const authReady = new Promise((resolve, reject) => {
  let settled = false;
  let signInStarted = false;
  let unsubscribe = () => {};
  let timeoutId = null;

  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    if (timeoutId) clearTimeout(timeoutId);
    unsubscribe();
    callback(value);
  };

  timeoutId = setTimeout(() => {
    finish(reject, new Error('Authentication timed out. Check your connection and try again.'));
  }, AUTH_TIMEOUT_MS);

  unsubscribe = onAuthStateChanged(auth, async (user) => {
    if (user?.uid) {
      finish(resolve, user);
      return;
    }
    if (signInStarted) return;
    signInStarted = true;
    try {
      const credential = await signInAnonymously(auth);
      finish(resolve, credential.user);
    } catch (error) {
      finish(reject, new Error('Authentication failed. Check your connection and try again.', { cause: error }));
    }
  }, (error) => {
    finish(reject, new Error('Authentication failed. Check your connection and try again.', { cause: error }));
  });
});

authReady.catch((err) => console.error('Auth error:', err));
