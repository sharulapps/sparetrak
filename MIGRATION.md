# Pindah MNSB ke SpareTrack versi baru (project Firebase baru, plan Spark)

- **Project lama** (`mnsb-sparepart`) dan site lama **tak disentuh**. User terus guna sistem lama sampai hari pertukaran.
- **Project baru** dapat quota Spark sendiri (50k read / 20k write sehari).
- Akaun login dipindah **dengan password sekali**, jadi user login macam biasa dan UID tetap sama.

---

## 1. Setup project Firebase baru (sekali je)

1. https://console.firebase.google.com → **Add project** (contoh nama `sparetrak-mnsb`). Plan kekal Spark.
2. **Build → Authentication → Get started → Email/Password → Enable.**
3. **Build → Firestore Database → Create database**: pilih **production mode**, location **asia-southeast1 (Singapore)**. Location tak boleh tukar kemudian.
4. **Firestore → Rules:** paste isi `firestore.rules` → **Publish**.
5. **⚙ Project settings → General → Your apps → Web (</>)**: daftar app, copy config, dan paste ke dalam
   **`public/firebase-config.js`**. Ni satu-satunya tempat untuk config.
6. **Authentication → Settings → Authorized domains:** tambah domain Cloudflare baru (contoh `sparetrak.pages.dev`).

## 2. Deploy site baru (Cloudflare Pages)

Workers & Pages → Create → Pages → connect repo `sharulapps/sparetrak`:
- Build command: *(kosong)*
- Build output directory: `public`

Site ni boleh hidup selari dengan site lama. Belum ada user yang perlu tahu pasal dia.

## 3. Persediaan kat PC kau

```bash
git clone https://github.com/sharulapps/sparetrak && cd sparetrak
npm install
npm run test:migrate        # latihan atas emulator — mesti "18/18 checks passed"
```

Kau perlukan dua service account key. Untuk setiap project: ⚙ Project settings → **Service accounts** → **Generate new private key**.
- Project lama → simpan sebagai `old-key.json`
- Project baru → simpan sebagai `new-key.json`

⚠ Fail key ni sama macam password admin penuh. `.gitignore` dah halang dia dari masuk Git. Jangan hantar kat sesiapa.

## 4. Pindah akaun login (dengan password)

1. Dalam **project lama**: Authentication → Users → tekan **⋮** (atas kanan senarai) → **Password hash parameters**.
   Salin `base64_signer_key`, `base64_salt_separator`, `rounds` dan `mem_cost`.
2. Jalan command ni:
   ```bash
   npx firebase login
   npx firebase auth:export users.json --format=json --project mnsb-sparepart
   npx firebase auth:import users.json --project <id-project-baru> \
     --hash-algo=SCRYPT --hash-key=<base64_signer_key> --salt-separator=<base64_salt_separator> \
     --rounds=<rounds> --mem-cost=<mem_cost>
   ```
3. **Padam `users.json` lepas siap**, sebab dia ada hash password.

## 5. Pindah data (boleh buat bila-bila untuk test, buat sekali lagi pada hari pertukaran)

```bash
node migrate.mjs export --key old-key.json
node migrate.mjs import backup/<fail>.json --key new-key.json --to <id-project-baru> --dry-run
node migrate.mjs import backup/<fail>.json --key new-key.json --to <id-project-baru>
node migrate.mjs verify backup/<fail>.json --key new-key.json
```

- `--to` ialah langkah keselamatan, supaya data tak tersilap masuk ke project lain.
- `verify` mesti tunjuk semua ✓. Ini termasuk "all N members have a login account". Kalau ada ✗ login, ulang langkah 4.
- Fail dalam `backup/` ialah **backup penuh** data lama. Simpan baik-baik.

**Lepas tu test site baru dengan data sebenar.** Login admin, login technician, buat IN/OUT, approval, export Excel.
Data yang kau ubah dalam site baru masa test akan ditimpa bila langkah 5 diulang pada hari pertukaran.

## 6. Hari pertukaran (lepas habis shift)

| # | Buat |
|---|---|
| 1 | Bagitau user: jangan guna SpareTrack lebih kurang 30 minit |
| 2 | Kalau ada user baru dalam sistem lama sejak langkah 4: ulang **langkah 4** |
| 3 | Ulang **langkah 5** (export → import → verify). Export baru akan ambil data terkini |
| 4 | Project **lama** → Firestore → Rules: tukar semua kepada read-only (`allow read: if request.auth != null; allow write: if false;`), supaya tiada siapa tersilap terus guna sistem lama |
| 5 | Bagi link baru kat semua user. Minta dia subscribe topic ntfy dari tab **Alert** kalau topic bertukar |
| 6 | Padam service account key dalam kedua-dua project (Service accounts → **Manage keys**) dan fail `old-key.json` / `new-key.json` |

**Kalau ada masalah:** pulangkan rules lama dalam project lama, dan suruh user guna site lama. Data lama masih utuh.

## Had Spark

- **Export:** satu read untuk setiap doc dalam project lama.
- **Import:** satu write untuk setiap doc, campur 2 write untuk setiap user, dalam project baru.
- **Kalau "Import will need" lebih dari 15,000:** skrip berhenti sendiri dan simpan progress. Jalan semula esok untuk sambung.
  Dalam kes ni, bagitau aku dulu. Ada cara untuk pindah sejarah transaksi lama siap-siap lebih awal.
- **Part yang dipadam dalam sistem lama** selepas import pertama masih kekal dalam sistem baru. Padam manual, atau bagitau aku.

## Apa yang berubah untuk user

- Link baru, tapi email dan password sama.
- Role dibawa terus. Role yang rules tak kenal jadi `technician`, dan role lama disimpan dalam `previousRole`.
- Akaun login yang takde profil dalam `users` ditambah sebagai `technician`.
- Admin dan manager boleh urus user sendiri dalam tab Users.
- Topic ntfy kekal `mnsb_sparepart`. Admin boleh tukar dari tab Alert.
- Sejarah stocktake dalam phone **tak ikut pindah**, sebab dia disimpan dalam browser, dan domain baru ada storage sendiri.
  Kalau perlu, export dulu sejarah tu ke Excel dari site lama.
