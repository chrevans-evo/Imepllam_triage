"""Score Australian work tasks for AI impact.

Sources:
  osca  every OSCA 2024 main task (data/au/osca.json), scored with its
        occupation for context. This is the app's primary task set.
  asc   every distinct Australian Skills Classification specialist task
        (data/au/asc.json).

Each task gets two 1-10 scores on the same scale the app already uses for
ESCO skills, so the Australian and European numbers stay comparable:
  automation     how much of the task AI can do end to end
  amplification  how much AI makes a person doing it faster or better
plus a physical flag and a one-line reason.

Runs through the Message Batches API (half price, results within 24 hours).
Resumable: tasks already in data/au/task_scores_<source>.json are skipped, and
a submitted batch is recorded in data/au/score_batch_<source>.json (with each
task's key) so results can be collected later, even if the inputs change.

Needs ANTHROPIC_API_KEY (or an `ant auth login` profile).

Usage:
  python3 scripts/au/score_tasks.py --source osca --dry-run     # plan and one request, no API calls
  python3 scripts/au/score_tasks.py --source osca --sample 25   # score 25 tasks now, to spot-check
  python3 scripts/au/score_tasks.py --source osca --submit      # submit the rest as one batch
  python3 scripts/au/score_tasks.py --source osca --collect --wait
"""
import argparse
import json
import sys
import time
from pathlib import Path

import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data/au"

MODEL = "claude-opus-5"
TASKS_PER_REQUEST = 25
RUBRIC_VERSION = "au-task-v1"

# Fixed system prompt: identical on every request so it caches.
SYSTEM = """You score work tasks done in Australian occupations for the likely impact of AI on them over the next three to five years.

Score each task on two questions, from 1 to 10. Judge AI as it is commercially available and in use in Australian workplaces, plus capabilities that are demonstrated and likely to be deployed within five years. Do not score on speculative future capability. When an occupation is given in brackets, score the task as that occupation does it.

automation: How much of this task can AI (including AI agents working inside business software) carry out end to end, with a person only checking the result?
  1-2  AI cannot do it. Needs physical presence, touch, or a human relationship at its core.
  3-4  AI does small parts (drafting, lookups); a person does the task.
  5-6  AI does about half; a person does the judgement, contact or physical steps.
  7-8  AI does most of it; a person reviews, handles exceptions and signs off.
  9-10 AI does it fully; human review is optional.

amplification: For the part a person still does, how much does AI make them faster or better?
  1-2  No real help.
  3-4  Minor help (search, spelling, reminders).
  5-6  Meaningful help; work is noticeably faster.
  7-8  Major help; output per person rises by several times.
  9-10 Transformative; a person can do work that was not possible before.

The two questions are independent. A task can score high on both (AI does most of it, and the person who oversees it gets far more done) or low on both.

physical: true if the task mainly needs a person to be physically present to handle objects, equipment, places or people's bodies.

reason: one plain sentence, 25 words at most, naming the main driver of the scores.

Calibration examples:
  "Record data in databases or information systems"  automation 9, amplification 6, physical false
  "Prepare financial reports"  automation 8, amplification 8, physical false
  "Interview witnesses, suspects or claimants"  automation 3, amplification 6, physical false
  "Negotiate contracts or agreements"  automation 3, amplification 7, physical false
  "Operate forklifts or other materials handling equipment"  automation 4, amplification 2, physical true
  "Provide personal care to patients or clients"  automation 1, amplification 3, physical true

Return one entry per task, using the task's id exactly as given. Score every task."""

SCHEMA = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "automation": {"type": "integer"},
                    "amplification": {"type": "integer"},
                    "physical": {"type": "boolean"},
                    "reason": {"type": "string"},
                },
                "required": ["id", "automation", "amplification", "physical", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["scores"],
    "additionalProperties": False,
}


def paths(source):
    return DATA / f"task_scores_{source}.json", DATA / f"score_batch_{source}.json"


def load_items(source) -> list[dict]:
    """Every task to score, as {key, text, occ}, in a stable order."""
    if source == "osca":
        occ = json.loads((DATA / "osca.json").read_text())["occupations"]
        return [{"key": f"{c}.{i}", "text": t, "occ": o["title"]}
                for c, o in sorted(occ.items()) for i, t in enumerate(o["tasks"])]
    tasks = json.loads((DATA / "asc.json").read_text())["tasks"]
    return [{"key": t, "text": t, "occ": None} for t in tasks]


def load_state(source):
    scores_path, _ = paths(source)
    items = load_items(source)
    scores = json.loads(scores_path.read_text()) if scores_path.exists() else {"meta": {}, "tasks": {}}
    todo = [it for it in items if it["key"] not in scores["tasks"]]
    return items, scores, todo


def chunks(items, n=TASKS_PER_REQUEST):
    for i in range(0, len(items), n):
        yield items[i:i + n]


def params_for(part):
    """One request; ids are local to the request (0..n-1)."""
    listing = "\n".join(f"{n}: [{it['occ']}] {it['text']}" if it["occ"] else f"{n}: {it['text']}"
                        for n, it in enumerate(part))
    return {
        "model": MODEL,
        "max_tokens": 16000,
        "system": [{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
        "thinking": {"type": "adaptive"},
        "output_config": {"format": {"type": "json_schema", "schema": SCHEMA}},
        "messages": [{"role": "user", "content": f"Score these {len(part)} tasks.\n\n{listing}"}],
    }


def absorb(keys: list[str], scores, message) -> list[str]:
    """Store valid scores from one response; return the keys still missing.
    `keys[n]` is the task key sent as local id n."""
    if message.stop_reason == "refusal":
        return list(keys)
    text = next((b.text for b in message.content if b.type == "text"), "")
    try:
        rows = json.loads(text)["scores"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return list(keys)
    missing = set(range(len(keys)))
    for r in rows:
        n = r.get("id")
        if n not in missing:
            continue
        a, m = r.get("automation"), r.get("amplification")
        if not (isinstance(a, int) and isinstance(m, int) and 1 <= a <= 10 and 1 <= m <= 10):
            continue
        scores["tasks"][keys[n]] = {"a": a, "m": m, "phys": bool(r.get("physical")), "r": str(r.get("reason", ""))[:300]}
        missing.discard(n)
    return [keys[n] for n in sorted(missing)]


def save(source, scores):
    scores_path, _ = paths(source)
    scores["meta"] = {"source": source, "model": MODEL, "rubric": RUBRIC_VERSION, "scored": len(scores["tasks"])}
    scores_path.parent.mkdir(parents=True, exist_ok=True)
    scores_path.write_text(json.dumps(scores, ensure_ascii=False, indent=1, sort_keys=True))


def dry_run(source):
    items, scores, todo = load_state(source)
    reqs = list(chunks(todo))
    print(f"{source}: {len(items)} tasks, {len(scores['tasks'])} already scored, {len(todo)} to score "
          f"in {len(reqs)} requests of up to {TASKS_PER_REQUEST}.")
    if reqs:
        p = params_for(reqs[0])
        shown = {**p, "system": SYSTEM[:160] + "…", "output_config": "json_schema (scores[])"}
        print("\nFirst request (system prompt shortened):")
        print(json.dumps(shown, indent=1, ensure_ascii=False)[:2500])


def sample(source, n):
    _, scores, todo = load_state(source)
    client = anthropic.Anthropic()
    part_all = todo[:n]
    missing = []
    for part in chunks(part_all):
        msg = client.messages.create(**params_for(part))
        missing += absorb([it["key"] for it in part], scores, msg)
    save(source, scores)
    print(f"Scored {len(part_all) - len(missing)} of {len(part_all)} tasks.")
    for it in part_all:
        s = scores["tasks"].get(it["key"])
        if s:
            occ = f"[{it['occ']}] " if it["occ"] else ""
            print(f"  a{s['a']:>2} m{s['m']:>2} {'P' if s['phys'] else ' '}  {occ}{it['text']}  ({s['r']})")
    if missing:
        print(f"Not scored (re-run to retry): {len(missing)}")


def submit(source):
    _, batch_path = paths(source)
    if batch_path.exists():
        sys.exit(f"A batch is already recorded in {batch_path.relative_to(ROOT)}. Run --collect first.")
    _, _, todo = load_state(source)
    if not todo:
        print("Every task is already scored.")
        return
    parts = list(chunks(todo))
    groups = {f"t{k:04d}": [it["key"] for it in part] for k, part in enumerate(parts)}
    client = anthropic.Anthropic()
    batch = client.messages.batches.create(requests=[
        Request(custom_id=cid, params=MessageCreateParamsNonStreaming(**params_for(part)))
        for cid, part in zip(groups, parts)
    ])
    batch_path.write_text(json.dumps({"id": batch.id, "groups": groups}, indent=1))
    print(f"Submitted batch {batch.id}: {len(groups)} requests, {len(todo)} tasks. Run --collect later.")


def collect(source, wait: bool):
    _, batch_path = paths(source)
    if not batch_path.exists():
        sys.exit("No submitted batch recorded. Run --submit first.")
    rec = json.loads(batch_path.read_text())
    client = anthropic.Anthropic()
    while True:
        b = client.messages.batches.retrieve(rec["id"])
        if b.processing_status == "ended":
            break
        if not wait:
            print(f"Batch {rec['id']} is {b.processing_status} ({b.request_counts.processing} still processing).")
            return
        time.sleep(60)
    _, scores, _ = load_state(source)
    retry = []
    for res in client.messages.batches.results(rec["id"]):
        keys = rec["groups"].get(res.custom_id, [])
        retry += absorb(keys, scores, res.result.message) if res.result.type == "succeeded" else keys
    save(source, scores)
    batch_path.unlink()
    print(f"Collected. {len(scores['tasks'])} tasks scored in total; {len(retry)} missed. "
          + ("Run --submit again to score the rest." if retry else "All done."))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", choices=["osca", "asc"], default="osca")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--sample", type=int, metavar="N")
    g.add_argument("--submit", action="store_true")
    g.add_argument("--collect", action="store_true")
    ap.add_argument("--wait", action="store_true", help="with --collect, poll until the batch ends")
    a = ap.parse_args()
    if a.dry_run:
        dry_run(a.source)
    elif a.sample:
        sample(a.source, a.sample)
    elif a.submit:
        submit(a.source)
    else:
        collect(a.source, a.wait)
