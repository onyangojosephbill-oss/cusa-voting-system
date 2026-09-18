/**
 * CUSA Verifiable Digital Ballot — reference backend.
 *
 * Zero external dependencies — only Node's built-in modules — so it runs
 * anywhere Node runs with nothing to `npm install`. Data is persisted to
 * data/store.json on disk, so votes and the voter roll survive restarts
 * and are shared by every device that hits this server (unlike the
 * original browser-only prototype, where everything lived in one tab's
 * memory).
 *
 * Run:   node server.js
 * Then open http://localhost:8080 in a browser.
 *
 * This is a REFERENCE implementation for demonstrating and testing the
 * election rules end-to-end on real, shared, persistent data. Before any
 * binding student election, read SECURITY-NOTES.md in this folder —
 * student authentication and admin authentication here are both
 * intentionally minimal and are NOT sufficient for a real election on
 * their own.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 8080;
const DATA_FILE = path.join(__dirname, "data", "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------------------------------------------------------------------
// Election structure — edit these to update faculties/candidates, then
// restart the server. (A future version could move these into the admin
// panel; for now they are the single source of truth for ballot content.)
// ---------------------------------------------------------------------

const FACULTIES = [
  { code: "FBUST", name: "Business Studies" },
  { code: "FHSS", name: "Humanities & Social Sciences" },
  { code: "FAST", name: "Science & Technology" },
  { code: "FAES", name: "Agriculture & Environmental Studies" },
  { code: "FERD", name: "Education & Resources Development" },
  { code: "FENG", name: "Engineering" },
  { code: "LAW", name: "Law" },
  { code: "NPH", name: "Nursing & Public Health" },
];

// 4 sample candidates per faculty, 2 male / 2 female, so the delegate
// gender-swap rule has something real to demonstrate out of the box.
const FACULTY_CANDIDATES = {};
FACULTIES.forEach((f) => {
  FACULTY_CANDIDATES[f.code] = [
    { id: "ASP-" + f.code + "-01", name: "Candidate A — " + f.name, gender: "male", party: "UNITI" },
    { id: "ASP-" + f.code + "-02", name: "Candidate B — " + f.name, gender: "female", party: "SAUTI" },
    { id: "ASP-" + f.code + "-03", name: "Candidate C — " + f.name, gender: "male", party: "SAUTI" },
    { id: "ASP-" + f.code + "-04", name: "Candidate D — " + f.name, gender: "female", party: "UNITI" },
  ];
});

const RESIDENTIAL_SEATS = ["Male Resident", "Female Resident", "Male Non-Resident", "Female Non-Resident"];
const RESIDENTIAL_CANDIDATES = {
  "Male Resident": [
    { name: "James Mutiso", party: "UNITI" },
    { name: "Collins Barasa", party: "SAUTI" },
  ],
  "Female Resident": [
    { name: "Winnie Nyaboke", party: "UNITI" },
    { name: "Purity Wangui", party: "SAUTI" },
  ],
  "Male Non-Resident": [
    { name: "Erick Kiplangat", party: "UNITI" },
    { name: "Bramwel Otieno", party: "SAUTI" },
  ],
  "Female Non-Resident": [
    { name: "Sharon Adhiambo", party: "UNITI" },
    { name: "Immaculate Wanjiru", party: "SAUTI" },
  ],
};

const G7_POSITIONS = [
  "Chairman", "Vice Chairperson", "Director Academics", "Secretary General",
  "Treasurer", "Director Student Welfare", "Organising Secretary",
];
const G7_CANDIDATES = {};
G7_POSITIONS.forEach((p) => {
  G7_CANDIDATES[p] = [
    { name: p + " — Candidate 1", party: "UNITI" },
    { name: p + " — Candidate 2", party: "SAUTI" },
  ];
});

const ALLOWED_LEVELS = ["bachelors", "diploma", "certificate"];
const LEVEL_LABELS = { bachelors: "Bachelor's", diploma: "Diploma", certificate: "Certificate", masters: "Masters", phd: "PhD" };

// ---------------------------------------------------------------------
// Persistence — a JSON file on disk. Small scale, single Node process,
// synchronous fs calls: no separate database engine to install or run.
// ---------------------------------------------------------------------

function loadStore() {
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  return JSON.parse(raw);
}
function saveStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

let DB = loadStore();

// ---------------------------------------------------------------------
// Ledger helpers — true hash-chained ledger. Because this whole server
// is one single-threaded Node process and every handler below runs
// fully to completion (synchronous fs + in-memory ops, no interleaved
// async work) before the next request is handled, appends are safely
// serialized — no two votes can race for the same "previous hash".
// ---------------------------------------------------------------------

function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function genReceiptCode() {
  return crypto.randomBytes(5).toString("hex").toUpperCase();
}

function appendToLedger(ledgerName, choices) {
  const ledger = DB.ledgers[ledgerName];
  const prevHash = ledger.length ? ledger[ledger.length - 1].hash : "GENESIS";
  const entry = {
    index: ledger.length,
    timestamp: new Date().toISOString(),
    receiptCode: genReceiptCode(),
    choices,
    prevHash,
  };
  entry.hash = sha256(prevHash + "|" + entry.timestamp + "|" + entry.receiptCode + "|" + JSON.stringify(choices));
  ledger.push(entry);
  saveStore(DB);
  return entry;
}

function verifyLedger(ledgerName) {
  const ledger = DB.ledgers[ledgerName] || [];
  const problems = [];
  let prevHash = "GENESIS";
  for (const entry of ledger) {
    const expectedHash = sha256(prevHash + "|" + entry.timestamp + "|" + entry.receiptCode + "|" + JSON.stringify(entry.choices));
    if (entry.prevHash !== prevHash) {
      problems.push({ index: entry.index, issue: "prevHash does not match the previous entry — chain is broken here." });
    } else if (entry.hash !== expectedHash) {
      problems.push({ index: entry.index, issue: "stored hash does not match recomputed hash — this entry's data was altered after it was recorded." });
    }
    prevHash = entry.hash;
  }
  return { total: ledger.length, valid: problems.length === 0, problems };
}

// ---------------------------------------------------------------------
// Delegate computation — top 3 Faculty Rep vote-getters per faculty,
// with the gender-balance swap rule.
// ---------------------------------------------------------------------

function computeDelegates() {
  const perFaculty = {};
  FACULTIES.forEach((f) => { perFaculty[f.code] = {}; });
  DB.ledgers.faculty.forEach((entry) => {
    const { faculty, candidateId } = entry.choices;
    if (!perFaculty[faculty]) return;
    perFaculty[faculty][candidateId] = (perFaculty[faculty][candidateId] || 0) + 1;
  });

  const delegates = {};
  FACULTIES.forEach((f) => {
    const candidates = FACULTY_CANDIDATES[f.code];
    const ranked = candidates
      .map((c) => ({ ...c, votes: perFaculty[f.code][c.id] || 0 }))
      .sort((a, b) => b.votes - a.votes);

    let top3 = ranked.slice(0, 3);
    const fourth = ranked[3];
    let swapped = false, swapFailed = false;
    const genders = top3.map((c) => c.gender);
    const allSameGender = genders.every((g) => g === genders[0]) && top3.length === 3;

    if (allSameGender) {
      if (fourth && fourth.gender !== genders[0]) {
        top3 = [top3[0], top3[1], fourth];
        swapped = true;
      } else {
        swapFailed = true; // no opposite-gender candidate available in top 4
      }
    }

    delegates[f.code] = {
      faculty: f.name,
      ranked,
      chosen: top3,
      swapped,
      swapFailed,
    };
  });

  DB.delegates = delegates;
  DB.phase = "g7open";
  saveStore(DB);
  return delegates;
}

function findDelegate(regNoOrId) {
  if (!DB.delegates) return null;
  for (const facCode of Object.keys(DB.delegates)) {
    const match = DB.delegates[facCode].chosen.find((c) => c.id === regNoOrId);
    if (match) return { ...match, facultyCode: facCode };
  }
  return null;
}

// ---------------------------------------------------------------------
// Admin auth — a shared demo passcode, checked server-side (already a
// real improvement over a client-only JS check, since it can't be
// bypassed by viewing page source) but still a placeholder. See
// SECURITY-NOTES.md before any binding election.
// ---------------------------------------------------------------------

const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "admin2026";
const adminTokens = new Map(); // token -> expiry timestamp

function issueAdminToken() {
  const token = crypto.randomBytes(24).toString("hex");
  adminTokens.set(token, Date.now() + 2 * 60 * 60 * 1000); // 2 hours
  return token;
}
function isValidAdminToken(token) {
  const expiry = adminTokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { adminTokens.delete(token); return false; }
  return true;
}
function requireAdmin(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return isValidAdminToken(token);
}

// ---------------------------------------------------------------------
// Tiny HTTP layer — routing, JSON body parsing, static file serving.
// No framework: keeps this to zero npm dependencies.
// ---------------------------------------------------------------------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error("Body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------

function publicVoter(v) {
  if (!v) return null;
  return {
    regNo: v.regNo, name: v.name, level: v.level, levelLabel: LEVEL_LABELS[v.level] || v.level,
    faculty: v.faculty, gender: v.gender, residency: v.residency,
    votedFaculty: !!v.votedFaculty, votedResidential: !!v.votedResidential, votedG7: !!v.votedG7,
  };
}

function seatFor(v) {
  const genderLabel = v.gender === "male" ? "Male" : "Female";
  const residencyLabel = v.residency === "resident" ? "Resident" : "Non-Resident";
  return genderLabel + " " + residencyLabel;
}

async function handleApi(req, res, pathname, query) {
  // ---- Public: election structure & phase ----
  if (pathname === "/api/structure" && req.method === "GET") {
    return sendJson(res, 200, {
      faculties: FACULTIES, facultyCandidates: FACULTY_CANDIDATES,
      residentialSeats: RESIDENTIAL_SEATS, residentialCandidates: RESIDENTIAL_CANDIDATES,
      g7Positions: G7_POSITIONS, g7Candidates: G7_CANDIDATES,
      phase: DB.phase,
    });
  }

  // ---- Student login ----
  if (pathname === "/api/login" && req.method === "POST") {
    const body = await readJsonBody(req);
    const regNo = String(body.regNo || "").trim().toUpperCase();
    if (!regNo) return sendJson(res, 400, { ok: false, error: "Enter your registration number." });

    const voter = DB.voters[regNo];
    if (voter) {
      if (ALLOWED_LEVELS.indexOf(voter.level) === -1) {
        return sendJson(res, 200, { ok: false, error: "This is a " + (LEVEL_LABELS[voter.level] || voter.level) + " registration number. CUSA elections are open to Bachelor's, Diploma, and Certificate students only." });
      }
      return sendJson(res, 200, { ok: true, role: "voter", voter: publicVoter(voter), phase: DB.phase });
    }

    const delegate = findDelegate(regNo);
    if (delegate && DB.phase === "g7open") {
      return sendJson(res, 200, {
        ok: true, role: "delegate",
        delegate: { id: delegate.id, name: delegate.name, faculty: delegate.faculty, facultyCode: delegate.facultyCode },
        votedG7: !!(DB.g7Voted && DB.g7Voted[regNo]),
        phase: DB.phase,
      });
    }

    return sendJson(res, 200, { ok: false, error: "That registration number isn't on the eligible voters list. Contact your electoral office if you believe this is an error." });
  }

  // ---- Cast: Faculty Rep ----
  if (pathname === "/api/vote/faculty" && req.method === "POST") {
    const body = await readJsonBody(req);
    const regNo = String(body.regNo || "").trim().toUpperCase();
    const candidateId = String(body.candidateId || "");
    const voter = DB.voters[regNo];
    if (!voter) return sendJson(res, 404, { ok: false, error: "Voter not found." });
    if (ALLOWED_LEVELS.indexOf(voter.level) === -1) return sendJson(res, 403, { ok: false, error: "Not eligible to vote." });
    if (DB.phase !== "faculty") return sendJson(res, 409, { ok: false, error: "Faculty Rep voting is closed." });
    if (voter.votedFaculty) return sendJson(res, 409, { ok: false, error: "You have already voted for Faculty Rep." });
    const candidates = FACULTY_CANDIDATES[voter.faculty] || [];
    if (!candidates.find((c) => c.id === candidateId)) return sendJson(res, 400, { ok: false, error: "Invalid candidate for your faculty." });

    const entry = appendToLedger("faculty", { faculty: voter.faculty, candidateId });
    voter.votedFaculty = true;
    saveStore(DB);
    return sendJson(res, 200, { ok: true, receiptCode: entry.receiptCode });
  }

  // ---- Cast: Residential ----
  if (pathname === "/api/vote/residential" && req.method === "POST") {
    const body = await readJsonBody(req);
    const regNo = String(body.regNo || "").trim().toUpperCase();
    const candidateName = String(body.candidateName || "");
    const voter = DB.voters[regNo];
    if (!voter) return sendJson(res, 404, { ok: false, error: "Voter not found." });
    if (ALLOWED_LEVELS.indexOf(voter.level) === -1) return sendJson(res, 403, { ok: false, error: "Not eligible to vote." });
    if (voter.votedResidential) return sendJson(res, 409, { ok: false, error: "You have already voted for your Residential seat." });
    const seat = seatFor(voter);
    const candidates = RESIDENTIAL_CANDIDATES[seat] || [];
    if (!candidates.find((c) => c.name === candidateName)) return sendJson(res, 400, { ok: false, error: "Invalid candidate for your seat (" + seat + ")." });

    const entry = appendToLedger("residential", { seat, candidateName });
    voter.votedResidential = true;
    saveStore(DB);
    return sendJson(res, 200, { ok: true, receiptCode: entry.receiptCode, seat });
  }

  // ---- Cast: G7 (delegates only) ----
  if (pathname === "/api/vote/g7" && req.method === "POST") {
    const body = await readJsonBody(req);
    const regNo = String(body.regNo || "").trim().toUpperCase();
    const choices = body.choices || {};
    if (DB.phase !== "g7open") return sendJson(res, 409, { ok: false, error: "G7 voting is not open yet." });
    const delegate = findDelegate(regNo);
    if (!delegate) return sendJson(res, 403, { ok: false, error: "Only computed delegates may vote for G7." });
    DB.g7Voted = DB.g7Voted || {};
    if (DB.g7Voted[regNo]) return sendJson(res, 409, { ok: false, error: "You have already voted for G7." });

    for (const pos of G7_POSITIONS) {
      const pick = choices[pos];
      const valid = (G7_CANDIDATES[pos] || []).find((c) => c.name === pick);
      if (!valid) return sendJson(res, 400, { ok: false, error: "Missing or invalid choice for " + pos + "." });
    }

    const entry = appendToLedger("g7", choices);
    DB.g7Voted[regNo] = true;
    saveStore(DB);
    return sendJson(res, 200, { ok: true, receiptCode: entry.receiptCode });
  }

  // ---- Live tallies ----
  if (pathname === "/api/tally" && req.method === "GET") {
    const facultyTally = {};
    FACULTIES.forEach((f) => {
      facultyTally[f.code] = {};
      FACULTY_CANDIDATES[f.code].forEach((c) => { facultyTally[f.code][c.id] = 0; });
    });
    DB.ledgers.faculty.forEach((e) => {
      if (facultyTally[e.choices.faculty] && facultyTally[e.choices.faculty][e.choices.candidateId] !== undefined) {
        facultyTally[e.choices.faculty][e.choices.candidateId]++;
      }
    });

    const residentialTally = {};
    RESIDENTIAL_SEATS.forEach((seat) => {
      residentialTally[seat] = {};
      RESIDENTIAL_CANDIDATES[seat].forEach((c) => { residentialTally[seat][c.name] = 0; });
    });
    DB.ledgers.residential.forEach((e) => {
      if (residentialTally[e.choices.seat] && residentialTally[e.choices.seat][e.choices.candidateName] !== undefined) {
        residentialTally[e.choices.seat][e.choices.candidateName]++;
      }
    });

    const g7Tally = {};
    G7_POSITIONS.forEach((pos) => {
      g7Tally[pos] = {};
      G7_CANDIDATES[pos].forEach((c) => { g7Tally[pos][c.name] = 0; });
    });
    DB.ledgers.g7.forEach((e) => {
      G7_POSITIONS.forEach((pos) => {
        const pick = e.choices[pos];
        if (g7Tally[pos][pick] !== undefined) g7Tally[pos][pick]++;
      });
    });

    return sendJson(res, 200, {
      facultyTally, residentialTally, g7Tally,
      counts: { faculty: DB.ledgers.faculty.length, residential: DB.ledgers.residential.length, g7: DB.ledgers.g7.length, voters: Object.keys(DB.voters).length },
      phase: DB.phase, delegates: DB.delegates || null,
    });
  }

  // ---- Receipt lookup ----
  if (pathname.startsWith("/api/receipt/") && req.method === "GET") {
    const code = decodeURIComponent(pathname.slice("/api/receipt/".length)).toUpperCase();
    for (const ledgerName of ["faculty", "residential", "g7"]) {
      const entry = DB.ledgers[ledgerName].find((e) => e.receiptCode === code);
      if (entry) return sendJson(res, 200, { ok: true, ledger: ledgerName, entry });
    }
    return sendJson(res, 404, { ok: false, error: "No ballot found for that receipt code." });
  }

  // ---- Admin: login ----
  if (pathname === "/api/admin/login" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (String(body.passcode || "") !== ADMIN_PASSCODE) {
      return sendJson(res, 401, { ok: false, error: "Incorrect passcode." });
    }
    return sendJson(res, 200, { ok: true, token: issueAdminToken() });
  }

  // Everything below requires a valid admin token.
  if (pathname.startsWith("/api/admin/") && pathname !== "/api/admin/login") {
    if (!requireAdmin(req)) return sendJson(res, 401, { ok: false, error: "Admin session expired or invalid — log in again." });
  }

  // ---- Admin: bulk voter upload ----
  if (pathname === "/api/admin/voters" && req.method === "POST") {
    const body = await readJsonBody(req);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    let added = 0, updated = 0, skipped = 0;
    rows.forEach((r) => {
      const regNo = String(r.regNo || "").trim().toUpperCase();
      if (!regNo) { skipped++; return; }
      const level = String(r.level || "").trim().toLowerCase();
      const gender = String(r.gender || "").trim().toLowerCase();
      const residency = String(r.residency || "").trim().toLowerCase();
      const faculty = String(r.faculty || "").trim().toUpperCase();
      if (["male", "female"].indexOf(gender) === -1 || ["resident", "non-resident"].indexOf(residency) === -1) { skipped++; return; }
      const existing = DB.voters[regNo];
      DB.voters[regNo] = {
        regNo, name: String(r.name || "").trim() || (existing ? existing.name : ""),
        level, gender, residency, faculty,
        votedFaculty: existing ? existing.votedFaculty : false,
        votedResidential: existing ? existing.votedResidential : false,
        votedG7: existing ? existing.votedG7 : false,
      };
      existing ? updated++ : added++;
    });
    saveStore(DB);
    return sendJson(res, 200, { ok: true, added, updated, skipped, total: Object.keys(DB.voters).length });
  }

  // ---- Admin: list voters (for the roster view) ----
  if (pathname === "/api/admin/voters" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, voters: Object.values(DB.voters) });
  }

  // ---- Admin: compute delegates & open G7 ----
  if (pathname === "/api/admin/compute-delegates" && req.method === "POST") {
    if (DB.phase !== "faculty") return sendJson(res, 409, { ok: false, error: "Delegates have already been computed for this election." });
    const delegates = computeDelegates();
    return sendJson(res, 200, { ok: true, delegates });
  }

  // ---- Admin: integrity check ----
  if (pathname.startsWith("/api/admin/integrity/") && req.method === "GET") {
    const ledgerName = pathname.split("/").pop();
    if (!DB.ledgers[ledgerName]) return sendJson(res, 400, { ok: false, error: "Unknown ledger." });
    return sendJson(res, 200, { ok: true, ...verifyLedger(ledgerName) });
  }

  // ---- Admin: simulate tampering (demo/testing aid) ----
  if (pathname === "/api/admin/simulate-tamper" && req.method === "POST") {
    const body = await readJsonBody(req);
    const ledgerName = String(body.ledger || "");
    const index = Number(body.index);
    const ledger = DB.ledgers[ledgerName];
    if (!ledger || !ledger[index]) return sendJson(res, 404, { ok: false, error: "Entry not found." });
    // Mutate stored choices directly, the way a raw database edit would — WITHOUT recomputing the hash.
    ledger[index].choices = { ...ledger[index].choices, __tampered: true, tamperedAt: new Date().toISOString() };
    saveStore(DB);
    return sendJson(res, 200, { ok: true, message: "Entry " + index + " in " + ledgerName + " was edited directly, bypassing the hash chain. Run the integrity check to see it get caught." });
  }

  // ---- Admin: reset votes (keeps the voter roll) ----
  if (pathname === "/api/admin/reset-votes" && req.method === "POST") {
    DB.ledgers = { faculty: [], residential: [], g7: [] };
    DB.delegates = null;
    DB.g7Voted = {};
    DB.phase = "faculty";
    Object.values(DB.voters).forEach((v) => { v.votedFaculty = false; v.votedResidential = false; v.votedG7 = false; });
    saveStore(DB);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: "Unknown endpoint." });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const pathname = parsed.pathname;

  if (pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, pathname, parsed.searchParams);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: "Server error: " + e.message });
    }
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log("CUSA Verifiable Digital Ballot server running at http://localhost:" + PORT);
  console.log("Admin passcode: " + ADMIN_PASSCODE + " (change via ADMIN_PASSCODE env var before real use)");
});
