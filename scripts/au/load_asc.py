"""Load the Australian Skills Classification (ASC) into one tidy JSON file.

Accepts either:
  - the ASC Excel workbook published by Jobs and Skills Australia
    (Release 2.0 or 3.0; sheets are found by their column names), or
  - the `strayr` R package's data folder, which holds the March 2021 beta
    (github.com/runapp-aus/strayr, data/*.rda; needs `pip install pyreadr`).

Output: data/au/asc.json
  {
    "meta": {...},
    "occupations": {
      "<ANZSCO code>": {
        "name": ..., "description": ...,
        "tasks": [{"task": ..., "time": 0.12, "cluster": ..., "family": ...}],
        "competencies": [{"name": ..., "score": 6, "level": "Intermediate"}],
        "tools": [...]
      }
    },
    "tasks": ["<every distinct specialist task>"]
  }

Usage:
  python3 scripts/au/load_asc.py path/to/ASC.xlsx
  python3 scripts/au/load_asc.py path/to/strayr/data
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data/au/asc.json"


def snake(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(name).strip().lower()).strip("_")


def pick(df: pd.DataFrame, *candidates: str) -> str | None:
    """First column whose snake_case name contains every word of a candidate."""
    cols = {snake(c): c for c in df.columns}
    for cand in candidates:
        words = cand.split("_")
        for key, col in cols.items():
            if all(w in key for w in words):
                return col
    return None


def read_tables(src: Path) -> dict[str, pd.DataFrame]:
    if src.is_dir():
        import pyreadr  # only needed for the strayr beta

        names = ["asc_descriptions", "asc_specialist_tasks", "asc_core_competencies", "asc_technology_tools"]
        return {n: next(iter(pyreadr.read_r(str(src / f"{n}.rda")).values())) for n in names}
    sheets = pd.read_excel(src, sheet_name=None)
    found: dict[str, pd.DataFrame] = {}
    for df in sheets.values():
        # Some releases put a title block above the header row.
        if not any("anzsco" in snake(c) for c in df.columns):
            for i in range(min(10, len(df))):
                if any("anzsco" in snake(v) for v in df.iloc[i].astype(str)):
                    df = df.iloc[i + 1:].set_axis(df.iloc[i].tolist(), axis=1)
                    break
        if pick(df, "specialist_task") and pick(df, "time"):
            found["asc_specialist_tasks"] = df
        elif pick(df, "core_competenc") and pick(df, "score"):
            found["asc_core_competencies"] = df
        elif pick(df, "technology_tool") or pick(df, "tech_tool"):
            found.setdefault("asc_technology_tools", df)
        elif pick(df, "anzsco_desc") or pick(df, "occupation_desc"):
            found["asc_descriptions"] = df
    missing = {"asc_specialist_tasks", "asc_descriptions"} - set(found)
    if missing:
        sys.exit(f"Couldn't find these tables in {src.name}: {', '.join(sorted(missing))}. "
                 f"Sheets seen: {', '.join(sheets)}")
    return found


def code_of(v) -> str:
    s = str(v).strip()
    return s[:-2] if s.endswith(".0") else s


def main(src: Path) -> None:
    t = read_tables(src)
    occ: dict[str, dict] = {}

    d = t["asc_descriptions"]
    c_code, c_name = pick(d, "anzsco_code") or pick(d, "code"), pick(d, "anzsco_name") or pick(d, "anzsco_title") or pick(d, "occupation_title")
    c_desc = pick(d, "anzsco_desc") or pick(d, "description")
    for _, r in d.iterrows():
        occ[code_of(r[c_code])] = {"name": str(r[c_name]).strip(), "description": str(r[c_desc]).strip() if c_desc else "",
                                   "tasks": [], "competencies": [], "tools": []}

    s = t["asc_specialist_tasks"]
    s_code, s_task = pick(s, "anzsco_code") or pick(s, "code"), pick(s, "specialist_task")
    s_time = pick(s, "time_spent_on_task") or pick(s, "time_task") or pick(s, "time")
    s_cluster, s_family = pick(s, "specialist_cluster") or pick(s, "cluster"), pick(s, "cluster_family") or pick(s, "family")
    for _, r in s.iterrows():
        o = occ.get(code_of(r[s_code]))
        if o is None or pd.isna(r[s_task]):
            continue
        time = float(r[s_time]) if s_time and not pd.isna(r[s_time]) else None
        if time is not None and time > 1:  # some releases give percentages, not shares
            time /= 100
        o["tasks"].append({"task": str(r[s_task]).strip(), "time": time,
                           "cluster": str(r[s_cluster]).strip() if s_cluster else "",
                           "family": str(r[s_family]).strip() if s_family else ""})

    if "asc_core_competencies" in t:
        c = t["asc_core_competencies"]
        k_code, k_name = pick(c, "anzsco_code") or pick(c, "code"), pick(c, "core_competenc")
        k_score, k_level = pick(c, "score"), pick(c, "proficiency") or pick(c, "level")
        for _, r in c.iterrows():
            o = occ.get(code_of(r[k_code]))
            if o is not None:
                o["competencies"].append({"name": str(r[k_name]).strip(),
                                          "score": int(r[k_score]) if not pd.isna(r[k_score]) else None,
                                          "level": str(r[k_level]).strip() if k_level else ""})

    if "asc_technology_tools" in t:
        tt = t["asc_technology_tools"]
        t_code, t_name = pick(tt, "anzsco_code") or pick(tt, "code"), pick(tt, "technology_tool") or pick(tt, "tech_tool")
        for _, r in tt.iterrows():
            o = occ.get(code_of(r[t_code]))
            if o is not None and not pd.isna(r[t_name]):
                o["tools"].append(str(r[t_name]).strip())

    occ = {k: v for k, v in occ.items() if v["tasks"]}
    tasks = sorted({x["task"] for o in occ.values() for x in o["tasks"]})
    timed = sum(1 for o in occ.values() if all(x["time"] is not None for x in o["tasks"]))
    payload = {
        "meta": {
            "source": str(src.name),
            "release": "2021 beta (strayr)" if src.is_dir() else "workbook",
            "loaded": date.today().isoformat(),
            "occupations": len(occ),
            "distinct_tasks": len(tasks),
            "occupations_with_time_shares": timed,
            "licence": "Australian Skills Classification, Jobs and Skills Australia, CC BY 4.0",
        },
        "occupations": occ,
        "tasks": tasks,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1))
    m = payload["meta"]
    print(f"{m['occupations']} occupations, {m['distinct_tasks']} distinct tasks, "
          f"{m['occupations_with_time_shares']} with time shares -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]))
