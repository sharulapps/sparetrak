# SpareTrack v2

Spare part management PWA (vanilla HTML/JS + Firebase Auth/Firestore + Cloudflare Pages).
v2 keeps each company's data under `tenants/{id}/`, lets company admins manage their own
users, and enforces roles and company isolation in `firestore.rules`.
MNSB is the first company. New companies can sign up for a **free trial** (3 users, 10 parts)
from the login page; the owner upgrades them in `platform.html`.

## Repo layout

```
public/                  ← Cloudflare Pages output dir (everything here is public)
  index.html             the app
  firebase-config.js     Firebase project settings — the ONLY place to set them
  platform.html          owner console: create / suspend companies (optional)
  sw.js, manifest.json, _headers, icon-*.png
firestore.rules          security rules — paste into Firebase Console → Firestore → Rules
migrate.mjs              copy MNSB data from the old project into this one
MIGRATION.md             step-by-step setup + cutover guide (start here)
seed.mjs                 demo data for local emulators
tests/rules.test.mjs     35 security-rules tests
tools/e2e.mjs            browser walkthrough on emulators (22 checks + screenshots)
tools/test-migrate.mjs   migration rehearsal old project → new project (18 checks)
tools/e2e-trial.mjs      free-trial sign-up + plan limits walkthrough (17 checks)
tools/build-index.py     one-off: generated public/index.html from sharulapps/sparetrack.
                         Edit public/index.html directly from now on.
screenshots/             output of the walkthroughs
```

## Data layout

```
platformAdmins/{uid}              owner of the platform (set in Firebase console only)
userTenants/{uid}                 { tenantId }  login lookup, create-only
tenants/{tid}                     { name, status, plan, maxUsers, maxParts, userCount, settings:{ ntfyTopic } }
  members/{uid}                   { name, email, role, status }
  parts/{id}  transactions/{id}  approvals/{id}
```

Roles: `admin, manager, engineer, technician, finance, purchasing, production`
(rights match `PERMISSIONS` in index.html; rules enforce them).

## Plans and limits

| Plan | Users | Parts | How it is created |
|---|---|---|---|
| `trial` | 3 | 10 | Self sign-up on the login page ("Start a free trial"), or platform.html |
| `pro` / others | `maxUsers` | unlimited (`maxParts: 0`) | platform.html (or **Upgrade** on a trial) |

Limits are enforced in `firestore.rules`, so they hold even if someone edits the app in the browser:
- **Users:** a new member must be written in the same batch as `userCount + 1`, and `userCount` may not
  exceed `maxUsers`. Disabled users still count (deleting a member needs the platform owner).
- **Parts:** when `maxParts > 0`, part ids must be `slot-1 … slot-<maxParts>`, so more cannot exist.
  `window._fs.addDoc` picks a free slot automatically; deleting a part frees its slot.
- **Sign-up:** one free trial per account, fixed limits, the caller becomes its admin.

## Deploy

1. Follow **MIGRATION.md** section 1 to create the Firebase project and fill in `public/firebase-config.js`.
2. Cloudflare Pages: build command empty, output directory `public`.
3. When `index.html` or other cached files change, bump `CACHE` in `public/sw.js`.

## Run locally (emulators — never touches a live project)

Needs Node 18+ and Java 11+.

```bash
npm install
npx playwright install chromium   # once, for e2e / test:migrate
npm test                 # security-rules tests
npm run test:migrate     # migration rehearsal
npm run e2e              # full browser walkthrough + screenshots
npm run e2e:trial        # free-trial sign-up and limits

npm run emulators        # terminal 1
npm run seed             # terminal 2: demo companies + users (password demo1234)
npm run serve            # http://localhost:5000  (owner console: /platform.html)
```

Demo logins after `npm run seed`: `admin@mnsb.test`, `manager@mnsb.test`, `tech@mnsb.test`,
`admin@contoh.test`, `engineer@contoh.test`, owner `owner@sparetrack.test` — all `demo1234`.

## Notes

- `window._fs.collection/doc` prefix `tenants/{TID}/` automatically, so app code writes
  `collection(db,'parts')` and can only reach the signed-in user's company.
- ntfy alerts send title/priority/tags in the URL query: `fetch(..., {mode:'no-cors'})` drops
  custom headers.
- Not done yet: `maxUsers` isn't enforced; deleting a login needs the Admin SDK (the app disables
  instead); stocktake history is stored per device, not in Firestore.
