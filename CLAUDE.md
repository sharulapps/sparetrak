# SpareTrack v2

Spare part management PWA for MNSB. Vanilla HTML/JS, Firebase Auth + Firestore (Spark plan), Cloudflare Pages (`public/`).

- Read README.md (layout, data model) and MIGRATION.md (setup/cutover) first.
- Vanilla JS only; no framework, bundler or build step for the site. UI text in English.
- All tenant data access goes through `window._fs.collection/doc`, which prefix `tenants/{TID}/`. Never import Firestore directly for tenant data.
- Firebase settings live only in `public/firebase-config.js`. On localhost every page uses the emulators.
- Security is in `firestore.rules`. Any rules change needs a test in `tests/rules.test.mjs`; run `npm test`. After changing rules, the live rules must be re-published in the Firebase console.
- Plan limits (trial: 3 users / 10 parts) live in the rules: members need a `userCount` +1 in the same batch; limited companies store parts as `slot-N`. Create parts via `window._fs.addDoc`, never raw Firestore.
- After app changes: `node --check` each inline script, run `npm run e2e` and `npm run e2e:trial`, bump `CACHE` in `public/sw.js`.
- Spark plan: no backups, 50k reads / 20k writes per day. Deletes are permanent.
- Never commit service-account keys, `users.json` (password hashes) or `backup/`.
