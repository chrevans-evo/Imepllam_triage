// Matches free-text job titles to ESCO occupations.
// Weighted token overlap (IDF-weighted Dice) against each occupation's
// preferred title and its ESCO alternative titles.

const ABBREV = {
  mgr: "manager", mngr: "manager", mgt: "management", mgmt: "management",
  exec: "executive", admin: "administrator", asst: "assistant",
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
  rn: "registered nurse", gp: "general practitioner",
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

const SYNONYM = { head: "manager", officer: "officer", advisor: "adviser", organiser: "organizer",
  centre: "center", labour: "labor", programme: "program", analyse: "analyze", colour: "color" };

// Words that mark a role as managing others. A title without one should not
// land on a manager occupation just because the other words match.
const MANAGES = new Set(["manager", "supervisor", "director", "head", "chief", "leader"]);

function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

export function tokens(text, { dropNoise = true } = {}) {
  const raw = String(text).toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim().split(/\s+/).filter(Boolean);
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
  const labels = []; // { job, text, toks, pref }
  jobs.forEach((j, ji) => {
    labels.push({ job: ji, text: j.t, toks: tokens(j.t), pref: true });
    for (const a of j.alt || []) labels.push({ job: ji, text: a, toks: tokens(a), pref: false });
  });
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

  function match(title, k = 5) {
    let q = tokens(title);
    if (!q.length) q = tokens(title, { dropNoise: false });
    if (!q.length) return [];
    const qw = q.reduce((s, t) => s + idf(t), 0);
    const qManages = q.some((t) => MANAGES.has(t));
    const overlap = new Map();
    for (const t of q) for (const li of postings.get(t) || []) {
      overlap.set(li, (overlap.get(li) || 0) + idf(t));
    }
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
    return [...best.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, k)
      .map(([ji, v]) => ({ s: jobs[ji].s, score: Math.min(1, +v.score.toFixed(3)), label: v.label }));
  }

  function search(text, k = 12) {
    return match(text, k);
  }

  return { match, search };
}

// A match is only "high" when it is strong and clearly ahead of the next job.
export function confidence(cands) {
  const score = cands[0]?.score || 0;
  const gap = score - (cands[1]?.score || 0);
  if (score >= 0.8 && gap >= 0.03) return "high";
  if (score >= 0.55) return "medium";
  return "low";
}
