// Find More Like This: search by change process, compare against visual appearance, lead-time discovery.
import { S, emit, syncBody } from "./store.js";
import { api } from "./api.js";
import { strandSVG } from "./strand.js";
import { $, $$, esc, pct, sleep, toast, flip, STAGES, ease, tween } from "./util.js";
import { M, setArcs, clearArcs, sweep, flyToBounds, flyTo } from "./map.js";

const FACETS = ["shape", "type", "magnitude", "sensor", "context"];
const FLAB = ["SHAPE", "TYPE", "MAG", "SENSOR", "CTX"];
let handlers = {};
export const initDiscovery = (h) => {
  handlers = h;
  const body = $("#rail-body");
  body.addEventListener("input", (e) => {
    const s = e.target.closest("[data-w]");
    if (!s || !S.disc) return;
    S.disc.weights[+s.dataset.w] = +s.value / 100;
    s.closest(".slider").querySelector("b").textContent = s.value;
    if (!S.disc._raf) S.disc._raf = requestAnimationFrame(() => { S.disc._raf = 0; rerank(); });
  });
};

// ------------------------------------------------------------------ start / stop
export async function startDiscovery(id) {
  S.tab = "results";
  const [proc, app] = await Promise.all([api.similar(id), api.appearance(id)]);
  S.disc = { protoId: id, mode: "process", process: proc, appearance: app, weights: proc.weights.slice(), reveal: 0, align: false, tuneOpen: false, marked: {} };
  S.selectedId = id;
  S.view = "discovery";
  syncBody();
  emit("view");
  emit("rail");
  emit("markers");
  const ids = [id, ...proc.results.map((r) => r.id)];
  flyToBounds(ids, 70);
  await sleep(950);
  if (S.view !== "discovery" || S.disc?.protoId !== id) return;
  const proto = S.eventMap.get(id);
  sweep(proto.centroid);
  buildArcs();
  const n = ranked().length;
  for (let k = 1; k <= n; k++) { S.disc.reveal = k; emit("markers"); await sleep(105); }
  S.disc.reveal = 99;
  renderLead();
  emit("markers");
}

export function exitDiscovery() {
  S.disc = null;
  S.view = "explore";
  clearArcs();
  $("#lead").hidden = true;
  syncBody();
  emit("view");
  emit("markers");
  emit("rail");
}

// ------------------------------------------------------------------ ranking
function ranked() {
  const d = S.disc;
  const w = d.weights;
  const s = w.reduce((a, b) => a + b, 0) || 1;
  return d.process.results
    .map((r) => {
      let t = FACETS.reduce((a, k, i) => a + (w[i] / s) * r.facets[k], 0);
      t = Math.min(0.985, 0.5 + (t - 0.5) * 1.15);
      return { ...r, similarity: t };
    })
    .filter((x) => x.similarity >= 0.6)
    .sort((a, b) => b.similarity - a.similarity)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
export const currentResults = () => (S.disc ? (S.disc.mode === "process" ? ranked() : S.disc.appearance.results) : []);

function buildArcs() {
  const d = S.disc;
  const proto = S.eventMap.get(d.protoId);
  if (d.mode === "process") {
    setArcs(ranked().map((r, i) => ({ from: proto.centroid, to: r.centroid, color: "#ffb020", alpha: 0.28 + 0.6 * ((r.similarity - 0.6) / 0.4), width: 1 + 2 * ((r.similarity - 0.6) / 0.4), delay: i * 105 })));
  } else {
    setArcs(d.appearance.results.map((r, i) => ({ from: proto.centroid, to: r.centroid, color: "#c3d8ff", alpha: 0.85, width: 1.8, dash: "5 5", delay: i * 80 })));
  }
}

// ------------------------------------------------------------------ rail
export function renderDiscovery(body) {
  const d = S.disc;
  const p = S.eventMap.get(d.protoId);
  const sig = [`${p.duration_days} D trajectory`, `${p.magnitude_sigma}σ`, `${p.type_label}`, `${p.river_dist_m} m from river`, `stage: ${p.stage}`];
  body.innerHTML = `
    <div class="disc-h"><button data-d="back">← RESULTS</button><span class="lbl">FIND MORE LIKE THIS</span></div>
    <div class="proto"><span class="lbl">CHANGE PROTOTYPE · EXTRACTED FROM EVENT</span>
      <h5>${esc(p.type_label.toUpperCase())} · #${p.num}</h5>
      <div class="ev-strand">${strandSVG(p.strand, { w: 380, h: 64, pad: 5, sw: 1.8 })}</div>
      <div class="sig">${sig.map((s) => `<span class="chip">${esc(s)}</span>`).join("")}</div></div>
    <div class="mode-seg" id="mode-seg">
      <button class="proc ${d.mode === "process" ? "on" : ""}" data-mode="process">CHANGE PROCESS<small>same temporal trajectory</small></button>
      <button class="app ${d.mode === "appearance" ? "on" : ""}" data-mode="appearance">VISUAL APPEARANCE<small>looks alike · image similarity</small></button></div>
    <div id="disc-body">${discBody()}</div>`;
}

function discBody() {
  const d = S.disc;
  return d.mode === "process" ? processBody() : appearanceBody();
}

function processBody() {
  const d = S.disc;
  const res = ranked();
  const earlier = res.filter((r) => r.stage_relation === "earlier").length;
  return `<div class="claim proc">These places changed in the same way.</div>
    <div class="claim-sub">${res.length} events share this change trajectory · <b style="color:var(--amber)">${earlier} at earlier stages</b> of the same process. Similarity is measured on trajectory, not on how the surface looks.</div>
    <div class="tune ${d.tuneOpen ? "open" : ""}" id="tune"><div class="tune-h" data-tune="1"><span class="lbl">TUNE SIMILARITY · 5 FACETS</span><span class="lbl" style="color:var(--amber)">${d.tuneOpen ? "HIDE" : "ADJUST"}</span></div>
      <div class="tune-b">${FACETS.map((f, i) => `<div class="slider"><span>${f}</span><input type="range" min="0" max="100" value="${Math.round(d.weights[i] * 100)}" data-w="${i}"><b>${Math.round(d.weights[i] * 100)}</b></div>`).join("")}
        <div style="display:flex;justify-content:space-between;margin-top:10px"><span style="font:400 10.5px var(--f-ui);color:var(--tx3)">Re-ranks live. Analyst feedback shifts these weights.</span><button data-resetw="1" class="lbl" style="color:var(--amber)">RESET</button></div></div></div>
    <div class="tgl ${d.align ? "on" : ""}" data-align="1" style="margin-bottom:12px;width:max-content"><i></i>ALIGN AT CHANGE POINT</div>
    <div id="align-host">${d.align ? alignHTML(res) : ""}</div>
    <div id="sim-list">${res.map(simHTML).join("")}</div>
    <div class="lt-note">Earlier-stage matches are found by comparing partial trajectories against the reference. This is retrieval of places on the same observed path — <b>not</b> a prediction that they will complete it.</div>`;
}

function simHTML(r) {
  const rel = r.stage_relation;
  const sg = esc((r.stage || r.direction || "").toUpperCase());
  const tag = rel === "earlier" ? `<span class="tag early">EARLIER · ${sg}</span>` : rel === "later" ? `<span class="tag later">LATER · ${sg}</span>` : `<span class="tag same">SAME · ${sg}</span>`;
  const m = S.disc.marked[r.id];
  return `<article class="sim" data-id="${r.id}" data-kind="event">
    <span class="sn">${String(r.rank).padStart(2, "0")}</span>
    <span class="st">#${r.num} ${tag}</span>
    <span class="sc">${pct(r.similarity)}<span style="font-size:11px;color:var(--tx3)">%</span></span>
    <span class="ss">${esc(r.site)} · ${r.river_dist_m} m river · ${r.overlap}/16 seg.</span>
    <div class="fac">${FACETS.map((f, i) => `<span>${FLAB[i]}<i><b style="width:${r.facets[f] * 100}%"></b></i></span>`).join("")}</div>
    <div class="fb"><button class="up ${m === "up" ? "done" : ""}" data-fb="relevant">✓ RELEVANT</button><button class="dn ${m === "dn" ? "done" : ""}" data-fb="not_relevant">✕ NOT RELEVANT</button></div>
  </article>`;
}

function appearanceBody() {
  const a = S.disc.appearance;
  return `<div class="claim app">These places look similar.</div>
    <div class="claim-sub">Ranked by image appearance only — the way a conventional embedding search would. <b style="color:#9fc2ff">${a.note}</b> Switch back to see which of these actually share the change.</div>
    <div id="sim-list">${a.results.map(appHTML).join("")}</div>
    ${a.missed.length ? `<div class="missed"><div class="lbl" style="color:var(--amber)">MISSED BY APPEARANCE SEARCH · ${a.missed.length} PLACES THAT CHANGED THE SAME WAY</div>
      <div class="tiles" style="margin-top:10px">${a.missed.map((m) => `<div class="tl" data-id="${m.id}" data-kind="event"><img src="/assets/chips/${m.id}/s2_46.jpg" alt=""><span>#${m.num} · ${esc(m.stage)}</span></div>`).join("")}</div>
      <div class="claim-sub" style="margin:10px 0 0">Bare ground and foundations do not look like finished buildings, so an image-similarity search cannot find them. A change-process search can.</div></div>` : ""}`;
}
function appHTML(r) {
  const tag = r.verdict === "same" ? `<span class="tag v-same">SAME PROCESS</span>` : r.verdict === "stable" ? `<span class="tag v-stable">NO CHANGE HISTORY</span>` : r.verdict === "suppressed" ? `<span class="tag v-supp">SUPPRESSED</span>` : `<span class="tag v-diff">DIFFERENT PROCESS</span>`;
  return `<article class="sim app" data-id="${r.id}" data-kind="${r.kind === "event" ? "event" : r.kind === "candidate" ? "candidate" : "stable"}">
    <span class="sn">${String(r.rank).padStart(2, "0")}</span>
    <span class="st">${esc(r.label)}</span>
    <span class="sc">${pct(r.appearance_similarity)}<span style="font-size:11px;color:var(--tx3)">%</span></span>
    <span class="ss">${tag} <span style="margin-left:4px">${esc(r.history)}</span></span>
    <div class="mini">${strandSVG(r.strand, { w: 300, h: 30, pad: 3, flat: r.kind === "stable", cp: r.kind !== "stable" })}</div>
    <div class="ss" style="grid-column:2/4;margin-top:4px">trajectory match <b style="color:${r.process_match >= 0.6 ? "var(--mint)" : "var(--tx3)"}">${pct(r.process_match)}%</b></div>
  </article>`;
}

function alignHTML(res) {
  const W = 380, H = 128, pad = 12, from = -6, to = 26;
  const X = (i) => pad + ((i - from) / (to - from)) * (W - 2 * pad);
  const items = [{ id: S.disc.protoId, strand: S.eventMap.get(S.disc.protoId).strand, proto: true }, ...res.slice(0, 8)];
  let g = `<line x1="${X(0)}" x2="${X(0)}" y1="6" y2="${H - 16}" stroke="#ffb020" stroke-dasharray="3 3"/><text x="${X(0) + 5}" y="16" fill="#ffb020" style="font:600 9px Inter;letter-spacing:.12em">CHANGE POINT · t = 0</text>`;
  for (let m = -3; m <= 12; m += 3) g += `<text x="${X(m * 2)}" y="${H - 3}" fill="#66768a" text-anchor="middle" style="font:400 9px 'JetBrains Mono'">${m > 0 ? "+" : ""}${m}mo</text>`;
  const line = (it) => {
    const st = it.strand, c = st.cp;
    if (c == null) return "";
    const pre = st.v.slice(Math.max(0, c - 3), c);
    const base = pre.length ? pre.reduce((a, b) => a + b, 0) / pre.length : st.v[c];
    let d = "";
    for (let i = from; i <= to; i++) {
      const j = c + i;
      if (j < 0 || j > 47) continue;
      const v = Math.max(-0.12, Math.min(1, base - st.v[j]));
      d += (d ? "L" : "M") + X(i).toFixed(1) + " " + (H - 18 - v * (H - 34)).toFixed(1);
    }
    return `<path d="${d}" fill="none" stroke="${it.proto ? "#ffffff" : "#ffb020"}" stroke-width="${it.proto ? 2.2 : 1.4}" opacity="${it.proto ? 1 : 0.5}" stroke-linejoin="round"/>`;
  };
  items.slice().reverse().forEach((it) => (g += line(it)));
  return `<div class="align-card"><div class="lbl" style="margin-bottom:6px">ALIGNED AT CHANGE POINT · <b style="color:var(--tx)">SAME SHAPE, DIFFERENT CALENDAR DATES</b></div><svg viewBox="0 0 ${W} ${H}">${g}</svg></div>`;
}

// ------------------------------------------------------------------ interactions
export async function setMode(m) {
  const d = S.disc;
  if (!d || d.mode === m) return;
  d.mode = m;
  $$("#mode-seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  const host = $("#disc-body");
  await host.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${m === "appearance" ? -14 : 14}px)` }], { duration: 170, fill: "forwards" }).finished;
  host.innerHTML = discBody();
  host.getAnimations().forEach((a) => a.cancel());
  host.animate([{ opacity: 0, transform: `translateX(${m === "appearance" ? 16 : -16}px)` }, { opacity: 1, transform: "none" }], { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" });
  $$("#sim-list .sim").forEach((n, i) => n.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: 40 + i * 35, fill: "backwards", easing: "ease-out" }));
  d.reveal = 99;
  buildArcs();
  const lead = $("#lead");
  if (m === "appearance") lead.hidden = true; else renderLead();
  emit("markers");
  if (m === "appearance") toast("Visual appearance mode", "", `${d.appearance.note}`);
  else toast("Change process mode", "ok", "ranked by temporal trajectory, not appearance");
}

function rerank() {
  const host = $("#sim-list");
  if (!host || S.disc.mode !== "process") return;
  flip(host, () => { host.innerHTML = ranked().map(simHTML).join(""); }, ".sim", 380);
  const claim = $(".claim-sub");
  if (claim) { const res = ranked(); const e = res.filter((r) => r.stage_relation === "earlier").length; claim.innerHTML = `${res.length} events share this change trajectory · <b style="color:var(--amber)">${e} at earlier stages</b> of the same process. Similarity is measured on trajectory, not on how the surface looks.`; }
  const al = $("#align-host");
  if (al && S.disc.align) al.innerHTML = alignHTML(ranked());
  buildArcs();
  renderLead();
  emit("markers");
}

export function toggleTune() {
  const d = S.disc; d.tuneOpen = !d.tuneOpen;
  $("#tune").classList.toggle("open", d.tuneOpen);
  $("#tune .tune-h span:last-child").textContent = d.tuneOpen ? "HIDE" : "ADJUST";
}
export function toggleAlign() {
  const d = S.disc; d.align = !d.align;
  $("[data-align]").classList.toggle("on", d.align);
  $("#align-host").innerHTML = d.align ? alignHTML(ranked()) : "";
  if (d.align) $("#align-host").animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], { duration: 300 });
}
export function resetWeights() {
  const d = S.disc;
  d.weights = d.process.default_weights.slice();
  $$("[data-w]").forEach((s, i) => { s.value = Math.round(d.weights[i] * 100); s.closest(".slider").querySelector("b").textContent = s.value; });
  rerank();
}

export async function markResult(id, decision) {
  const d = S.disc;
  const r = await api.feedback(id, decision, "", "", { prototype_id: d.protoId, query_id: S.query?.query_id });
  d.marked[id] = decision === "relevant" ? "up" : "dn";
  const before = r.weights_before.slice();
  d.weights = r.weights.slice();
  $$("[data-w]").forEach((s, i) => { s.value = Math.round(d.weights[i] * 100); s.closest(".slider").querySelector("b").textContent = s.value; });
  let mv = 0, mi = 0;
  r.weights.forEach((w, i) => { const dl = w - before[i]; if (Math.abs(dl) > Math.abs(mv)) { mv = dl; mi = i; } });
  rerank();
  toast(decision === "relevant" ? "Refined toward confirmed examples" : "Refined away from rejected examples", decision === "relevant" ? "ok" : "bad", `${FACETS[mi]} weight ${mv >= 0 ? "+" : ""}${(mv * 100).toFixed(1)} pts · written to the audit trail`);
  emit("audit");
}

// ------------------------------------------------------------------ lead-time overlay
export function renderLead() {
  const d = S.disc;
  const host = $("#lead");
  if (!d || d.mode !== "process") { host.hidden = true; return; }
  const res = ranked();
  const proto = S.eventMap.get(d.protoId);
  const pi = STAGES.indexOf(proto.stage);
  const earlier = res.filter((r) => r.stage_relation === "earlier").length;
  const tile = (r, ref) => `<div class="tl ${ref ? "ref" : ""}" data-id="${r.id}" data-kind="event"><img src="/assets/chips/${r.id}/s2_46.jpg" alt=""><span>#${r.num}${ref ? "" : " · " + pct(r.similarity) + "%"}</span></div>`;
  const lanes = STAGES.slice(1).map((st, li) => {
    const idx = li + 1;
    const items = res.filter((r) => r.stage === st);
    const refHere = proto.stage === st;
    return `<div class="lane ${idx < pi ? "early" : ""}"><div class="lane-h ${refHere ? "ref" : ""}"><span>${st.toUpperCase()}${refHere ? " · REFERENCE" : ""}</span><i>${items.length + (refHere ? 1 : 0)}</i></div><div class="tiles">${refHere ? tile(proto, true) : ""}${items.map((r) => tile(r, false)).join("") || (refHere ? "" : '<span style="font:400 10px var(--f-mono);color:var(--tx4)">none</span>')}</div>${li < 3 ? '<span class="lane-arrow">▸</span>' : ""}</div>`;
  }).join("");
  host.innerHTML = `<div class="lead-h"><div><span class="lbl">LEAD-TIME DISCOVERY</span><br><b>${earlier} locations at earlier stages of the same observed change trajectory</b></div><span>Earlier-stage trajectory matching — a retrieval capability, not a forecast. Reference: #${proto.num}, ${proto.stage.toLowerCase()}.</span></div><div class="lanes">${lanes}</div>`;
  host.hidden = false;
}
