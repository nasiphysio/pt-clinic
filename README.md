# Physiclinic — PT Clinic Management

A web app for running a physiotherapy clinic: patient files, assessments, schedule, sessions, payments and finance.
Plain static files on GitHub Pages (no build step), data in Firebase.

- **Live:** https://nasiphysio.github.io/pt-clinic/
- **Repo:** `nasiphysio/pt-clinic`
- **Firebase project:** `physiclinic-4a8d1` (Firestore + email/password sign-in)

## Files

| File | What it is |
|---|---|
| `index.html` | Page structure (login, pages, pop-up windows) |
| `styles.css` | All styling |
| `app.js` | All app logic (Firebase, pages, PDFs, exports) |
| `quick-sheet.js` | ⚡ Shortcut sheet: the clinic's one-page assessment sheet with a mic next to each field (voice typing). Saved as a normal visit with extra fields in `visit.quick` |
| `manifest.webmanifest`, `sw.js`, `*.png` | Install on the phone as an app; offline shell |
| `firestore.rules` | Recommended security rules — paste them in the Firebase console |

When you change any file, bump `CACHE` in `sw.js` (e.g. `ptclinic-v3`) so phones pick up the new version.

## Features

- **Dashboard** — today's appointments, attended/remaining, money collected today and this month, outstanding balances, patients due a follow-up, patients waiting for assessment.
- **Patients** — search by name/phone/file no./region/diagnosis; filters (active, needs assessment, follow-up due, has balance, discharged); full patient file with contact info, referral source and medical history (chronic diseases, medications, surgeries, allergies, imaging, red flags).
- **Assessments** — initial, follow-up and discharge; per region: diagnosis, complaints, findings, problem list, treatment, VAS, measurements (ROM/MMT); outcome measures (ODI, NDI, KOOS…); goals; pain chart over time; PDF report and CSV.
- **Sessions & payments** — attended appointments become sessions automatically; record payments (cash, card, InstaPay, Vodafone Cash…); balance or prepaid credit; receipt and account statement PDFs.
- **Home exercise program** — per patient, from an exercise library; PDF or WhatsApp.
- **Schedule** — day grid per doctor, previous/next day, statuses (scheduled, confirmed, attended, no-show, cancelled), double-booking warning, repeating series (Sat/Mon/Wed, Sun/Tue/Thu, weekly, daily), WhatsApp reminder.
- **Finance** (doctors) — collected, session value, expenses, net, by payment method, by doctor, per-day chart, CSV export.
- **Staff accounts** (doctors) — add staff, approve new sign-ins, change roles, remove access, send password reset.
- **Settings** — clinic profile and logo, working hours, slot length, prices, currency, follow-up alert days, WhatsApp message, schedule doctors, full JSON backup.

## Roles

- **Doctor** — everything.
- **Receptionist** — dashboard, patients (add/edit info), schedule, sessions and payments. No finance reports, settings, staff or assessment editing.
- Someone who signs in without a staff profile (for example a removed account) is held as **pending** until a doctor approves them.

Roles are enforced in the app; publish `firestore.rules` so they're enforced on the server too.

## Data (Firestore)

- `patients/{id}` — name, age, gender, job, phone, fileNo, address, emergency, referral, refDoctor, status, `history{…}`, `visits[]`, `sessions[]`, `payments[]`, `hep{items[], advice}`
- `appointments/{id}` — date, time, patientId, patientName, doctorId, doctorName, type, price, status, notes, seriesId
- `expenses/{id}` — date, amount, category, note
- `users/{uid}` — name, email, role (`doctor` | `receptionist` | `pending`), disabled
- `config/clinic` — clinic profile, hours, prices, doctors, WhatsApp template
- `config/options` — assessment pick-lists, outcome measures, exercise library

Sessions saved by the old version (no `billed` flag) count as already paid, so old patients don't show a false balance.

Patient data stays in Firebase only. Backups and CSV exports contain patient data — don't commit them to this repo.
