import {
  scoreAll, churnWindows, MAYBE, fmtHM, fmtAgeMs, haversineMiles, nyNow,
} from "./model.js";

const RAW_STATE = "https://raw.githubusercontent.com/kimseyri/parkscout/data/state.json";
const $ = (s) => document.querySelector(s);
const NS = "http://www.w3.org/2000/svg";
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const RAMP = {
  light: [[0, [231, 242, 228]], [0.25, [169, 216, 164]], [0.5, [87, 177, 88]],
          [0.75, [46, 139, 58]], [1, [15, 111, 43]]],
  dark: [[0, [34, 48, 31]], [0.25, [46, 79, 44]], [0.5, [63, 122, 60]],
         [0.75, [79, 164, 74]], [1, [99, 209, 92]]],
};
const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
function rampColor(p) {
  const stops = RAMP[isDark() ? "dark" : "light"];
  for (let i = 1; i < stops.length; i++) {
    if (p <= stops[i][0]) {
      const [p0, c0] = stops[i - 1], [p1, c1] = stops[i];
      const f = (p - p0) / (p1 - p0);
      return `rgb(${c0.map((v, k) => Math.round(v + f * (c1[k] - v))).join(",")})`;
    }
  }
  return `rgb(${stops.at(-1)[1].join(",")})`;
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};

const App = {
  cameras: null, blocks: null, state: null, stateSource: null,
  liveEvents: [], scored: [], selected: null, hunt: null,
  geo: { x: {}, y: () => 0 },
};

async function loadJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function loadState() {
  for (const [url, src] of [["/state/state.json", "proxy"],
                            [`${RAW_STATE}?t=${Date.now()}`, "github"]]) {
    try {
      App.state = await loadJSON(url);
      App.stateSource = src;
      return;
    } catch { /* try next */ }
  }
}

// ------------------------------------------------------------------ map

function el(tag, attrs = {}, parent = null) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function buildMap() {
  const W = 380, PADL = 30, PADR = 14, PADT = 46, PADB = 30, ROW = 26;
  const streets = App.blocks.streets;
  const top = streets[streets.length - 1];
  const yFor = (st) => PADT + (top - st) * ROW;
  const xFor = (ave) => PADL + App.blocks.aveX[ave] * (W - PADL - PADR);
  App.geo = { x: xFor, y: yFor };
  const H = yFor(streets[0]) + PADB;

  const svg = $("#map");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  for (const ave of App.blocks.aveOrder) {
    const x = xFor(ave);
    el("line", { x1: x, y1: yFor(top) - 12, x2: x, y2: yFor(streets[0]) + 12, class: "ave-line" }, svg);
    el("text", { x, y: yFor(top) - 38, class: "ave-label", "text-anchor": "middle" }, svg)
      .textContent = App.blocks.aveShort[ave];
  }
  for (const st of streets) {
    el("text", { x: PADL - 8, y: yFor(st) + 3, class: "st-label", "text-anchor": "end" }, svg)
      .textContent = st;
  }
  for (const b of App.blocks.blocks) {
    const y = yFor(b.street), x1 = xFor(b.west) + 7, x2 = xFor(b.east) - 7;
    const dim = b.inRadius ? "" : " dim";
    el("line", { x1, y1: y, x2, y2: y, class: "blk-under" + dim }, svg);
    el("line", { x1, y1: y, x2, y2: y, class: "blk-val" + dim, "data-id": b.id }, svg);
    const hit = el("line", { x1: x1 - 3, y1: y, x2: x2 + 3, y2: y, class: "blk-hit", "data-id": b.id }, svg);
    hit.addEventListener("click", () => select(b.id));
    hit.addEventListener("pointerenter", (e) => tip(e, b.id));
    hit.addEventListener("pointermove", (e) => tip(e, b.id));
    hit.addEventListener("pointerleave", hideTip);
  }
  for (const c of App.cameras.cameras) {
    const d = el("circle", { cx: xFor(c.ave), cy: yFor(c.st), r: 3.5, class: "cam-dot" }, svg);
    d.addEventListener("pointerenter", (e) => tipText(e, camTip(c)));
    d.addEventListener("pointerleave", hideTip);
  }
  const hx = xFor("5AV") + 0.72 * (xFor("MAD") - xFor("5AV"));
  el("circle", { cx: hx, cy: yFor(68), r: 5.5, class: "home-ring" }, svg);
  el("circle", { cx: hx, cy: yFor(68), r: 2, class: "home-dot" }, svg);
}

function camTip(c) {
  const entry = App.state?.cameras?.[c.id];
  return `${c.name}${entry?.count != null ? ` — ${entry.count} vehicles in view` : ""}`;
}

function paint() {
  for (const s of App.scored) {
    const line = document.querySelector(`.blk-val[data-id="${s.id}"]`);
    if (!line) continue;
    line.style.stroke = s.churnNow ? "var(--warning)" : rampColor(s.p);
    line.classList.toggle("sel", s.id === App.selected);
  }
}

// ------------------------------------------------------------------ tooltip

function tipText(e, text) {
  const t = $("#tip");
  t.textContent = text;
  t.hidden = false;
  t.style.left = `${Math.min(e.clientX + 12, innerWidth - t.offsetWidth - 8)}px`;
  t.style.top = `${e.clientY + 14}px`;
}
function tip(e, id) {
  const s = App.scored.find((x) => x.id === id);
  if (s) {
    tipText(e, s.churnNow
      ? `${s.block.label} — 🧹 cleaning now (ends in ${s.churnEndsIn}m)`
      : `${s.block.label} — ${Math.round(s.p * 100)}% open`);
  }
}
const hideTip = () => { $("#tip").hidden = true; };

// ------------------------------------------------------------------ scoring + ledger

function rescore() {
  if (!App.blocks) return;
  App.liveEvents = App.liveEvents.filter((ev) => Date.now() - ev.ts < 25 * 60000);
  App.scored = scoreAll({
    blocks: App.blocks, cameras: App.cameras, state: App.state,
    liveEvents: App.liveEvents,
  });
  updateLedger();
  paint();
  renderBets();
  renderWindows();
  renderRecent();
  renderHeader();
  if (App.selected) renderPanel(App.selected);
}

function updateLedger() {
  const led = store.get("ps_ledger_v1", { open: {}, closed: [] });
  const now = Date.now();
  for (const s of App.scored) {
    const rec = led.open[s.id];
    const evidenceNow = Math.abs(s.camSum) + Math.abs(s.liveSum) > 0.15;
    if (!rec && s.label === "likely") {
      led.open[s.id] = { opened: now, lastEvidence: evidenceNow ? now : null, peak: s.p };
    } else if (rec) {
      rec.peak = Math.max(rec.peak, s.p);
      if (evidenceNow) rec.lastEvidence = now;
      if (s.p < MAYBE) {
        const reason = s.camSum < -0.4 || s.liveSum < -0.4 ? "arrival evidence" : "decayed";
        led.closed.unshift({ id: s.id, label: s.block.label, opened: rec.opened,
                             closed: now, reason, peak: rec.peak });
        led.closed = led.closed.slice(0, 40);
        delete led.open[s.id];
      }
    }
  }
  store.set("ps_ledger_v1", led);
  App.ledger = led;
}

// ------------------------------------------------------------------ render

function renderHeader() {
  const chip = $("#ageChip");
  if (!App.state?.updated_at) {
    chip.textContent = "no counts yet";
    chip.dataset.tone = "stale";
    return;
  }
  const ageMs = Date.now() - Date.parse(App.state.updated_at);
  const m = ageMs / 60000;
  chip.textContent = `counts ${fmtAgeMs(ageMs)}`;
  chip.dataset.tone = m < 12 ? "good" : m < 30 ? "warn" : "stale";
}

function renderBets() {
  const host = $("#bets");
  const best = App.scored
    .filter((s) => s.block.inRadius && !s.churnNow && s.p >= MAYBE)
    .sort((a, b) => b.p - a.p).slice(0, 3);
  host.innerHTML = "";
  if (!best.length) {
    host.innerHTML = `<div class="bet bet-empty">Nothing likely right now — check the next cleaning window below.</div>`;
    return;
  }
  for (const s of best) {
    const div = document.createElement("div");
    div.className = "bet";
    div.innerHTML = `<div class="bet-p" style="color:${rampColor(s.p)}">${Math.round(s.p * 100)}%</div>
      <div><div class="bet-name">${s.block.label}</div>
      <div class="bet-why">${s.why[1]?.t ?? s.why[0].t}</div></div>`;
    div.addEventListener("click", () => select(s.id));
    host.appendChild(div);
  }
}

function renderWindows() {
  const host = $("#windows");
  if (!App.blocks.regsSource) {
    host.innerHTML = `<div class="win muted">Street-cleaning schedules pending (NYC Open Data was down at build time) — running on camera + time-of-day signals. Rerun scripts/build_blocks.py to backfill.</div>`;
    return;
  }
  const wins = churnWindows(App.blocks).slice(0, 3);
  host.innerHTML = wins.length ? "" : `<div class="win muted">No street-cleaning windows in the next few hours.</div>`;
  const { minutes } = nyNow();
  for (const w of wins) {
    const stateTxt = minutes >= w.start && minutes < w.end
      ? `ends in ${w.end - minutes}m — spots open as it wraps`
      : minutes >= w.end ? `ended ${minutes - w.end}m ago — churn window live`
      : `starts in ${w.start - minutes}m`;
    const div = document.createElement("div");
    div.className = "win";
    div.innerHTML = `<span class="win-icon">🧹</span><div>
      <div class="win-t">${fmtHM(w.start)}–${fmtHM(w.end)} · ${w.side} side · ${w.blocks.length} blocks</div>
      <div class="win-s">${stateTxt}</div></div>`;
    host.appendChild(div);
  }
}

function renderRecent() {
  const host = $("#recent");
  const items = [];
  for (const [id, rec] of Object.entries(App.ledger?.open ?? {})) {
    const s = App.scored.find((x) => x.id === id);
    if (!s) continue;
    items.push(`<li><span class="dot dot-open"></span>${s.block.label} — open likely since ${new Date(rec.opened).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (${fmtAgeMs(Date.now() - rec.opened)})${rec.lastEvidence ? ` · evidence ${fmtAgeMs(Date.now() - rec.lastEvidence)}` : ""}</li>`);
  }
  for (const c of (App.ledger?.closed ?? []).slice(0, 5)) {
    items.push(`<li class="muted"><span class="dot dot-gone"></span>${c.label} — gone ${fmtAgeMs(Date.now() - c.closed)} (${c.reason}) · was live ${Math.max(1, Math.round((c.closed - c.opened) / 60000))}m</li>`);
  }
  host.innerHTML = items.length ? items.join("") : `<li class="muted">No predicted-open spots on the books yet.</li>`;
}

function sideText(rules) {
  if (!rules) return "no sign data";
  const bits = [];
  if (rules.asp) {
    bits.push(`🧹 ${rules.asp.days.map((d) => DAY_NAMES[d]).join(" & ")} ${fmtHM(rules.asp.start)}–${fmtHM(rules.asp.end)}`);
  }
  if (rules.meter >= 2) bits.push("meters");
  if (rules.noStanding + rules.noParking >= 3) bits.push("large no-standing/parking stretch");
  return bits.join(" · ") || "no notable rules parsed";
}

function renderPanel(id) {
  const s = App.scored.find((x) => x.id === id);
  if (!s) return;
  const panel = $("#panel");
  panel.hidden = false;
  const rec = App.ledger?.open?.[id];
  const churn = s.churnNow
    ? `<span class="chip chip-warn">🧹 cleaning now · ends in ${s.churnEndsIn}m</span>` : "";
  panel.innerHTML = `
    <div class="panel-head">
      <div><h2>${s.block.full}</h2><div class="muted">${s.block.dist} mi from home</div></div>
      <button class="x" id="closePanel" aria-label="close">×</button>
    </div>
    <div class="panel-score">
      <span class="p-big" style="color:${rampColor(s.p)}">${Math.round(s.p * 100)}%</span>
      <span class="chip chip-${s.label}">${s.label}</span>${churn}
    </div>
    <div class="stamp">${rec
      ? `predicted open since ${new Date(rec.opened).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${rec.lastEvidence ? ` · last evidence ${fmtAgeMs(Date.now() - rec.lastEvidence)}` : " · no fresh evidence"}`
      : "not currently on the predicted-open ledger"}</div>
    <ul class="why">${s.why.map((w) => `<li>${w.mag > 0.05 ? "▲" : w.mag < -0.05 ? "▼" : "·"} ${w.t}</li>`).join("")}</ul>
    <div class="sides">
      <div><b>N side</b> ${sideText(s.block.sides?.N)}</div>
      <div><b>S side</b> ${sideText(s.block.sides?.S)}</div>
    </div>
    <div class="fb">
      <span>Were you here?</span>
      <button data-got="1">Got a spot</button>
      <button data-got="0">Struck out</button>
    </div>`;
  $("#closePanel").addEventListener("click", () => {
    panel.hidden = true;
    App.selected = null;
    paint();
  });
  panel.querySelectorAll(".fb button").forEach((b) =>
    b.addEventListener("click", () => feedback(id, +b.dataset.got)));
}

function select(id) {
  App.selected = id;
  paint();
  renderPanel(id);
  const b = App.blocks.blocks.find((x) => x.id === id);
  App.priorityIds = [...App.cameras.cameras]
    .sort((c1, c2) => haversineMiles(b.lat, b.lng, c1.lat, c1.lng)
                    - haversineMiles(b.lat, b.lng, c2.lat, c2.lng))
    .slice(0, 2).map((c) => c.id);
  App.hunt?.setPriority(App.priorityIds);
  $("#panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function feedback(id, got) {
  const s = App.scored.find((x) => x.id === id);
  const fb = store.get("ps_fb_v1", []);
  fb.push({ ts: Date.now(), id, p: s?.p ?? null, got });
  store.set("ps_fb_v1", fb);
  renderCalibration();
  toast(got ? "Logged: got a spot 🎉" : "Logged: struck out — model will hear about it");
}

function renderCalibration() {
  const fb = store.get("ps_fb_v1", []).filter((f) => f.p != null);
  const elc = $("#calib");
  if (!fb.length) { elc.textContent = "no ground truth yet — tap feedback after a hunt"; return; }
  const brier = fb.reduce((a, f) => a + (f.p - f.got) ** 2, 0) / fb.length;
  elc.textContent = `${fb.length} checks · Brier ${brier.toFixed(2)} (lower is better)`;
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ------------------------------------------------------------------ hunt wiring

async function toggleHunt() {
  const btn = $("#huntBtn");
  if (App.hunt?.running) {
    App.hunt.stop();
    btn.textContent = "Start hunt mode";
    btn.classList.remove("on");
    return;
  }
  btn.disabled = true;
  btn.textContent = "Loading detector…";
  try {
    if (!App.hunt) {
      const mod = await import("./hunt.js");
      App.hunt = mod.createHunt({
        cameras: App.cameras,
        grid: $("#huntGrid"),
        onStatus: (m) => { $("#huntStatus").textContent = m; },
        onEvent: (ev) => {
          App.liveEvents.push(ev);
          const li = document.createElement("li");
          li.className = ev.type === "departure" ? "ev-dep" : "ev-arr";
          li.textContent = `${new Date(ev.ts).toLocaleTimeString()} — ${ev.type} @ ${ev.name}${ev.type === "departure" ? " → spot likely open nearby" : ""}`;
          $("#huntFeed").prepend(li);
          while ($("#huntFeed").children.length > 20) $("#huntFeed").lastChild.remove();
          rescore();
        },
      });
    }
    if (App.priorityIds) App.hunt.setPriority(App.priorityIds);
    await App.hunt.start();
    btn.textContent = "Stop hunt mode";
    btn.classList.add("on");
  } catch (e) {
    $("#huntStatus").textContent = `hunt mode failed: ${e.message}`;
    btn.textContent = "Start hunt mode";
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ boot

async function boot() {
  try {
    [App.cameras, App.blocks] = await Promise.all([
      loadJSON("./data/cameras.json"), loadJSON("./data/blocks.json"),
    ]);
  } catch (e) {
    document.body.innerHTML = `<p style="padding:2rem">failed to load data: ${e.message}</p>`;
    return;
  }
  await loadState();
  buildMap();
  rescore();
  renderCalibration();
  $("#huntBtn").addEventListener("click", toggleHunt);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rescore);
  setInterval(rescore, 30000);
  setInterval(async () => {
    if (document.visibilityState === "visible") { await loadState(); rescore(); }
  }, 90000);
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible") { await loadState(); rescore(); }
  });
}

boot();
