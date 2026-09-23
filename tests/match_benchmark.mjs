// Scores the title matcher against tests/match_benchmark.json.
// Usage: node tests/match_benchmark.mjs [--verbose]
import fs from "fs";
import { buildMatcher } from "../app/matcher.js";

const root = new URL("..", import.meta.url).pathname;
const jobs = JSON.parse(fs.readFileSync(root + "app/data/jobs_index.json")).jobs;
const cases = JSON.parse(fs.readFileSync(root + "tests/match_benchmark.json"));
const verbose = process.argv.includes("--verbose");
const m = buildMatcher(jobs);

let top1 = 0, top3 = 0;
for (const c of cases) {
  const res = m.match(c.title, 5);
  const rank = res.findIndex((r) => c.accept.includes(r.s));
  if (rank === 0) top1++;
  if (rank >= 0 && rank < 3) top3++;
  if (verbose && rank !== 0) console.log(`${rank < 0 ? "MISS" : "rank " + (rank + 1)}  ${c.title} [${c.dept}] -> ${res.slice(0, 3).map((r) => r.s).join(", ")}`);
}
const pc = (n) => `${Math.round((100 * n) / cases.length)}%`;
console.log(`${cases.length} titles · top-1 ${top1} (${pc(top1)}) · top-3 ${top3} (${pc(top3)})`);
