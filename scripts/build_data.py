"""Build app/data/jobs_index.json and app/data/jobs_detail.json from a local clone of the AI-ISCO repository.

Uses only the openly licensed parts of AI-ISCO:
  - site/portfolio_data.json  (Gemini scores + narratives, CC BY 4.0)
  - site/data.json            (ISCO unit group per job, CC BY 4.0)
  - data/esco/occupations_en.csv (ESCO v1.2.1 titles, alternative titles, descriptions)

The TypeSafe (jev) "v2" score files are deliberately not used: they are not
under the CC BY grant.

Usage:
  python3 scripts/build_data.py /path/to/AI-ISCO
"""
import csv
import json
import sys
from datetime import date
from pathlib import Path

MAX_ESSENTIAL_SKILLS = 10
MAX_ADJACENT = 4
MAX_GAP_SKILLS = 3
MAX_ALT_LABELS = 25
DESC_CHARS = 320


def main(src: Path, out: Path) -> None:
    portfolio = json.loads((src / "site/portfolio_data.json").read_text())
    site = {j["slug"]: j for j in json.loads((src / "site/data.json").read_text())}
    csv.field_size_limit(10_000_000)
    esco = {}
    with open(src / "data/esco/occupations_en.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            esco[row["preferredLabel"].strip().lower()] = row

    all_skills = portfolio["skills"]
    used = set()
    jobs = []
    for o in portfolio["occupations"]:
        n = o["n"]
        row = esco.get(o["t"].lower(), {})
        alts = [a.strip() for a in row.get("altLabels", "").split("\n") if a.strip()]
        desc = " ".join(row.get("description", "").split())
        if len(desc) > DESC_CHARS:
            desc = desc[:DESC_CHARS].rsplit(" ", 1)[0] + "…"

        # Keep the essential skills that say most about the job's future:
        # highest automation or amplification first.
        se = [s for s in o["se"] if s in all_skills]
        se.sort(key=lambda s: -max(all_skills[s]["a"] or 0, all_skills[s]["m"] or 0))
        se = se[:MAX_ESSENTIAL_SKILLS]
        used.update(se)

        adj = []
        for a in o["adj"][:MAX_ADJACENT]:
            gap = [g for g in a["gap"] if g in all_skills][:MAX_GAP_SKILLS]
            used.update(gap)
            adj.append({"s": a["s"], "t": a["t"], "q": a["q"], "ov": a["ov"], "gap": gap})

        jobs.append({
            "s": o["s"],
            "t": o["t"],
            "c": o["c"],
            "mg": o["mg"],
            "ug": site.get(o["s"], {}).get("unit_group", ""),
            "q": o["q"],
            "ar": o["ar"],
            "ap": o["ap"],
            "alt": alts[:MAX_ALT_LABELS],
            "d": desc,
            "se": se,
            "adj": adj,
            "n": {
                "story": n["story"],
                "ts": n["ts"],
                "auto": n["auto"],
                "amp": n["amp"],
                "tools": n["tools"],
                "week": n["week"],
                "tl": n["tl"],
                "adv": n["adv"],
            },
        })

    skills = {k: [v["t"], v["a"], v["m"], v.get("r", "")] for k, v in all_skills.items() if k in used}
    missing_alt = sum(1 for j in jobs if not j["alt"] and not j["d"])
    meta = {
        "built": date.today().isoformat(),
        "jobs": len(jobs),
        "skills": len(skills),
        "source": "AI-ISCO (github.com/Jorisdevreede/AI-ISCO), Gemini score set",
    }
    # Small index, loaded first: enough to match titles and draw the organisation view.
    index_keys = ("s", "t", "c", "mg", "ug", "q", "ar", "ap", "alt")
    index = [{**{k: j[k] for k in index_keys}, "ts": j["n"]["ts"], "tl": j["n"]["tl"]} for j in jobs]
    # Detail, loaded in the background: everything the job view needs.
    detail = {j["s"]: {k: j[k] for k in ("d", "se", "adj", "n")} for j in jobs}

    out.mkdir(parents=True, exist_ok=True)
    for name, payload in (("jobs_index.json", {"meta": meta, "jobs": index}),
                          ("jobs_detail.json", {"meta": meta, "skills": skills, "jobs": detail})):
        path = out / name
        path.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
        print(f"{path.stat().st_size / 1e6:.1f} MB -> {path}")
    print(f"{len(jobs)} jobs, {len(skills)} skills, {missing_alt} jobs without ESCO text")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = Path(__file__).resolve().parent.parent
    main(Path(sys.argv[1]), root / "app/data")
