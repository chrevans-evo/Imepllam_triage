"""Score every Australian Skills Classification specialist task for AI impact.

Each task gets two 1-10 scores on the same scale the app already uses for
ESCO skills, so the Australian and European numbers stay comparable:
  automation     how much of the task AI can do end to end
  amplification  how much AI makes a person doing it faster or better
plus a physical flag and a one-line reason.

Runs through the Message Batches API (half price, results within 24 hours).
Resumable: tasks already in data/au/task_scores.json are skipped, and a
submitted batch is recorded in data/au/score_batch.json so it can be
collected later.

Needs ANTHROPIC_API_KEY (or an `ant auth login` profile).

Usage:
  python3 scripts/au/score_tasks.py --dry-run     # show the plan and one request, no API calls
  python3 scripts/au/score_tasks.py --sample 25   # score 25 tasks now, synchronously, to spot-check
  python3 scripts/au/score_tasks.py --submit      # submit the rest as one batch
  python3 scripts/au/score_tasks.py --collect     # fetch results of the submitted batch
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
ASC = ROOT / "data/au/asc.json"
SCORES = ROOT / "data/au/task_scores.json"
BATCH = ROOT / "data/au/score_batch.json"

MODEL = "claude-opus-5"
TASKS_PER_REQUEST = 25
RUBRIC_VERSION = "au-task-v1"

# Fixed system prompt: identical on every request so it caches.
SYSTEM = """You score work tasks from the Australian Skills Classification for the likely impact of AI on them over the next three to five years.

Score each task on two questions, from 1 to 10. Judge AI as it is commercially available and in use in Australian workplaces, plus capabilities that are demonstrated and likely to be deployed within five years. Do not score on speculative future capability.

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


def load_state():
    asc = json.loads(ASC.read_text())
    tasks = asc["tasks"]
    scores = json.loads(SCORES.read_text()) if SCORES.exists() else {"meta": {}, "tasks": {}}
    todo = [i for i, t in enumerate(tasks) if t not in scores["tasks"]]
    return tasks, scores, todo


def chunks(ids, n=TASKS_PER_REQUEST):
    for i in range(0, len(ids), n):
        yield ids[i:i + n]


def params_for(tasks, ids):
    listing = "\n".join(f"{i}: {tasks[i]}" for i in ids)
    return {
        "model": MODEL,
        "max_tokens": 16000,
        "system": [{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
        "thinking": {"type": "adaptive"},
        "output_config": {"format": {"type": "json_schema", "schema": SCHEMA}},
        "messages": [{"role": "user", "content": f"Score these {len(ids)} tasks.\n\n{listing}"}],
    }


def absorb(names: dict[int, str], scores, message) -> list[int]:
    """Store valid scores from one response; return the ids still missing.
    `names` maps each id sent in the request to its task text."""
    ids = sorted(names)
    if message.stop_reason == "refusal":
        return ids
    text = next((b.text for b in message.content if b.type == "text"), "")
    try:
        rows = json.loads(text)["scores"]
    except (json.JSONDecodeError, KeyError):
        return ids
    wanted = set(ids)
    for r in rows:
        i = r.get("id")
        if i not in wanted:
            continue
        a, m = r.get("automation"), r.get("amplification")
        if not (isinstance(a, int) and isinstance(m, int) and 1 <= a <= 10 and 1 <= m <= 10):
            continue
        scores["tasks"][names[i]] = {"a": a, "m": m, "phys": bool(r.get("physical")), "r": str(r.get("reason", ""))[:300]}
        wanted.discard(i)
    return sorted(wanted)


def save(scores):
    scores["meta"] = {"model": MODEL, "rubric": RUBRIC_VERSION, "scored": len(scores["tasks"])}
    SCORES.parent.mkdir(parents=True, exist_ok=True)
    SCORES.write_text(json.dumps(scores, ensure_ascii=False, indent=1, sort_keys=True))


def dry_run():
    tasks, scores, todo = load_state()
    reqs = list(chunks(todo))
    print(f"{len(tasks)} tasks, {len(scores['tasks'])} already scored, {len(todo)} to score "
          f"in {len(reqs)} requests of up to {TASKS_PER_REQUEST}.")
    if reqs:
        p = params_for(tasks, reqs[0])
        print("\nFirst request (system prompt shortened):")
        shown = {**p, "system": SYSTEM[:160] + "…", "output_config": "json_schema (scores[])"}
        print(json.dumps(shown, indent=1, ensure_ascii=False)[:2500])


def sample(n):
    tasks, scores, todo = load_state()
    client = anthropic.Anthropic()
    ids = todo[:n]
    missing = []
    for part in chunks(ids):
        msg = client.messages.create(**params_for(tasks, part))
        missing += absorb({i: tasks[i] for i in part}, scores, msg)
    save(scores)
    print(f"Scored {len(ids) - len(missing)} of {len(ids)} tasks.")
    for i in ids:
        s = scores["tasks"].get(tasks[i])
        if s:
            print(f"  a{s['a']:>2} m{s['m']:>2} {'P' if s['phys'] else ' '}  {tasks[i]}  ({s['r']})")
    if missing:
        print(f"Not scored (re-run to retry): {len(missing)}")


def submit():
    if BATCH.exists():
        sys.exit(f"A batch is already recorded in {BATCH.relative_to(ROOT)}. Run --collect first.")
    tasks, scores, todo = load_state()
    if not todo:
        print("Every task is already scored.")
        return
    # Keep each id's task text with the batch, so results still attach to the
    # right task if data/au/asc.json is rebuilt before they are collected.
    groups = {f"t{k:04d}": {str(i): tasks[i] for i in part} for k, part in enumerate(chunks(todo))}
    client = anthropic.Anthropic()
    batch = client.messages.batches.create(requests=[
        Request(custom_id=cid, params=MessageCreateParamsNonStreaming(**params_for(tasks, [int(i) for i in g])))
        for cid, g in groups.items()
    ])
    BATCH.write_text(json.dumps({"id": batch.id, "groups": groups}, indent=1))
    print(f"Submitted batch {batch.id}: {len(groups)} requests, {len(todo)} tasks. Run --collect later.")


def collect(wait: bool):
    if not BATCH.exists():
        sys.exit("No submitted batch recorded. Run --submit first.")
    rec = json.loads(BATCH.read_text())
    client = anthropic.Anthropic()
    while True:
        b = client.messages.batches.retrieve(rec["id"])
        if b.processing_status == "ended":
            break
        if not wait:
            print(f"Batch {rec['id']} is {b.processing_status} ({b.request_counts.processing} still processing).")
            return
        time.sleep(60)
    _, scores, _ = load_state()
    retry = []
    for res in client.messages.batches.results(rec["id"]):
        names = {int(i): t for i, t in rec["groups"].get(res.custom_id, {}).items()}
        if res.result.type == "succeeded":
            retry += absorb(names, scores, res.result.message)
        else:
            retry += sorted(names)
    save(scores)
    BATCH.unlink()
    print(f"Collected. {len(scores['tasks'])} tasks scored in total; {len(retry)} missed. "
          + ("Run --submit again to score the rest." if retry else "All done."))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--sample", type=int, metavar="N")
    g.add_argument("--submit", action="store_true")
    g.add_argument("--collect", action="store_true")
    ap.add_argument("--wait", action="store_true", help="with --collect, poll until the batch ends")
    a = ap.parse_args()
    if a.dry_run:
        dry_run()
    elif a.sample:
        sample(a.sample)
    elif a.submit:
        submit()
    else:
        collect(a.wait)
