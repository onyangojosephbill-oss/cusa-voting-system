# Security Notes — Read Before Any Binding Election

This system correctly enforces every *rule* you specified: eligibility by study level, residency-and-gender-locked seats, the delegate gender-swap logic, one ballot per student, and a tamper-evident vote ledger. That part is solid and tested.

What it does **not** yet solve is **identity** — proving the person typing a registration number is actually that student. That's a different problem from ballot logic, and it's the one thing every real election system has to get right before it can be trusted with a binding vote.

## 1. Student authentication is a single shared secret (the registration number)

**Risk:** Registration numbers are not secret. A student's number can be seen on their ID card, printed on transcripts, or simply known by roommates and classmates. Anyone who knows another student's registration number can currently vote as them.

**Fix before real use:** Add a second factor the student alone controls — for example:
- A one-time code emailed to the student's official university email address (the university almost certainly already has these on file), entered alongside the registration number.
- Or, if the university has any existing student login system (a student portal, Google Workspace account, etc.), have students authenticate through that instead of typing a bare registration number here.

## 2. Admin authentication is a single shared passcode

**Risk:** Everyone with admin access uses the same passcode. There's no way to tell which admin performed which action, and if the passcode leaks, anyone can compute delegates early, reset votes, or view the full roll.

**Fix before real use:** Individual admin accounts (username + password, or better, an existing university staff login) so actions are attributable to a specific person, with the ability to revoke one admin's access without changing the passcode for everyone else.

## 3. No automated backups

**Risk:** All data lives in one file (`data/store.json`) on one server. If that disk fails or the file is corrupted mid-election, votes could be lost.

**Fix before real use:** Automated, regular backups of `data/store.json` to a separate location (and ideally, replace the flat file with a small database engine that handles this more robustly at scale).

## 4. HTTPS is not automatic

**Risk:** If this is deployed behind plain HTTP, registration numbers and votes travel across the network in a form anyone on the same network could read.

**Fix before real use:** Deploy behind HTTPS. Most hosting providers (Railway, Render, Fly.io, etc.) provide this automatically; if self-hosting on a university server, this needs to be configured explicitly (e.g. with a free certificate from Let's Encrypt).

## 5. No independent security review has been done

This was built and tested by working through the rules you gave and confirming the server enforces them correctly — that is not the same as a security audit. Before a binding student election, have someone outside the build process (ideally with security experience) specifically try to break the authentication and vote-casting logic — attempt to vote twice, vote as someone else, tamper with recorded votes, or access admin functions without the passcode — and confirm none of it succeeds.

## What's already handled well

To be clear about what you're *not* starting over on:
- **Vote logic is enforced server-side**, not just in the browser — someone bypassing the web page entirely and calling the API directly hits the exact same eligibility, residency/gender, and double-vote checks.
- **The vote ledger is genuinely tamper-evident**, not just for show — any direct edit to a stored vote is detectable by the integrity check, because the server serializes every vote through one process (see `server.js` for how this differs from the browser-only prototype, where true chaining wasn't safely possible with multiple simultaneous voters).
- **The delegate gender-swap rule is unit-verified** against edge cases (all-male top 3 with a female in 4th, all-male top 3 with no opposite-gender candidate available, and an already-mixed top 3) — see the testing performed during development.

The remaining gap is entirely about *proving who's on the other end of the connection* — both for students and for admins — which is a policy and infrastructure decision for the university to make (what login system to require), not something more code alone can solve.
