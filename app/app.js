import { buildMatcher, confidence, titleKey } from "./matcher.js";
import { SAMPLE_CSV, SAMPLE_MATCHES, SAMPLE_NAME } from "./sample.js";

// Brand copy lives here so the app can be re-branded in one place.
const BRAND = {
  name: "Vertage",
  product: "Future of Work Lens",
  tagline: "Where advantage compounds.",
};

// The four types come from the two job scores, cut at 6. They are kept as a
// secondary tag: the work split below is the headline measure.
const TYPES = {
  SHRINK: {
    label: "Shrinking",
    blurb: "AI can do much of this work and adds little on top. Expect fewer of these roles, or much smaller ones.",
  },
  TRANSFORM: {
    label: "Transforming",
    blurb: "AI takes over a large part of the work and gives people big new abilities. The role changes shape.",
  },
  EVOLVE: {
    label: "Augmented",
    blurb: "AI does less of the work itself but makes people much better at it. Same role, stronger output.",
  },
  STABLE: {
    label: "Steady",
    blurb: "Low exposure either way. Mostly hands-on, physical or face-to-face work.",
  },
};
const ORDER = ["SHRINK", "TRANSFORM", "EVOLVE", "STABLE"];
const THRESHOLD = 6;
const BORDERLINE = 0.5;

// The work split: every skill in a job is scored 1–10 on two questions.
const SPLIT = [
  { key: "take", label: "AI can take over", blurb: "Skills where AI scores 7 or more on doing the work itself." },
  { key: "assist", label: "AI assists", blurb: "Skills AI can't do alone but scores 7 or more on making people better at." },
  { key: "human", label: "Stays human", blurb: "Skills AI neither does nor boosts much. Often physical, judgement or people work." },
];

// A role is a candidate for an internal move when AI can take over this much of it,
// and the destination must be at least this much less exposed.
const EXPOSED_AT = 0.4;
const SAFER_BY = 0.15;

const STORE_KEY = "fowl-state-v2";
const MEMORY_KEY = "fowl-memory-v1";
const SETTINGS_KEY = "fowl-settings-v1";

const state = {
  jobs: [],
  bySlug: new Map(),
  matcher: null,
  detail: null,
  skills: null,
  orgName: "",
  isSample: false,
  rows: [],
  memory: {}, // titleKey -> { s, mix } saved from a person's corrections
  adoption: 0.5, // share of AI-ready work the organisation actually takes up
  horizon: 3, // years from now
  view: "org",
  role: null, // { rowId } or { slug }
  reviewOnly: false,
  sort: { key: "hc", dir: -1 },
  loadMsg: null,
  picker: null, // { mode: "assign" | "blend", rowId } or { mode: "explore" }
};

const $ = (sel, root = document) => root.querySelector(sel);
const main = $("#main");
const tip = $("#tooltip");

// ---------------------------------------------------------------- utils

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const fmt = (n) => Math.round(n).toLocaleString("en-AU");
const pct = (x) => `${Math.round(x * 100)}%`;
const fte = (n) => (n >= 10 ? fmt(n) : n.toFixed(1));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
let uid = 0;
const newId = () => `r${Date.now().toString(36)}${(uid++).toString(36)}`;

function typePill(q, bl = false) {
  return `<span class="pill"><span class="sw sw-${q}"></span>${esc(TYPES[q].label)}</span>${bl ? ` <span class="bl-tag" data-tip="${esc("Within 0.5 of the line at 6. A small change in the scores would move this role to another type.")}">Borderline</span>` : ""}`;
}
function splitMini(sh) {
  return `<span class="split-mini" aria-hidden="true">${SPLIT.map((p, i) => `<span class="sw-${p.key}" style="width:${sh[i] * 100}%"></span>`).join("")}</span>`;
}
function confLabel(c) {
  return { high: "Strong match", medium: "Check", low: "Weak match", manual: "Checked", remembered: "Remembered" }[c] || c;
}
function typeFor(ar, ap) {
  if (ar >= THRESHOLD && ap >= THRESHOLD) return "TRANSFORM";
  if (ar >= THRESHOLD) return "SHRINK";
  if (ap >= THRESHOLD) return "EVOLVE";
  return "STABLE";
}
function tlRange(tl) {
  const n = String(tl).match(/\d+/g) || ["3", "5"];
  const a = +n[0];
  return [a, +(n[1] || a)];
}
// Share of the full change reached by a given year. The change starts in the
// year before the timeline's first number and is complete by its last.
function ramp(year, [a, b]) {
  const start = a - 1;
  return clamp((year - start) / Math.max(1, b - start), 0, 1);
}

// ---------------------------------------------------------------- persistence

function readStore(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: the session still works */ }
}
function save() {
  writeStore(STORE_KEY, { orgName: state.orgName, isSample: state.isSample, rows: state.rows });
  writeStore(SETTINGS_KEY, { adoption: state.adoption, horizon: state.horizon });
}
function restore() {
  const mem = readStore(MEMORY_KEY);
  if (mem && typeof mem === "object") state.memory = mem;
  const set = readStore(SETTINGS_KEY);
  if (set) {
    state.adoption = clamp(+set.adoption || 0.5, 0.1, 1);
    state.horizon = clamp(+set.horizon || 3, 1, 10);
  }
  const s = readStore(STORE_KEY);
  if (!s || !Array.isArray(s.rows) || !s.rows.length) return false;
  const valid = (r) => !r.s || (state.bySlug.has(r.s) && (!r.mix || r.mix.every((p) => state.bySlug.has(p.s))));
  const rows = s.rows.filter(valid);
  if (!rows.length) return false;
  Object.assign(state, { orgName: s.orgName || "", isSample: !!s.isSample, rows });
  return true;
}
function remember(r) {
  if (state.isSample) return;
  state.memory[titleKey(r.title)] = { s: r.s, mix: r.mix || null };
  writeStore(MEMORY_KEY, state.memory);
}

// ---------------------------------------------------------------- role metrics
// A row maps to one ESCO job, or a blend of two for hybrid roles.

const mixOf = (r) => (r.mix?.length ? r.mix : [{ s: r.s, w: 1 }]);

function metrics(r) {
  const parts = mixOf(r).map((p) => ({ j: state.bySlug.get(p.s), w: p.w }));
  const sum = (f) => parts.reduce((acc, p) => acc + f(p.j) * p.w, 0);
  const ar = +sum((j) => j.ar).toFixed(1);
  const ap = +sum((j) => j.ap).toFixed(1);
  const range = [sum((j) => tlRange(j.tl)[0]), sum((j) => tlRange(j.tl)[1])].map((x) => Math.round(x));
  return {
    j: parts[0].j,
    blended: parts.length > 1,
    ar, ap,
    q: typeFor(ar, ap),
    bl: Math.min(Math.abs(ar - THRESHOLD), Math.abs(ap - THRESHOLD)) < BORDERLINE,
    sh: [0, 1, 2].map((i) => sum((j) => j.sh[i])),
    tk: [0, 1].map((i) => sum((j) => j.tk[i])),
    ts: sum((j) => j.ts),
    range,
    tl: range[0] === range[1] ? `${range[0]} years` : `${range[0]}-${range[1]} years`,
  };
}

// FTE-equivalent time freed for a role by a given year, at the chosen adoption.
function capacity(r, year = state.horizon) {
  const m = metrics(r);
  return (r.hc * m.ts) / 100 * state.adoption * ramp(year, m.range);
}

// ---------------------------------------------------------------- parsing

function parseDelimited(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delim = firstLine.includes("\t") ? "\t" : (firstLine.split(";").length > firstLine.split(",").length ? ";" : ",");
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"' && field === "") inQ = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some(Boolean));
}

function tableToRoles(table) {
  if (!table.length) throw new Error("The file is empty.");
  const head = table[0].map((h) => h.toLowerCase());
  const find = (...words) => head.findIndex((h) => words.some((w) => h.includes(w)));
  let ti = find("title", "role", "job", "position", "occupation");
  let hi = find("headcount", "head count", "count", "fte", "number", "staff", "employees", "hc");
  let di = find("department", "dept", "function", "team", "business unit", "division", "area");
  let body = table.slice(1);
  if (ti < 0) {
    // No recognisable header: assume title, headcount, department.
    const numericSecond = table.every((r) => r[1] === undefined || /^[\d,.\s]*$/.test(r[1]));
    if (!numericSecond) throw new Error("Couldn't find a job title column. Add a header row with “Job title”, “Headcount” and “Department”.");
    ti = 0; hi = 1; di = 2; body = table;
  }
  const roles = [];
  for (const r of body) {
    const title = r[ti];
    if (!title) continue;
    const hc = hi >= 0 ? parseFloat(String(r[hi] || "").replace(/,/g, "")) : NaN;
    roles.push({ title, hc: Number.isFinite(hc) && hc > 0 ? hc : 1, dept: di >= 0 && r[di] ? r[di] : "Unassigned" });
  }
  if (!roles.length) throw new Error("No job titles found under the title column.");
  return roles;
}

function matchRoles(roles, { useMemory = true } = {}) {
  // First pass finds words typical of this organisation's industry,
  // second pass uses them to break ties (an insurer's "Underwriter").
  const context = state.matcher.industryContext(roles.map((r) => r.title));
  return roles.map((r) => {
    const cands = state.matcher.match(r.title, 5, { context });
    const mem = useMemory ? state.memory[titleKey(r.title)] : null;
    if (mem && state.bySlug.has(mem.s)) {
      if (!cands.some((c) => c.s === mem.s)) cands.unshift({ s: mem.s, score: 1, label: state.bySlug.get(mem.s).t });
      const mix = mem.mix?.every((p) => state.bySlug.has(p.s)) ? mem.mix : null;
      return { id: newId(), ...r, cands, s: mem.s, mix, conf: "remembered" };
    }
    return { id: newId(), ...r, cands, s: cands[0]?.s || null, mix: null, conf: cands.length ? confidence(cands) : "low" };
  });
}

function loadOrg(text, name, isSample = false) {
  const roles = tableToRoles(parseDelimited(text));
  state.isSample = isSample;
  state.rows = matchRoles(roles, { useMemory: !isSample });
  if (isSample) {
    for (const r of state.rows) {
      const s = SAMPLE_MATCHES[r.title];
      if (s && state.bySlug.has(s)) {
        if (!r.cands.some((c) => c.s === s)) r.cands.unshift({ s, score: 1, label: state.bySlug.get(s).t });
        r.s = s;
      }
      r.conf = "manual";
    }
  }
  state.orgName = name || "Your organisation";
  state.role = null;
  save();
  return state.rows;
}

// ---------------------------------------------------------------- aggregation

const matched = () => state.rows.filter((r) => r.s && state.bySlug.has(r.s));
const needsReview = () => state.rows.filter((r) => r.conf === "medium" || r.conf === "low" || !r.s);

function summarise(rows) {
  const total = rows.reduce((s, r) => s + r.hc, 0);
  const byType = Object.fromEntries(ORDER.map((q) => [q, 0]));
  const split = [0, 0, 0];
  const tk = [0, 0];
  let borderline = 0;
  for (const r of rows) {
    const m = metrics(r);
    byType[m.q] += r.hc;
    m.sh.forEach((v, i) => { split[i] += v * r.hc; });
    m.tk.forEach((v, i) => { tk[i] += v * r.hc; });
    if (m.bl) borderline++;
  }
  return { total, byType, split: split.map((v) => v / (total || 1)), tk: tk.map((v) => v / (total || 1)), borderline, cap: rows.reduce((s, r) => s + capacity(r), 0) };
}

// ---------------------------------------------------------------- internal moves

function skillSets(r) {
  const all = new Set(), ess = new Set();
  for (const p of mixOf(r)) {
    const d = state.detail?.[p.s];
    if (!d) continue;
    d.sea.forEach((s) => { all.add(s); ess.add(s); });
    d.soa.forEach((s) => all.add(s));
  }
  return { all, ess };
}

// Roles in the same organisation that are less exposed and share skills.
// Overlap = share of the destination's core skills the source already has.
function internalMoves(row, rows, k = 3) {
  if (!state.detail) return [];
  const src = metrics(row);
  const have = skillSets(row).all;
  const out = [];
  for (const r of rows) {
    if (r.id === row.id || r.s === row.s) continue;
    const m = metrics(r);
    if (m.sh[0] > src.sh[0] - SAFER_BY) continue;
    const need = [...skillSets(r).ess];
    if (!need.length) continue;
    const held = need.filter((s) => have.has(s)).length;
    const gap = need.filter((s) => !have.has(s))
      .map((s) => state.skills[s]).filter(Boolean)
      .sort((a, b) => (a[1] ?? 10) - (b[1] ?? 10))
      .slice(0, 3).map((s) => s[0]);
    const stepUp = !MANAGES_RE.test(src.j.t) && MANAGES_RE.test(m.j.t);
    // A move into a supervisor or manager job is a promotion path for a few
    // people, not redeployment at scale, so it ranks below same-level moves.
    out.push({ row: r, m, overlap: held / need.length, gap, stepUp, rank: (held / need.length) * (stepUp ? 0.7 : 1) });
  }
  return out.filter((x) => x.overlap >= 0.1).sort((a, b) => b.rank - a.rank).slice(0, k);
}
const MANAGES_RE = /\b(manager|supervisor|director|head|chief|leader)\b/i;
function moveTag(x) {
  return x.stepUp ? ` <span class="bl-tag" data-tip="${esc("A supervisor or manager job: a path for a few people, not redeployment at scale.")}">Step up</span>` : "";
}

// ---------------------------------------------------------------- tooltip

function showTip(evt, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 14;
  const { innerWidth: w, innerHeight: h } = window;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + r.width > w - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > h - 8) y = evt.clientY - r.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => { tip.hidden = true; };

document.addEventListener("pointermove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (t) showTip(e, t.getAttribute("data-tip"));
  else hideTip();
});
document.addEventListener("click", (e) => {
  const go = e.target.closest?.("[data-go-row], [data-go-slug]");
  if (!go) return;
  hideTip();
  if (go.dataset.goRow) state.role = { rowId: go.dataset.goRow };
  else state.role = { slug: go.dataset.goSlug };
  setView("role");
});

// ---------------------------------------------------------------- charts
// Every chart draws at its container's real width and redraws on resize.

const charts = [];
function mount(el, draw) {
  if (!el) return;
  const render = () => { el.innerHTML = draw(Math.max(280, el.clientWidth)); };
  charts.push({ el, render });
  render();
}
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => charts.forEach((c) => c.el.isConnected && c.render()), 120);
});

// One 100% bar split into the three shares of work.
function drawSplit(sh, { height = 40, note = "" } = {}) {
  return (w) => {
    let x = 0, out = "";
    SPLIT.forEach((p, i) => {
      const bw = sh[i] * w;
      if (bw <= 0) return;
      out += `<rect class="f-${p.key}" x="${x}" y="0" width="${Math.max(0, bw - 2)}" height="${height}" rx="4" data-tip="${esc(`<b>${p.label}</b><br>${pct(sh[i])} of the work${note}`)}"></rect>`;
      if (bw > 56) out += `<text x="${x + 10}" y="${height / 2 + 5}" class="i-${p.key}" style="font-weight:700;font-size:14px" pointer-events="none">${pct(sh[i])}</text>`;
      x += bw;
    });
    return `<svg class="chart" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}" role="img" aria-label="Work split: ${SPLIT.map((p, i) => `${p.label} ${pct(sh[i])}`).join(", ")}">${out}</svg>`;
  };
}

function tipRow(titles, hc, m) {
  return esc(`<b>${titles}</b><br>${fmt(hc)} people · matched to ${esc(cap(m.j.t))}${m.blended ? " (blend)" : ""}<br>AI can take over ${pct(m.sh[0])} · assists ${pct(m.sh[1])} · stays human ${pct(m.sh[2])}<br>${TYPES[m.q].label}${m.bl ? " (borderline)" : ""} · ${esc(m.tl)}`);
}

// Bubble map: automation (x) against amplification (y), bubble area = headcount.
// Roles that land on the same point share one bubble.
function drawMap(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = mixOf(r).map((p) => `${p.s}:${p.w}`).join("|");
    const g = groups.get(key) || { hc: 0, rows: [], m: metrics(r) };
    g.hc += r.hc; g.rows.push(r);
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => b.hc - a.hc);
  const lo = Math.max(1, Math.floor(Math.min(THRESHOLD - 1, ...list.map((g) => Math.min(g.m.ar, g.m.ap))) - 0.5));
  const hi = Math.min(10, Math.ceil(Math.max(THRESHOLD + 1, ...list.map((g) => Math.max(g.m.ar, g.m.ap))) + 0.5));
  const name = (g) => (g.rows.length > 1 ? `${g.rows[0].title} +${g.rows.length - 1}` : g.rows[0].title);
  return (w) => {
    const h = Math.min(540, Math.max(340, w * 0.62));
    const m = { l: 44, r: 16, t: 16, b: 44 };
    const iw = w - m.l - m.r, ih = h - m.t - m.b;
    const sx = (v) => m.l + ((v - lo) / (hi - lo)) * iw;
    const sy = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
    const maxHc = Math.max(...list.map((g) => g.hc), 1);
    const rad = (hc) => 5 + Math.sqrt(hc / maxHc) * Math.min(30, w / 28);
    const tx = sx(THRESHOLD), ty = sy(THRESHOLD);
    let g = "";
    g += `<rect class="region" x="${tx}" y="${m.t}" width="${m.l + iw - tx}" height="${ty - m.t}" opacity="0.6"></rect>`;
    g += `<rect class="region" x="${m.l}" y="${ty}" width="${tx - m.l}" height="${m.t + ih - ty}" opacity="0.6"></rect>`;
    const qlab = (x, y, anchor, q) => `<text x="${x}" y="${y}" text-anchor="${anchor}" class="t-strong" style="font-size:13px">${TYPES[q].label}</text>`;
    g += qlab(m.l + 8, m.t + 18, "start", "EVOLVE") + qlab(m.l + iw - 8, m.t + 18, "end", "TRANSFORM");
    g += qlab(m.l + 8, m.t + ih - 10, "start", "STABLE") + qlab(m.l + iw - 8, m.t + ih - 10, "end", "SHRINK");
    for (let v = lo; v <= hi; v++) {
      g += `<line class="grid" x1="${m.l}" x2="${m.l + iw}" y1="${sy(v)}" y2="${sy(v)}" opacity="0.6"></line>`;
      g += `<text x="${m.l - 8}" y="${sy(v) + 4}" text-anchor="end" class="t-muted num">${v}</text>`;
      g += `<text x="${sx(v)}" y="${m.t + ih + 18}" text-anchor="middle" class="t-muted num">${v}</text>`;
    }
    g += `<line class="axis" x1="${tx}" x2="${tx}" y1="${m.t}" y2="${m.t + ih}" stroke-dasharray="4 4"></line>`;
    g += `<line class="axis" x1="${m.l}" x2="${m.l + iw}" y1="${ty}" y2="${ty}" stroke-dasharray="4 4"></line>`;
    g += `<text x="${m.l + iw / 2}" y="${h - 6}" text-anchor="middle">How much of the work AI can do →</text>`;
    g += `<text transform="translate(12 ${m.t + ih / 2}) rotate(-90)" text-anchor="middle">How much AI boosts the people →</text>`;
    for (const grp of list) {
      const titles = grp.rows.map((r) => esc(r.title)).join("<br>");
      g += `<circle class="bubble f-${grp.m.q}${grp.m.bl ? " bl" : ""}" cx="${sx(grp.m.ar)}" cy="${sy(grp.m.ap)}" r="${rad(grp.hc)}" data-tip="${tipRow(titles, grp.hc, grp.m)}" data-go-row="${grp.rows[0].id}"></circle>`;
    }
    // Direct labels for the biggest groups, skipping any that would collide.
    const placed = [];
    let labels = "";
    for (const grp of list) {
      if (placed.length >= 6) break;
      const text = name(grp);
      const tw = text.length * 6.6, x = sx(grp.m.ar), y = sy(grp.m.ap) - rad(grp.hc) - 6;
      const anchor = x > m.l + iw - tw / 2 ? "end" : x < m.l + tw / 2 ? "start" : "middle";
      const x0 = anchor === "end" ? x - tw : anchor === "start" ? x : x - tw / 2;
      const box = { x0: x0 - 3, x1: x0 + tw + 3, y0: y - 13, y1: y + 3 };
      if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
      placed.push(box);
      labels += `<text x="${x}" y="${y}" text-anchor="${anchor}" class="t-strong" pointer-events="none" style="paint-order:stroke;stroke:var(--surface);stroke-width:3px">${esc(text)}</text>`;
    }
    return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Role map">${g}${labels}</svg>`;
  };
}

// Departments: the work split in each, most exposed first.
function drawDepts(rows) {
  const depts = new Map();
  for (const r of rows) {
    const d = depts.get(r.dept) || { name: r.dept, total: 0, split: [0, 0, 0] };
    d.total += r.hc;
    metrics(r).sh.forEach((v, i) => { d.split[i] += v * r.hc; });
    depts.set(r.dept, d);
  }
  const list = [...depts.values()].map((d) => ({ ...d, split: d.split.map((v) => v / d.total) }))
    .sort((a, b) => b.split[0] - a.split[0]);
  return (w) => {
    const labelW = Math.min(170, w * 0.32), valW = 56, rowH = 30, bh = 18;
    const bw = w - labelW - valW;
    const h = list.length * rowH + 4;
    let g = "";
    list.forEach((d, i) => {
      const y = i * rowH + 4;
      g += `<text x="0" y="${y + bh / 2 + 4}" class="t-strong">${esc(d.name.length > 26 ? d.name.slice(0, 25) + "…" : d.name)}</text>`;
      let x = labelW;
      SPLIT.forEach((p, k) => {
        const sw = d.split[k] * bw;
        if (sw <= 0) return;
        g += `<rect class="f-${p.key}" x="${x}" y="${y}" width="${Math.max(0, sw - 2)}" height="${bh}" rx="3" data-tip="${esc(`<b>${esc(d.name)}</b> · ${fmt(d.total)} people<br>${p.label}: ${pct(d.split[k])} of the work`)}"></rect>`;
        if (k === 0 && sw > 40) g += `<text x="${x + 6}" y="${y + bh / 2 + 4}" class="i-take" style="font-weight:700;font-size:11px" pointer-events="none">${pct(d.split[0])}</text>`;
        x += sw;
      });
      g += `<text x="${w}" y="${y + bh / 2 + 4}" text-anchor="end" class="num">${fmt(d.total)}</text>`;
    });
    return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Departments by work split">${g}</svg>`;
  };
}

// Capacity freed over ten years at the chosen adoption; marker at the chosen year.
function drawCapacity(rows) {
  const years = Array.from({ length: 10 }, (_, i) => i + 1);
  const vals = years.map((y) => rows.reduce((s, r) => s + capacity(r, y), 0));
  return (w) => {
    const h = 220, m = { l: 48, r: 16, t: 16, b: 34 };
    const iw = w - m.l - m.r, ih = h - m.t - m.b;
    const maxRaw = Math.max(...vals, 1);
    const step = niceStep(maxRaw / 4);
    const max = Math.ceil(maxRaw / step) * step;
    const sx = (y) => m.l + ((y - 1) / 9) * iw;
    const sy = (v) => m.t + ih - (v / max) * ih;
    let g = "";
    for (let v = 0; v <= max + 1e-9; v += step) {
      g += `<line class="grid" x1="${m.l}" x2="${m.l + iw}" y1="${sy(v)}" y2="${sy(v)}"></line>`;
      g += `<text x="${m.l - 8}" y="${sy(v) + 4}" text-anchor="end" class="t-muted num">${fmt(v)}</text>`;
    }
    years.forEach((y) => { g += `<text x="${sx(y)}" y="${h - 12}" text-anchor="middle" class="t-muted num">Yr ${y}</text>`; });
    const pts = years.map((y, i) => `${sx(y)},${sy(vals[i])}`).join(" ");
    g += `<polygon class="area" points="${sx(1)},${sy(0)} ${pts} ${sx(10)},${sy(0)}"></polygon>`;
    g += `<polyline class="line" points="${pts}"></polyline>`;
    const hy = state.horizon;
    g += `<line class="axis" x1="${sx(hy)}" x2="${sx(hy)}" y1="${m.t}" y2="${m.t + ih}" stroke-dasharray="4 4"></line>`;
    g += `<circle class="dot" cx="${sx(hy)}" cy="${sy(vals[hy - 1])}" r="6"></circle>`;
    const lx = sx(hy), anchor = lx > m.l + iw - 90 ? "end" : "start";
    g += `<text x="${lx + (anchor === "start" ? 10 : -10)}" y="${sy(vals[hy - 1]) - 10}" text-anchor="${anchor}" class="t-strong num" style="paint-order:stroke;stroke:var(--surface);stroke-width:3px">${fte(vals[hy - 1])} FTE</text>`;
    // Hover columns, one per year
    const cw = iw / 9;
    years.forEach((y, i) => {
      g += `<rect class="hit" x="${sx(y) - cw / 2}" y="${m.t}" width="${cw}" height="${ih}" data-tip="${esc(`<b>Year ${y}</b><br>${fte(vals[i])} FTE of time freed<br>at ${pct(state.adoption)} adoption`)}"></rect>`;
    });
    return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Capacity freed over ten years">${g}</svg>`;
  };
}
function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1e-9))));
  const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// A working week, today against the future: one row per activity.
function drawWeek(week) {
  const before = week.before || {}, after = week.after || {};
  const cats = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((c) => c !== "new_ai_augmented");
  if ("new_ai_augmented" in after) cats.push("new_ai_augmented");
  const name = (c) => (c === "new_ai_augmented" ? "New AI-assisted work" : cap(c.replace(/_/g, " ")));
  return (w) => {
    const labelW = Math.min(200, w * 0.42), rowH = 48, bh = 14;
    const bw = w - labelW - 40;
    const max = Math.max(...cats.map((c) => Math.max(before[c] || 0, after[c] || 0)), 1);
    let g = "";
    cats.forEach((c, i) => {
      const y = i * rowH + 6;
      const isNew = c === "new_ai_augmented";
      const label = name(c);
      wrap(label, Math.floor(labelW / 7)).slice(0, 2).forEach((ln, k) => {
        g += `<text x="0" y="${y + 12 + k * 15}" class="${isNew ? "t-strong" : ""}" ${isNew ? "" : 'style="fill:var(--ink)"'}>${esc(ln)}</text>`;
      });
      const b = before[c] || 0, a = after[c] || 0;
      const tipTxt = esc(`<b>${esc(label)}</b><br>Today: ${b}% of the week<br>Future: ${a}% of the week`);
      g += `<rect class="f-today" x="${labelW}" y="${y}" width="${Math.max(b ? 3 : 0, (b / max) * bw)}" height="${bh}" rx="3" data-tip="${tipTxt}"></rect>`;
      g += `<text x="${labelW + (b / max) * bw + 6}" y="${y + bh - 3}" class="num t-muted">${b}%</text>`;
      g += `<rect class="${isNew ? "f-new" : "f-future"}" x="${labelW}" y="${y + bh + 3}" width="${Math.max(a ? 3 : 0, (a / max) * bw)}" height="${bh}" rx="3" data-tip="${tipTxt}"></rect>`;
      g += `<text x="${labelW + (a / max) * bw + 6}" y="${y + 2 * bh}" class="num t-strong">${a}%</text>`;
    });
    const h = cats.length * rowH + 4;
    return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Working week today and in future">${g}</svg>`;
  };
}

function wrap(text, n) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const wd of words) {
    if ((cur + " " + wd).trim().length > n && cur) { lines.push(cur); cur = wd; }
    else cur = (cur + " " + wd).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > 2) lines[1] = lines.slice(1).join(" ").slice(0, n - 1) + "…";
  return lines;
}

function legendTypes() {
  return `<div class="legend">${ORDER.map((q) => `<span><i class="sw-${q}"></i>${TYPES[q].label}</span>`).join("")}<span><i style="border:1.5px dashed var(--ink);background:none"></i>Borderline</span></div>`;
}
function legendSplit() {
  return `<div class="legend">${SPLIT.map((p) => `<span><i class="sw-${p.key}"></i>${p.label}</span>`).join("")}</div>`;
}

// ---------------------------------------------------------------- capacity controls

function controlsHtml() {
  return `<div class="controls">
    <div class="control">
      <div class="control-head"><label for="adoption">How much of the AI-ready work gets adopted</label><b id="adoption-val">${pct(state.adoption)}</b></div>
      <input type="range" id="adoption" min="10" max="100" step="5" value="${Math.round(state.adoption * 100)}">
      <small>Most organisations capture well under 100%. Process, tools and people all have to change.</small>
    </div>
    <div class="control">
      <div class="control-head"><label for="horizon">Years from now</label><b id="horizon-val">${state.horizon}</b></div>
      <input type="range" id="horizon" min="1" max="10" step="1" value="${state.horizon}">
      <small>Each role phases in over its own timeline.</small>
    </div>
  </div>`;
}
function wireControls(onChange) {
  const a = $("#adoption"), h = $("#horizon");
  if (!a || !h) return;
  const update = () => {
    state.adoption = +a.value / 100;
    state.horizon = +h.value;
    $("#adoption-val").textContent = pct(state.adoption);
    $("#horizon-val").textContent = state.horizon;
    save();
    onChange();
  };
  a.addEventListener("input", update);
  h.addEventListener("input", update);
}

// ---------------------------------------------------------------- views

function setView(v, { push = true } = {}) {
  state.view = v;
  if (push && location.hash !== `#${v}`) history.replaceState(null, "", `#${v}`);
  render();
  window.scrollTo({ top: 0 });
}

function render() {
  charts.length = 0;
  hideTip();
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-current", t.dataset.view === state.view ? "page" : "false"));
  const n = needsReview().length;
  const badge = $("#review-count");
  badge.hidden = !n;
  badge.textContent = n;
  ({ load: renderLoad, match: renderMatch, org: renderOrg, role: renderRole })[state.view]();
}

function sampleBanner() {
  if (!state.isSample) return "";
  return `<div class="banner"><span><b>This is example data</b> for a fictional insurer. Load your client's job list to see their organisation.</span><button type="button" class="btn-ghost" data-action="goto-load">Load a job list</button></div>`;
}

// ---- 1. Load
function renderLoad() {
  const template = "Department,Job title,Headcount\nFinance,Payroll Officer,6\nCustomer Operations,Claims Officer,140";
  const remembered = Object.keys(state.memory).length;
  main.innerHTML = `
    <section class="page-head">
      <div>
        <p class="eyebrow">Step 1</p>
        <h1>Load the organisation's roles</h1>
        <p class="lede">Upload a CSV file, or copy rows straight from Excel and paste them here. You need one row per role: job title and headcount, plus department if you have it. Everything stays in this browser. Nothing is uploaded to a server.</p>
      </div>
    </section>
    <div class="grid-2">
      <section class="panel" style="display:grid;gap:16px;align-content:start">
        <label class="field"><span>Organisation name</span>
          <input type="text" id="org-name" value="${esc(state.isSample ? "" : state.orgName)}" placeholder="e.g. Client name">
        </label>
        <div class="drop" id="drop">
          <b>Drop a CSV file here</b>
          <span class="muted small">or</span>
          <label class="btn-ghost" for="file">Choose file</label>
          <input type="file" id="file" accept=".csv,.tsv,.txt,text/csv" hidden>
          <span class="muted small">Using Excel? Save the sheet as CSV first, or paste the rows below.</span>
        </div>
        <label class="field"><span>Or paste rows from a spreadsheet</span>
          <textarea id="paste" placeholder="${esc(template)}"></textarea>
        </label>
        <div class="row">
          <button type="button" class="btn" id="use-paste">Match these roles</button>
          <button type="button" class="btn-ghost" id="use-sample">Use the sample organisation</button>
        </div>
        ${state.loadMsg ? `<p class="msg ${state.loadMsg.ok ? "ok" : "err"}" role="status">${esc(state.loadMsg.text)}</p>` : ""}
      </section>
      <section class="panel" style="display:grid;gap:14px;align-content:start">
        <h2>What the file should look like</h2>
        <p class="sub">A header row helps. Column names are flexible: “Role”, “Position” or “Job title” all work, and so do “FTE” or “Count” for headcount.</p>
        <div class="template">${esc(template)}</div>
        <div class="row"><button type="button" class="btn-ghost" id="copy-template">Copy template</button><span class="muted small" id="copy-msg"></span></div>
        <h2 style="margin-top:8px">What happens next</h2>
        <ol class="list">
          <li>Each title is matched to one of 3,039 standard jobs in the EU's ESCO catalogue.</li>
          <li>You check the weak matches. Titles like “Team Lead – APAC” need a human eye. Hybrid roles can be a blend of two jobs.</li>
          <li>The app shows how AI is likely to change each role, and the whole organisation.</li>
        </ol>
        <h2 style="margin-top:8px">Saved matches</h2>
        <p class="sub">${remembered ? `This browser remembers ${remembered} title${remembered === 1 ? "" : "s"} you corrected. They are applied automatically to the next list you load.` : "When you correct a match, this browser remembers it for the next list you load."}</p>
        ${remembered ? `<div class="row"><button type="button" class="btn-ghost" id="forget">Forget saved matches</button></div>` : ""}
      </section>
    </div>`;

  const nameEl = $("#org-name");
  const run = (text) => {
    try {
      const rows = loadOrg(text, nameEl.value.trim());
      const weak = needsReview().length;
      const mem = rows.filter((r) => r.conf === "remembered").length;
      state.loadMsg = { ok: true, text: `Matched ${rows.length} roles${mem ? `, ${mem} from saved matches` : ""}. ${weak} need a check.` };
      setView(weak ? "match" : "org");
    } catch (err) {
      state.loadMsg = { ok: false, text: err.message };
      renderLoad();
    }
  };
  $("#use-paste").addEventListener("click", () => {
    const text = $("#paste").value.trim();
    if (!text) { state.loadMsg = { ok: false, text: "Paste some rows first, or choose a file." }; renderLoad(); return; }
    run(text);
  });
  $("#use-sample").addEventListener("click", () => {
    loadOrg(SAMPLE_CSV, SAMPLE_NAME, true);
    state.loadMsg = null;
    setView("org");
  });
  $("#forget")?.addEventListener("click", () => {
    state.memory = {};
    writeStore(MEMORY_KEY, state.memory);
    renderLoad();
  });
  const readFile = (file) => {
    if (!file) return;
    if (/\.xlsx?$/i.test(file.name)) {
      state.loadMsg = { ok: false, text: "That's an Excel file. Save it as CSV first, or copy the rows and paste them here." };
      renderLoad();
      return;
    }
    const fr = new FileReader();
    fr.onload = () => {
      if (!nameEl.value.trim()) nameEl.value = file.name.replace(/\.[^.]+$/, "");
      run(String(fr.result));
    };
    fr.readAsText(file);
  };
  $("#file").addEventListener("change", (e) => readFile(e.target.files[0]));
  const drop = $("#drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); readFile(e.dataTransfer.files[0]); });
  $("#copy-template").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(template); $("#copy-msg").textContent = "Copied"; }
    catch { $("#copy-msg").textContent = "Select the text above and copy it."; }
  });
}

// ---- 2. Match
const BLEND_SPLITS = [0.5, 0.6, 0.7, 0.8];

function renderMatch() {
  if (!state.rows.length) { setView("load"); return; }
  const weak = needsReview();
  const rows = state.reviewOnly ? weak : state.rows;
  const counts = { high: 0, medium: 0, low: 0, manual: 0, remembered: 0 };
  state.rows.forEach((r) => { counts[r.conf] = (counts[r.conf] || 0) + 1; });

  const body = rows.map((r) => {
    const j = r.s ? state.bySlug.get(r.s) : null;
    const cands = [...r.cands];
    if (r.s && !cands.some((c) => c.s === r.s)) cands.unshift({ s: r.s, score: 1, label: j.t });
    const hit = r.cands.find((c) => c.s === r.s);
    const via = hit && j && hit.label.toLowerCase() !== j.t.toLowerCase() ? `matched on “${esc(hit.label)}”` : "";
    const m = j ? metrics(r) : null;
    const blend = r.mix ? `<div class="blend">Blend:
        <select data-split="${r.id}" aria-label="Blend split for ${esc(r.title)}">${BLEND_SPLITS.map((w) => `<option value="${w}" ${Math.abs(r.mix[0].w - w) < 0.01 ? "selected" : ""}>${Math.round(w * 100)}/${Math.round((1 - w) * 100)}</option>`).join("")}</select>
        with <b>${esc(cap(state.bySlug.get(r.mix[1].s).t))}</b>
        <button type="button" class="btn-link" data-unblend="${r.id}">Remove blend</button></div>` : "";
    return `<tr>
      <td><div class="cell-title">${esc(r.title)}</div><div class="cell-sub">${esc(r.dept)}</div></td>
      <td class="r num">${fmt(r.hc)}</td>
      <td>
        ${cands.length ? `<select class="match-select" data-row="${r.id}" aria-label="ESCO job for ${esc(r.title)}">${cands.map((c) => `<option value="${esc(c.s)}" ${c.s === r.s ? "selected" : ""}>${esc(cap(state.bySlug.get(c.s).t))}</option>`).join("")}</select>` : `<span class="muted">No match found</span>`}
        <div class="cell-sub">${m ? `${typePill(m.q, m.bl)} ${via}` : ""}</div>
        ${blend}
      </td>
      <td><span class="conf conf-${r.conf}">${confLabel(r.conf)}</span></td>
      <td><div class="row">
        ${r.conf === "medium" || r.conf === "low" ? `<button type="button" class="btn-ghost" data-ok="${r.id}">Looks right</button>` : ""}
        <button type="button" class="btn-link" data-search="${r.id}">Search</button>
        ${r.s && !r.mix ? `<button type="button" class="btn-link" data-blend="${r.id}" data-tip="${esc("For hybrid roles: mix in a second ESCO job, e.g. 60% HR officer and 40% HR manager.")}">Blend</button>` : ""}
        <button type="button" class="btn-link" data-remove="${r.id}">Remove</button>
      </div></td>
    </tr>`;
  }).join("");

  main.innerHTML = `
    ${sampleBanner()}
    <section class="page-head">
      <div>
        <p class="eyebrow">Step 2 · ${esc(state.orgName)}</p>
        <h1>Check how each title was matched</h1>
        <p class="lede">Titles are matched to standard ESCO jobs by the words they share. On a test set of 87 real-world titles the first suggestion is right 83% of the time, and the right job is in the top three 95% of the time. So give the orange and red rows a quick look. Your corrections are remembered for next time.</p>
      </div>
      <button type="button" class="btn" data-action="goto-org">View the organisation →</button>
    </section>
    <section class="panel" style="display:grid;gap:14px">
      <div class="row" style="justify-content:space-between">
        <div class="row small">
          <span class="conf conf-high">${counts.high} strong</span>
          <span class="conf conf-manual">${counts.manual + counts.remembered} checked or remembered</span>
          <span class="conf conf-medium">${counts.medium} to check</span>
          <span class="conf conf-low">${counts.low} weak</span>
        </div>
        <label class="row small"><input type="checkbox" id="review-only" ${state.reviewOnly ? "checked" : ""}> Show only rows to check (${weak.length})</label>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Their title</th><th class="r">People</th><th>ESCO job</th><th>Match</th><th></th></tr></thead>
        <tbody>${body || `<tr><td colspan="5" class="muted">Nothing left to check.</td></tr>`}</tbody>
      </table></div>
    </section>`;

  const byId = (id) => state.rows.find((x) => x.id === id);
  const commit = (r) => { r.conf = "manual"; remember(r); save(); render(); };
  $("#review-only").addEventListener("change", (e) => { state.reviewOnly = e.target.checked; renderMatch(); });
  main.querySelectorAll(".match-select").forEach((sel) => sel.addEventListener("change", () => {
    const r = byId(sel.dataset.row);
    r.s = sel.value;
    if (r.mix) r.mix[0].s = r.s;
    commit(r);
  }));
  main.querySelectorAll("[data-split]").forEach((sel) => sel.addEventListener("change", () => {
    const r = byId(sel.dataset.split);
    const w = +sel.value;
    r.mix = [{ s: r.mix[0].s, w }, { s: r.mix[1].s, w: +(1 - w).toFixed(2) }];
    commit(r);
  }));
  main.querySelectorAll("[data-unblend]").forEach((b) => b.addEventListener("click", () => { const r = byId(b.dataset.unblend); r.mix = null; commit(r); }));
  main.querySelectorAll("[data-ok]").forEach((b) => b.addEventListener("click", () => commit(byId(b.dataset.ok))));
  main.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => {
    state.rows = state.rows.filter((x) => x.id !== b.dataset.remove);
    save(); render();
  }));
  main.querySelectorAll("[data-search]").forEach((b) => b.addEventListener("click", () => {
    const r = byId(b.dataset.search);
    openPicker({ mode: "assign", rowId: r.id }, r.title);
  }));
  main.querySelectorAll("[data-blend]").forEach((b) => b.addEventListener("click", () => {
    const r = byId(b.dataset.blend);
    openPicker({ mode: "blend", rowId: r.id }, r.title);
  }));
}

// ---- 3. Organisation
function orgLede(s) {
  const [take, assist, human] = s.split;
  return `Across ${fmt(s.total)} people, AI can take over about ${pct(take)} of the work and make people better at another ${pct(assist)}. The remaining ${pct(human)} stays human. At ${pct(state.adoption)} adoption, that frees about ${fte(s.cap)} full-time equivalents of time within ${state.horizon} year${state.horizon === 1 ? "" : "s"}.`;
}

function renderOrg() {
  const rows = matched();
  if (!rows.length) { setView("load"); return; }
  const s = summarise(rows);
  const weak = needsReview().length;

  const sortKey = state.sort.key, dir = state.sort.dir;
  const val = (r) => {
    const m = metrics(r);
    return { title: r.title.toLowerCase(), dept: r.dept.toLowerCase(), hc: r.hc, take: m.sh[0], assist: m.sh[1], q: ORDER.indexOf(m.q), fte: capacity(r), tl: m.range[0] }[sortKey];
  };
  const sorted = [...rows].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * dir);
  const th = (key, label, cls = "") => `<th class="${cls}"><button type="button" data-sort="${key}" ${sortKey === key ? `aria-sort="${dir > 0 ? "ascending" : "descending"}"` : ""}>${label}</button></th>`;

  main.innerHTML = `
    ${sampleBanner()}
    <section class="page-head">
      <div>
        <p class="eyebrow">${esc(state.orgName)}</p>
        <h1>How AI is likely to reshape ${fmt(s.total)} roles</h1>
        <p class="lede" id="org-lede">${orgLede(s)}</p>
      </div>
      ${weak ? `<button type="button" class="btn-ghost" data-action="goto-match">${weak} matches to check</button>` : ""}
    </section>

    <section class="kpis">
      <div class="kpi"><span class="kpi-label">People in scope</span><span class="kpi-value num">${fmt(s.total)}</span><span class="kpi-note">${rows.length} roles${rows.length < state.rows.length ? `, ${state.rows.length - rows.length} unmatched` : ""}</span></div>
      <div class="kpi"><span class="kpi-label">Work AI can take over</span><span class="kpi-value num">${pct(s.split[0])}</span><span class="kpi-note" data-tip="${esc(`A skill counts as “AI can take over” when it scores 7 or more. At 8 the share would be ${pct(s.tk[1])}; at 6 it would be ${pct(s.tk[0])}.`)}">Range ${pct(s.tk[1])}–${pct(s.tk[0])} depending on the cut-off</span></div>
      <div class="kpi"><span class="kpi-label">Work AI makes people better at</span><span class="kpi-value num">${pct(s.split[1])}</span><span class="kpi-note">Weighted by headcount</span></div>
      <div class="kpi"><span class="kpi-label" id="kpi-cap-label">Time freed within ${state.horizon} yr${state.horizon === 1 ? "" : "s"}</span><span class="kpi-value num" id="kpi-cap">${fte(s.cap)} FTE</span><span class="kpi-note" id="kpi-cap-note">At ${pct(state.adoption)} adoption. Model estimate.</span></div>
    </section>

    <section class="panel" style="display:grid;gap:12px">
      <div class="panel-head"><h2>How the work splits</h2><span class="muted small">Share of all work, weighted by headcount</span></div>
      <div class="chart-wrap" id="c-split"></div>
      <div class="split-key">${SPLIT.map((p, i) => `<div><span class="sw sw-${p.key}"></span><b>${p.label} · ${pct(s.split[i])}</b><p>${p.blurb}</p></div>`).join("")}</div>
      <p class="sub"><b>How sure is this?</b> The split depends on where the line is drawn. A skill counts as “AI can take over” at a score of 7 or more. At 8, this organisation's figure would be ${pct(s.tk[1])}. At 6, it would be ${pct(s.tk[0])}. Treat the headline as the middle of that range, not a precise number.</p>
      <div class="types-line"><span>By type:</span>${ORDER.filter((q) => s.byType[q]).map((q) => `<span class="pill"><span class="sw sw-${q}"></span>${TYPES[q].label} ${pct(s.byType[q] / s.total)}</span>`).join("")}${s.borderline ? `<span class="bl-tag">${s.borderline} of ${rows.length} roles are borderline between types</span>` : ""}</div>
    </section>

    <section class="panel" style="display:grid;gap:14px">
      <div class="panel-head"><h2>Capacity over time</h2><span class="muted small">FTE-equivalent time freed, whole organisation</span></div>
      ${controlsHtml()}
      <p class="cap-summary" id="cap-summary"></p>
      <div class="chart-wrap" id="c-cap"></div>
      <p class="sub">This is time, not jobs. What happens to it is a choice: less overtime, better service, new work, redeployment or smaller teams. The time-saved figure per job is an AI model estimate.</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Where people could move inside ${esc(state.orgName)}</h2><span class="muted small">Exposed roles, and the closest less-exposed role you already have</span></div>
      <p class="sub">Roles where AI can take over ${pct(EXPOSED_AT)} or more of the work. “Skills held” is the share of the destination role's core skills these people already have. Check the size of the destination: a role with 20 seats can't absorb 200 people.</p>
      <div id="moves" style="margin-top:10px">${state.detail ? movesTable(rows) : `<p class="muted">Loading skill detail…</p>`}</div>
    </section>

    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>By department</h2><span class="muted small">Most exposed first · headcount on the right</span></div>
        ${legendSplit()}
        <div class="chart-wrap" id="c-dept"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Role map</h2><span class="muted small">Size shows headcount. Click to open.</span></div>
        <p class="sub">The two job scores behind the four types, averaged across each job's skills. Dashed rings are borderline roles.</p>
        ${legendTypes()}
        <div class="chart-wrap" id="c-map"></div>
      </section>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>Every role</h2><span class="muted small">Click a row to open the role</span></div>
      <div class="table-wrap"><table>
        <thead><tr>${th("title", "Role")}${th("dept", "Department")}${th("hc", "People", "r")}${th("take", "AI can take over", "r")}${th("assist", "AI assists", "r")}${th("q", "Type")}${th("tl", "Timeline")}${th("fte", `FTE freed, yr ${state.horizon}`, "r")}</tr></thead>
        <tbody>${sorted.map((r) => {
          const m = metrics(r);
          return `<tr class="clickable" data-go-row="${r.id}" tabindex="0">
            <td><div class="cell-title">${esc(r.title)}</div><div class="cell-sub">${esc(cap(m.j.t))}${m.blended ? " + blend" : ""}</div></td>
            <td>${esc(r.dept)}</td>
            <td class="r num">${fmt(r.hc)}</td>
            <td class="r num"><div style="display:grid;justify-items:end;gap:4px">${pct(m.sh[0])}${splitMini(m.sh)}</div></td>
            <td class="r num">${pct(m.sh[1])}</td>
            <td>${typePill(m.q, m.bl)}</td>
            <td class="num">${esc(m.tl)}</td>
            <td class="r num" data-fte-row="${r.id}">${fte(capacity(r))}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
    </section>`;

  mount($("#c-split"), drawSplit(s.split));
  mount($("#c-dept"), drawDepts(rows));
  mount($("#c-map"), drawMap(rows));
  const refreshCap = () => {
    const cap = rows.reduce((acc, r) => acc + capacity(r), 0);
    $("#kpi-cap").textContent = `${fte(cap)} FTE`;
    $("#kpi-cap-label").textContent = `Time freed within ${state.horizon} yr${state.horizon === 1 ? "" : "s"}`;
    $("#kpi-cap-note").textContent = `At ${pct(state.adoption)} adoption. Model estimate.`;
    $("#org-lede").textContent = orgLede({ ...s, cap });
    $("#cap-summary").innerHTML = `By year ${state.horizon}, at ${pct(state.adoption)} adoption: <b>${fte(cap)} FTE</b> of time freed, or ${pct(cap / s.total)} of total capacity.`;
    main.querySelectorAll("[data-fte-row]").forEach((td) => { td.textContent = fte(capacity(rows.find((r) => r.id === td.dataset.fteRow))); });
    const fteTh = main.querySelector('[data-sort="fte"]');
    if (fteTh) fteTh.textContent = `FTE freed, yr ${state.horizon}`;
    charts.filter((c) => c.el.id === "c-cap").forEach((c) => c.render());
  };
  mount($("#c-cap"), drawCapacity(rows));
  refreshCap();
  wireControls(refreshCap);

  main.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.sort;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (["title", "dept", "q", "tl"].includes(k) ? 1 : -1) };
    renderOrg();
  }));
  main.querySelectorAll("tr[data-go-row]").forEach((tr) => tr.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { state.role = { rowId: tr.dataset.goRow }; setView("role"); }
  }));
}

function movesTable(rows) {
  const exposed = rows.filter((r) => metrics(r).sh[0] >= EXPOSED_AT).sort((a, b) => b.hc - a.hc).slice(0, 10);
  if (!exposed.length) return `<p class="muted">No role has ${pct(EXPOSED_AT)} or more of its work exposed to AI take-over.</p>`;
  const withMove = [], without = [];
  for (const r of exposed) {
    const best = internalMoves(r, rows, 1)[0];
    (best ? withMove : without).push({ r, m: metrics(r), best });
  }
  const noneHc = without.reduce((acc, x) => acc + x.r.hc, 0);
  const table = withMove.length ? `<div class="table-wrap"><table class="moves-table">
    <thead><tr><th>From</th><th class="r">People</th><th>Closest less-exposed role</th><th class="r">Skills held</th><th>Skills to add</th></tr></thead>
    <tbody>${withMove.map(({ r, m, best }) => `<tr>
        <td><button type="button" class="btn-link" data-go-row="${r.id}">${esc(r.title)}</button><div class="cell-sub">AI can take over ${pct(m.sh[0])}</div></td>
        <td class="r num">${fmt(r.hc)}</td>
        <td><button type="button" class="btn-link" data-go-row="${best.row.id}">${esc(best.row.title)}</button>${moveTag(best)}<div class="cell-sub">${fmt(best.row.hc)} people today · AI can take over ${pct(best.m.sh[0])}</div></td>
        <td class="r num">${pct(best.overlap)}</td>
        <td><div class="chips">${best.gap.map((g) => `<span class="chip">${esc(cap(g))}</span>`).join("")}</div></td>
      </tr>`).join("")}</tbody>
  </table></div>` : "";
  const none = without.length ? `<p class="sub" style="margin-top:12px"><b>${without.length} exposed role${without.length === 1 ? " has" : "s have"} no close, less-exposed role inside the organisation</b> (${fmt(noneHc)} people): ${without.map(({ r }) => `<button type="button" class="btn-link" data-go-row="${r.id}">${esc(r.title)}</button>`).join(", ")}. For these, reskilling within the role, or moves to the wider job market shown on each role page, matter more than internal redeployment.</p>` : "";
  return table + none;
}

// ---- 4. Role deep dive
function currentRole() {
  if (state.role?.rowId) {
    const r = state.rows.find((x) => x.id === state.role.rowId);
    if (r && r.s) return { row: r, slug: r.s };
  }
  if (state.role?.slug && state.bySlug.has(state.role.slug)) return { row: null, slug: state.role.slug };
  const biggest = [...matched()].sort((a, b) => b.hc - a.hc)[0];
  if (biggest) return { row: biggest, slug: biggest.s };
  return { row: null, slug: state.jobs[0].s };
}

function renderRole() {
  const { row, slug } = currentRole();
  const j = state.bySlug.get(slug);
  const m = row ? metrics(row) : metrics({ s: slug, hc: 1 });
  const d = state.detail?.[slug];
  const inOrg = new Map();
  for (const r of matched()) inOrg.set(r.s, (inOrg.get(r.s) || 0) + r.hc);

  const opts = [...matched()].sort((a, b) => a.dept.localeCompare(b.dept) || a.title.localeCompare(b.title));
  const groups = [...new Set(opts.map((r) => r.dept))];
  const picker = opts.length ? `
    <label class="field"><span>Role in ${esc(state.orgName)}</span>
      <select id="role-select">
        ${row ? "" : `<option value="" selected>Exploring: ${esc(cap(j.t))}</option>`}
        ${groups.map((g) => `<optgroup label="${esc(g)}">${opts.filter((r) => r.dept === g).map((r) => `<option value="${r.id}" ${row?.id === r.id ? "selected" : ""}>${esc(r.title)} (${fmt(r.hc)})</option>`).join("")}</optgroup>`).join("")}
      </select>
    </label>` : "";

  const title = row ? row.title : cap(j.t);
  const blendNote = row?.mix ? `<p class="sub">Blended role: ${row.mix.map((p) => `${Math.round(p.w * 100)}% ${esc(cap(state.bySlug.get(p.s).t))}`).join(" + ")}. The scores blend both. The story, week and skills below describe ${esc(cap(j.t))}.</p>` : "";

  main.innerHTML = `
    ${sampleBanner()}
    <section class="role-top">
      <div class="role-picker">
        ${picker}
        <button type="button" class="btn-ghost" data-action="explore">Explore any job</button>
      </div>
      <div>
        <p class="eyebrow">${row ? esc(row.dept) : "Any job in ESCO"}</p>
        <h1>${esc(title)}</h1>
        <div class="role-meta" style="margin-top:8px">
          ${typePill(m.q, m.bl)}
          <span>ESCO job: <b>${esc(cap(j.t))}</b> · ISCO ${esc(j.c)}${j.ug ? ` · ${esc(j.ug)}` : ""}</span>
          ${row ? `<span>${fmt(row.hc)} people</span>` : ""}
        </div>
      </div>
      <p class="sub">${esc(TYPES[m.q].blurb)}${m.bl ? " This role sits close to the line between types, so read the work split below rather than the label." : ""}</p>
      ${blendNote}
    </section>

    <section class="kpis">
      <div class="kpi"><span class="kpi-label">Work AI can take over</span><span class="kpi-value num">${pct(m.sh[0])}</span><span class="kpi-note">Range ${pct(m.tk[1])}–${pct(m.tk[0])} depending on the cut-off</span></div>
      <div class="kpi"><span class="kpi-label">Work AI makes people better at</span><span class="kpi-value num">${pct(m.sh[1])}</span><span class="kpi-note">Share of this job's skills</span></div>
      <div class="kpi"><span class="kpi-label">When the change lands</span><span class="kpi-value num">${esc(m.tl)}</span><span class="kpi-note">Model estimate</span></div>
      ${row ? `<div class="kpi"><span class="kpi-label" id="role-cap-label">Time freed in this team, yr ${state.horizon}</span><span class="kpi-value num" id="role-cap">${fte(capacity(row))} FTE</span><span class="kpi-note" id="role-cap-note">${fmt(row.hc)} people × ${Math.round(m.ts)}% × ${pct(state.adoption)} adoption</span></div>` : `<div class="kpi"><span class="kpi-label">Time AI could free up</span><span class="kpi-value num">${Math.round(m.ts)}%</span><span class="kpi-note">Model estimate, before adoption</span></div>`}
    </section>

    <section class="panel" style="display:grid;gap:12px">
      <div class="panel-head"><h2>How this role's work splits</h2><span class="muted small">Every skill in the job, core skills counted twice</span></div>
      <div class="chart-wrap" id="c-role-split"></div>
      ${legendSplit()}
      ${row ? controlsHtml() : ""}
    </section>

    ${d ? roleDetail(j, d, row, inOrg) : `<section class="panel"><p class="muted">Loading the full job detail…</p></section>`}`;

  const sel = $("#role-select");
  if (sel) sel.addEventListener("change", () => { if (sel.value) { state.role = { rowId: sel.value }; renderRole(); } });
  mount($("#c-role-split"), drawSplit(m.sh, { height: 44 }));
  if (d) mount($("#c-week"), drawWeek(d.n.week));
  if (row) wireControls(() => {
    $("#role-cap").textContent = `${fte(capacity(row))} FTE`;
    $("#role-cap-label").textContent = `Time freed in this team, yr ${state.horizon}`;
    $("#role-cap-note").textContent = `${fmt(row.hc)} people × ${Math.round(m.ts)}% × ${pct(state.adoption)} adoption`;
  });
}

function roleDetail(j, d, row, inOrg) {
  const n = d.n;
  const skills = d.se.map((id) => state.skills[id]).filter(Boolean);
  const skillHtml = skills.map(([t, a, mm, why]) => `
    <div class="skill-row">
      <div class="skill-name">${esc(cap(t))} <span class="chip" style="margin-left:6px">${a >= 7 ? "AI can take over" : mm >= 7 ? "AI assists" : "Stays human"}</span></div>
      <div class="bars">
        <div class="bar-line"><span>AI can do it</span><span class="bar-track"><span class="bar-fill auto" style="display:block;width:${(a || 0) * 10}%"></span></span><span class="num">${a ?? "–"}</span></div>
        <div class="bar-line"><span>AI boosts people</span><span class="bar-track"><span class="bar-fill amp" style="display:block;width:${(mm || 0) * 10}%"></span></span><span class="num">${mm ?? "–"}</span></div>
      </div>
      ${why ? `<p class="skill-why">${esc(why)}</p>` : ""}
    </div>`).join("");

  const inside = row ? internalMoves(row, matched(), 3) : [];
  const insideHtml = row
    ? (inside.length ? inside.map((x) => `<div class="move">
        <div class="move-head">
          <span><button type="button" class="btn-link" data-go-row="${x.row.id}">${esc(x.row.title)}</button>${moveTag(x)}</span>
          <span class="row"><span class="muted small num">${fmt(x.row.hc)} people today · AI can take over ${pct(x.m.sh[0])}</span></span>
        </div>
        <span class="small"><b class="num">${pct(x.overlap)}</b> of its core skills already held</span>
        ${x.gap.length ? `<div class="chips"><span class="small muted">Skills to add:</span>${x.gap.map((g) => `<span class="chip">${esc(cap(g))}</span>`).join("")}</div>` : ""}
      </div>`).join("")
      : `<p class="muted small" style="margin-top:8px">No less-exposed role in ${esc(state.orgName)} shares enough skills with this one.</p>`)
    : `<p class="muted small" style="margin-top:8px">Pick a role from the organisation to see moves inside it.</p>`;

  const outside = d.adj.map((a) => {
    const here = inOrg.get(a.s);
    const aj = state.bySlug.get(a.s);
    return `<div class="move">
      <div class="move-head">
        <button type="button" class="btn-link" data-go-slug="${esc(a.s)}">${esc(cap(a.t))}</button>
        <span class="row">${aj ? `<span class="muted small num">AI can take over ${pct(aj.sh[0])}</span>` : ""}<span class="muted small num">${pct(a.ov)} skills shared</span></span>
      </div>
      ${here ? `<span class="small" style="color:var(--ok-ink);font-weight:600">You already employ ${fmt(here)} people in this job</span>` : ""}
      ${a.gap.length ? `<div class="chips"><span class="small muted">Skills to add:</span>${a.gap.map((g) => state.skills[g]).filter(Boolean).map((s) => `<span class="chip">${esc(cap(s[0]))}</span>`).join("")}</div>` : ""}
    </div>`;
  }).join("");

  return `
    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>A working week, today and in future</h2></div>
        <p class="sub">Share of a typical week, as estimated by the model. Green is new work that AI makes possible.</p>
        <div class="legend"><span><i style="background:var(--today)"></i>Today</span><span><i style="background:var(--future)"></i>Future</span><span><i style="background:var(--newwork)"></i>New AI-assisted work</span></div>
        <div class="chart-wrap" id="c-week"></div>
      </section>
      <section class="panel" style="display:grid;gap:12px;align-content:start">
        <h2>How the job changes</h2>
        <div class="story">${n.story.split(/\n\n+/).map((p) => `<p>${esc(p)}</p>`).join("")}</div>
        <p class="muted small">Written by an AI model for the standard ESCO job, in the voice of someone doing it.</p>
      </section>
    </div>

    <div class="grid-3">
      <section class="panel"><h2>What AI takes over</h2><ul class="list">${n.auto.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>
      <section class="panel"><h2>What AI makes people better at</h2><ul class="list">${n.amp.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>
      <section class="panel"><h2>Tools to know</h2><ul class="list">${n.tools.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>The skills behind the score</h2><span class="muted small">Core skills for this job, most affected first</span></div>
      <p class="sub">Each skill was scored from 1 to 10 on two questions. A 7 or more on “AI can do it” puts the skill in “AI can take over”.</p>
      <div style="margin-top:8px">${skillHtml || `<p class="muted">No skill detail for this job.</p>`}</div>
    </section>

    <section class="panel" style="display:grid;gap:12px;align-content:start">
      <h2>Capability to build</h2>
      <p class="callout">${esc(n.adv)}</p>
      ${d.d ? `<h3 style="margin-top:8px">What this job is (ESCO)</h3><p class="sub">${esc(d.d)}</p>` : ""}
    </section>

    <div class="two-col">
      <section class="panel">
        <div class="panel-head"><h2>Moves inside ${esc(state.orgName || "the organisation")}</h2><span class="muted small">Less exposed roles you already have</span></div>
        ${insideHtml}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Moves across the job market</h2><span class="muted small">Nearby ESCO jobs by shared skills</span></div>
        ${outside || `<p class="muted" style="margin-top:8px">No close neighbours for this job in the data.</p>`}
      </section>
    </div>`;
}

// ---------------------------------------------------------------- picker dialog

const dlg = $("#picker");
function openPicker(mode, query = "") {
  state.picker = mode;
  $("#picker-title").textContent = { assign: "Choose the right ESCO job", blend: "Blend in a second ESCO job", explore: "Explore any job" }[mode.mode];
  const q = $("#picker-q");
  q.value = query;
  fillPicker(query);
  if (!dlg.open) dlg.showModal();
  q.focus();
  q.select();
}
function fillPicker(text) {
  const list = $("#picker-results");
  const res = text.trim() ? state.matcher.search(text, 15) : [];
  list.innerHTML = res.length
    ? res.map((r) => {
      const j = state.bySlug.get(r.s);
      return `<li><button type="button" data-pick="${esc(r.s)}"><span><b>${esc(cap(j.t))}</b><br><span class="cell-sub">${esc(j.ug || j.mg)}${r.label.toLowerCase() !== j.t.toLowerCase() ? ` · also called “${esc(r.label)}”` : ""}</span></span>${typePill(j.q)}</button></li>`;
    }).join("")
    : `<li class="muted small" style="padding:8px">${text.trim() ? "No jobs found. Try a simpler title." : "Start typing a job title."}</li>`;
}
$("#picker-q").addEventListener("input", (e) => fillPicker(e.target.value));
$("#picker-form").addEventListener("submit", () => { state.picker = null; });
$("#picker-results").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pick]");
  if (!b) return;
  const s = b.dataset.pick;
  const mode = state.picker;
  dlg.close();
  const r = mode?.rowId ? state.rows.find((x) => x.id === mode.rowId) : null;
  if (mode?.mode === "assign" && r) {
    r.s = s;
    if (r.mix) r.mix[0].s = s;
    if (!r.cands.some((c) => c.s === s)) r.cands.unshift({ s, score: 1, label: state.bySlug.get(s).t });
    r.conf = "manual";
    remember(r);
    save();
    render();
  } else if (mode?.mode === "blend" && r) {
    if (s !== r.s) {
      r.mix = [{ s: r.s, w: 0.6 }, { s, w: 0.4 }];
      r.conf = "manual";
      remember(r);
      save();
    }
    render();
  } else {
    state.role = { slug: s };
    setView("role");
  }
});

// ---------------------------------------------------------------- wiring

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("[data-action]");
  if (!a) return;
  const act = a.dataset.action;
  if (act === "goto-load") setView("load");
  else if (act === "goto-org") setView("org");
  else if (act === "goto-match") { state.reviewOnly = true; setView("match"); }
  else if (act === "explore") openPicker({ mode: "explore" });
});
window.addEventListener("hashchange", () => {
  const v = location.hash.slice(1);
  if (["load", "match", "org", "role"].includes(v) && v !== state.view) setView(v, { push: false });
});

async function init() {
  $("#brand-name").textContent = BRAND.name;
  $("#brand-product").textContent = BRAND.product;
  try {
    const idx = await (await fetch("data/jobs_index.json")).json();
    state.jobs = idx.jobs;
    state.jobs.forEach((j) => state.bySlug.set(j.s, j));
    state.matcher = buildMatcher(state.jobs);
  } catch (err) {
    main.innerHTML = `<p class="msg err">Couldn't load the job data (${esc(err.message)}). If you opened this file directly, serve the folder instead: <code>python3 -m http.server</code>.</p>`;
    return;
  }
  if (!restore()) loadOrg(SAMPLE_CSV, SAMPLE_NAME, true);
  const v = location.hash.slice(1);
  state.view = ["load", "match", "org", "role"].includes(v) ? v : "org";
  render();

  // The full detail is large; fetch it after the first screen is up.
  fetch("data/jobs_detail.json")
    .then((r) => r.json())
    .then((d) => {
      state.detail = d.jobs;
      state.skills = d.skills;
      if (state.view === "role") render();
      else if (state.view === "org") {
        const el = $("#moves");
        if (el) el.innerHTML = movesTable(matched());
      }
    })
    .catch(() => {
      if (state.view === "role") main.insertAdjacentHTML("beforeend", `<p class="msg err">Couldn't load the job detail. Reload the page to try again.</p>`);
    });
}

init();
