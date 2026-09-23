// Matches free-text job titles to ESCO occupations.
// Weighted token overlap (IDF-weighted Dice) against each occupation's
// preferred title and its ESCO alternative titles, plus a small nudge from
// the organisation's industry. (A department hint was tried and made
// matching worse on the benchmark, so it is not used.)
// Measured by tests/match_benchmark.mjs.

const ABBREV = {
  mgr: "manager", mngr: "manager", mgt: "management", mgmt: "management",
  exec: "executive", admin: "administrative", asst: "assistant",
  hr: "human resources", hrbp: "human resources business partner",
  it: "ict", ict: "ict", rep: "representative", reps: "representative", dev: "developer",
  eng: "engineer", engr: "engineer", ops: "operations", acct: "accountant",
  coord: "coordinator", spec: "specialist", tech: "technician",
  cs: "customer service", csr: "customer service representative", bdm: "business development manager",
  ba: "business analyst", pm: "project manager", qa: "quality assurance", ux: "user experience",
  ui: "user interface", ceo: "chief executive officer", cfo: "chief financial officer",
  cto: "chief technology officer", cio: "chief information officer", coo: "chief operating officer",
  chro: "chief human resources officer", gm: "general manager",
  svc: "service", sw: "software", sde: "software developer", swe: "software engineer",
  wh: "warehouse", whse: "warehouse", maint: "maintenance", ohs: "health safety", whs: "health safety",
  rn: "registered nurse", gp: "general practitioner", pa: "personal assistant", ea: "executive assistant",
  fpa: "financial planning analyst", devops: "devops",
};

// Words that describe level, location or contract, not the work itself.
const NOISE = new Set([
  "senior", "snr", "sr", "junior", "jnr", "jr", "graduate", "grad", "principal", "lead",
  "i", "ii", "iii", "iv", "1", "2", "3", "4", "5", "level", "grade", "band",
  "apac", "emea", "anz", "au", "aus", "australia", "nz", "asia", "pacific", "global", "regional",
  "national", "group", "nsw", "vic", "qld", "wa", "sa", "tas", "act", "nt", "sydney", "melbourne",
  "brisbane", "perth", "adelaide", "contract", "temp", "casual", "permanent", "fte", "part", "time",
  "full", "fixed", "term", "acting", "interim", "the", "of", "and", "a", "an", "for", "in", "to", "at",
  "with", "on", "team", "department", "dept",
]);

const SYNONYM = { head: "manager", advisor: "adviser", organiser: "organizer",
  centre: "center", labour: "labor", programme: "program", analyse: "analyze", colour: "color" };

// Words that often mean the same role in different organisations. A match on
// one of these earns half the credit of an exact word match.
const SOFT_GROUPS = [
  ["officer", "adviser", "consultant", "specialist", "agent", "representative", "partner", "associate"],
  ["assistant", "clerk", "administrator", "secretary"],
  ["leader", "supervisor"],
  ["retail", "shop", "store"],
  ["communication", "public", "relation", "media"],
  ["developer", "engineer", "programmer"],
  ["designer", "analyst"],
];
const SOFT = new Map();
for (const g of SOFT_GROUPS) for (const w of g) SOFT.set(w, g.filter((x) => x !== w));
const SOFT_CREDIT = 0.5;

// Words that mark a role as managing others. A title without one should not
// land on a manager occupation just because the other words match.
const MANAGES = new Set(["manager", "supervisor", "director", "chief", "leader"]);

// Role nouns say what level a job is at, not what industry it sits in.
const ROLE_NOUNS = new Set([
  "manager", "officer", "assistant", "clerk", "adviser", "consultant", "specialist", "analyst", "worker",
  "director", "supervisor", "technician", "coordinator", "administrator", "agent", "representative",
  "operator", "engineer", "developer", "leader", "chief", "executive", "service", "support", "general",
]);

const STEM_KEEP = new Set(["securities", "sales", "utilities", "logistics", "physics", "economics", "statistics", "news"]);

function stem(w) {
  if (STEM_KEEP.has(w)) return w;
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

function clean(text) {
  return String(text).toLowerCase()
    .replace(/fp\s*&\s*a/g, " fpa ")
    // Australian "contact centre" is ESCO's "call centre".
    .replace(/\bcontact\s+cent(re|er)\b/g, "call centre")
    // "Assistant to the CEO": the part after "to" names the boss, not the job.
    .replace(/\b(assistant|pa|ea|secretary|adviser|advisor)\s+to\s+.*$/g, "$1")
    .replace(/&/g, " and ");
}

export function tokens(text, { dropNoise = true } = {}) {
  const raw = clean(text).replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (const w of raw) {
    const expanded = Object.hasOwn(ABBREV, w) ? ABBREV[w].split(" ") : [w];
    for (let x of expanded) {
      if (Object.hasOwn(SYNONYM, x)) x = SYNONYM[x];
      if (dropNoise && NOISE.has(x)) continue;
      out.push(stem(x));
    }
  }
  return [...new Set(out)];
}

export function buildMatcher(jobs) {
  const labels = []; // { job, text, toks, pref, w }
  const titleToks = []; // every word in a job's titles and alternative titles
  jobs.forEach((j, ji) => {
    const all = new Set();
    const add = (text, pref) => {
      const toks = tokens(text);
      toks.forEach((t) => all.add(t));
      labels.push({ job: ji, text, toks, pref });
    };
    add(j.t, true);
    for (const a of j.alt || []) add(a, false);
    titleToks.push(all);
  });
  const slugIndex = new Map(jobs.map((j, i) => [j.s, i]));
  const df = new Map();
  const postings = new Map();
  labels.forEach((l, li) => {
    for (const t of l.toks) {
      df.set(t, (df.get(t) || 0) + 1);
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push(li);
    }
  });
  const N = labels.length;
  const idf = (t) => Math.log(1 + N / (df.get(t) || 0.5));
  for (const l of labels) l.w = l.toks.reduce((s, t) => s + idf(t), 0);
  const prefToks = jobs.map((j) => tokens(j.t));

  const dice = (a, b) => {
    const bs = new Set(b);
    const ov = a.filter((t) => bs.has(t)).reduce((s, t) => s + idf(t), 0);
    const w = a.reduce((s, t) => s + idf(t), 0) + b.reduce((s, t) => s + idf(t), 0);
    return w ? (2 * ov) / w : 0;
  };

  // opts.context: Map(token -> weight 0..1) of words typical of this
  // organisation's industry (see industryContext).
  function match(title, k = 5, opts = {}) {
    let q = tokens(title);
    if (!q.length) q = tokens(title, { dropNoise: false });
    if (!q.length) return [];
    const qw = q.reduce((s, t) => s + idf(t), 0);
    const qManages = q.some((t) => MANAGES.has(t));
    const qSet = new Set(q);

    // Exact word overlap, then half credit for soft equivalents not already present.
    const overlap = new Map();
    const credit = (li, v) => overlap.set(li, (overlap.get(li) || 0) + v);
    for (const t of q) for (const li of postings.get(t) || []) credit(li, idf(t));
    for (const t of q) {
      for (const alt of SOFT.get(t) || []) {
        if (qSet.has(alt)) continue;
        for (const li of postings.get(alt) || []) {
          if (!labels[li].toks.includes(t)) credit(li, SOFT_CREDIT * Math.min(idf(t), idf(alt)));
        }
      }
    }

    const ctx = opts.context || new Map();

    const best = new Map(); // job -> { score, label }
    for (const [li, ov] of overlap) {
      const l = labels[li];
      let score = (2 * ov) / (qw + l.w);
      if (l.pref) score *= 1.03;
      const labelManages = l.toks.some((t) => MANAGES.has(t));
      if (labelManages && !qManages) score *= 0.88;
      else if (qManages && !labelManages) score *= 0.95;
      const cur = best.get(l.job);
      if (!cur || score > cur.score) best.set(l.job, { score, label: l.text });
    }
    for (const [ji, v] of best) {
      // Prefer the job whose main title is closest to the query (generic over niche).
      v.score += 0.06 * dice(q, prefToks[ji]);
      // Industry words that run through the rest of the organisation.
      let c = 0;
      for (const [t, w] of ctx) if (!qSet.has(t) && titleToks[ji].has(t)) c = Math.max(c, w);
      v.score += 0.08 * c;
    }
    return [...best.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, k)
      .map(([ji, v]) => ({ s: jobs[ji].s, score: Math.min(1, +v.score.toFixed(3)), label: v.label }));
  }

  // Words that recur across the organisation's likely matches (e.g. "insurance"
  // for an insurer). Built from a first matching pass over every title.
  function industryContext(titles) {
    const counts = new Map();
    let n = 0;
    for (const title of titles) {
      const top = match(title, 3);
      if (!top.length) continue;
      n++;
      const seen = new Set();
      for (const r of top) {
        for (const t of prefToks[slugIndex.get(r.s)]) if (!ROLE_NOUNS.has(t) && !NOISE.has(t)) seen.add(t);
      }
      for (const t of seen) counts.set(t, (counts.get(t) || 0) + 1);
    }
    const ctx = new Map();
    if (n < 5) return ctx;
    for (const [t, c] of counts) {
      const share = c / n;
      // Common across this organisation, but not common across all jobs.
      if (c >= 3 && share >= 0.12 && (df.get(t) || 0) < N * 0.01) ctx.set(t, Math.min(1, share * 2));
    }
    return ctx;
  }

  const search = (text, k = 12) => match(text, k);

  return { match, search, industryContext };
}

// A match is only "high" when it is strong and clearly ahead of the next job.
export function confidence(cands) {
  const score = cands[0]?.score || 0;
  const gap = score - (cands[1]?.score || 0);
  if (score >= 0.8 && gap >= 0.03) return "high";
  if (score >= 0.55) return "medium";
  return "low";
}

// Normalised form of a title, used to remember a person's corrections.
export const titleKey = (title) => tokens(title).sort().join(" ");
