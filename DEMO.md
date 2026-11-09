# Demo walkthrough

A two-minute run of the demo repo (`demo/restaurant`): an agent fixes a receipt bug, silently breaks invoicing in
another file, and the dependency graph catches it and guides the agent to a safe fix.

## Start
```bash
docker compose up -d
.venv/bin/impact serve        # http://127.0.0.1:8090, resets the demo repo on start
```
Use the default request text. With a 9B model, plain-language requests work best (numbers in the request tend to
send it down arithmetic dead ends).

## Steps

| # | Do | You'll see | Why it matters |
|---|---|---|---|
| 1 | **Run ▸ receipt.py** | `Total $38.48` | The bug: food is counted twice. |
| 2 | **Run ▸ invoice.py** | `Invoice total $113.00` | Invoicing is correct today. |
| 3 | **Ask agent** | The agent edits `sales_tax()` in `tax.py`; the graph walks outward from the change | A plausible fix to a misleadingly named shared helper. |
| 4 | **Run ▸ receipt.py** | `$19.98` | The receipt looks fixed; most agents would stop here. |
| 5 | **Run ▸ invoice.py** | `$13.00` | Invoicing broke, in a file the agent never touched. The card shows it: the agent's own test passes, the graph checked 3 dependents and 4 tests. |
| 6 | **Fix it using this evidence** | `Locked tax.sales_tax, invoice.invoice_total…`; the agent fixes `receipt.py` instead | Shared code its other callers depend on is locked. The model proposes candidates; the graph verifies each one. |
| 7 | **Write tests for receipt()** | New tests in `test_receipt.py`; the card turns *Validated* | The graph names the affected function no test covered. |
| 8 | **Run** both | `$19.98` and `$113.00` | Both correct, with every affected function covered by a passing test. |

If step 6 ends red, run it again: locks persist, and the next round generates fresh candidates.

## What to look at
- **▶ replay** on any card replays the traversal hop by hop.
- Click a graph node to jump to that function; click a card to view that attempt.
- **Tests** tab: why each test was selected (graph path, runtime coverage, added by the patch, or failing before it).
- **Report** tab: the full blast radius and any calls the parser could not resolve.
- **Neo4j ↗**: the raw graph (`neo4j` / `airlock-dev`), e.g. `MATCH p=(n:Code {repo:'restaurant'})-->() RETURN p`.

## Questions people ask
- **How are dependents found?** Python AST → `CALLS`/`READS` edges in Neo4j → reverse traversal from the changed
  symbols, combined with runtime coverage of which test executed which function.
- **Other languages?** Implement a `LanguageParser`, `TestRunner` and `EvidenceProvider`; the graph core is unchanged.
- **Why lock code?** If changing a shared function breaks its other callers, those callers were correct. The fix
  belongs where the bug appeared, and the graph enforces that rather than the model.
- **Limits?** Dynamic calls are reported as unresolved; a 9B model needs generate-and-verify to be dependable; tests
  the agent writes are shown in the diff for human review.
