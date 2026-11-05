"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SOURCE = { agent: "agent fix", revision: "agent revision", tests: "agent adds tests" };
const runs = [];
const VERDICT = {
  regression: "Regression: do not approve",
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
let confirmApprove = false;

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
    confirmApprove = false;
    state = await api(`/api/${action}`, body);
    if (action === "reset" || action === "approve") Object.keys(cache).forEach((k) => delete cache[k]);
    if (action === "reset") { tabs = []; active = null; seenAttempts = 0; selected = -1; }
    if (action === "approve" && active) await openFile(active);
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
    if (selected >= 0) autoOpen();
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
  renderRun();
  renderDecision(v);
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
  const applied = state.approved && selected === state.attempts.length - 1;
  const rows = diffRows(cache[active].replace(/\n$/, "").split("\n"), v && !applied ? (v.hunks[active] || []) : []);
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

function renderRun() {
  const run = $("run");
  if (!state.steps.length) {
    run.innerHTML = `<div class="run-empty">The agent's work appears here step by step: patch → graph → blast radius → tests → verdict.</div>`;
    return;
  }
  const groups = {};
  state.steps.forEach((s) => (groups[s.attempt] ||= []).push(s));
  run.innerHTML = Object.keys(groups).map(Number).sort((x, y) => x - y).map((i) => {
    const a = state.attempts[i];
    const head = a ? `<span>Attempt ${i + 1} <span class="src">· ${SOURCE[a.source]}</span></span>
        <span class="vchip ${a.report.verdict}">${CHIP[a.report.verdict]}</span>`
      : `<span>Attempt ${i + 1} <span class="src">· running…</span></span>`;
    const steps = groups[i].map((s) => `
      <div class="step ${s.status}">
        <span class="ic">${s.status === "done" ? "✓" : s.status === "failed" ? "✕" : ""}</span>
        <span class="lb">${esc(s.label)}</span>
        <span class="sec">${s.seconds != null ? s.seconds.toFixed(1) + "s" : ""}</span>
        ${s.detail ? `<span class="dt">${esc(s.detail)}</span>` : ""}
      </div>`).join("");
    return `<div class="attempt ${i === selected ? "selected" : ""}" data-i="${i}">
      <div class="attempt-head">${head}</div>${steps}</div>`;
  }).join("");
  run.querySelectorAll(".attempt-head").forEach((el) => el.addEventListener("click", () => {
    const i = +el.parentElement.dataset.i;
    if (state.attempts[i]) { selected = i; $("graph").dataset.key = ""; render(); }
  }));
  run.scrollTop = run.scrollHeight;
}

function renderDecision(v) {
  const box = $("verdict");
  const next = $("btn-next");
  const approve = $("btn-approve");
  if (!v) {
    box.className = "verdict";
    box.innerHTML = state.busy ? "<b>Working…</b>The agent is running." : "<b>No patch yet</b>Run the program, then describe what looks wrong.";
    next.disabled = approve.disabled = true;
    next.textContent = "↩ Send back to agent";
    return;
  }
  const r = v.r;
  const latest = selected === state.attempts.length - 1;
  if (state.approved && latest) {
    box.className = "verdict approved";
    box.innerHTML = "<b>Approved and applied</b>A human made the final call with the evidence above.";
  } else {
    const failed = r.tests.filter((t) => FAILED(t.status));
    const direct = r.tests.filter((t) => t.scope === "direct");
    let sub;
    if (failed.length) {
      sub = (direct.length && direct.every((t) => t.status === "passed") ? "The change's own test passes, but " : "") +
        failed.map((t) => `<code>${esc(t.id)}</code> fails`).join(", ") + ".";
    } else if (r.gaps.length) {
      sub = `All ${r.tests.length} selected tests pass, but nothing tests ${r.gaps.map((g) => `<code>${esc(g)}</code>`).join(", ")}.`;
    } else {
      sub = `All ${r.tests.length} selected tests pass and cover every affected function.`;
    }
    box.className = `verdict ${r.verdict}`;
    box.innerHTML = `<b>${VERDICT[r.verdict]}</b>${sub}`;
  }
  next.dataset.action = r.verdict === "regression" ? "revise" : "cover";
  next.textContent = r.verdict === "regression" ? "↩ Fix regression using graph evidence"
    : r.verdict === "unvalidated" ? "↩ Write tests for untested code" : "↩ Send back to agent";
  next.disabled = !latest || state.busy || state.approved || r.verdict === "validated";
  approve.disabled = !latest || state.busy || state.approved;
  approve.className = `btn ${r.verdict === "regression" ? "danger" : "approve"}`;
  approve.textContent = r.verdict === "regression" ? (confirmApprove ? "Click again to confirm" : "Approve anyway") : "Approve & apply";
}

function renderPanel(v) {
  document.querySelectorAll(".ptab").forEach((b) => b.classList.toggle("active", b.dataset.tab === panelTab));
  ["graph", "tests", "report", "terminal"].forEach((t) => $(t).classList.toggle("hidden", t !== panelTab));
  $("graph-legend").classList.toggle("hidden", panelTab !== "graph");
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
  if (panelTab === "graph" && $("graph").dataset.key !== key) { $("graph").dataset.key = key; renderGraph(v); }
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

function renderGraph(v) {
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
    ],
  });
  cy.nodes(".faded").connectedEdges().addClass("faded");
  const focus = cy.nodes().not(".faded");
  cy.fit(focus.length ? focus : undefined, 28);
  if (cy.zoom() > 1.4) { cy.zoom(1.4); cy.center(focus); }
  cy.on("tap", "node", (e) => openFile(e.target.data("file"), e.target.data("line")));
}

async function runProgram() {
  try {
    const res = await api("/api/run", {});
    const label = state.approved ? "after approved fix" : runs.length ? "current code" : "before any change";
    runs.push({ ...res.run, label });
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
$("btn-next").addEventListener("click", (e) => act(e.currentTarget.dataset.action));
$("btn-approve").addEventListener("click", () => {
  const v = view();
  if (v.r.verdict === "regression" && !confirmApprove) { confirmApprove = true; return renderDecision(v); }
  act("approve");
});
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
