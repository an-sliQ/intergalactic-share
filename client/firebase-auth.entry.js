// Bundled into public/vendor/firebase-auth.js by `npm run build:firebase`.
// Only the pieces the team inbox needs: Google sign-in through a popup.
export { initializeApp } from 'firebase/app';
export { getAuth, GoogleAuthProvider, signInWithPopup, signOut, browserSessionPersistence, setPersistence } from 'firebase/auth';
