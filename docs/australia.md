# Australian data layer

Goal: put Australian occupations and tasks at the centre of the app.

**Backbone: OSCA 2024 v1.0** (ABS), which replaces ANZSCO in official statistics
from September 2026. Each OSCA occupation brings its main tasks, skill level
(1-5), alternative titles and specialisations, plus official links to ANZSCO
and ISCO-08.

- ANZSCO is kept only as a bridge to data still coded to it: the Australian
  Skills Classification (task time shares, tools, competencies) and the JSA
  Gen AI exposure scores.
- ISCO-08 links OSCA to ESCO, which supplies the job stories and career moves.
  Most of these links are partial (1,059 of 1,158), so ESCO content is shown
  as "the nearest international job", not as the OSCA occupation itself.

## Sources

| Source | Role in the app | Licence | Status |
|---|---|---|---|
| ASC Release 3.0 (Dec 2023), Jobs and Skills Australia | Time shares, core competencies, technology tools per ANZSCO occupation | CC BY 4.0 | **Upload needed**: the JSA site's content network refuses cloud servers even with network access granted |
| ASC March 2021 beta (via the `strayr` R package) | Stand-in until 3.0 is loaded | CC BY 4.0 | Loaded: `data/au/asc.json` (600 occupations, 1,925 tasks) |
| JSA Gen AI Capacity Study (2025), occupation data | Official Australian exposure scores: the headline and a check on the task scores | Check terms on download | **Upload needed** (same reason) |
| OSCA 2024 v1.0, ABS | Backbone: 1,156 occupations, 6,887 tasks, 3,340 titles, skill levels | CC BY 4.0 | Loaded: `data/au/osca.json` (sources in `data/au/abs/`) |
| OSCA correspondence tables v2, ABS | OSCA to ANZSCO 2022 and to ISCO-08 | CC BY 4.0 | Loaded (in `osca.json`) |
| Task scores (this project) | AI impact per ASC task, 1-10 on the same scale as the ESCO skill scores | Project output | Script ready: `scripts/au/score_tasks.py` |

## Pipeline

```bash
pip install anthropic pandas openpyxl pyreadr

# 1. Load OSCA (from the ABS files in data/au/abs/)
python3 scripts/au/load_osca.py

# 1b. Load the ASC (3.0 workbook, or the strayr beta data folder)
python3 scripts/au/load_asc.py path/to/ASC_release_3.xlsx

# 2. Score every OSCA task for AI impact (needs ANTHROPIC_API_KEY; about US$10-20)
python3 scripts/au/score_tasks.py --source osca --dry-run      # plan and first request, no API calls
python3 scripts/au/score_tasks.py --source osca --sample 25    # spot-check 25 tasks before paying for all
python3 scripts/au/score_tasks.py --source osca --submit       # the rest, via the Batches API (half price)
python3 scripts/au/score_tasks.py --source osca --collect --wait
```

Decided: **OSCA tasks drive the work split**, weighted by ASC time shares where
an OSCA occupation links to the ASC through ANZSCO, and equally elsewhere
(flagged in the app).

Still to build:

2b. `scripts/au/weight_tasks.py` (after ASC 3.0 is uploaded): for each linked OSCA occupation, map the ASC time shares onto its OSCA tasks. Kept separate from scoring so new ASC data never forces a re-score.
3. `scripts/au/build_au_data.py`: join ASC tasks + task scores + JSA exposure + ANZSCO/OSCA codes + the ISCO link into the app's data files.
4. App changes: match titles through ESCO's alternative names to ANZSCO, headline the time-weighted work split, show JSA's official exposure alongside, list ASC tasks, tools and competencies on the role page.
5. Validation: compare the task-derived occupation scores with JSA's exposure scores. If they disagree badly, say so in the app rather than hide it.

## Setup needed

- **Network access:** done for `www.abs.gov.au` and `data.gov.au`. `www.jobsandskills.gov.au` passes our network rules but its own content network (Akamai) returns 403 to cloud servers, so its files must be uploaded.
- **API key:** add `ANTHROPIC_API_KEY` as an environment variable (for step 2), then start a new session.

## Things to know

- The ASC mixes 4-digit and 6-digit ANZSCO codes. The join has to handle both.
- The ASC 2021 beta reaches 731 of the 1,156 OSCA occupations through ANZSCO. Release 3.0 should reach more.
- OSCA is finer-grained than ANZSCO in places. For example, ANZSCO's single payroll code becomes Payroll Manager (skill level 2) and Payroll Officer (skill level 4) in OSCA. Data carried over from ANZSCO applies to both.
- Task scores come from one model (Claude), just as the ESCO scores come from one model (Gemini). JSA's exposure data is the independent check.
