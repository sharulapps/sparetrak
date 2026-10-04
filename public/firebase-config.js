// ═══════════════════════════════════════════════════════════════
// SpareTrack — Firebase project settings. This is the ONLY place to set them;
// index.html and platform.html both load this file.
//
// Where to get the values:
//   Firebase Console → ⚙ Project settings → General → "Your apps" → Web app (</>)
//   → "SDK setup and configuration" → Config
//
// These values identify the project; they are not secret. Access is controlled by
// firestore.rules. On localhost the pages ignore this and use the Firebase emulators.
// ═══════════════════════════════════════════════════════════════
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAFnDCWRdz2N_-FymnX6-DhAs3HEVtuJ2c",
  authDomain:        "sparetrak.firebaseapp.com",
  projectId:         "sparetrak",
  storageBucket:     "sparetrak.firebasestorage.app",
  messagingSenderId: "536051855170",
  appId:             "1:536051855170:web:78337492cf61fc2b0e62db"
};

const FIREBASE_CONFIG_READY = !/^PASTE_/.test(FIREBASE_CONFIG.apiKey);
const USE_EMULATOR = ['localhost', '127.0.0.1'].includes(location.hostname);
const ACTIVE_FIREBASE_CONFIG = USE_EMULATOR
  ? { apiKey: 'demo-key', authDomain: 'demo-sparetrack.firebaseapp.com', projectId: 'demo-sparetrack', appId: 'demo-app' }
  : FIREBASE_CONFIG;
