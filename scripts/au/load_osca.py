"""Load OSCA (Occupation Standard Classification for Australia, 2024 v1.0)
into one tidy JSON file, with links to ANZSCO and ISCO-08.

Reads the ABS data downloads kept in data/au/abs/:
  OSCA Category Descriptions.xlsx          occupations, lead statements, main tasks, skill level
  OSCA index of principal titles ... .xlsx alternative titles and specialisations (for matching)
  OSCA correspondence tables v2.xlsx       OSCA <-> ANZSCO 2022 and OSCA <-> ISCO-08

Source: Australian Bureau of Statistics, OSCA 2024 v1.0 (CC BY 4.0).
https://www.abs.gov.au/statistics/classifications/osca-occupation-standard-classification-australia

Output: data/au/osca.json
  {
    "meta": {...},
    "groups": {"<1-4 digit code>": "<title>"},
    "occupations": {
      "<6-digit OSCA code>": {
        "title": ..., "alt": [...], "spec": [...], "nec": [...],
        "lead": ..., "tasks": [...], "skill": 1-5, "licensing": ...,
        "anzsco": [{"code": "...", "title": "...", "partial": bool}],
        "isco":   [{"code": "...", "title": "...", "partial": bool}]
      }
    }
  }

Usage:
  python3 scripts/au/load_osca.py
"""
import json
import re
from datetime import date
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
ABS = ROOT / "data/au/abs"
OUT = ROOT / "data/au/osca.json"

DESCRIPTIONS = ABS / "OSCA Category Descriptions.xlsx"
INDEX = ABS / "OSCA index of principal titles alternative titles and specialisations.xlsx"
CORRESPONDENCE = ABS / "OSCA correspondence tables v2.xlsx"


def code(v) -> str:
    s = str(v).strip()
    return s[:-2] if s.endswith(".0") else s


def clean(v) -> str:
    return "" if pd.isna(v) else re.sub(r"\s+", " ", str(v)).strip()


def with_header(path: Path, sheet: str) -> pd.DataFrame:
    """ABS sheets have a title block; the header row starts with 'Identifier'."""
    raw = pd.read_excel(path, sheet_name=sheet, header=None)
    first = raw.iloc[:, 0].astype(str).str.strip()
    row = first.index[first.eq("Identifier")][0]
    df = raw.iloc[row + 1:].copy()
    df.columns = [clean(c) or f"col{i}" for i, c in enumerate(raw.iloc[row])]
    return df.dropna(how="all")


def split_list(v) -> list[str]:
    return [x.strip() for x in re.split(r";|\n", clean(v)) if x.strip()]


def correspondence(sheet: str) -> list[tuple[str, str, str, bool]]:
    """(OSCA code, other code, other title, partial) from an 'OSCA to X' table."""
    raw = pd.read_excel(CORRESPONDENCE, sheet_name=sheet, header=None)
    rows = []
    for _, r in raw.iterrows():
        a, b = code(r[0]), code(r[2])
        if a.isdigit() and b.isdigit():
            rows.append((a, b, clean(r[4]), clean(r[3]).lower() == "p"))
    return rows


def main() -> None:
    d = with_header(DESCRIPTIONS, "Table 1")
    d["Identifier"] = d["Identifier"].map(code)
    occ = {}
    for _, r in d[d["Identifier"].str.len() == 6].iterrows():
        skill = clean(r.get("Skill Level"))
        occ[r["Identifier"]] = {
            "title": clean(r["Principal Title"]),
            "alt": split_list(r.get("Alternative Title")),
            "spec": split_list(r.get("Specialisations")),
            "nec": split_list(r.get("Occupation in NEC category")),
            "lead": clean(r.get("Lead Statement")),
            "tasks": split_list(r.get("Main Tasks")),
            "skill": int(skill) if skill.isdigit() else None,
            "licensing": clean(r.get("Registration or Licensing")),
            "anzsco": [],
            "isco": [],
        }

    groups = {}
    g = with_header(DESCRIPTIONS, "Table 2")
    for _, r in g.iterrows():
        c = code(r["Identifier"])
        if c.isdigit():
            groups[c] = clean(r.get("Occupation Title"))

    # The title index adds titles the descriptions file doesn't list.
    idx = with_header(INDEX, "Table 2")
    for _, r in idx.iterrows():
        o = occ.get(code(r["Identifier"]))
        title, cat = clean(r.get("Description")), clean(r.get("Category")).lower()
        if not o or not title or title == o["title"]:
            continue
        key = "spec" if cat.startswith("special") else "nec" if "nec" in cat else "alt"
        if title not in o[key]:
            o[key].append(title)

    for a, b, t, p in correspondence("Table 6"):  # OSCA 2024 v1.0 -> ANZSCO 2022
        if a in occ:
            occ[a]["anzsco"].append({"code": b, "title": t, "partial": p})
    for a, b, t, p in correspondence("Table 8"):  # OSCA 2024 v1.0 -> ISCO-08
        if a in occ:
            occ[a]["isco"].append({"code": b, "title": t, "partial": p})

    payload = {
        "meta": {
            "source": "ABS, OSCA - Occupation Standard Classification for Australia, 2024, Version 1.0",
            "licence": "CC BY 4.0",
            "loaded": date.today().isoformat(),
            "occupations": len(occ),
            "tasks": sum(len(o["tasks"]) for o in occ.values()),
            "titles": sum(1 + len(o["alt"]) + len(o["spec"]) + len(o["nec"]) for o in occ.values()),
        },
        "groups": groups,
        "occupations": occ,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1))
    m = payload["meta"]
    linked = sum(1 for o in occ.values() if o["anzsco"]), sum(1 for o in occ.values() if o["isco"])
    print(f"{m['occupations']} occupations, {m['tasks']} tasks, {m['titles']} titles; "
          f"{linked[0]} linked to ANZSCO, {linked[1]} to ISCO-08 -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
