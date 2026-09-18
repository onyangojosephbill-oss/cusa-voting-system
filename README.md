# CUSA Verifiable Digital Ballot — Full System

A working, persistent, multi-device implementation of the CUSA online student election, built from the browser-only prototype and report you already reviewed. This is the next stage up: real server-side rules, real shared storage, and a true tamper-evident vote ledger — **not** a browser-tab demo anymore.

## What changed from the prototype

| | Browser-only prototype | This system |
|---|---|---|
| Where votes live | One browser tab's memory (lost on reload) | A server-side data file, shared by every device |
| Who enforces the rules | The browser's JavaScript (viewable/editable by anyone) | The server (`server.js`) — the same checks run even if someone bypasses the web page entirely |
| Admin passcode check | Pure client-side JS (trivial to view/bypass in browser dev tools) | Checked server-side; the page never receives write access without a valid token |
| Vote ledger | Hash-chained, but only safe within a single browser tab | True hash-chained ledger, safely serialized because the whole server is one process |

## Requirements

- [Node.js](https://nodejs.org) version 18 or newer. Nothing else — no `npm install`, no database server, no external services.

## Running it

```bash
cd cusa-voting-system
node server.js
```

Then open **http://localhost:8080** in a browser. That's the whole app — student voting, live tallies, receipt lookup, integrity check, and the admin panel are all on that one page, organized into tabs.

- **Admin passcode (demo):** `admin2026`
  Change it before real use: `ADMIN_PASSCODE=your-real-passcode node server.js`

## Trying it out

Sample registration numbers are pre-loaded in `data/store.json` (Bachelor's, Diploma, and Certificate students who can vote, plus one Masters and one PhD number to confirm they're correctly turned away):

- `BED/1123/21` — Bachelor's, Education & Resources Development, female, resident
- `DIP-BUS/0099/24` — Diploma, Business Studies, female, resident
- `CERT-IT/0055/24` — Certificate, Science & Technology, male, non-resident
- `MSC-CD/0044/24` — Masters (try this one — it should be rejected)
- `PHD-AGEC/0011/23` — PhD (also should be rejected)

**A typical run-through:**
1. Log in as a student, vote for Faculty Rep and your Residential seat.
2. Go to the **Admin** tab, log in with the passcode, and click "Close Faculty Rep voting & compute delegates." This runs the gender-swap logic automatically and opens G7 voting.
3. The delegate IDs (e.g. `ASP-FBUST-01`) shown in the **G7** tab can now log in on the **Cast Ballot** tab as delegates and vote for the executive committee.
4. Check the **Integrity** tab (admin login required) to verify the ledger, or use "Simulate Admin Tampering" in the Admin tab to see the integrity check catch an edited vote.

## Data and configuration

- **`data/store.json`** — the live data: voter roll, votes, delegates, election phase. Back this file up before any real election, and after it — this is your official record.
- **`server.js`** — candidates, faculties, and G7 positions are defined near the top of this file (`FACULTIES`, `FACULTY_CANDIDATES`, `RESIDENTIAL_CANDIDATES`, `G7_CANDIDATES`). Edit these with the real candidate list once nominations close, then restart the server.
- **Real voter roll** — replace the sample entries via the Admin tab's bulk upload (paste rows as `regNo, name, level, faculty code, gender, residency`), sourced from the registrar's actual list of Bachelor's, Diploma, and Certificate students.

## Deploying so students can actually reach it

Running `node server.js` on your own laptop only serves `localhost` — nobody else can reach it. To let real students vote, run this same code on a server reachable over the internet or campus network:

- **Simplest:** any Node hosting provider (e.g. Railway, Render, Fly.io) — push this folder, set `PORT` and `ADMIN_PASSCODE`, and it runs the same way.
- **On-campus:** university IT can run `node server.js` on any server they control (with a process manager like `pm2` so it restarts automatically), behind HTTPS.

Whichever you choose, put it behind **HTTPS**, not plain HTTP — student registration numbers and votes should never travel unencrypted.

## Before this runs a binding election

Read `SECURITY-NOTES.md` in this folder. The short version: this system faithfully enforces the *rules* of your election (eligibility, residency/gender-locked seats, the delegate swap rule, one vote per student, tamper-evident storage) — but student and admin authentication are still intentionally minimal, and there's no automated backup. Those are the remaining gaps between "a correct reference implementation" and "a system ready for a real, binding student election."
