# Future of Work Lens

Show a CPO how every role in their organisation is likely to change with AI.

Load a job list (title, headcount, department). The app matches each title to one of 3,039 standard jobs in the EU's ESCO catalogue, and then shows:

- **Organisation view.** Headcount by future type, a role map, a department breakdown, timelines and the time AI could free up.
- **Role deep dive.** A working week today and in future, what AI takes over, what it makes people better at, the skills behind the score, the capability to build, and nearby jobs people could move into.

Everything runs in the browser. A client's job list is never sent to a server.

## Run it

```bash
python3 -m http.server 8000 --directory app
# open http://localhost:8000
```

It opens on a fictional sample insurer. Use **1 · Load roles** to paste rows from Excel or drop in a CSV.

## How it works

| Step | What happens |
|---|---|
| Match | Each title is matched to ESCO job titles and their alternative names by shared words. Rare words count more. Level and location words (Senior, APAC, NSW) are ignored. Near-synonyms ("consultant" and "agent", "retail" and "shop") earn half credit. Words that recur across the organisation (such as "insurance") break ties. Weak or too-close-to-call matches are flagged for a person to check. Corrections are remembered in the browser. A hybrid role can be a blend of two jobs. |
| Work split | Every skill in a job is scored 1–10 on two questions. A skill is **AI can take over** if it scores 7+ on doing the work, **AI assists** if it scores below 7 there but 7+ on boosting people, and **stays human** otherwise. Core skills count twice. This is the headline measure. |
| Types | The job's average scores, cut at 6, give four types: Shrinking, Transforming, Augmented and Steady. A job within 0.5 of a cut is marked borderline. Types are a secondary tag. |
| Capacity | Time freed = headcount × the model's time-saved estimate × the adoption you set, phased in over the job's timeline. It is time, not jobs. |
| Internal moves | For roles where AI can take over 40%+ of the work, the app finds roles in the same organisation that are at least 15 points less exposed and share core skills. Moves into supervisor or manager jobs are marked "Step up" and ranked lower. |

## How good is the matching?

`tests/match_benchmark.json` holds 87 realistic Australian titles, each with the ESCO jobs a person would accept.

```bash
node tests/match_benchmark.mjs --verbose
```

| Version | Right first time | Right in top three |
|---|---|---|
| First version | 74% | 90% |
| Current | 83% | 95% |

A department hint was tried and made matching worse at every weight, so it is not used. Most remaining misses come from ESCO itself; for example, ESCO lists "maintenance technician" as another name for welder.

## Limits to keep in mind in front of a client

- **The scores and stories are estimates from one AI model** (Google Gemini). Nobody measured these jobs. Use them to open a conversation about work design, not to make decisions about individual people.
- **The headline depends on a cut-off.** For the sample insurer, "AI can take over" is 56% at a skill score of 7, 35% at 8 and 71% at 6. The app shows this range next to the number.
- **The data describes the standard ESCO job**, not the client's version of it. A title match is only as good as the review step.
- **Office-heavy organisations cluster** in the Transforming and Augmented types, which is why the work split is the headline.
- **Internal moves are thin when everything is exposed.** In the sample insurer most exposed roles have no less-exposed role nearby. That is a finding, not a bug.
- **ESCO is a European catalogue.** It has no Australian headcount or pay data.

## Data and licences

Data comes from [AI-ISCO](https://github.com/Jorisdevreede/AI-ISCO) by Joris de Vreede. This app uses only its openly licensed parts:

- The Gemini scores and narratives are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit is shown in the app footer.
- The newer TypeSafe ("v2") scores are **not used**. They are not under the CC BY grant.
- This publication uses the ESCO classification of the European Commission. The scores, types and narratives are AI-generated additions to ESCO v1.2.1 and are not part of ESCO. ISCO-08 © International Labour Organization.

To rebuild the data files from a fresh clone of AI-ISCO:

```bash
git clone --depth 1 https://github.com/Jorisdevreede/AI-ISCO.git /tmp/AI-ISCO
python3 scripts/build_data.py /tmp/AI-ISCO
```

## Branding

Vertage has not yet issued colours or typefaces. All brand styling sits in the `BRAND LAYER` block at the top of `app/styles.css`, and the brand name is in `BRAND` at the top of `app/app.js`. Swap those two blocks to re-skin the app.

## Files

| Path | What it is |
|---|---|
| `app/index.html`, `app/styles.css`, `app/app.js` | The app |
| `app/matcher.js` | Job title matching |
| `app/sample.js` | The fictional sample organisation |
| `app/data/jobs_index.json` | Small index loaded first (titles, scores, types) |
| `app/data/jobs_detail.json` | Full job detail, loaded in the background |
| `scripts/build_data.py` | Builds both data files from AI-ISCO |
