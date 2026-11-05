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
const expanded = new Set();
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
    if (action === "reset") { tabs = []; active = null; seenAttempts = 0; selected = -1; expanded.clear(); }
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
  if ($("run-btns").dataset.n !== String(state.programs.length)) {
    $("run-btns").dataset.n = state.programs.length;
    $("run-btns").innerHTML = state.programs.map((p, i) => `<button class="run-btn" data-p="${i}" title="Run ${esc(p)} on the agent's latest patch">▸ ${esc(p)}</button>`).join("");
    $("run-btns").querySelectorAll(".run-btn").forEach((b) => b.addEventListener("click", () => runProgram(+b.dataset.p)));
  }
  $("btn-ask").disabled = state.busy;
  const v = view();
  renderTree(v);
  renderTabs(v);
  renderEditor(v);
  renderChat();
  renderPanel(v);
  renderChrome(v);
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
    const ext = f.split(".").pop();
    return `<div class="file ${f === active ? "active" : ""} ${v && !badges ? "dim" : ""}" data-f="${esc(f)}">
      <span class="ftype ${ext}">${ext === "py" ? "py" : "md"}</span><span class="name">${esc(f)}</span>${badges}</div>`;
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
  const failing = new Set(r.tests.filter((t) => FAILED(t.status)).map((t) => t.id));
  const all = chains(r);
  const chip = (id, h) => {
    const broken = (ev[id] || []).filter((t) => failing.has(t)).length;
    const kind = changed.has(id) ? (broken ? "changed broken-own" : "changed") : broken ? "broken" : gaps.has(id) ? "gap" : "covered";
    const hops = `${h} hop${h > 1 ? "s" : ""}`;
    const note = changed.has(id) ? (broken ? `changed · ${broken} test${broken > 1 ? "s" : ""} fail` : "changed") : broken ? `${hops} · ${broken} test${broken > 1 ? "s" : ""} fail`
      : gaps.has(id) ? `${hops} · no tests` : `${hops} · ${(ev[id] || []).length} tests`;
    return `<span class="node ${kind}"><code>${esc(label(id))}</code><small>${note}</small></span>`;
  };
  const roots = [...new Set([...r.changed.map((c) => c.id), ...all.map((c) => c[0])])];
  return roots.map((root) => {
    const branches = all.filter((c) => c[0] === root && c.length > 1).slice(0, 4);
    return `<div class="tree">${chip(root, 0)}<div class="branches">${branches.map((c) =>
      `<div class="chain">${c.slice(1).map((id, k) => `<span class="arrow">←</span>${chip(id, k + 1)}`).join("")}</div>`
    ).join("") || '<div class="chain"><small class="none">no other code depends on it</small></div>'}</div></div>`;
  }).join("") + (all.length > 4 ? `<div class="more">+${all.length - 4} more paths in the graph</div>` : "");
}

const label = (id) => (id.startsWith("file:") ? id.slice(5) : id.split(".").pop());
const fn = (id) => (id.startsWith("file:") ? label(id) : `${label(id)}()`);

function headline(a) {
  // one plain-English sentence for the card
  const r = a.report;
  const touched = new Set(Object.keys(parseDiff(a.diff)));
  const nodes = Object.fromEntries(r.graph.nodes.map((n) => [n.id, n]));
  const failing = r.tests.filter((t) => FAILED(t.status));
  if (failing.length) {
    const victims = [...new Set(failing.flatMap((t) => t.path.slice(1, -1)))];
    const outside = victims.filter((v) => nodes[v] && !touched.has(nodes[v].file));
    if (outside.length) return `Broke ${outside.map((v) => `<code>${esc(fn(v))}</code> in <code>${esc(nodes[v].file)}</code>`).join(", ")}, a file the agent never touched`;
    if (victims.length) return `Broke ${victims.map((v) => `<code>${esc(fn(v))}</code>`).join(", ")}, which depends on the change`;
    return `Its own test fails: <code>${esc(failing[0].id.split(".").pop())}</code>`;
  }
  if (r.gaps.length) return `No regressions, but ${r.gaps.map((g) => `<code>${esc(fn(g))}</code>`).join(", ")} has no test`;
  return "Every affected function is tested and passing";
}

function oneLiner(a) {
  const changed = a.report.changed.map((c) => fn(c.id)).join(", ") || "tests only";
  const icon = `<b class="v-${a.report.verdict}">${CHIP[a.report.verdict]}</b>`;
  return `${a.source === "tests" ? "added tests" : `changed <code>${esc(changed)}</code>`} · ${icon} ${headline(a)}`;
}

function dependencyCard(a, i) {
  const r = a.report;
  const latest = i === state.attempts.length - 1;
  const failed = r.tests.filter((t) => FAILED(t.status));
  const direct = r.tests.filter((t) => t.scope === "direct" && !t.why.includes("added by patch"));
  let action = "";
  if (latest && !state.busy && r.verdict === "regression") action = `<button class="btn primary sm" data-act="revise">Fix it using this evidence</button>`;
  if (latest && !state.busy && r.verdict === "unvalidated") action = `<button class="btn primary sm" data-act="cover">Write tests for ${esc(r.gaps.map(fn).join(", "))}</button>`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return `<div class="card dep-card ${r.verdict}" data-i="${i}">
    <div class="card-title"><span class="vchip ${r.verdict}">${CHIP[r.verdict]}</span>
      <a class="view-graph" data-i="${i}" title="Replay on graph">▶ replay</a></div>
    <div class="headline">${headline(a)}</div>
    ${chainHtml(r)}
    <div class="contrast-line">Typical agent checks <b>${plural(direct.length, "test")}</b> · dependency graph checked
      <b>${plural(r.impacted.length, "dependent")}, ${plural(r.tests.length, "test")}</b>${failed.length ? ` · <b class="bad">${failed.length} failing</b>` : ""}</div>
    ${action}
  </div>`;
}

const STAGES = [["fix", "Fix"], ["check", "Check"], ["revise", "Revise"], ["tests", "Tests"], ["done", "Validated"]];

function stage() {
  const a = state.attempts;
  if (!a.length) return state.busy ? "fix" : null;
  const last = a[a.length - 1];
  if (state.busy) return last.report.verdict === "regression" ? "revise" : "tests";
  if (last.report.verdict === "validated") return "done";
  if (last.report.verdict === "unvalidated") return "tests";
  return a.length > 1 ? "revise" : "check";
}

function renderStepper() {
  const cur = stage();
  const idx = STAGES.findIndex(([k]) => k === cur);
  $("stepper").innerHTML = STAGES.map(([k, label], n) =>
    `<span class="stp ${n < idx ? "past" : n === idx ? "now" : ""}">${label}</span>`).join('<span class="stp-sep">/</span>');
}

function renderChat() {
  renderStepper();
  const chat = $("chat");
  if (!state.request && !state.attempts.length) {
    chat.innerHTML = `<div class="chat-empty">▶ Run the program, then tell the agent what looks wrong.<br>
      After every change, the dependency graph checks everything the change touches.</div>`;
    return;
  }
  const last = state.attempts.length - 1;
  const parts = [`<div class="msg user">${esc(state.request)}</div>`];
  state.attempts.forEach((a, i) => {
    if (i < last && !expanded.has(i)) {
      parts.push(`<div class="row-collapsed ${a.report.verdict}" data-x="${i}"><span class="n">${i + 1}</span><span>${oneLiner(a)}</span></div>`);
      return;
    }
    const intro = a.source === "tests" ? "Added tests for the untested code" : a.source === "revision" ? "Revised using the dependency evidence" : "Proposed fix";
    parts.push(`<div class="msg agent ${i === selected ? "selected" : ""}" data-i="${i}">
      <div class="who"><span>${i + 1} · ${intro}</span>${i < last ? `<a class="collapse" data-x="${i}">collapse</a>` : ""}</div>
      <div class="expl">${esc(a.explanation).replace(/^((?:Locked .+? depends? on it\. ?)+)/, '<span class="lock">$1</span>')}</div>
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
  chat.querySelectorAll("[data-x]").forEach((el) => el.addEventListener("click", (e) => {
    e.stopPropagation();
    const i = +el.dataset.x;
    expanded.has(i) ? expanded.delete(i) : expanded.add(i);
    selected = i;
    $("graph").dataset.key = "";
    render();
  }));
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
      <span class="st ${FAILED(t.status) ? "bad" : t.status === "passed" ? "ok" : ""}">${FAILED(t.status) ? "fail" : t.status === "passed" ? "pass" : "–"}</span>
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
    <h4>No test evidence</h4>${list(r.gaps.map((g) => `<div class="item" style="color:var(--amber)">${esc(g)}</div>`), "none")}
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
  const failedTests = v.r.tests.filter((t) => FAILED(t.status));
  const failed = failedTests.length;
  steps.push({ ids: v.r.tests.map((t) => t.id), tone: failed ? "bad" : "",
    text: `${v.r.tests.length} tests reach the change · ${v.r.tests.length - failed} passed${failed ? ` · ${failed} failed` : ""}` });
  if (v.r.gaps.length) steps.push({ ids: v.r.gaps, tone: "warn", text: `⚠ No test reaches ${v.r.gaps.map(short).join(", ")}` });
  if (failed) {
    const far = failedTests.reduce((a, b) => (b.path.length > a.path.length ? b : a));
    steps.push({ ids: far.path, tone: "bad", text: `Broken through the graph: ${far.path.map((id) => short(id.split(".").pop())).join(" → ")}` });
  } else if (!v.r.gaps.length) steps.push({ ids: [], tone: "good", text: "Every affected function is covered by a passing test" });

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
  if (cy.zoom() > 1.0) { cy.zoom(1.0); cy.center(focus); }
  cy.on("tap", "node", (e) => openFile(e.target.data("file"), e.target.data("line")));
  if (animate) ripple(v);
}

async function runProgram(program) {
  try {
    const res = await api("/api/run", { program });
    runs.push(res.run);
    panelTab = "terminal";
    renderTerminal();
    render();
  } catch (e) { toast(e.message); }
}

function renderTerminal() {
  if (!runs.length) return;
  const shade = (text) => esc(text).replace(/^(.*\btotal\b.*)$/gim, (line) => `<span class="hl">${line}</span>`);
  $("terminal").innerHTML = runs.map((r) => `<div class="term-run">
      <div class="term-cmd">$ ${esc(r.cmd)}<span class="tag">${esc(r.label)}</span></div>
      <div class="term-out">${shade(r.output)}</div></div>`).join("");
  $("terminal").scrollTop = $("terminal").scrollHeight;
}

function renderChrome(v) {
  // breadcrumb: repo > file > symbol under the first changed/annotated line
  const sym = v && active ? Object.values(v.nodes).find((n) => n.file === active && (v.changed.has(n.id) || n.id in v.impacted)) : null;
  $("breadcrumb").innerHTML = active ? `${esc(state.repo)} <span>›</span> <b>${esc(active)}</b>${sym ? ` <span>›</span> ${esc(sym.name)}` : ""}` : "";
  const r = v?.r;
  const failed = r ? r.tests.filter((t) => FAILED(t.status)).length : 0;
  const nodes = r ? r.graph.nodes.length : 0;
  const edges = r ? r.graph.edges.length : 0;
  $("statusbar").innerHTML = `<span>⎇ main</span><span>graph: ${esc(state.store)}${r ? ` · ${nodes} nodes · ${edges} edges` : ""}</span>
    <span class="sb-right">${r ? `<span class="${failed ? "bad" : r.gaps.length ? "warn" : "ok"}">tests ${r.tests.length - failed}/${r.tests.length} passing${r.gaps.length ? ` · ${r.gaps.length} untested` : ""}</span>` : ""}
    <span>${esc(state.model)} · local</span><span>${state.busy ? "agent working…" : "idle"}</span></span>`;
}

// ---------- resizable panes ----------
const LIMITS = { left: [140, 420], right: [300, 640], panel: [140, () => window.innerHeight - 200] };
const root = document.documentElement;

function setSize(key, px) {
  const [min, maxRaw] = LIMITS[key];
  const max = typeof maxRaw === "function" ? maxRaw() : maxRaw;
  const v = Math.max(min, Math.min(max, px));
  root.style.setProperty(key === "panel" ? "--panel-h" : `--${key}`, `${v}px`);
  localStorage.setItem(`pane-${key}`, v);
  if (cy) { cy.resize(); }
}

["left", "right", "panel"].forEach((k) => { const v = localStorage.getItem(`pane-${k}`); if (v) setSize(k, +v); });

document.querySelectorAll(".gutter").forEach((g) => g.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const key = g.dataset.g;
  const startX = e.clientX, startY = e.clientY;
  const start = key === "left" ? document.querySelector(".explorer").offsetWidth
    : key === "right" ? document.querySelector(".agent").offsetWidth : document.querySelector(".panel").offsetHeight;
  g.classList.add("dragging");
  document.body.classList.add("resizing", key === "panel" ? "row" : "col");
  const move = (ev) => setSize(key, key === "left" ? start + ev.clientX - startX
    : key === "right" ? start - (ev.clientX - startX) : start - (ev.clientY - startY));
  const up = () => {
    g.classList.remove("dragging");
    document.body.classList.remove("resizing", "row", "col");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (cy) { cy.resize(); cy.fit(cy.nodes().not(".faded"), 28); }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}));

$("btn-max").addEventListener("click", () => {
  const h = document.querySelector(".panel").offsetHeight;
  const big = window.innerHeight - 200;
  setSize("panel", h < big - 20 ? big : 310);
  if (cy) cy.fit(cy.nodes().not(".faded"), 28);
});
window.addEventListener("resize", () => { if (cy) cy.resize(); });

// ---------- events ----------
$("btn-ask").addEventListener("click", () => act("ask", { request: $("request").value.trim() }));
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
