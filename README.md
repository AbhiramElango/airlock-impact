# Airlock Impact

**An AI agent fixed a bug and silently broke a file it never touched. Airlock Impact catches that with a dependency
graph, and guides the agent to a fix that's safe for everything that depends on the change.**

Runs fully on a laptop: a local model (Ollama), a local graph database (Neo4j), no cloud calls.

## The problem

Coding agents check the function they changed, usually by running that function's own test. On a real codebase, the
damage is elsewhere: a shared helper "fixed" for one caller breaks another caller in a different file.

```
receipt.totals ──► sales_tax ◄── invoice.invoice_total ◄── test_invoice   ✕  (file the agent never opened)
```

## What it does

```
request ─► local LLM proposes a patch
                │
                ▼
   apply in a sandbox ─► parse code into a graph (Neo4j) ─► changed symbols
                                                              │
                         walk dependents backwards ◄──────────┘   (blast radius, hops)
                                │
             run every test that reaches the change ─► verdict
                                │
     ┌──────────────────────────┼───────────────────────────┐
     ▼                          ▼                           ▼
 regression                 untested parts              validated
 lock shared code it        agent writes tests for
 broke; agent revises,      exactly the uncovered
 graph verifies each        dependents
 candidate
```

- **Code graph:** Python AST → `CALLS`, `READS`, `IMPORTS` edges; each edge records whether it was seen statically or at runtime.
- **Runtime evidence:** the test suite runs once under `coverage.py` with per-test contexts, recording which test executed which function.
- **Blast radius:** reverse traversal from the changed symbols (Cypher in Neo4j, BFS in memory), up to `--max-hops`.
- **Test selection:** tests found through the graph, tests observed covering the change, tests the patch adds, and tests that were failing before the patch (the reported bug).
- **Guardrail:** if changing a shared function breaks its other callers, that function and the broken callers are locked. The revision must fix the bug where it appeared. Up to six candidates are generated, and the graph verifies each one.
- **Honest verdicts:** `regression`, `unvalidated` (passes, but some affected function has no test), `validated`. Unresolved calls are reported, not hidden.

## Run it

Needs Python 3.12+, Docker, and [Ollama](https://ollama.com).

```bash
ollama pull qwen3.5:9b
docker compose up -d                     # Neo4j on :7474 / :7687 (neo4j / airlock-dev)
uv venv && uv pip install -e .
.venv/bin/impact serve                   # http://127.0.0.1:8090 (resets the demo repo)
```

Command line, no UI:

```bash
impact index demo/restaurant                       # build the graph
impact analyze demo/restaurant fix.diff --max-hops 8
```

See [DEMO.md](DEMO.md) for the two-minute walkthrough.

## Layout

```
impact/
  model.py, ports.py      language-neutral graph schema; interfaces (parser, store, runner, evidence, LLM)
  parsers/python_ast.py   Python adapter
  stores/                 Neo4j and in-memory graph stores (same interface, tested to agree)
  changes.py              diff → changed symbols
  coverage_map.py         runtime test → function evidence
  runner.py, workspace.py isolated pytest runs on scratch copies; the user's repo is never modified
  pipeline.py, report.py  orchestration (dependency injection) and the single result model
  agent/                  Ollama client (loopback only), fixer, test writer, SEARCH/REPLACE edits
  web/                    review UI: explorer, editor with inline diffs, graph, agent log
tests/                    unit + end-to-end tests on a fixture repo
demo/restaurant/          demo repo
```

New language: implement `LanguageParser`, `TestRunner` and `EvidenceProvider`; the graph core is unchanged.

## Limits

- Static analysis misses dynamic calls (`getattr`, dispatch tables); they are listed as unresolved.
- A 9B model is brittle at revisions; generate-and-verify makes it usable, not perfect.
- Tests written by the agent are shown in the diff for human review; the same model wrote the fix.
- The graph is rebuilt per patch; incremental indexing is the next step for large repos.
