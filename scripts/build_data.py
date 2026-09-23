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
# Work split: a skill counts as "AI can take over" when its automation score
# is at least this, and as "AI assists" when automation is below it but
# amplification reaches it. Everything else "stays human".
SPLIT_AT = 7
# Types are cut at 6 on the job scores; within this distance a job is borderline.
BORDERLINE = 0.5


def take_share(essential, optional, skills, at):
    """Share of a job's skill weight scoring at least `at` on automation."""
    weighted = [(skills[s], 2) for s in essential if s in skills] + [(skills[s], 1) for s in optional if s in skills]
    total = sum(w for _, w in weighted)
    return round(sum(w for sk, w in weighted if sk["a"] >= at) / total, 3) if total else 0.0


def work_split(essential, optional, skills):
    """Share of a job's skill weight in each bucket; essential skills count twice."""
    weighted = [(skills[s], 2) for s in essential if s in skills] + [(skills[s], 1) for s in optional if s in skills]
    total = sum(w for _, w in weighted)
    if not total:
        return [0.0, 0.0, 1.0]
    take = sum(w for sk, w in weighted if sk["a"] >= SPLIT_AT) / total
    assist = sum(w for sk, w in weighted if sk["a"] < SPLIT_AT and sk["m"] >= SPLIT_AT) / total
    return [round(take, 3), round(assist, 3), round(1 - take - assist, 3)]


def main(src: Path, out: Path) -> None:
    portfolio = json.loads((src / "site/portfolio_data.json").read_text())
    site = {j["slug"]: j for j in json.loads((src / "site/data.json").read_text())}
    csv.field_size_limit(10_000_000)
    esco = {}
    with open(src / "data/esco/occupations_en.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            esco[row["preferredLabel"].strip().lower()] = row

    all_skills = portfolio["skills"]
    used = set()      # skills shown with scores and rationale
    named = set()     # skills only needed by name (internal moves)
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

        # Full skill lists, used in the browser to find moves inside an organisation.
        sea = [s for s in o["se"] if s in all_skills]
        soa = [s for s in o["so"] if s in all_skills]
        named.update(sea)

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
            "sh": work_split(sea, soa, all_skills),
            # "AI can take over" if the line were drawn one point lower or higher.
            "tk": [take_share(sea, soa, all_skills, SPLIT_AT - 1), take_share(sea, soa, all_skills, SPLIT_AT + 1)],
            "bl": min(abs(o["ar"] - 6), abs(o["ap"] - 6)) < BORDERLINE,
            "d": desc,
            "se": se,
            "sea": sea,
            "soa": soa,
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
    skills.update({k: [all_skills[k]["t"], all_skills[k]["a"], all_skills[k]["m"]] for k in named - used})
    missing_alt = sum(1 for j in jobs if not j["alt"] and not j["d"])
    meta = {
        "built": date.today().isoformat(),
        "jobs": len(jobs),
        "skills": len(skills),
        "source": "AI-ISCO (github.com/Jorisdevreede/AI-ISCO), Gemini score set",
    }
    # Small index, loaded first: enough to match titles and draw the organisation view.
    index_keys = ("s", "t", "c", "mg", "ug", "q", "ar", "ap", "alt", "sh", "tk", "bl")
    index = [{**{k: j[k] for k in index_keys}, "ts": j["n"]["ts"], "tl": j["n"]["tl"]} for j in jobs]
    # Detail, loaded in the background: everything the job view needs.
    detail = {j["s"]: {k: j[k] for k in ("d", "se", "sea", "soa", "adj", "n")} for j in jobs}

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
