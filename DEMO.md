# Demo script (2 minutes)

**One line:** *An AI agent fixed a bug and silently broke a file it never touched. Airlock Impact catches that with a
dependency graph, and guides the agent to the right fix.*

## Before you start
```bash
docker start airlock-neo4j
cd ~/Projects/airlock-impact && pkill -f "impact serve"; .venv/bin/impact serve
```
Open http://127.0.0.1:8090. Keep the default request text. Don't type numbers in it.

## Flow

| # | Click | Say |
|---|---|---|
| 1 | **▶ receipt.py** → `$38.48` | "A restaurant app. The receipt total is wrong." |
| 2 | **▶ invoice.py** → `$113.00` | "Catering invoices are correct. Remember this number." |
| 3 | **Ask agent** | "A 9B model, on this laptop, offline." |
| 4 | *(graph animates)* | "It changed the shared `sales_tax()` helper. Watch the dependency graph walk outward from the change." |
| 5 | **▶ receipt.py** → `$19.98` | "The receipt looks fixed. Most agents stop here." |
| 6 | **▶ invoice.py** → `$13.00` | "But invoices are now wrong, in a file the agent never touched. The card says it: typical agent checks 1 test; the graph checked 3 dependents and 4 tests." |
| 7 | **Fix it using this evidence** | "The graph locks code that other callers depend on. The agent proposes candidates; the graph verifies each one." |
| 8 | *(card ⚠)* → **Write tests for receipt()** | "No regressions now, but one affected function has no test. The graph tells the agent exactly what to test." |
| 9 | *(card ✅)* **▶ receipt.py** `$19.98`, **▶ invoice.py** `$113.00` | "Both correct, and every affected function is verified." |

If step 7 shows an error, click **Fix it using this evidence** again.

## Likely questions
- **How does it find dependents?** Python AST → code graph in Neo4j (CALLS / READS edges) → reverse traversal from the
  changed function, plus runtime coverage of which test ran which function.
- **Other languages?** Ports and adapters: add a parser + test runner for the language; the graph core is unchanged.
- **Why lock code?** If changing a shared function breaks its other callers, those callers were right. The fix belongs
  where the bug showed up. The graph decides that, not the LLM.
- **Limits?** Static analysis misses dynamic calls (reported as "unresolved"); a 9B model is brittle, so we generate
  several candidates and let the graph verify them. AI-written tests are shown in the diff for human review.
