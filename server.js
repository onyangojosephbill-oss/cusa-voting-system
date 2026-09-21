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

const DEFAULT_SEED = {
  phase: "faculty",
  voters: {
    "BED/1123/21": { regNo: "BED/1123/21", name: "Ann Mumbi", level: "bachelors", faculty: "FERD", gender: "female", residency: "resident", votedFaculty: false, votedResidential: false, votedG7: false },
    "BCOM/0456/22": { regNo: "BCOM/0456/22", name: "Peter Kamau", level: "bachelors", faculty: "FBUST", gender: "male", residency: "non-resident", votedFaculty: false, votedResidential: false, votedG7: false },
    "BSC-CS/0789/20": { regNo: "BSC-CS/0789/20", name: "Grace Njeri", level: "bachelors", faculty: "FAST", gender: "female", residency: "resident", votedFaculty: false, votedResidential: false, votedG7: false },
    "DIP-BUS/0099/24": { regNo: "DIP-BUS/0099/24", name: "Faith Chebet", level: "diploma", faculty: "FBUST", gender: "female", residency: "resident", votedFaculty: false, votedResidential: false, votedG7: false },
    "CERT-IT/0055/24": { regNo: "CERT-IT/0055/24", name: "Brian Otieno", level: "certificate", faculty: "FAST", gender: "male", residency: "non-resident", votedFaculty: false, votedResidential: false, votedG7: false },
    "MSC-CD/0044/24": { regNo: "MSC-CD/0044/24", name: "Onyango J. Bill", level: "masters", faculty: "FHSS", gender: "male", residency: "non-resident", votedFaculty: false, votedResidential: false, votedG7: false },
    "PHD-AGEC/0011/23": { regNo: "PHD-AGEC/0011/23", name: "Wilson Karanja", level: "phd", faculty: "FAES", gender: "male", residency: "non-resident", votedFaculty: false, votedResidential: false, votedG7: false },
  },
  ledgers: { faculty: [], residential: [], g7: [] },
  delegates: null,
  g7Voted: {},
};

function loadStore() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === "ENOENT") {
      console.log("data/store.json not found — creating it with a starter seed (a handful of sample voters). Replace via the Admin tab's bulk upload with your real roll.");
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_SEED, null, 2));
      return JSON.parse(JSON.stringify(DEFAULT_SEED));
    }
    throw e;
  }
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
