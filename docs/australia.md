# Australian data layer

Goal: put Australian occupations and tasks at the centre of the app. Roles map to
ANZSCO (and the new OSCA codes). The Australian Skills Classification (ASC)
supplies each occupation's tasks **and the share of working time spent on each**,
so the work split becomes "share of working time", not "share of skills".
ESCO stays for title matching, the job stories and career moves.

## Sources

| Source | Role in the app | Licence | Status |
|---|---|---|---|
| ASC Release 3.0 (Dec 2023), Jobs and Skills Australia | Tasks, time shares, core competencies, technology tools per ANZSCO occupation | CC BY 4.0 | Needs network access to `www.jobsandskills.gov.au` |
| ASC March 2021 beta (via the `strayr` R package) | Stand-in until 3.0 is loaded | CC BY 4.0 | Loaded: `data/au/asc.json` (600 occupations, 1,925 tasks) |
| JSA Gen AI Capacity Study (2025), occupation data | Official Australian exposure scores: the headline and a check on the task scores | Check terms on download | Needs network access |
| ANZSCO 2022 and OSCA 2024, ABS | Titles, codes and the ANZSCO-to-OSCA link | ABS terms (generally CC BY) | ANZSCO 2022 and OSCA 2024 tables are in `strayr`; the correspondence needs `www.abs.gov.au` |
| ANZSCO to ISCO-08 correspondence, ABS | Links Australian occupations to ESCO (stories, career moves, title matching) | ABS terms | Needs `www.abs.gov.au` |
| Task scores (this project) | AI impact per ASC task, 1-10 on the same scale as the ESCO skill scores | Project output | Script ready: `scripts/au/score_tasks.py` |

## Pipeline

```bash
pip install anthropic pandas openpyxl pyreadr

# 1. Load the ASC (3.0 workbook, or the strayr beta data folder)
python3 scripts/au/load_asc.py path/to/ASC_release_3.xlsx

# 2. Score every task for AI impact (needs ANTHROPIC_API_KEY)
python3 scripts/au/score_tasks.py --dry-run      # plan and first request, no API calls
python3 scripts/au/score_tasks.py --sample 25    # spot-check 25 tasks before paying for all
python3 scripts/au/score_tasks.py --submit       # the rest, via the Batches API (half price)
python3 scripts/au/score_tasks.py --collect --wait
```

Still to build, once the blocked sources are downloaded:

3. `scripts/au/build_au_data.py`: join ASC tasks + task scores + JSA exposure + ANZSCO/OSCA codes + the ISCO link into the app's data files.
4. App changes: match titles through ESCO's alternative names to ANZSCO, headline the time-weighted work split, show JSA's official exposure alongside, list ASC tasks, tools and competencies on the role page.
5. Validation: compare the task-derived occupation scores with JSA's exposure scores. If they disagree badly, say so in the app rather than hide it.

## Setup needed (environment settings, then a new session)

- **Network access:** add `www.jobsandskills.gov.au`, `www.abs.gov.au` and `data.gov.au` to the environment's allowed domains.
- **API key:** add `ANTHROPIC_API_KEY` as an environment variable (for step 2).

## Things to know

- The ASC mixes 4-digit and 6-digit ANZSCO codes. The join has to handle both.
- ANZSCO is being retired: OSCA is used in official statistics from September 2026. The ASC and JSA data are still coded to ANZSCO, so ANZSCO is the join key and each role also carries its OSCA code.
- Task scores come from one model (Claude), just as the ESCO scores come from one model (Gemini). JSA's exposure data is the independent check.
