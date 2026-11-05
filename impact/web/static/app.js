"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SOURCE = { agent: "agent fix", revision: "agent revision", tests: "agent adds tests" };
const runs = [];
const VERDICT = {
  regression: "Regression",
  unvalidated: "Passes, but parts are untested",
  validated: "Validated",
};
const CHIP = { regression: "Regression", unvalidated: "Untested parts", validated: "Validated" };
const FAILED = (s) => s === "failed" || s === "error";

let state = null;
let files = [];
let selected = -1;
const cache = {};
let tabs = [];
let active = null;
let panelTab = "graph";
let cy = null;
let polling = false;
let seenAttempts = 0;
let animateNext = false;
let rippleTimers = [];

// ---------- data ----------
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 5000);
}

async function act(action, body = {}) {
  try {
    state = await api(`/api/${action}`, body);
    if (action === "reset") Object.keys(cache).forEach((k) => delete cache[k]);
    if (action === "reset") { tabs = []; active = null; seenAttempts = 0; selected = -1; }
    onState();
    if (state.busy) poll();
  } catch (e) { toast(e.message); }
}

async function poll() {
  if (polling) return;
  polling = true;
  while (true) {
    await new Promise((r) => setTimeout(r, 350));
    try { state = await api("/api/state"); } catch (e) { toast(e.message); break; }
    onState();
    if (!state.busy) break;
  }
  polling = false;
  if (state.error) toast(state.error);
}

function onState() {
  if (state.attempts.length !== seenAttempts) {
    seenAttempts = state.attempts.length;
    selected = seenAttempts - 1;
    if (selected >= 0) { autoOpen(); panelTab = "graph"; animateNext = true; }
  }
  render();
}

// ---------- report helpers ----------
function view() {
  const a = state.attempts[selected];
  if (!a) return null;
  const r = a.report;
  return {
    a, r,
    nodes: Object.fromEntries(r.graph.nodes.map((n) => [n.id, n])),
    tests: Object.fromEntries(r.tests.map((t) => [t.id, t])),
    changed: new Set(r.changed.map((c) => c.id)),
    impacted: Object.fromEntries(r.impacted.map((i) => [i.id, i])),
    gaps: new Set(r.gaps),
    hunks: parseDiff(a.diff),
  };
}

function parseDiff(diff) {
  const out = {};
  let file = null;
  let hunk = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) { file = line.slice(4).replace(/^b\//, ""); out[file] = []; continue; }
    if (line.startsWith("--- ")) continue;
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (m && file) { hunk = { oldStart: +m[1], lines: [] }; out[file].push(hunk); continue; }
    if (hunk && /^[ +-]/.test(line)) hunk.lines.push({ t: line[0], text: line.slice(1) });
  }
  return out;
}

function fileStatus(v, file) {
  if (!v) return {};
  const inFile = Object.values(v.nodes).filter((n) => n.file === file);
  const tests = inFile.map((n) => v.tests[n.id]).filter(Boolean);
  return {
    changed: file in v.hunks,
    impacted: inFile.some((n) => n.id in v.impacted),
    fail: tests.some((t) => FAILED(t.status)),
    pass: tests.length > 0 && tests.every((t) => t.status === "passed"),
  };
}

function autoOpen() {
  const v = view();
  const changedFiles = Object.keys(v.hunks);
  const failing = v.r.tests.filter((t) => FAILED(t.status)).map((t) => v.nodes[t.id]?.file).filter(Boolean);
  [...changedFiles, ...failing].forEach((f) => { if (!tabs.includes(f)) tabs.push(f); });
  failing.forEach((f) => { if (!(f in cache)) api(`/api/file?path=${encodeURIComponent(f)}`).then((d) => { cache[f] = d.text; }); });
  if (changedFiles.length) openFile(changedFiles[0], v.r.changed[0]?.line);
}

// ---------- render ----------
function render() {
  $("crumb-repo").textContent = state.repo;
  $("tree-root").textContent = state.repo;
  $("pill-model").textContent = state.model;
  $("pill-store").textContent = `graph: ${state.store}`;
  $("btn-reset").classList.toggle("hidden", !state.can_reset);
  $("run-cmd").textContent = state.run_cmd.replace(/^\S*python\S*/, "python");
  $("btn-ask").disabled = state.busy;
  const v = view();
  renderTree(v);
  renderTabs(v);
  renderEditor(v);
  renderChat();
  renderPanel(v);
}

function badgesFor(s, compact) {
  return [s.changed && `<span class="badge b-changed">M</span>`,
    s.impacted && !s.changed && `<span class="badge b-impacted">◐</span>`,
    s.fail && `<span class="badge b-fail">✕</span>`,
    !compact && s.pass && `<span class="badge b-pass">✓</span>`].filter(Boolean).join("");
}

function renderTree(v) {
  $("tree").innerHTML = files.map((f) => {
    const badges = badgesFor(fileStatus(v, f));
    return `<div class="file ${f === active ? "active" : ""} ${v && !badges ? "dim" : ""}" data-f="${esc(f)}">
      <span class="name">${esc(f)}</span>${badges}</div>`;
  }).join("");
  document.querySelectorAll(".file").forEach((el) => el.addEventListener("click", () => openFile(el.dataset.f)));
}

function renderTabs(v) {
  $("editor-tabs").innerHTML = tabs.map((f) => `<div class="tab ${f === active ? "active" : ""}" data-f="${esc(f)}">
      ${esc(f)} ${badgesFor(fileStatus(v, f), true)}<span class="x" data-x="${esc(f)}">×</span></div>`).join("");
  document.querySelectorAll(".tab").forEach((el) => el.addEventListener("click", (e) => {
    const closing = e.target.dataset.x;
    if (closing) {
      tabs = tabs.filter((t) => t !== closing);
      if (active === closing) active = tabs[tabs.length - 1] || null;
      return render();
    }
    openFile(el.dataset.f);
  }));
}

async function openFile(file, line) {
  if (!(file in cache)) {
    try { cache[file] = (await api(`/api/file?path=${encodeURIComponent(file)}`)).text; } catch (e) { return toast(e.message); }
  }
  if (!tabs.includes(file)) tabs.push(file);
  active = file;
  render();
  if (line) {
    const row = document.querySelector(`.ln[data-n="${line}"]`);
    if (row) { row.scrollIntoView({ block: "center" }); row.classList.add("flash"); }
  }
}

const KW = "def|class|return|if|elif|else|for|in|while|import|from|as|with|try|except|finally|raise|not|and|or|is|None|True|False|lambda|yield|pass|break|continue|async|await";
const TOKENS = new RegExp(`(?<f>(?<=\\bdef\\s+)\\w+)|(?<c>#.*$)|(?<s>f?"""[^]*?"""|f?'''[^]*?'''|f?"(?:\\\\.|[^"\\\\])*"|f?'(?:\\\\.|[^'\\\\])*')|(?<k>\\b(?:${KW})\\b)|(?<n>\\b\\d+(?:\\.\\d+)?\\b)|(?<b>\\b(?:print|sum|round|len|range|str|int|float|dict|list|self)\\b)`, "g");

function highlight(line) {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(TOKENS)) {
    out += esc(line.slice(last, m.index));
    const kind = Object.entries(m.groups).find(([, val]) => val !== undefined)[0];
    out += `<span class="tok-${kind}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(line.slice(last));
}

function lensFor(v, node) {
  const chips = [];
  let range = "";
  const evidence = (v.r.evidence[node.id] || []).map((t) => {
    const st = v.tests[t]?.status;
    return `<span class="chip ${FAILED(st) ? "fail" : st === "passed" ? "pass" : ""}">${FAILED(st) ? "✕" : "✓"} ${esc(t.split(".").pop())}</span>`;
  });
  if (v.changed.has(node.id)) {
    chips.push(`<span class="chip changed">changed by patch</span>`);
    range = "r-changed";
  } else if (node.id in v.impacted) {
    const hops = v.impacted[node.id].hops;
    chips.push(`<span class="chip impacted">affected · ${hops} hop${hops > 1 ? "s" : ""} from change</span>`);
    range = "r-impacted";
  }
  if (v.gaps.has(node.id)) chips.push(`<span class="chip gap">no test exercises this</span>`);
  else if (evidence.length) chips.push("tested by", ...evidence);
  const t = v.tests[node.id];
  if (t) {
    const bad = FAILED(t.status);
    const kind = t.why.includes("added by patch") ? "new test · added by agent" : `${t.scope} test`;
    chips.push(`<span class="chip ${bad ? "fail" : "pass"}">${bad ? "✕ failed" : "✓ passed"}</span>`, kind);
    if (bad) chips.push(`<span style="color:var(--red)">${esc((t.message || "").split("\n")[0])}</span>`);
    range = bad ? "r-fail" : "r-pass";
  }
  return chips.length ? { html: chips.join(" "), range } : null;
}

function diffRows(original, hunks) {
  const rows = [];
  let o = 1;
  let n = 1;
  const ctx = (text) => { rows.push({ t: " ", text, n: n++ }); o++; };
  for (const h of hunks) {
    while (o < h.oldStart) ctx(original[o - 1]);
    for (const l of h.lines) {
      if (l.t === " ") ctx(l.text);
      else if (l.t === "-") { rows.push({ t: "-", text: l.text, n: null }); o++; }
      else rows.push({ t: "+", text: l.text, n: n++ });
    }
  }
  while (o <= original.length) ctx(original[o - 1]);
  return rows;
}

function renderEditor(v) {
  const ed = $("editor");
  if (!active || !(active in cache)) {
    ed.innerHTML = `<div class="empty-editor"><div class="empty-mark"></div>
      <p>Ask the agent for a fix. Changed and affected files light up in the explorer.</p></div>`;
    return;
  }
  const rows = diffRows(cache[active].replace(/\n$/, "").split("\n"), v ? (v.hunks[active] || []) : []);
  const annotated = v ? Object.values(v.nodes)
    .filter((nd) => nd.file === active && (nd.kind === "Function" || nd.kind === "Test"))
    .map((nd) => ({ nd, lens: lensFor(v, nd) })).filter((x) => x.lens) : [];
  const html = rows.map((row) => {
    let pre = "";
    const cls = [row.t === "+" ? "add" : row.t === "-" ? "del" : ""];
    if (row.n) {
      for (const { nd, lens } of annotated) {
        if (nd.start === row.n) pre += `<div class="lens"><span class="no"></span><span class="body">${lens.html}</span></div>`;
        if (row.n >= nd.start && row.n <= nd.end && lens.range) cls.push(lens.range);
      }
    }
    return `${pre}<div class="ln ${cls.join(" ")}" ${row.n ? `data-n="${row.n}"` : ""}><span class="no">${row.n ?? ""}</span><span class="tx">${highlight(row.text) || " "}</span></div>`;
  }).join("");
  ed.innerHTML = `<div class="code">${html}</div>`;
}

const STEP_LABEL = {
  patch: "Writing a patch", feedback: "Reading the dependency evidence", baseline: "Learning what tests exercise",
  graph: "Indexing the code graph", changes: "Mapping the diff", blast: "Walking dependents",
  tests: "Running selected tests", selfcheck: "Re-checking its own test", verdict: "Wrapping up",
};

function diffCard(diff, onlyFiles) {
  const files = parseDiff(diff);
  return Object.entries(files).filter(([f]) => !onlyFiles || onlyFiles.has(f)).map(([f, hunks]) => `
    <div class="dcard"><div class="dcard-head">${esc(f)}</div><div class="dcard-body">${
      hunks.map((h) => h.lines.filter((l) => l.t !== " " || h.lines.length < 8).map((l) =>
        `<div class="dl ${l.t === "+" ? "add" : l.t === "-" ? "del" : ""}"><span class="sg">${l.t === " " ? "" : l.t}</span>${highlight(l.text) || " "}</div>`
      ).join("")).join('<div class="dl gap">⋯</div>')}</div></div>`).join("");
}

function newFiles(i) {
  // files whose change is new in this attempt (e.g. only the added tests), relative to the previous attempt
  if (i === 0) return null;
  const prev = parseDiff(state.attempts[i - 1].diff);
  const cur = parseDiff(state.attempts[i].diff);
  return new Set(Object.keys(cur).filter((f) => JSON.stringify(cur[f]) !== JSON.stringify(prev[f])));
}

function chains(r) {
  // maximal dependency paths, drawn from the changed symbol outwards
  const paths = r.impacted.map((d) => d.path);
  const extended = new Set(paths.filter((p) => p.length > 2).map((p) => JSON.stringify(p.slice(1))));
  const maximal = paths.filter((p) => !extended.has(JSON.stringify(p))).map((p) => [...p].reverse());
  return maximal.length ? maximal : r.changed.map((c) => [c.id]);
}

function chainHtml(r) {
  const gaps = new Set(r.gaps);
  const changed = new Set(r.changed.map((c) => c.id));
  const ev = r.evidence || {};
  const all = chains(r);
  return all.slice(0, 3).map((chain) => `<div class="chain">${chain.map((id, h) => {
    const kind = changed.has(id) ? "changed" : gaps.has(id) ? "gap" : "covered";
    const note = changed.has(id) ? "changed" : gaps.has(id) ? `${h} hop${h > 1 ? "s" : ""} · no tests`
      : `${h} hop${h > 1 ? "s" : ""} · ${(ev[id] || []).length} tests`;
    return `${h ? '<span class="arrow">←</span>' : ""}<span class="node ${kind}"><code>${esc(id.split(".").pop())}</code><small>${note}</small></span>`;
  }).join("")}</div>`).join("") + (all.length > 3 ? `<div class="more">+${all.length - 3} more paths in the graph</div>` : "");
}

function dependencyCard(a, i) {
  const r = a.report;
  const latest = i === state.attempts.length - 1;
  const failed = r.tests.filter((t) => FAILED(t.status));
  const added = r.tests.filter((t) => t.why.includes("added by patch"));
  const direct = r.tests.filter((t) => t.scope === "direct" && !t.why.includes("added by patch"));
  let action = "";
  if (latest && !state.busy && r.verdict === "regression") action = `<button class="btn primary sm" data-act="revise">Fix it using this evidence</button>`;
  if (latest && !state.busy && r.verdict === "unvalidated") action = `<button class="btn primary sm" data-act="cover">Write tests for ${esc(r.gaps.map((g) => g.split(".").pop() + "()").join(", "))}</button>`;
  const summary = failed.length ? `${failed.map((t) => `<code>${esc(t.id.split(".").pop())}</code>`).join(", ")} failed: ${esc((failed[0].message || "").split("\n")[0])}`
    : r.gaps.length ? `All ${r.tests.length} tests pass, but nothing tests ${r.gaps.map((g) => `<code>${esc(g)}</code>`).join(", ")}.`
    : `All ${r.tests.length} tests pass${added.length ? ` (${added.length} new)` : ""}, and every affected function is covered.`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return `<div class="card dep-card ${r.verdict}" data-i="${i}">
    <div class="card-title"><span>Dependency check</span><span class="vchip ${r.verdict}">${CHIP[r.verdict]}</span></div>
    ${chainHtml(r)}
    <div class="contrast">
      <div class="row"><span class="lbl">Typical agent checks</span><span>${plural(direct.length, "test")} <small>(the changed function's own)</small></span></div>
      <div class="row strong"><span class="lbl">Dependency graph found</span><span>${plural(r.impacted.length, "dependent")} · ${plural(r.tests.length, "test")}${r.gaps.length ? ` · <b class="warn">${r.gaps.length} untested</b>` : ""}${failed.length ? ` · <b class="bad">${failed.length} failing</b>` : ""}</span></div>
    </div>
    <div class="dep-summary">${summary}</div>
    <div class="dep-foot"><a class="view-graph" data-i="${i}">▶ replay on graph</a></div>
    ${action}
  </div>`;
}

function renderChat() {
  const chat = $("chat");
  if (!state.request && !state.attempts.length) {
    chat.innerHTML = `<div class="chat-empty">Run the program, then tell the agent what looks wrong.<br>
      It fixes the code, then checks everything that depends on the change.</div>`;
    return;
  }
  const parts = [`<div class="msg user">${esc(state.request)}</div>`];
  state.attempts.forEach((a, i) => {
    const intro = a.source === "tests" ? "I added tests for the code the check found untested:"
      : a.source === "revision" ? "Revised using the failing tests and their dependency paths:" : "";
    parts.push(`<div class="msg agent ${i === selected ? "selected" : ""}" data-i="${i}">
      <div class="who">Agent · ${esc(state.model)}</div>
      ${intro ? `<div class="intro">${intro}</div>` : ""}
      <div class="expl">${esc(a.explanation)}</div>
      ${diffCard(a.diff, newFiles(i))}
    </div>`);
    parts.push(dependencyCard(a, i));
  });
  if (state.busy) {
    const cur = [...state.steps].reverse().find((s) => s.status === "running");
    parts.push(`<div class="msg status"><span class="spin"></span>${esc(STEP_LABEL[cur?.key] || "Working")}…</div>`);
  }
  chat.innerHTML = parts.join("");
  chat.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act)));
  chat.querySelectorAll(".msg.agent, .view-graph").forEach((el) => el.addEventListener("click", () => {
    selected = +el.dataset.i;
    if (el.classList.contains("view-graph")) { panelTab = "graph"; animateNext = true; }
    $("graph").dataset.key = "";
    render();
  }));
  chat.scrollTop = chat.scrollHeight;
}

function renderPanel(v) {
  document.querySelectorAll(".ptab").forEach((b) => b.classList.toggle("active", b.dataset.tab === panelTab));
  ["graph", "tests", "report", "terminal"].forEach((t) => $(t).classList.toggle("hidden", t !== panelTab));
  $("graph-legend").classList.toggle("hidden", panelTab !== "graph");
  if (panelTab !== "graph") $("graph-caption").classList.add("hidden");
  else if ($("graph-caption").innerHTML) $("graph-caption").classList.remove("hidden");
  $("tests-count").textContent = v ? `(${v.r.tests.length})` : "";
  if (!v) {
    if (cy) { cy.destroy(); cy = null; }
    $("tests").innerHTML = $("report").innerHTML = "";
    $("graph").dataset.key = "";
    return;
  }
  renderTests(v);
  renderReport(v);
  const key = `${selected}:${state.attempts.length}`;
  if (panelTab === "graph" && ($("graph").dataset.key !== key || animateNext)) {
    $("graph").dataset.key = key;
    renderGraph(v, animateNext);
    animateNext = false;
  }
}

function renderTests(v) {
  $("tests").innerHTML = v.r.tests.map((t) => `
    <div class="trow" data-id="${esc(t.id)}">
      <span>${FAILED(t.status) ? "❌" : t.status === "passed" ? "✅" : "·"}</span>
      <span class="tn">${esc(t.id)}</span>
      <span class="scope ${t.scope}">${t.scope}</span>
      <span class="tp">found via ${esc(t.why.join(" + "))}${t.path.length ? " · " + t.path.map(esc).join(" → ") : ""}</span>
      ${FAILED(t.status) ? `<span class="tm">${esc((t.message || "").split("\n")[0])}</span>` : ""}
    </div>`).join("") || "<div>No tests reach the changed code.</div>";
  $("tests").querySelectorAll(".trow").forEach((el) => el.addEventListener("click", () => {
    const n = v.nodes[el.dataset.id];
    if (n) openFile(n.file, n.start);
  }));
}

function renderReport(v) {
  const r = v.r;
  const list = (items, empty) => items.join("") || `<div class="item">${empty}</div>`;
  $("report").innerHTML = `<div class="rep">
    <h4>Changed</h4>${list(r.changed.map((c) => `<div class="item"><span class="hop">changed</span>${esc(c.id)} <span style="color:var(--muted)">${esc(c.file)}:${c.line}</span></div>`), "none")}
    <h4>Dependents (blast radius)</h4>${list(r.impacted.map((i) => `<div class="item"><span class="hop">${i.hops} hop${i.hops > 1 ? "s" : ""}</span>${i.path.map(esc).join(" → ")}</div>`), "none")}
    <h4>No test evidence</h4>${list(r.gaps.map((g) => `<div class="item" style="color:var(--amber)">⚠ ${esc(g)}</div>`), "none")}
    <h4>Unresolved calls</h4>${list(r.unresolved.map((u) => `<div class="item">? ${esc(u)}</div>`), "none: every call in the repo was resolved")}
  </div>`;
}

function caption(text, tone = "") {
  const c = $("graph-caption");
  c.className = `graph-caption ${tone}`;
  c.innerHTML = text;
  c.classList.toggle("hidden", !text);
}

function ripple(v) {
  // Replays the traversal: changed node, then each hop outward, then the tests that reach it.
  const hopOf = {};
  v.r.changed.forEach((c) => { hopOf[c.id] = 0; });
  v.r.impacted.forEach((i) => { hopOf[i.id] = i.hops; });
  const maxHop = Math.max(0, ...Object.values(hopOf));
  const short = (id) => `<code>${esc(id)}</code>`;
  const steps = [];
  for (let h = 0; h <= maxHop; h++) {
    const ids = Object.keys(hopOf).filter((id) => hopOf[id] === h);
    if (ids.length) steps.push({ ids, text: h === 0 ? `Changed ${ids.map(short).join(", ")}`
      : `Hop ${h} · ${ids.map(short).join(", ")} depend${ids.length === 1 ? "s" : ""} on it` });
  }
  const failed = v.r.tests.filter((t) => FAILED(t.status)).length;
  steps.push({ ids: v.r.tests.map((t) => t.id), tone: failed ? "bad" : "",
    text: `${v.r.tests.length} tests reach the change · ${v.r.tests.length - failed} passed${failed ? ` · ${failed} failed` : ""}` });
  if (v.r.gaps.length) steps.push({ ids: v.r.gaps, tone: "warn", pulse: true,
    text: `⚠ No test reaches ${v.r.gaps.map(short).join(", ")}` });
  else if (!failed) steps.push({ ids: [], tone: "good", text: "✓ Every affected function is covered by a passing test" });

  const live = cy.elements().not(".faded");
  live.addClass("pending");
  steps.forEach((step, k) => rippleTimers.push(setTimeout(() => {
    const nodes = cy.nodes().filter((n) => step.ids.includes(n.id()));
    nodes.removeClass("pending");
    cy.edges(".pending").filter((e) => !e.source().hasClass("pending") && !e.target().hasClass("pending")).removeClass("pending");
    nodes.forEach((n) => n.animate({ style: { "border-width": 7 } }, { duration: 220,
      complete: () => n.animate({ style: { "border-width": 2 } }, { duration: 260, complete: () => n.removeStyle("border-width") }) }));
    caption(step.text, step.tone);
  }, 250 + 750 * k)));
}

function renderGraph(v, animate = false) {
  rippleTimers.forEach(clearTimeout);
  rippleTimers = [];
  caption("");
  const r = v.r;
  const hot = new Set();
  r.tests.filter((t) => FAILED(t.status)).forEach((t) => {
    for (let i = 0; i < t.path.length - 1; i++) hot.add(`${t.path[i]}>${t.path[i + 1]}`);
  });
  const cls = (id) => {
    const c = [];
    if (v.changed.has(id)) c.push("changed"); else if (id in v.impacted) c.push("impacted");
    if (v.gaps.has(id)) c.push("gap");
    if (v.tests[id]) c.push(FAILED(v.tests[id].status) ? "fail" : v.tests[id].status === "passed" ? "pass" : "");
    return c.filter(Boolean).join(" ") || "faded";
  };
  if (cy) cy.destroy();
  cy = cytoscape({
    container: $("graph"),
    wheelSensitivity: 0.2,
    elements: [
      ...r.graph.nodes.map((n) => ({ data: { id: n.id, label: n.kind === "Test" ? n.name : n.id, file: n.file, line: n.start },
        classes: `${n.kind} ${cls(n.id)}` })),
      ...r.graph.edges.map((e) => ({ data: { id: `${e.src}>${e.dst}`, source: e.src, target: e.dst },
        classes: `${e.rel} ${hot.has(`${e.src}>${e.dst}`) ? "hot" : ""}` })),
    ],
    layout: { name: "dagre", rankDir: "LR", nodeSep: 14, rankSep: 60, fit: false },
    style: [
      { selector: "node", style: { label: "data(label)", "font-family": "JetBrains Mono, SF Mono, Menlo, monospace",
        "font-size": 12, color: "#1f2330", "text-valign": "center", "background-color": "#fff", "border-width": 1.5,
        "border-color": "#d5d7e2", shape: "round-rectangle", width: "label", height: 28, padding: 10 } },
      { selector: "node.Variable", style: { shape: "hexagon" } },
      { selector: "node.Test", style: { shape: "round-tag" } },
      { selector: "node.impacted", style: { "background-color": "#fff6e5", "border-color": "#e8900c", "border-width": 2 } },
      { selector: "node.changed", style: { "background-color": "#5b39f3", color: "#fff", "border-color": "#2d1c77", "border-width": 2 } },
      { selector: "node.pass", style: { "background-color": "#eaf8ef", "border-color": "#2f9e58", "border-width": 2 } },
      { selector: "node.fail", style: { "background-color": "#e5484d", color: "#fff", "border-color": "#a3262a", "border-width": 2 } },
      { selector: "node.gap", style: { "border-style": "dashed", "border-color": "#4a5065", "border-width": 2 } },
      { selector: ".faded", style: { opacity: 0.22 } },
      { selector: "edge", style: { width: 1.4, "line-color": "#c3c6d4", "target-arrow-color": "#c3c6d4",
        "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 0.8 } },
      { selector: "edge.READS", style: { "line-style": "dotted" } },
      { selector: "edge.hot", style: { width: 3.5, "line-color": "#e5484d", "target-arrow-color": "#e5484d" } },
      { selector: ".pending", style: { opacity: 0.07 } },
    ],
  });
  cy.nodes(".faded").connectedEdges().addClass("faded");
  const focus = cy.nodes().not(".faded");
  cy.fit(focus.length ? focus : undefined, 28);
  if (cy.zoom() > 1.4) { cy.zoom(1.4); cy.center(focus); }
  cy.on("tap", "node", (e) => openFile(e.target.data("file"), e.target.data("line")));
  if (animate) ripple(v);
}

async function runProgram() {
  try {
    const res = await api("/api/run", {});
    runs.push(res.run);
    panelTab = "terminal";
    renderTerminal();
    render();
  } catch (e) { toast(e.message); }
}

function renderTerminal() {
  if (!runs.length) return;
  const shade = (text) => esc(text).replace(/^(Total.*)$/m, (line) => `<span class="hl">${line}</span>`);
  $("terminal").innerHTML = runs.map((r) => `<div class="term-run">
      <div class="term-cmd">$ ${esc(r.cmd.replace(/^\S*python\S*/, "python"))}<span class="tag">${esc(r.label)}</span></div>
      <div class="term-out">${shade(r.output)}</div></div>`).join("");
  $("terminal").scrollTop = $("terminal").scrollHeight;
}

// ---------- events ----------
$("btn-ask").addEventListener("click", () => act("ask", { request: $("request").value.trim() }));
$("btn-run").addEventListener("click", runProgram);
$("request").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("btn-ask").click(); } });
$("btn-reset").addEventListener("click", () => { runs.length = 0; $("terminal").innerHTML = '<div class="term-empty">Press ▶ Run to execute the program on the current code.</div>'; act("reset"); });
document.querySelectorAll(".ptab").forEach((b) => b.addEventListener("click", () => {
  panelTab = b.dataset.tab;
  $("graph").dataset.key = "";
  render();
}));

(async () => {
  try {
    [state, files] = await Promise.all([api("/api/state"), api("/api/files")]);
    onState();
    if (state.busy) poll();
  } catch (e) { toast(e.message); }
})();
