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
| Match | Each title is matched to ESCO job titles and their alternative names by shared words, weighted so rare words count more. Level and location words (Senior, APAC, NSW) are ignored. Matches that are weak, or too close to call, are flagged for a person to check. |
| Score | Each ESCO job carries two scores out of 10, averaged across its skills: how much of the work AI can do, and how much AI boosts the people doing it. The cut-off at 6 gives four types: Shrinking, Transforming, Augmented and Steady. |
| Narrate | Each job has an AI-written account of how it changes, a before-and-after working week, a timeline and the share of time AI could free up. |

## Limits to keep in mind in front of a client

- **The scores and stories are estimates from one AI model** (Google Gemini). Nobody measured these jobs. Use them to open a conversation about work design, not to make decisions about individual people.
- **The data describes the standard ESCO job**, not the client's version of it. A title match is only as good as the review step.
- **Office-heavy organisations cluster.** Most office jobs score high on "AI boosts people", so they land in Transforming or Augmented. The role map zooms in to show the differences inside a cluster.
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
