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
  apiKey:            "PASTE_YOUR_API_KEY",
  authDomain:        "your-project-id.firebaseapp.com",
  projectId:         "your-project-id",
  storageBucket:     "your-project-id.firebasestorage.app",
  messagingSenderId: "000000000000",
  appId:             "1:000000000000:web:0000000000000000000000"
};

const FIREBASE_CONFIG_READY = !/^PASTE_/.test(FIREBASE_CONFIG.apiKey);
const USE_EMULATOR = ['localhost', '127.0.0.1'].includes(location.hostname);
const ACTIVE_FIREBASE_CONFIG = USE_EMULATOR
  ? { apiKey: 'demo-key', authDomain: 'demo-sparetrack.firebaseapp.com', projectId: 'demo-sparetrack', appId: 'demo-app' }
  : FIREBASE_CONFIG;
