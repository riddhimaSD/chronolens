// The Event Dossier: the hero investigation view (and its "rejected candidate" twin).
import { S, on, emit, syncBody } from "./store.js";
import { api } from "./api.js";
import { mountInstrument } from "./instrument.js";
import { setCursor, play, stopPlay, redrawChrono } from "./chrono.js";
import { $, $$, esc, ms, fmtDate, fmtMs, pct, stageAt, STAGES, toast, sleep, download, DAY, TYPE_UP } from "./util.js";
import { strandSVG } from "./strand.js";

let D = null;   // dossier context
let unsub = null;

const COMP = { persistence: "Persistence", deviation: "Baseline deviation", optical: "Optical evidence", sar: "SAR evidence", quality: "Data quality", registration: "Registration", semantic: "Semantic consistency", onset: "Onset certainty" };
const ICON = { pass: "✓", warn: "~", fail: "✕", skipped: "–" };
const REJECT_REASONS = ["Seasonal variation", "Flood / water", "Cloud / shadow", "Registration issue", "Not relevant"];

export function askReason(title, sub, options = REJECT_REASONS) {
  return new Promise((res) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><p>${esc(sub)}</p><div class="opts">${options.map((o) => `<button data-r="${esc(o)}">${esc(o)}</button>`).join("")}</div><div class="row"><button class="btn" data-r="">CANCEL</button></div></div>`;
    document.body.appendChild(back);
    back.addEventListener("click", (e) => {
      const b = e.target.closest("[data-r]");
      if (b || e.target === back) { back.remove(); res(b ? b.dataset.r || null : null); }
    });
  });
}

export const dossierId = () => D?.id;

export async function openDossier(id, kind = "event", opts = {}) {
  if (D) await closeDossier(true);
  const root = $("#dossier");
  S.prevView = S.view === "dossier" ? S.prevView : S.view;
  S.view = "dossier";
  S.selectedId = id;
  syncBody();
  root.hidden = false;
  root.classList.remove("open");
  root.innerHTML = `<div class="d-head"><div class="d-id"><div class="crumb"><button data-a="close">← BACK TO MAP</button></div><h1>${kind === "candidate" ? "CANDIDATE" : "CHANGE EVENT"} #${id.slice(2)}</h1></div></div><div class="d-body"><div class="empty" style="grid-column:1/-1">Loading evidence…</div></div>`;
  requestAnimationFrame(() => root.classList.add("open"));
  const isEv = kind === "event";
  const [rec, traj, imag, evi] = await Promise.all([
    isEv ? api.event(id) : api.candidate(id),
    api.trajectory(id, kind),
    api.imagery(id, kind),
    isEv ? api.evidence(id) : Promise.resolve(null),
  ]);
  const summ = isEv ? S.eventMap.get(id) : S.candMap.get(id);
  D = { id, kind, rec, traj, imag, evi, summ, sensor: "s2", swipe: { on: false, x: 0.5 }, tab: "prov", inst: null, autoPlayed: false, interacted: false };
  D.seq = isEv ? rec.state_sequence : null;
  const cp = traj.change_point;
  D.window = isEv ? [ms(cp.last_clean_pre), ms(cp.first_supporting)] : null;
  const lastUsable = [...imag.s2].reverse().find((f) => f.usable) || imag.s2[imag.s2.length - 1];
  D.endT = ms(lastUsable.date);
  D.preT = isEv ? ms(cp.last_clean_pre) : ms(rec.conventional.date_a);
  D.changeT = isEv ? ms(cp.first_supporting) : ms(rec.conventional.date_b);
  render();
  emit("view");
  preload();
  unsub = on("cursor", onCursor);
  // initial cursor + story
  if (isEv) {
    setCursor(S.t0, "dossier");
    await sleep(650);
    if (D && D.id === id && !D.interacted) play(S.t0, 4600, () => { if (D) D.autoPlayed = true; }, D.endT);
  } else {
    setCursor(D.changeT, "dossier");
    flipCompare();
  }
}

export async function closeDossier(silent = false) {
  if (!D) return;
  stopPlay();
  D.inst && D.inst.destroy();
  const root = $("#dossier");
  root.classList.remove("open");
  D = null;
  S.dossier = null;
  S.view = S.prevView || "explore";
  syncBody();
  if (!silent) {
    await sleep(240);
    root.hidden = true;
    root.innerHTML = "";
    setCursor(S.t1, "dossier");
    emit("view");
    emit("markers");
  } else {
    root.innerHTML = "";
  }
}

function preload() {
  const frames = [...D.imag.s2, ...D.imag.s1];
  frames.forEach((f) => { const i = new Image(); i.src = f.url; });
}

// ------------------------------------------------------------------ render
function render() {
  const { rec, kind, summ } = D;
  const isEv = kind === "event";
  const root = $("#dossier");
  const conf = isEv ? rec.confidence : null;
  const on_ = isEv ? rec.onset : null;
  S.dossier = { id: D.id, seq: D.seq, window: D.window };
  const status = isEv ? S.eventMap.get(D.id)?.status || rec.status : rec.status;
  const head = isEv
    ? `
    <div class="d-id"><div class="crumb"><button data-a="close">← BACK TO MAP</button><span>/</span><span>${esc(rec.site)} · TILE ${esc(rec.tile_id)}</span></div>
      <h1>CHANGE EVENT #${rec.num}<small>${statusChip(status)}</small></h1></div>
    <div class="d-metrics">
      <div class="d-m"><span class="lbl">TYPE</span><div class="v">${esc(rec.type_label.toUpperCase())}</div><div class="sub">${esc(rec.direction)} · ${esc(rec.summary.length > 46 ? rec.context.river_dist_m + " m from river" : rec.summary)}</div></div>
      <div class="d-m"><span class="lbl">CONFIDENCE</span><div class="v ${conf.tier === "high" ? "mint" : conf.tier === "medium" ? "amber" : "coral"}">${pct(conf.score)}%<small>${conf.tier.toUpperCase()}</small></div><div class="sub">evidence-based · ${rec.checks.filter((c) => c.status === "pass").length}/${rec.checks.length} checks</div></div>
      <div class="d-m"><span class="lbl">ONSET</span><div class="v amber">${fmtDate(on_.estimate)}<small>± ${Math.round(on_.half_width_days)} D</small></div><div class="sub">first supporting obs ${fmtDate(on_.first_supporting).slice(0, 6)} · ${on_.first_supporting_sensor}</div></div>
      <div class="d-m"><span class="lbl">PERSISTENCE</span><div class="v">${rec.duration_days} D<small>${rec.persistence_obs} obs</small></div><div class="sub">${rec.context.river_dist_m} m from river · ${rec.area_ha} ha</div></div>
    </div>
    <div class="d-act">
      <button class="btn primary" data-a="fml"><svg width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.4" fill="currentColor"/><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.5 2"/></svg>FIND MORE LIKE THIS</button>
      <button class="btn ok ${status === "analyst_confirmed" ? "on" : ""}" data-a="confirm">✓ CONFIRM</button>
      <button class="btn bad" data-a="reject">✕ REJECT</button>
      <button class="btn" data-a="export">EXPORT GEOJSON</button>
      <button class="btn x" data-a="close" title="Close (Esc)">✕</button>
    </div>`
    : `
    <div class="d-id"><div class="crumb"><button data-a="close">← BACK TO MAP</button><span>/</span><span>WHY WE DIDN'T ALERT</span></div>
      <h1>CANDIDATE #${rec.num}<small><span class="stat ${rec.status === "downgraded" ? "down" : ""}">${esc(rec.status_label)}</span></small></h1></div>
    <div class="d-metrics">
      <div class="d-m"><span class="lbl">LOOKED LIKE</span><div class="v">${esc(rec.conventional.guess.replace("Possible ", "").split(" / ")[0].toUpperCase())}</div><div class="sub">${esc(rec.conventional.delta)} between A and B</div></div>
      <div class="d-m"><span class="lbl">STOPPED BY</span><div class="v coral">${esc((rec.checks.find((c) => c.status === "fail" || c.status === "warn") || {}).label || "").split(" ").slice(0, 3).join(" ").toUpperCase()}</div><div class="sub">layer ${rec.checks.findIndex((c) => c.status === "fail" || c.status === "warn") + 1} of ${rec.checks.length}</div></div>
      <div class="d-m"><span class="lbl">WOULD-BE CONFIDENCE</span><div class="v">${pct(rec.candidate_score)}%<small>&lt; 65% gate</small></div><div class="sub">alert threshold not met</div></div>
      <div class="d-m"><span class="lbl">LOCATION</span><div class="v">${rec.river_dist_m} m<small>from river</small></div><div class="sub">${esc(rec.tile_id)}</div></div>
    </div>
    <div class="d-act">
      <button class="btn primary" data-a="promote">↑ PROMOTE TO REVIEW</button>
      <button class="btn x" data-a="close" title="Close (Esc)">✕</button>
    </div>`;

  const sens = isEv
    ? `<div class="ring-legend" style="padding:0 18px 12px;display:flex;flex-direction:column;gap:6px;margin-top:2px">
        ${sensorLine("SENTINEL-2", "s2", rec.sensor_evidence.s2, rec.sensor_evidence.s2_detail)}
        ${sensorLine("SENTINEL-1", "s1", rec.sensor_evidence.s1, rec.sensor_evidence.s1_detail)}
      </div>` : "";

  root.innerHTML = `
    <div class="d-head">${head}</div>
    <div class="d-body">
      <div class="d-col c1">
        <div class="panel-h"><span class="lbl">IMAGERY · <b>1.1 KM CHIP</b></span><span class="r">
          <div class="mini-seg" id="v-sensor"><button data-v="s2" class="on">S2</button><button data-v="s1">S1</button><button data-v="fused">FUSED</button></div>
          <div class="tgl" id="v-swipe"><i></i>BEFORE / AFTER</div></span></div>
        <div class="viewer" id="viewer">
          <img id="imgA" alt="Sentinel-2 chip"><img id="imgB" alt="Sentinel-1 chip" style="opacity:0"><img id="imgPre" class="img-b" alt="Before" style="opacity:0">
          <div class="veil"></div>
          <div class="reticle"></div>
          <div class="vt"><span class="date" id="v-date">—</span><span class="chip s2" id="v-sens">S2</span><span class="chip warn" id="v-stage" ${isEv ? "" : "hidden"}></span></div>
          <div class="maskbar" id="v-mask"></div>
          <div class="lab-b" id="lab-b" hidden>BEFORE</div><div class="lab-a" id="lab-a" hidden>AFTER</div>
          <div class="swipe-h" id="swipe-h" hidden></div>
          <div class="vb"><div class="scale mono"><i></i>≈ 250 m</div><span class="chip mute" id="v-scene">—</span></div>
        </div>
        <div class="tri" id="tri"></div>
        ${isEv ? `<div class="stages" id="stages"><div class="lbl">CHANGE PROCESS · STAGE AT CURSOR</div><div class="row" id="stage-row"></div></div>` : ""}
      </div>
      <div class="d-col c2">
        ${isEv ? "" : compareHTML()}
        <div class="panel-h"><span class="lbl">TEMPORAL TRAJECTORY · <b>OBSERVED VS. EXPECTED FOR THIS LOCATION</b></span><span class="r">
          <div class="mini-seg" id="i-view"><button data-v="value" class="on">VALUE</button><button data-v="dev">DEVIATION σ</button></div>
          <div class="tgl on" id="i-base"><i></i>SEASONAL BASELINE</div>
          ${isEv ? `<button class="btn" id="i-play" style="height:28px;padding:0 10px;font-size:9px">▶ REPLAY</button>` : ""}</span></div>
        <div class="inst-wrap" id="inst-host"></div>
        <div class="inst-note">
          <span><i style="border-color:#3fd0e8"></i>observed (S2)</span><span><i style="border-color:#a98bff"></i>observed (S1)</span>
          <span><i style="border-color:rgba(140,168,204,.6);border-top-style:solid;height:7px;border-top-width:7px;opacity:.4"></i>location-specific seasonal band</span>
          <span><i style="border-color:rgba(170,190,215,.25)"></i>same season, prior year</span>
          <span><i style="border-color:#ffb020;border-top-style:dotted"></i>counterfactual expected</span>
          <span style="color:#66768a">○ masked observation (cloud, shadow, haze, registration)</span>
        </div>
        ${isEv ? `<div class="inst-note" style="margin-top:8px;color:var(--tx2)">${esc(rec.summary)}</div>` : `<div class="inst-note" style="margin-top:10px;color:var(--tx2)">${esc(rec.explanation)}</div>`}
      </div>
      <div class="d-col c3">
        <div class="panel-h"><span class="lbl">VERIFICATION LADDER · <b>${isEv ? "EVIDENCE CHAIN" : "WHERE IT STOPPED"}</b></span></div>
        <div class="ladder" id="ladder"></div>
        ${isEv ? `<div class="panel-h" style="padding-top:18px"><span class="lbl">CONFIDENCE · <b>COMPONENTS</b></span></div><div class="ring-wrap" id="ring"></div>${sens}` : ""}
        <div class="d-tabs"><button data-t="prov" class="on">PROVENANCE</button><button data-t="audit">AUDIT</button></div>
        <div id="d-tab"></div>
      </div>
    </div>`;
  buildTri();
  buildLadder();
  if (isEv) buildRing();
  mountInst();
  bindDossier();
  loadTab();
  onCursor();
}

const statusChip = (s) => ({ analyst_confirmed: '<span class="chip ok">✓ ANALYST CONFIRMED</span>', analyst_rejected: '<span class="chip bad">ANALYST REJECTED</span>', system_confirmed: '<span class="chip">SYSTEM VERIFIED</span>' }[s] || "");

function sensorLine(name, k, state, detail) {
  const cls = state === "supports" ? "s" + k[1] : state === "ambiguous" || state === "unavailable" ? "warn" : "bad";
  const tx = { supports: "SUPPORTS", ambiguous: "AMBIGUOUS · TIER DOWNGRADED", unavailable: "UNAVAILABLE", contradicts: "CONTRADICTS" }[state];
  return `<div style="display:flex;gap:8px;align-items:baseline"><span class="chip ${cls}">${k.toUpperCase()} ${state === "supports" ? "✓" : state === "contradicts" ? "✕" : "~"}</span><span style="font:400 10.5px var(--f-mono);color:var(--tx3)">${tx} · ${esc(detail || "")}</span></div>`;
}

function compareHTML() {
  const c = D.rec;
  return `<div class="panel-h" style="padding-bottom:8px"><span class="lbl">SAME CANDIDATE · <b>TWO SYSTEMS</b></span><span class="lbl" style="color:var(--tx4)">click to compare</span></div>
    <div class="cmp"><div class="cmp-h"><button class="cv on" data-m="cv">CONVENTIONAL SYSTEM</button><button class="cl" data-m="cl">CHRONOLENS</button></div><div class="cmp-b cv" id="cmp-b"></div></div>`;
}
function setCompare(mode) {
  const c = D.rec, b = $("#cmp-b");
  if (!b) return;
  $$(".cmp-h button").forEach((x) => x.classList.toggle("on", x.dataset.m === mode));
  b.className = "cmp-b " + mode;
  const step = c.checks.find((x) => x.status === "fail" || x.status === "warn");
  b.innerHTML = mode === "cv"
    ? `<div class="sw"><span class="stamp">ALERT</span><div class="big">CHANGE DETECTED</div><div class="sm">${esc(c.conventional.guess)}.<br><span class="mono" style="color:var(--tx3)">${esc(c.conventional.delta)} · A ${fmtDate(c.conventional.date_a)} → B ${fmtDate(c.conventional.date_b)}</span></div><div class="sm" style="color:var(--tx3)">A two-date difference sees only A and B. It cannot tell season, cloud, shadow or misregistration from a real change.</div></div>`
    : `<div class="sw"><span class="stamp">${esc(c.status_label)}</span><div class="big">${c.status === "downgraded" ? "DOWNGRADED · NO ALERT" : "NO ALERT"}</div><div class="sm"><b style="color:var(--tx)">Reason:</b> ${esc(c.explanation)}</div><div class="sm mono" style="color:var(--coral)">✕ ${esc(step?.label || "")}<br><span style="color:var(--tx3)">${esc(step?.detail || "")}</span></div></div>`;
}
async function flipCompare() {
  setCompare("cv");
  await sleep(1700);
  if (D && D.kind === "candidate" && !D.cmpTouched) setCompare("cl");
}

// ------------------------------------------------------------------ pieces
function frameFor(sensor, t) {
  const fr = D.imag[sensor];
  let best = fr[0], bd = Infinity;
  for (const f of fr) { const d = Math.abs(ms(f.date) - t); if (d < bd) { bd = d; best = f; } }
  return best;
}
function usableFrameFor(sensor, t) {
  const fr = D.imag[sensor].filter((f) => f.usable);
  let best = fr[0], bd = Infinity;
  for (const f of fr) { const d = Math.abs(ms(f.date) - t); if (d < bd) { bd = d; best = f; } }
  return best;
}

function buildTri() {
  const isEv = D.kind === "event";
  const items = [
    [isEv ? "BEFORE" : "DATE A", D.preT],
    [isEv ? "CHANGE" : "DATE B", D.changeT],
    ["AFTER", D.endT],
  ];
  $("#tri").innerHTML = items.map(([lab, t], i) => {
    const f = usableFrameFor("s2", t);
    return `<button data-t="${t}" data-i="${i}"><img src="${f.url}" alt=""><span>${lab}<em>${fmtDate(f.date)}</em></span></button>`;
  }).join("");
}

function buildLadder() {
  const checks = D.kind === "event" ? D.evi.checks : D.rec.checks;
  $("#ladder").innerHTML = checks.map((c) => `<div class="lad ${c.status}"><span class="ic">${ICON[c.status]}</span><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></div>`).join("");
  $$("#ladder .lad").forEach((n, i) => setTimeout(() => n.classList.add("in"), 500 + i * 95));
}

function buildRing() {
  const c = D.rec.confidence, R = 54, W_ = 14, cx = 70, cy = 70;
  const keys = Object.keys(c.weights);
  let ang = -90, segs = "";
  const arc = (a0, a1, r) => {
    const p = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  const col = c.tier === "high" ? "#4fe3b0" : c.tier === "medium" ? "#ffb020" : "#ff6b6b";
  keys.forEach((k) => {
    const span = c.weights[k] * 360 - 3.5;
    const a0 = ang + 1.75, a1 = a0 + span;
    segs += `<path d="${arc(a0, a1, R)}" stroke="rgba(150,172,196,.18)" stroke-width="${W_}" fill="none"><title>${COMP[k]}</title></path>`;
    segs += `<path d="${arc(a0, a0 + span * c.components[k], R)}" stroke="${col}" stroke-width="${W_}" fill="none" data-k="${k}"><title>${COMP[k]} · ${pct(c.components[k])}% · weight ${pct(c.weights[k])}%</title></path>`;
    ang += c.weights[k] * 360;
  });
  $("#ring").innerHTML = `<svg width="140" height="140" viewBox="0 0 140 140">${segs}
      <text x="70" y="70" text-anchor="middle" style="font:500 28px 'Space Grotesk';fill:#dde5ee;letter-spacing:-.02em">${pct(c.score)}</text>
      <text x="70" y="88" text-anchor="middle" style="font:600 8.5px Inter;letter-spacing:.16em;fill:${col}">${c.tier.toUpperCase()}</text></svg>
    <div class="ring-legend">${keys.map((k) => `<div data-k="${k}"><span>${COMP[k]}</span><b>${pct(c.components[k])}</b></div>`).join("")}</div>`;
  $$("#ring .ring-legend div").forEach((d) => {
    d.addEventListener("mouseenter", () => $$(`#ring path[data-k]`).forEach((p) => (p.style.opacity = p.dataset.k === d.dataset.k ? 1 : 0.25)));
    d.addEventListener("mouseleave", () => $$(`#ring path[data-k]`).forEach((p) => (p.style.opacity = 1)));
  });
}

function mountInst() {
  D.inst && D.inst.destroy();
  D.inst = mountInstrument($("#inst-host"), { traj: D.traj, kind: D.kind, ev: D.rec, cand: D.kind === "candidate" ? D.rec : null, onInteract: () => (D.interacted = true) });
}

// ------------------------------------------------------------------ cursor-linked updates
let lastA = "", lastB = "", lastP = "";
function onCursor() {
  if (!D) return;
  const t = S.cursor;
  const sensor = D.sensor;
  const f2 = frameFor("s2", t), f1 = frameFor("s1", t);
  const a = $("#imgA"), b = $("#imgB"), pre = $("#imgPre");
  if (!a) return;
  if (f2.url !== lastA) { a.src = f2.url; lastA = f2.url; }
  if (f1.url !== lastB) { b.src = f1.url; lastB = f1.url; }
  a.style.opacity = sensor === "s1" ? 0 : 1;
  b.style.opacity = sensor === "s2" ? 0 : sensor === "fused" ? 0.5 : 1;
  b.style.mixBlendMode = sensor === "fused" ? "screen" : "normal";
  const shown = sensor === "s1" ? f1 : f2;
  $("#v-date").textContent = fmtDate(shown.date);
  const sc = $("#v-sens");
  sc.className = "chip " + (sensor === "s1" ? "s1" : sensor === "s2" ? "s2" : "");
  sc.textContent = sensor === "fused" ? "S2 + S1" : sensor.toUpperCase();
  $("#v-scene").textContent = shown.scene_id.replace("SYN_", "").slice(0, 30);
  const masked = sensor !== "s1" && !f2.usable;
  $("#viewer").classList.toggle("masked", masked);
  if (masked) $("#v-mask").textContent = `S2 MASKED · ${(f2.mask_reason || "").replace("_", " ").toUpperCase()}${f2.cloud_frac ? " " + Math.round(f2.cloud_frac * 100) + "%" : ""} — SENTINEL-1 CONTINUITY IN THE SAR LANE`;
  // stage chip + stepper
  if (D.kind === "event") {
    const st = stageAt(D.seq, t);
    const chip = $("#v-stage");
    chip.textContent = st ? st.toUpperCase() : "";
    buildStages(st);
  }
  // swipe
  const pk = D.swipe.on ? (sensor === "s1" ? frameFor("s1", D.preT) : usableFrameFor("s2", D.preT)) : null;
  if (pk && pk.url !== lastP) { pre.src = pk.url; lastP = pk.url; }
  applySwipe();
  D.inst && D.inst.setCursor();
  redrawChrono();
}

function applySwipe() {
  const on_ = D.swipe.on, pre = $("#imgPre");
  pre.style.opacity = on_ ? 1 : 0;
  pre.style.clipPath = `inset(0 ${(1 - D.swipe.x) * 100}% 0 0)`;
  $("#swipe-h").hidden = !on_;
  $("#lab-b").hidden = !on_; $("#lab-a").hidden = !on_;
  $("#swipe-h").style.left = D.swipe.x * 100 + "%";
  $("#viewer").querySelector(".reticle").style.opacity = on_ ? 0 : "";
}

function buildStages(cur) {
  const row = $("#stage-row");
  if (!row) return;
  const seq = D.seq;
  const names = D.rec.type === "construction" ? STAGES : seq.map((s) => s.state);
  const idx = names.indexOf(cur);
  row.innerHTML = names.map((n, i) => {
    const s = seq.find((x) => x.state === n);
    const cls = s == null ? "fut" : i === idx ? "cur" : i < idx ? "done" : "fut";
    const when = s ? fmtDate(s.start).slice(0, 6) + " " + fmtDate(s.start).slice(-2) : "not reached";
    return `<div class="st ${cls}">${esc(n.toUpperCase())}<em>${when}</em></div>`;
  }).join("");
}

// ------------------------------------------------------------------ interaction
function bindDossier() {
  const root = $("#dossier");
  root.onclick = async (e) => {
    const a = e.target.closest("[data-a]");
    if (a) return act(a.dataset.a);
    const tri = e.target.closest("#tri button");
    if (tri) { D.interacted = true; stopPlay(); setCursor(+tri.dataset.t, "tri"); return; }
    const sv = e.target.closest("#v-sensor button");
    if (sv) { D.sensor = sv.dataset.v; $$("#v-sensor button").forEach((b) => b.classList.toggle("on", b === sv)); lastP = ""; onCursor(); return; }
    if (e.target.closest("#v-swipe")) { D.swipe.on = !D.swipe.on; $("#v-swipe").classList.toggle("on", D.swipe.on); lastP = ""; onCursor(); return; }
    const iv = e.target.closest("#i-view button");
    if (iv) { $$("#i-view button").forEach((b) => b.classList.toggle("on", b === iv)); D.inst.setOptions({ view: iv.dataset.v }); return; }
    if (e.target.closest("#i-base")) { const t = $("#i-base"); t.classList.toggle("on"); D.inst.setOptions({ baseline: t.classList.contains("on") }); return; }
    if (e.target.closest("#i-play")) { D.interacted = true; play(S.t0, 5200, null, D.endT); return; }
    const cm = e.target.closest(".cmp-h button");
    if (cm) { D.cmpTouched = true; setCompare(cm.dataset.m); return; }
    const tab = e.target.closest(".d-tabs button");
    if (tab) { D.tab = tab.dataset.t; $$(".d-tabs button").forEach((b) => b.classList.toggle("on", b === tab)); loadTab(); return; }
    if (e.target.closest("#do-export")) return act("export");
  };
  // swipe handle drag
  const h = $("#swipe-h"), v = $("#viewer");
  let drag = false;
  const move = (ev) => { const r = v.getBoundingClientRect(); D.swipe.x = Math.min(0.98, Math.max(0.02, (ev.clientX - r.left) / r.width)); applySwipe(); };
  h.addEventListener("pointerdown", (e) => { drag = true; h.setPointerCapture(e.pointerId); });
  h.addEventListener("pointermove", (e) => drag && move(e));
  h.addEventListener("pointerup", () => (drag = false));
  v.addEventListener("pointerdown", (e) => { if (D.swipe.on && e.target !== h) { move(e); drag = true; v.setPointerCapture(e.pointerId); } });
  v.addEventListener("pointermove", (e) => drag && D.swipe.on && move(e));
  v.addEventListener("pointerup", () => (drag = false));
  // initial sensor state
  D.sensor = "s2";
}

async function act(a) {
  const id = D.id;
  if (a === "close") return closeDossier();
  if (a === "fml") { const pid = id; await closeDossier(); emit("fml", pid); return; }
  if (a === "export") { download(api.exportUrl([id])); toast("GeoJSON export started", "ok", "features carry source scenes, processing history, quality flags and analyst decisions"); return; }
  if (a === "confirm") {
    const r = await api.feedback(id, "confirm", "", "", { query_id: S.query?.query_id, prototype_id: S.disc?.protoId });
    updateStatus(r.event.status);
    toast(`Event #${D.rec.num} confirmed`, "ok", "written to audit trail · ranking refined");
    emit("feedback", r);
    return;
  }
  if (a === "reject") {
    const reason = await askReason(`Reject event #${D.rec.num}`, "Select a reason. It is stored in the audit trail and used to refine ranking.");
    if (!reason) return;
    const r = await api.feedback(id, "reject", reason, "", { query_id: S.query?.query_id, prototype_id: S.disc?.protoId });
    toast(`Event #${D.rec.num} rejected`, "bad", `reason: ${reason} · removed from results`);
    emit("feedback", r);
    await closeDossier();
    return;
  }
  if (a === "promote") {
    const r = await api.promote(id);
    toast(`Candidate #${D.rec.num} promoted to review`, "", "logged in the audit trail as an analyst override");
    emit("feedback", r);
    loadTab();
  }
}
function updateStatus(s) {
  const h1 = $(".d-id h1 small");
  if (h1) h1.innerHTML = statusChip(s);
  const b = $('[data-a="confirm"]');
  b && b.classList.toggle("on", s === "analyst_confirmed");
}

async function loadTab() {
  const host = $("#d-tab");
  if (!host) return;
  if (D.tab === "audit") {
    const p = await api.provenance(D.id, D.kind);
    host.innerHTML = `<div class="prov"><h5>ANALYST DECISIONS FOR THIS ${D.kind === "event" ? "EVENT" : "CANDIDATE"}</h5>${p.audit.length ? p.audit.slice().reverse().map((a) => `<div class="audit-item"><span class="ts">${esc(a.ts.replace("T", " ").replace("Z", " UTC"))}</span><br><b class="d-${a.decision}">${esc(a.decision.toUpperCase())}</b> by ${esc(a.analyst)}${a.reason ? " · " + esc(a.reason) : ""}${a.note ? `<br><span style="color:var(--tx3)">${esc(a.note)}</span>` : ""}</div>`).join("") : '<div class="empty" style="padding:14px 0;text-align:left">No analyst decisions yet.</div>'}</div>`;
    return;
  }
  host.innerHTML = '<div class="prov"><div class="empty">Loading provenance…</div></div>';
  const p = await api.provenance(D.id, D.kind);
  if (!D || D.id !== p.id) return;
  const tr = p.transform;
  host.innerHTML = `<div class="prov">
    <div class="warn-note">Curated demonstration dataset · scenes and processing records are <b>synthetic</b> and mirror the schema a live pipeline fills.</div>
    <h5>SOURCE SCENES</h5>
    <table>${p.source_scenes.map((s) => `<tr><td>${esc(s.role.toUpperCase())}</td><td><span class="sid">${esc(s.scene_id)}</span><br>${esc(s.sensor)} · ${esc(s.acquired.replace("T", " ").replace("Z", " UTC"))} · ${esc(s.orbit)}</td></tr>`).join("")}</table>
    <div style="font:400 10.5px var(--f-mono);color:var(--tx3);margin-top:6px">${p.observations_used} usable observations · ${p.scene_total.s2} S2 + ${p.scene_total.s1} S1 scenes in STAC</div>
    <h5>PROCESSING</h5>
    ${p.processing.map((s) => `<div class="step"><b>✓</b><span>${esc(s.description)}</span></div>`).join("")}
    <div style="font:400 10.5px var(--f-mono);color:var(--tx3);margin-top:6px">processed ${esc(p.processing_timestamp)} · mode ${esc(p.mode)}</div>
    <h5>GEOSPATIAL</h5>
    <table><tr><td>CRS</td><td>${esc(p.crs)}</td></tr><tr><td>ORIGIN</td><td>${tr[0].toFixed(1)} E · ${tr[3].toFixed(1)} N</td></tr><tr><td>PIXEL</td><td>${tr[1]} m (synthetic grid)</td></tr><tr><td>TILE</td><td>${esc(p.tile_id || "")}</td></tr><tr><td>CENTROID</td><td>${p.centroid[1].toFixed(5)}°N ${p.centroid[0].toFixed(5)}°E</td></tr></table>
    <h5>PROVENANCE CHAIN</h5>
    <div class="chain">${p.chain.map((c) => `<div><span>${esc(c.level)}</span>${esc(c.value)}</div>`).join("")}</div>
    ${D.kind === "event" ? `<div style="margin-top:16px"><button class="btn" id="do-export" style="width:100%;justify-content:center">EXPORT GEOJSON WITH PROVENANCE</button></div>` : ""}
  </div>`;
}

export function refreshDossierStatus() { if (D && D.kind === "event") updateStatus(S.eventMap.get(D.id)?.status); }
