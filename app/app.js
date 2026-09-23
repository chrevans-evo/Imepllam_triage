import { buildMatcher, confidence } from "./matcher.js";
import { SAMPLE_CSV, SAMPLE_MATCHES, SAMPLE_NAME } from "./sample.js";

// Brand copy lives here so the app can be re-branded in one place.
const BRAND = {
  name: "Vertage",
  product: "Future of Work Lens",
  tagline: "Where advantage compounds.",
};

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
const STORE_KEY = "fowl-state-v1";

const state = {
  jobs: [],
  bySlug: new Map(),
  matcher: null,
  detail: null,
  skills: null,
  orgName: "",
  isSample: false,
  rows: [],
  view: "org",
  role: null, // { rowId } or { slug }
  reviewOnly: false,
  sort: { key: "hc", dir: -1 },
  loadMsg: null,
  picker: null, // { mode: "assign", rowId } or { mode: "explore" }
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
let uid = 0;
const newId = () => `r${Date.now().toString(36)}${(uid++).toString(36)}`;

function typePill(q) {
  return `<span class="pill"><span class="sw sw-${q}"></span>${esc(TYPES[q].label)}</span>`;
}
function confLabel(c) {
  return { high: "Strong match", medium: "Check", low: "Weak match", manual: "Checked" }[c] || c;
}
function tlBucket(tl) {
  const first = parseInt(String(tl).match(/\d+/)?.[0] || "0", 10);
  if (first <= 2) return 0;
  if (first <= 4) return 1;
  return 2;
}
const TL_LABELS = ["Starts within 2 years", "Starts in 3–4 years", "Starts in 5+ years"];

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ orgName: state.orgName, isSample: state.isSample, rows: state.rows }));
  } catch { /* storage unavailable: the session still works */ }
}
function restore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (!Array.isArray(s.rows) || !s.rows.length) return false;
    const rows = s.rows.filter((r) => !r.s || state.bySlug.has(r.s));
    if (!rows.length) return false;
    Object.assign(state, { orgName: s.orgName || "", isSample: !!s.isSample, rows });
    return true;
  } catch {
    return false;
  }
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

function matchRoles(roles) {
  return roles.map((r) => {
    const cands = state.matcher.match(r.title, 5);
    return { id: newId(), ...r, cands, s: cands[0]?.s || null, conf: cands.length ? confidence(cands) : "low" };
  });
}

function loadOrg(text, name, isSample = false) {
  const roles = tableToRoles(parseDelimited(text));
  state.rows = matchRoles(roles);
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
  state.isSample = isSample;
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
  const byTl = [0, 0, 0];
  let freed = 0;
  for (const r of rows) {
    const j = state.bySlug.get(r.s);
    byType[j.q] += r.hc;
    byTl[tlBucket(j.tl)] += r.hc;
    freed += (r.hc * j.ts) / 100;
  }
  return { total, byType, byTl, freed };
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
  const render = () => { el.innerHTML = draw(Math.max(280, el.clientWidth)); };
  charts.push({ el, render });
  render();
}
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => charts.forEach((c) => c.el.isConnected && c.render()), 120);
});

function tipRole(r, j) {
  return esc(`<b>${esc(r.title)}</b><br>${fmt(r.hc)} people · ${esc(r.dept)}<br>Matched to: ${esc(cap(j.t))}<br>${TYPES[j.q].label} · automation ${j.ar} · amplification ${j.ap}<br>Time AI could free: ${j.ts}% · ${esc(j.tl)}`);
}

// One 100% bar: how the headcount splits across the four types.
function drawStack(byType, total) {
  return (w) => {
    const h = 44, y = 4, bh = 36;
    let x = 0, out = "";
    for (const q of ORDER) {
      const v = byType[q];
      if (!v) continue;
      const bw = (v / total) * w;
      const share = v / total;
      out += `<rect class="f-${q}" x="${x}" y="${y}" width="${Math.max(0, bw - 2)}" height="${bh}" rx="4" data-tip="${esc(`<b>${TYPES[q].label}</b><br>${fmt(v)} people · ${pct(share)}`)}"></rect>`;
      if (bw > 70) out += `<text x="${x + 10}" y="${y + bh / 2 + 5}" style="fill:#0b0b0b;font-weight:700;font-size:14px" pointer-events="none">${pct(share)}</text>`;
      x += bw;
    }
    return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Headcount by future type">${out}</svg>`;
  };
}

// Bubble map: automation (x) against amplification (y), bubble area = headcount.
// Roles matched to the same ESCO job share one bubble.
function drawMap(rows) {
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.s) || { s: r.s, hc: 0, rows: [] };
    g.hc += r.hc; g.rows.push(r);
    groups.set(r.s, g);
  }
  const list = [...groups.values()].sort((a, b) => b.hc - a.hc);
  const js = list.map((g) => state.bySlug.get(g.s));
  // Zoom to where the roles sit, always keeping the line at 6 in view.
  const lo = Math.max(1, Math.floor(Math.min(THRESHOLD - 1, ...js.map((j) => Math.min(j.ar, j.ap))) - 0.5));
  const hi = Math.min(10, Math.ceil(Math.max(THRESHOLD + 1, ...js.map((j) => Math.max(j.ar, j.ap))) + 0.5));
  const name = (g) => (g.rows.length > 1 ? `${g.rows[0].title} +${g.rows.length - 1}` : g.rows[0].title);
  const tipGroup = (g, j) => esc(`<b>${g.rows.map((r) => esc(r.title)).join("<br>")}</b><br>${fmt(g.hc)} people<br>Matched to: ${esc(cap(j.t))}<br>${TYPES[j.q].label} · AI can do the work ${j.ar} · AI boosts people ${j.ap}<br>Time AI could free: ${j.ts}% · ${esc(j.tl)}`);
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
    // Largest first so small bubbles stay on top and clickable
    list.forEach((grp, i) => {
      const j = js[i];
      g += `<circle class="bubble f-${j.q}" cx="${sx(j.ar)}" cy="${sy(j.ap)}" r="${rad(grp.hc)}" data-tip="${tipGroup(grp, j)}" data-go-row="${grp.rows[0].id}"></circle>`;
    });
    // Direct labels for the biggest groups, skipping any that would collide.
    const placed = [];
    let labels = "";
    for (let i = 0; i < list.length && placed.length < 6; i++) {
      const grp = list[i], j = js[i];
      const text = name(grp);
      const tw = text.length * 6.6, x = sx(j.ar), y = sy(j.ap) - rad(grp.hc) - 6;
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

// Departments: one 100% bar each, sorted by share of roles shrinking or transforming.
function drawDepts(rows) {
  const depts = new Map();
  for (const r of rows) {
    const d = depts.get(r.dept) || { name: r.dept, total: 0, byType: Object.fromEntries(ORDER.map((q) => [q, 0])) };
    d.total += r.hc;
    d.byType[state.bySlug.get(r.s).q] += r.hc;
    depts.set(r.dept, d);
  }
  const list = [...depts.values()].sort((a, b) =>
    (b.byType.SHRINK + b.byType.TRANSFORM) / b.total - (a.byType.SHRINK + a.byType.TRANSFORM) / a.total);
  return (w) => {
    const labelW = Math.min(170, w * 0.32), valW = 56, rowH = 30, bh = 18;
    const bw = w - labelW - valW;
    const h = list.length * rowH + 4;
    let g = "";
    list.forEach((d, i) => {
      const y = i * rowH + 4;
      g += `<text x="0" y="${y + bh / 2 + 4}" class="t-strong">${esc(d.name.length > 26 ? d.name.slice(0, 25) + "…" : d.name)}</text>`;
      let x = labelW;
      for (const q of ORDER) {
        const v = d.byType[q];
        if (!v) continue;
        const sw = (v / d.total) * bw;
        g += `<rect class="f-${q}" x="${x}" y="${y}" width="${Math.max(0, sw - 2)}" height="${bh}" rx="3" data-tip="${esc(`<b>${esc(d.name)}</b><br>${TYPES[q].label}: ${fmt(v)} of ${fmt(d.total)} people (${pct(v / d.total)})`)}"></rect>`;
        x += sw;
      }
      g += `<text x="${w}" y="${y + bh / 2 + 4}" text-anchor="end" class="num">${fmt(d.total)}</text>`;
    });
    return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Departments by future type">${g}</svg>`;
  };
}

// When change starts: headcount per timeline band.
function drawTimeline(byTl, total) {
  return (w) => {
    const labelW = Math.min(170, w * 0.4), valW = 90, rowH = 38, bh = 22;
    const bw = w - labelW - valW;
    const max = Math.max(...byTl, 1);
    let g = "";
    byTl.forEach((v, i) => {
      const y = i * rowH + 4;
      g += `<text x="0" y="${y + bh / 2 + 4}" class="t-strong">${TL_LABELS[i]}</text>`;
      const len = (v / max) * bw;
      if (v) g += `<rect class="f-future" x="${labelW}" y="${y}" width="${Math.max(4, len)}" height="${bh}" rx="4" data-tip="${esc(`<b>${TL_LABELS[i]}</b><br>${fmt(v)} people · ${pct(v / total)}`)}"></rect>`;
      g += `<text x="${labelW + Math.max(4, len) + 8}" y="${y + bh / 2 + 4}" class="num">${fmt(v)} · ${pct(v / total)}</text>`;
    });
    const h = byTl.length * rowH;
    return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="When the change starts">${g}</svg>`;
  };
}

// A working week, today against the future: one row per activity.
function drawWeek(week) {
  const before = week.before || {}, after = week.after || {};
  const cats = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((c) => c !== "new_ai_augmented");
  if ("new_ai_augmented" in after) cats.push("new_ai_augmented");
  const name = (c) => (c === "new_ai_augmented" ? "New AI-assisted work" : cap(c.replace(/_/g, " ")));
  return (w) => {
    const labelW = Math.min(200, w * 0.42), valW = 40, rowH = 48, bh = 14;
    const bw = w - labelW - valW;
    const max = Math.max(...cats.map((c) => Math.max(before[c] || 0, after[c] || 0)), 1);
    let g = "";
    cats.forEach((c, i) => {
      const y = i * rowH + 6;
      const isNew = c === "new_ai_augmented";
      const label = name(c);
      const lines = wrap(label, Math.floor(labelW / 7));
      lines.slice(0, 2).forEach((ln, k) => {
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
  return `<div class="legend">${ORDER.map((q) => `<span><i class="sw-${q}"></i>${TYPES[q].label}</span>`).join("")}</div>`;
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
          <li>You check the weak matches. Titles like “Team Lead – APAC” need a human eye.</li>
          <li>The app shows how AI is likely to change each role, and the whole organisation.</li>
        </ol>
      </section>
    </div>`;

  const nameEl = $("#org-name");
  const run = (text) => {
    try {
      const rows = loadOrg(text, nameEl.value.trim());
      const weak = needsReview().length;
      state.loadMsg = { ok: true, text: `Matched ${rows.length} roles. ${weak} need a check.` };
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
function renderMatch() {
  if (!state.rows.length) { setView("load"); return; }
  const weak = needsReview();
  const rows = state.reviewOnly ? weak : state.rows;
  const counts = { high: 0, medium: 0, low: 0, manual: 0 };
  state.rows.forEach((r) => { counts[r.conf] = (counts[r.conf] || 0) + 1; });

  const option = (r, c) => {
    const j = state.bySlug.get(c.s);
    return `<option value="${esc(c.s)}" ${c.s === r.s ? "selected" : ""}>${esc(cap(j.t))}</option>`;
  };
  const body = rows.map((r) => {
    const j = r.s ? state.bySlug.get(r.s) : null;
    const cands = [...r.cands];
    if (r.s && !cands.some((c) => c.s === r.s)) cands.unshift({ s: r.s, score: 1, label: j.t });
    const hit = r.cands.find((c) => c.s === r.s);
    const via = hit && hit.label.toLowerCase() !== j.t.toLowerCase() ? `matched on “${esc(hit.label)}”` : "";
    return `<tr>
      <td><div class="cell-title">${esc(r.title)}</div><div class="cell-sub">${esc(r.dept)}</div></td>
      <td class="r num">${fmt(r.hc)}</td>
      <td>
        ${cands.length ? `<select class="match-select" data-row="${r.id}" aria-label="ESCO job for ${esc(r.title)}">${cands.map((c) => option(r, c)).join("")}</select>` : `<span class="muted">No match found</span>`}
        <div class="cell-sub">${j ? `${typePill(j.q)} ${via}` : ""}</div>
      </td>
      <td><span class="conf conf-${r.conf}">${confLabel(r.conf)}</span></td>
      <td><div class="row">
        ${r.conf === "medium" || r.conf === "low" ? `<button type="button" class="btn-ghost" data-ok="${r.id}">Looks right</button>` : ""}
        <button type="button" class="btn-link" data-search="${r.id}">Search</button>
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
        <p class="lede">Titles are matched to standard ESCO jobs by the words they share. The match decides everything downstream, so give the orange and red rows a quick look. Pick a better job from the list, or search all 3,039.</p>
      </div>
      <button type="button" class="btn" data-action="goto-org">View the organisation →</button>
    </section>
    <section class="panel" style="display:grid;gap:14px">
      <div class="row" style="justify-content:space-between">
        <div class="row small">
          <span class="conf conf-high">${counts.high} strong</span>
          <span class="conf conf-manual">${counts.manual} checked</span>
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

  $("#review-only").addEventListener("change", (e) => { state.reviewOnly = e.target.checked; renderMatch(); });
  main.querySelectorAll(".match-select").forEach((sel) => sel.addEventListener("change", () => {
    const r = state.rows.find((x) => x.id === sel.dataset.row);
    r.s = sel.value; r.conf = "manual";
    save(); render();
  }));
  main.querySelectorAll("[data-ok]").forEach((b) => b.addEventListener("click", () => {
    state.rows.find((x) => x.id === b.dataset.ok).conf = "manual";
    save(); render();
  }));
  main.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => {
    state.rows = state.rows.filter((x) => x.id !== b.dataset.remove);
    save(); render();
  }));
  main.querySelectorAll("[data-search]").forEach((b) => b.addEventListener("click", () => {
    const r = state.rows.find((x) => x.id === b.dataset.search);
    openPicker({ mode: "assign", rowId: r.id }, r.title);
  }));
}

// ---- 3. Organisation
function orgLede(s) {
  const share = (q) => s.byType[q] / s.total;
  const changing = share("SHRINK") + share("TRANSFORM");
  const top = [...ORDER].sort((a, b) => s.byType[b] - s.byType[a])[0];
  let text = `${pct(changing)} of people work in roles where AI can take over a large share of the work.`;
  if (share("SHRINK") >= 0.05) text += ` ${pct(share("SHRINK"))} are in roles likely to shrink.`;
  const rest = share("EVOLVE") + share("STABLE");
  if (rest >= 0.05) text += ` The other ${pct(rest)} keep the core of their job, and ${share("EVOLVE") >= share("STABLE") ? "most of them gain from AI" : "most see little change"}.`;
  if (share(top) >= 0.7) text += ` With ${pct(share(top))} in one type, the role map below shows the differences inside it.`;
  return text;
}

function renderOrg() {
  const rows = matched();
  if (!rows.length) { setView("load"); return; }
  const s = summarise(rows);
  const changing = s.byType.SHRINK + s.byType.TRANSFORM;
  const weak = needsReview().length;

  const sortKey = state.sort.key, dir = state.sort.dir;
  const val = (r) => {
    const j = state.bySlug.get(r.s);
    return { title: r.title.toLowerCase(), dept: r.dept.toLowerCase(), hc: r.hc, q: ORDER.indexOf(j.q), ts: j.ts, fte: (r.hc * j.ts) / 100, tl: tlBucket(j.tl) }[sortKey];
  };
  const sorted = [...rows].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * dir);
  const th = (key, label, cls = "") => `<th class="${cls}"><button type="button" data-sort="${key}" ${sortKey === key ? `aria-sort="${dir > 0 ? "ascending" : "descending"}"` : ""}>${label}</button></th>`;

  main.innerHTML = `
    ${sampleBanner()}
    <section class="page-head">
      <div>
        <p class="eyebrow">${esc(state.orgName)}</p>
        <h1>How AI is likely to reshape ${fmt(s.total)} roles</h1>
        <p class="lede">${orgLede(s)}</p>
      </div>
      ${weak ? `<button type="button" class="btn-ghost" data-action="goto-match">${weak} matches to check</button>` : ""}
    </section>

    <section class="kpis">
      <div class="kpi"><span class="kpi-label">People in scope</span><span class="kpi-value num">${fmt(s.total)}</span><span class="kpi-note">${rows.length} roles${rows.length < state.rows.length ? `, ${state.rows.length - rows.length} unmatched` : ""}</span></div>
      <div class="kpi"><span class="kpi-label">In roles shrinking or transforming</span><span class="kpi-value num">${pct(changing / s.total)}</span><span class="kpi-note">${fmt(changing)} people</span></div>
      <div class="kpi"><span class="kpi-label">Work time AI could free up</span><span class="kpi-value num">${pct(s.freed / s.total)}</span><span class="kpi-note">About ${fte(s.freed)} full-time equivalents. Model estimate.</span></div>
      <div class="kpi"><span class="kpi-label">Change starts within 2 years for</span><span class="kpi-value num">${pct(s.byTl[0] / s.total)}</span><span class="kpi-note">${fmt(s.byTl[0])} people</span></div>
    </section>

    <section class="panel" style="display:grid;gap:12px">
      <div class="panel-head"><h2>Where your people sit</h2><span class="muted small">Share of headcount by future type</span></div>
      <div class="chart-wrap" id="c-stack"></div>
      <div class="type-key">${ORDER.map((q) => `<div><span class="sw sw-${q}"></span><b>${TYPES[q].label} · ${pct(s.byType[q] / s.total)}</b><p>${TYPES[q].blurb}</p></div>`).join("")}</div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Role map</h2><span class="muted small">Each bubble is a role. Size shows headcount. Click one to open it.</span></div>
      <p class="sub">Scores run from 1 to 10 and are averaged across each job's skills. The dashed lines mark 6, where the four types split. The axes zoom to where your roles sit.</p>
      ${legendTypes()}
      <div class="chart-wrap" id="c-map"></div>
    </section>

    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>By department</h2><span class="muted small">Most exposed first · headcount on the right</span></div>
        ${legendTypes()}
        <div class="chart-wrap" id="c-dept"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>When the change lands</h2><span class="muted small">People by the model's timeline for their role</span></div>
        <p class="sub" style="margin-bottom:12px">When a role's timeline is a range, such as 3–5 years, the start of the range sets the band.</p>
        <div class="chart-wrap" id="c-tl"></div>
      </section>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>Every role</h2><span class="muted small">Click a row to open the role</span></div>
      <div class="table-wrap"><table>
        <thead><tr>${th("title", "Role")}${th("dept", "Department")}${th("hc", "People", "r")}${th("q", "Future type")}${th("ts", "Time AI could free", "r")}${th("fte", "FTE freed", "r")}${th("tl", "Timeline")}</tr></thead>
        <tbody>${sorted.map((r) => {
          const j = state.bySlug.get(r.s);
          return `<tr class="clickable" data-go-row="${r.id}" tabindex="0">
            <td><div class="cell-title">${esc(r.title)}</div><div class="cell-sub">${esc(cap(j.t))}</div></td>
            <td>${esc(r.dept)}</td>
            <td class="r num">${fmt(r.hc)}</td>
            <td>${typePill(j.q)}</td>
            <td class="r num">${j.ts}%</td>
            <td class="r num">${fte((r.hc * j.ts) / 100)}</td>
            <td class="num">${esc(j.tl)}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
    </section>`;

  mount($("#c-stack"), drawStack(s.byType, s.total));
  mount($("#c-map"), drawMap(rows));
  mount($("#c-dept"), drawDepts(rows));
  mount($("#c-tl"), drawTimeline(s.byTl, s.total));
  main.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.sort;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === "title" || k === "dept" || k === "q" || k === "tl" ? 1 : -1) };
    renderOrg();
  }));
  main.querySelectorAll("tr[data-go-row]").forEach((tr) => tr.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { state.role = { rowId: tr.dataset.goRow }; setView("role"); }
  }));
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
  const teamFte = row ? (row.hc * j.ts) / 100 : null;

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
          ${typePill(j.q)}
          <span>ESCO job: <b>${esc(cap(j.t))}</b> · ISCO ${esc(j.c)}${j.ug ? ` · ${esc(j.ug)}` : ""}</span>
          ${row ? `<span>${fmt(row.hc)} people</span>` : ""}
        </div>
      </div>
      <p class="sub">${esc(TYPES[j.q].blurb)}</p>
    </section>

    <section class="kpis">
      <div class="kpi"><span class="kpi-label">Work time AI could free up</span><span class="kpi-value num">${j.ts}%</span><span class="kpi-note">Model estimate for this job</span></div>
      <div class="kpi"><span class="kpi-label">When the change lands</span><span class="kpi-value num">${esc(j.tl)}</span><span class="kpi-note">Model estimate</span></div>
      ${row ? `<div class="kpi"><span class="kpi-label">Capacity across this team</span><span class="kpi-value num">${fte(teamFte)} FTE</span><span class="kpi-note">${fmt(row.hc)} people × ${j.ts}%</span></div>` : ""}
      <div class="kpi"><span class="kpi-label">AI can do the work · AI boosts people</span><span class="kpi-value num">${j.ar} · ${j.ap}</span><span class="kpi-note">Out of 10. The types split at 6.</span></div>
    </section>

    ${d ? roleDetail(j, d, row, inOrg) : `<section class="panel"><p class="muted">Loading the full job detail…</p></section>`}`;

  const sel = $("#role-select");
  if (sel) sel.addEventListener("change", () => { if (sel.value) { state.role = { rowId: sel.value }; renderRole(); } });
  if (d) mount($("#c-week"), drawWeek(d.n.week));
}

function roleDetail(j, d, row, inOrg) {
  const n = d.n;
  const skills = d.se.map((id) => state.skills[id]).filter(Boolean);
  const skillHtml = skills.map(([t, a, m, why]) => `
    <div class="skill-row">
      <div class="skill-name">${esc(cap(t))}</div>
      <div class="bars">
        <div class="bar-line"><span>AI can do it</span><span class="bar-track"><span class="bar-fill auto" style="display:block;width:${(a || 0) * 10}%"></span></span><span class="num">${a ?? "–"}</span></div>
        <div class="bar-line"><span>AI boosts people</span><span class="bar-track"><span class="bar-fill amp" style="display:block;width:${(m || 0) * 10}%"></span></span><span class="num">${m ?? "–"}</span></div>
      </div>
      ${why ? `<p class="skill-why">${esc(why)}</p>` : ""}
    </div>`).join("");

  const moves = d.adj.map((a) => {
    const here = inOrg.get(a.s);
    return `<div class="move">
      <div class="move-head">
        <button type="button" class="btn-link" data-go-slug="${esc(a.s)}">${esc(cap(a.t))}</button>
        <span class="row">${typePill(a.q)}<span class="muted small num">${pct(a.ov)} skills shared</span></span>
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
      <p class="sub">Each skill was scored from 1 to 10 on two questions. The job's scores are the average across all its skills, with core skills counted twice.</p>
      <div style="margin-top:8px">${skillHtml || `<p class="muted">No skill detail for this job.</p>`}</div>
    </section>

    <div class="grid-2">
      <section class="panel" style="display:grid;gap:12px;align-content:start">
        <h2>Capability to build</h2>
        <p class="callout">${esc(n.adv)}</p>
        ${d.d ? `<h3 style="margin-top:8px">What this job is (ESCO)</h3><p class="sub">${esc(d.d)}</p>` : ""}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Where these people could move</h2><span class="muted small">Nearby jobs by shared skills</span></div>
        ${moves || `<p class="muted" style="margin-top:8px">No close neighbours for this job in the data.</p>`}
      </section>
    </div>`;
}

// ---------------------------------------------------------------- picker dialog

const dlg = $("#picker");
function openPicker(mode, query = "") {
  state.picker = mode;
  $("#picker-title").textContent = mode.mode === "assign" ? "Choose the right ESCO job" : "Explore any job";
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
  if (mode?.mode === "assign") {
    const r = state.rows.find((x) => x.id === mode.rowId);
    if (r) {
      r.s = s; r.conf = "manual";
      if (!r.cands.some((c) => c.s === s)) r.cands.unshift({ s, score: 1, label: state.bySlug.get(s).t });
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
    })
    .catch(() => {
      if (state.view === "role") main.insertAdjacentHTML("beforeend", `<p class="msg err">Couldn't load the job detail. Reload the page to try again.</p>`);
    });
}

init();
