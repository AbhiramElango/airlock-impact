"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ICON = { passed: "✅", failed: "❌", error: "❌", skipped: "⏭", not_run: "·" };
const SOURCE = { agent: "agent", revision: "agent revision", simulated: "simulated bad fix" };
const VERDICT = {
  regression: "❌ Regression: do not approve",
  unvalidated: "⚠️ Tests pass, but parts are untested",
  validated: "✅ Validated: every affected function has passing tests",
};

let state = null;
let selected = -1;
let cy = null;
let confirmApprove = false;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function run(label, path, body) {
  $("busy-text").textContent = label;
  $("busy").classList.remove("hidden");
  try {
    state = await api(path, body);
    selected = state.attempts.length - 1;
    confirmApprove = false;
    render();
  } catch (e) {
    toast(e.message);
  } finally {
    $("busy").classList.add("hidden");
  }
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 5000);
}


function render() {
  $("badge-model").textContent = state.model;
  $("badge-repo").textContent = `repo: ${state.repo}`;
  $("btn-reset").classList.toggle("hidden", !state.can_reset);
  $("btn-simulate").classList.toggle("hidden", !state.can_simulate);
  renderTimeline();
  const attempt = state.attempts[selected];
  if (!attempt) return renderEmpty();
  renderVerdict(attempt.report);
  renderPatch(attempt);
  renderEvidence(attempt.report);
  renderGraph(attempt.report);
  renderActions(attempt.report);
}

function renderEmpty() {
  $("verdict").className = "verdict idle";
  $("verdict").innerHTML = `<div class="verdict-title">No patch yet</div>
    <div class="verdict-sub">Ask the local agent for a fix, or simulate a bad one.</div>`;
  ["explanation", "diff", "tests", "gaps", "impacted"].forEach((id) => ($(id).innerHTML = ""));
  if (cy) { cy.destroy(); cy = null; }
  $("btn-revise").disabled = $("btn-approve").disabled = true;
  $("action-hint").textContent = "";
}

function renderTimeline() {
  $("timeline").innerHTML = state.attempts.map((a, i) => {
    const v = a.report.verdict;
    const icon = v === "regression" ? "❌" : v === "unvalidated" ? "⚠️" : "✅";
    const step = `<span class="step ${i === selected ? "active" : ""}" data-i="${i}">
      Attempt ${i + 1} · ${esc(SOURCE[a.source])} · ${icon}</span>`;
    return (i ? `<span class="step-arrow">→</span>` : "") + step;
  }).join("") + (state.approved ? `<span class="step-arrow">→</span><span class="step active">Approved ✓</span>` : "");
  document.querySelectorAll(".step[data-i]").forEach((el) =>
    el.addEventListener("click", () => { selected = +el.dataset.i; render(); }));
}

function renderVerdict(r) {
  const v = $("verdict");
  if (state.approved && selected === state.attempts.length - 1) {
    v.className = "verdict approved";
    v.innerHTML = `<div class="verdict-title">✓ Approved and applied to ${esc(state.repo)}</div>
      <div class="verdict-sub">A human made the final call, with the evidence above.</div>`;
    return;
  }
  const direct = r.tests.filter((t) => t.scope === "direct");
  const failed = r.tests.filter((t) => t.status === "failed" || t.status === "error");
  let sub;
  if (failed.length) {
    const own = direct.length && direct.every((t) => t.status === "passed");
    sub = (own ? "The change's own test passes. " : "") +
      `${failed.length === 1 ? "A downstream test fails" : failed.length + " tests fail"}: ` +
      failed.map((t) => `<code>${esc(t.id)}</code> (${esc((t.message || "").split("\n")[0])})`).join(", ");
  } else if (r.gaps.length) {
    sub = `${r.tests.length} selected tests pass, but no test exercises ` +
      r.gaps.map((g) => `<code>${esc(g)}</code>`).join(", ") + ". Passing tests are not proof of safety.";
  } else {
    sub = `${r.tests.length} selected tests pass and cover every affected function.`;
  }
  v.className = `verdict ${r.verdict}`;
  v.innerHTML = `<div class="verdict-title">${VERDICT[r.verdict]}</div><div class="verdict-sub">${sub}</div>`;
}

function renderPatch(a) {
  $("explanation").textContent = a.explanation || "";
  $("diff").innerHTML = a.diff.split("\n").map((l) => {
    const cls = l.startsWith("+++") || l.startsWith("---") ? "meta" : l.startsWith("@@") ? "hunk"
      : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "";
    return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l) + "\n";
  }).join("");
}

function renderEvidence(r) {
  $("tests").innerHTML = `<div class="section-title">Tests run (${r.tests.length})</div>` + (r.tests.map((t) => `
    <div class="test">
      <div class="test-row">
        <span>${ICON[t.status] || "?"}</span>
        <span class="test-name">${esc(t.id)}</span>
        <span class="pill ${t.scope}">${t.scope}</span>
      </div>
      <div class="path">via ${esc(t.why.join(" + "))}${t.path.length ? " · " + t.path.map(esc).join(" → ") : ""}</div>
      ${t.status === "failed" || t.status === "error" ? `<div class="failmsg">${esc((t.message || "").split("\n")[0])}</div>` : ""}
    </div>`).join("") || `<div class="muted">No tests reach the changed code.</div>`);

  $("gaps").innerHTML = r.gaps.length ? `<div class="section-title">No test evidence</div>` +
    r.gaps.map((g) => `<div class="gap-item">⚠️ ${esc(g)}</div>`).join("") : "";

  $("impacted").innerHTML = `<div class="section-title">Changed → dependents</div>` +
    r.changed.map((c) => `<div class="hop-item"><span class="hop">changed</span>${esc(c.id)} <span class="muted">${esc(c.file)}:${c.line}</span></div>`).join("") +
    r.impacted.map((i) => `<div class="hop-item"><span class="hop">${i.hops} hop${i.hops > 1 ? "s" : ""}</span>${esc(i.id)}</div>`).join("") +
    (r.unresolved.length ? `<div class="section-title">Unresolved calls (${r.unresolved.length})</div>` +
      r.unresolved.slice(0, 8).map((u) => `<div class="hop-item muted">? ${esc(u)}</div>`).join("") : "");
}

function nodeClasses(r) {
  const changed = new Set(r.changed.map((c) => c.id));
  const impacted = new Set(r.impacted.map((i) => i.id));
  const gaps = new Set(r.gaps);
  const tests = Object.fromEntries(r.tests.map((t) => [t.id, t.status]));
  return (id) => {
    const cls = [];
    if (changed.has(id)) cls.push("changed");
    else if (impacted.has(id)) cls.push("impacted");
    if (gaps.has(id)) cls.push("gap");
    if (id in tests) cls.push(tests[id] === "passed" ? "pass" : tests[id] === "not_run" ? "" : "fail");
    if (!cls.filter(Boolean).length) cls.push("faded");
    return cls.join(" ");
  };
}

function hotEdges(r) {
  const hot = new Set();
  r.tests.filter((t) => t.status === "failed" || t.status === "error").forEach((t) => {
    for (let i = 0; i < t.path.length - 1; i++) hot.add(`${t.path[i]}>${t.path[i + 1]}`);
  });
  return hot;
}

function renderGraph(r) {
  const cls = nodeClasses(r);
  const hot = hotEdges(r);
  const elements = [
    ...r.graph.nodes.map((n) => ({
      data: { id: n.id, label: n.kind === "Test" ? n.name : n.id, kind: n.kind, file: n.file, line: n.start },
      classes: `${n.kind} ${cls(n.id)}`,
    })),
    ...r.graph.edges.map((e) => ({
      data: { id: `${e.src}>${e.dst}`, source: e.src, target: e.dst, rel: e.rel },
      classes: `${e.rel} ${hot.has(`${e.src}>${e.dst}`) ? "hot" : ""}`,
    })),
  ];
  if (cy) cy.destroy();
  cy = cytoscape({
    container: $("graph"),
    elements,
    wheelSensitivity: 0.2,
    layout: { name: "dagre", rankDir: "LR", nodeSep: 18, rankSep: 70, fit: false },
    style: [
      { selector: "node", style: {
        label: "data(label)", color: "#e6edf3", "font-size": 13, "text-valign": "center", "text-halign": "center",
        "background-color": "#30363d", "border-width": 1, "border-color": "#484f58", shape: "round-rectangle",
        width: "label", height: 30, padding: 10, "text-wrap": "none" } },
      { selector: "node.Variable", style: { shape: "hexagon", padding: 10 } },
      { selector: "node.Test", style: { shape: "round-tag", "background-color": "#21262d" } },
      { selector: "node.impacted", style: { "background-color": "#5a3d10", "border-color": "#f0a73c", "border-width": 2 } },
      { selector: "node.changed", style: { "background-color": "#6e1d1a", "border-color": "#f85149", "border-width": 3 } },
      { selector: "node.pass", style: { "background-color": "#1a4224", "border-color": "#3fb950", "border-width": 2 } },
      { selector: "node.fail", style: { "background-color": "#f85149", color: "#0d1117", "border-color": "#fff", "border-width": 3, "font-weight": 700 } },
      { selector: "node.gap", style: { "border-style": "dashed", "border-color": "#c9d1d9", "border-width": 2 } },
      { selector: "node.faded", style: { opacity: 0.28 } },
      { selector: "edge", style: {
        width: 1.4, "line-color": "#484f58", "target-arrow-color": "#484f58", "target-arrow-shape": "triangle",
        "curve-style": "bezier", "arrow-scale": 0.8 } },
      { selector: "edge.READS", style: { "line-style": "dotted" } },
      { selector: "edge.faded", style: { opacity: 0.2 } },
      { selector: "edge.hot", style: { width: 3.5, "line-color": "#f85149", "target-arrow-color": "#f85149" } },
    ],
  });
  cy.nodes(".faded").connectedEdges().addClass("faded");
  const focus = cy.nodes().not(".faded");
  cy.fit(focus.length ? focus : undefined, 24);
  if (cy.zoom() > 1.6) { cy.zoom(1.6); cy.center(focus); }
  cy.on("tap", "node", (e) => {
    const d = e.target.data();
    const evidence = (r.impacted.find((i) => i.id === d.id) || {}).evidence || [];
    $("node-info").innerHTML = `<b>${esc(d.id)}</b> · ${esc(d.kind)} · ${esc(d.file)}:${d.line}` +
      (evidence.length ? `<br>tested by: ${evidence.map(esc).join(", ")}` : "");
  });
}

function renderActions(r) {
  const latest = selected === state.attempts.length - 1;
  const done = state.approved;
  $("btn-revise").disabled = !latest || done || r.verdict === "validated";
  const approve = $("btn-approve");
  approve.disabled = !latest || done;
  approve.className = r.verdict === "regression" ? "danger" : "approve";
  approve.textContent = r.verdict === "regression"
    ? (confirmApprove ? "Click again to approve anyway" : "Approve anyway")
    : "Approve & apply";
  $("action-hint").textContent = done ? "Applied. Reset to run the demo again."
    : !latest ? "Viewing an earlier attempt."
    : r.verdict === "regression" ? "Send the failing evidence back to the local agent to revise."
    : r.verdict === "unvalidated" ? "No regressions. Some affected code has no tests, so it's your call."
    : "All affected code has passing tests.";
}

$("btn-ask").addEventListener("click", () => {
  const request = $("request").value.trim();
  if (request) run("Local model is writing a patch, then Impact checks it…", "/api/ask", { request });
});
$("request").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-ask").click(); });
$("btn-simulate").addEventListener("click", () =>
  run("Analyzing the simulated patch…", "/api/simulate", { request: $("request").value.trim() }));
$("btn-revise").addEventListener("click", () =>
  run("Sending failing tests + dependency paths to the local model…", "/api/revise", {}));
$("btn-approve").addEventListener("click", () => {
  const r = state.attempts[selected].report;
  if (r.verdict === "regression" && !confirmApprove) { confirmApprove = true; return renderActions(r); }
  run("Applying the patch…", "/api/approve", {});
});
$("btn-reset").addEventListener("click", () => run("Resetting the demo repo…", "/api/reset", {}));

api("/api/state").then((s) => { state = s; selected = s.attempts.length - 1; render(); }).catch((e) => toast(e.message));
