// ChronoLens — application shell. Wires the modules and owns the marker model.
import { S, on, emit, syncBody } from "./store.js";
import { api } from "./api.js";
import { $, $$, esc, ms, fmtDate, pct, stageAt, STAGES, toast, DAY, flip, sleep } from "./util.js";
import { initMap, addMarkers, applyModel, setBase, flyTo, fitAOI, flyToBounds, M } from "./map.js";
import { initChrono, setCursor, play, stopPlay, redrawChrono, isPlaying } from "./chrono.js";
import { initRail, renderRail, renderSuggest, runSearch, updateTabs, SUGGEST, toggleFunnel } from "./rail.js";
import { openDossier, closeDossier, refreshDossierStatus } from "./dossier.js";
import { initDiscovery, startDiscovery, exitDiscovery, renderDiscovery, setMode, toggleTune, toggleAlign, resetWeights, markResult, currentResults, renderLead } from "./discovery.js";

const TYPE_QUERY = {
  construction: "Find newly constructed structures near a river.",
  clearance: "Where has vegetation been cleared recently?",
  water_extent: "Show water-extent changes this year.",
  road: "New roads",
  other: "Show unclassified surface changes",
};

// ------------------------------------------------------------------ marker model (single source of truth)
function computeModel() {
  const m = new Map();
  const cur = S.cursor;
  const conv = S.lens === "conventional";
  const res = S.query && S.query.kind === "events" ? new Map(S.query.results.map((r) => [r.id, r])) : null;
  const d = S.view === "discovery" ? S.disc : null;
  const alive = S.alive;
  const suppIds = new Set(S.query?.suppressed_ids || []);
  const dres = d ? currentResults() : [];
  const dIdx = new Map(dres.map((r, i) => [r.id, { r, i }]));
  const set = (id, o) => {
    const cls = o.cls;
    if (S.hoverId === id) cls.push("is-hover");
    if (S.selectedId === id && !d) cls.push("is-sel");
    m.set(id, { cls, badge: o.badge || "", label: o.label || "", pips: o.pips ?? null, z: o.z });
  };
  for (const e of S.events) {
    const cls = [];
    let badge = "", z = 0, pips = null;
    if (e.type === "construction") { const i = STAGES.indexOf(stageAt(e.state_sequence, cur)); if (i > 0) pips = i; }
    const started = ms(e.onset.first_supporting) <= cur;
    if (d) {
      if (e.id === d.protoId) { cls.push("is-proto"); z = 6; }
      else if (d.mode === "process") {
        const x = dIdx.get(e.id);
        if (x && x.i < d.reveal) { cls.push("is-sim"); badge = pct(x.r.similarity) + ""; z = 4; } else cls.push("is-dim");
      } else {
        const x = dIdx.get(e.id);
        if (x) { cls.push("is-sim-app"); badge = pct(x.r.appearance_similarity) + ""; z = 4; } else cls.push("is-dim");
      }
    } else if (!started) cls.push("is-future");
    else if (alive) cls.push(alive.has(e.id) ? "is-pool" : "is-out");
    else if (conv) cls.push("is-conv");
    else if (res) { if (res.has(e.id)) { cls.push("is-result"); badge = String(res.get(e.id).rank); z = 3; } else cls.push("is-dim"); }
    else cls.push("is-idx");
    set(e.id, { cls, badge, label: "#" + e.num, pips, z });
  }
  for (const c of S.cands) {
    const cls = [];
    let badge = "", z = 0;
    if (d) {
      const x = d.mode === "appearance" ? dIdx.get(c.id) : null;
      if (x) { cls.push("is-cand", "is-sim-app"); badge = pct(x.r.appearance_similarity) + ""; z = 4; } else cls.push("is-cand-off");
    } else if (alive) {
      if (alive.has(c.id)) cls.push("is-cand", "is-pool");
      else if (S.flashed.has(c.id)) cls.push("is-cand", "is-flash");
      else cls.push("is-cand-off");
    } else if (conv) cls.push("is-conv");
    else if (S.tab === "suppressed") { cls.push("is-cand"); if (S.suppScope === "query" && S.query?.kind === "events" && !suppIds.has(c.id)) cls.push("is-dim"); }
    else cls.push("is-cand-off");
    set(c.id, { cls, badge, label: "#" + c.num, z });
  }
  for (const s of S.stable) {
    const x = d && d.mode === "appearance" ? dIdx.get(s.id) : null;
    if (x) set(s.id, { cls: ["is-stable", "is-sim-app"], badge: pct(x.r.appearance_similarity) + "", label: s.label, z: 4 });
    else set(s.id, { cls: ["is-hidden"] });
  }
  return m;
}

let mqueued = false;
function refreshMarkers() {
  if (mqueued) return;
  mqueued = true;
  requestAnimationFrame(() => { mqueued = false; applyModel(computeModel()); updateBanner(); });
}

function updateBanner() {
  const b = $("#lens-banner");
  const conv = S.lens === "conventional";
  b.classList.toggle("cv", conv);
  if (S.view === "dossier") { b.innerHTML = ""; return; }
  if (S.view === "discovery" && S.disc) {
    const n = currentResults().length;
    b.innerHTML = S.disc.mode === "process"
      ? `<b>FIND MORE LIKE THIS</b> · ranked by <b>change-process</b> similarity · ${n} events`
      : `<b style="color:#9fc2ff">VISUAL APPEARANCE</b> · image-similarity ranking · <span style="color:var(--coral)">no change history considered</span>`;
    return;
  }
  const started = S.events.filter((e) => ms(e.onset.first_supporting) <= S.cursor).length;
  if (conv) b.innerHTML = `<b>CONVENTIONAL · TWO-DATE DIFFERENCE</b><br>${started + S.cands.length} changes flagged · no seasonal baseline, no quality gating, no cross-sensor check`;
  else if (S.query && S.query.kind === "events" && !S.alive) b.innerHTML = `<b>CHRONOLENS</b> · ${S.query.results.length} verified Change Events · <span style="color:var(--coral)">${S.query.suppressed_count} suppressed, with reasons</span>`;
  else b.innerHTML = `<b>CHRONOLENS</b> · ${started} Change Events under way · ${S.cands.length} candidates suppressed on record`;
}

// ------------------------------------------------------------------ boot
window.__CL = { S, M, emit, setCursor, openDossier, closeDossier };
async function boot() {
  const [system, aoi, evs, rej, stable] = await Promise.all([api.system(), api.aoi(), api.events(), api.rejected(), api.stable()]);
  S.system = system; S.aoi = aoi;
  const detail = await Promise.all(evs.events.map((e) => api.event(e.id)));
  const seqOf = new Map(detail.map((d) => [d.id, d.state_sequence]));
  S.events = evs.events.map((e) => ({ ...e, state_sequence: seqOf.get(e.id) }));
  S.events.forEach((e) => S.eventMap.set(e.id, e));
  S.cands = rej.candidates;
  S.cands.forEach((c) => S.candMap.set(c.id, c));
  S.stable = stable.sites;
  S.t0 = ms(aoi.time.start);
  S.t1 = ms(aoi.time.end);
  S.cursor = S.t1;
  $("#aoi-name").textContent = aoi.id;
  $("#aoi-window").textContent = `${fmtDate(aoi.time.start)} → ${fmtDate(aoi.time.end)}`;
  $("#aoi-crs").textContent = aoi.crs;
  $("#sys-counts").innerHTML = `${system.counts.events} events · ${system.counts.candidates} suppressed<br>${system.counts.scenes_s2} S2 + ${system.counts.scenes_s1} S1 scenes<br>${system.counts.observations.toLocaleString()} observations · ${system.aoi.tiles.toLocaleString()} tiles`;
  const mapReady = initMap(aoi, { click: onMarkerClick, hover: onMarkerHover });
  initChrono();
  initRail({ renderDiscovery, fitResults: (ids) => S.view === "explore" && flyToBounds(ids, 90) });
  initDiscovery({});
  renderSuggest();
  renderRail();
  syncBody();
  wire();
  trackExternalRequests();
  await mapReady;
  addMarkers([
    ...S.events.map((e) => ({ id: e.id, kind: "event", centroid: e.centroid, strand: e.strand, confidence: e.confidence })),
    ...S.cands.map((c) => ({ id: c.id, kind: "candidate", centroid: c.centroid, strand: c.strand, candidate_score: c.candidate_score })),
    ...S.stable.map((s) => ({ id: s.id, kind: "stable", centroid: s.centroid, strand: s.strand })),
  ]);
  refreshMarkers();
  // opening choreography: markers trace in
  $$(".mk .mki").forEach((el, i) => el.animate([{ opacity: 0, transform: "scale(.3)" }, { opacity: 1, transform: "none" }], { duration: 500, delay: 200 + i * 35, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }));
  if (new URLSearchParams(location.search).get("q")) { $("#q").value = new URLSearchParams(location.search).get("q"); runSearch($("#q").value); }
}

function trackExternalRequests() {
  const count = () => performance.getEntriesByType("resource").filter((r) => { try { const u = new URL(r.name); return u.origin !== location.origin && u.protocol.startsWith("http"); } catch { return false; } }).length;
  const upd = () => ($("#ext-req").textContent = count());
  upd();
  try { new PerformanceObserver(upd).observe({ type: "resource", buffered: true }); } catch {}
}

// ------------------------------------------------------------------ interaction wiring
function onMarkerClick(id, kind) {
  if (S.view === "dossier") return;
  if (kind === "stable") { toast("Stable site", "", "Looks like a change target but has no change history in 24 months."); return; }
  S.selectedId = id;
  openDossier(id, kind);
}
function onMarkerHover(id, kind, on_) {
  S.hoverId = on_ ? id : null;
  $$(`[data-id]`).forEach((n) => n.classList.toggle("hover", on_ && n.dataset.id === id && !n.classList.contains("mk")));
  refreshMarkers();
}

async function softRefresh() {
  const evs = await api.events();
  evs.events.forEach((e) => { const o = S.eventMap.get(e.id); Object.assign(o, e, { state_sequence: o.state_sequence }); });
  const rej = await api.rejected(S.query?.query_id);
  rej.candidates.forEach((c) => Object.assign(S.candMap.get(c.id), c));
  const a = await api.audit();
  $("#n-audit").textContent = a.total;
  if (S.query && S.query.kind === "events" && S.view !== "dossier") {
    const res = await api.search(S.query.intent.text, S.ov || {}, false);
    const host = $("#rail-body");
    if (S.tab === "results" && S.view !== "discovery") flip(host, () => { S.query = res; renderRail(); }, ".ev-card");
    else S.query = res;
  } else if (S.tab === "suppressed") renderRail();
  refreshDossierStatus();
  redrawChrono();
  refreshMarkers();
}

function wire() {
  on("markers", refreshMarkers);
  on("cursor", refreshMarkers);
  on("rail", renderRail);
  on("view", () => { syncBody(); refreshMarkers(); redrawChrono(); });
  on("fml", (id) => startDiscovery(id));
  on("disc:exit", () => exitDiscovery());
  on("feedback", () => softRefresh());
  on("audit", async () => { const a = await api.audit(); $("#n-audit").textContent = a.total; });
  on("results", () => redrawChrono());

  // search
  $("#qform").addEventListener("submit", (e) => { e.preventDefault(); runSearch($("#q").value); });
  $("#suggest").addEventListener("click", (e) => {
    const b = e.target.closest("[data-q]"); if (!b) return;
    $("#q").value = b.dataset.q; runSearch(b.dataset.q);
  });
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]"); if (!b) return;
    if (S.view === "dossier") return;
    S.tab = b.dataset.tab;
    updateTabs(); renderRail(); refreshMarkers();
  });

  // rail delegated clicks
  $("#rail-body").addEventListener("click", async (e) => {
    const t = e.target;
    let el;
    if ((el = t.closest(".funnel .sec-h"))) return toggleFunnel();
    if (t.closest("[data-reset]")) { await api.reset(); toast("Demo state reset", "ok", "audit trail, feedback and learned weights restored to the seeded state"); setTimeout(() => location.reload(), 700); return; }
    if ((el = t.closest("[data-d='back']"))) return exitDiscovery();
    if ((el = t.closest("[data-mode]"))) return setMode(el.dataset.mode);
    if (t.closest("[data-tune]")) return toggleTune();
    if (t.closest("[data-align]")) return toggleAlign();
    if (t.closest("[data-resetw]")) return resetWeights();
    if ((el = t.closest("[data-fb]"))) { e.stopPropagation(); return markResult(el.closest(".sim").dataset.id, el.dataset.fb); }
    if ((el = t.closest("[data-step]"))) {
      const it = S.query.intent;
      const ov = { ...(S.ov || {}) };
      if (el.dataset.step === "river") ov.river_m = Math.max(100, Math.min(5000, (it.spatial?.max_m || 500) + +el.dataset.d));
      else ov.months = Math.max(6, Math.min(24, it.time.months + +el.dataset.d));
      return quickSearch(it.text, ov);
    }
    if ((el = t.closest("[data-go='suppressed']"))) { S.tab = "suppressed"; updateTabs(); renderRail(); refreshMarkers(); return; }
    if ((el = t.closest("[data-tier]"))) { const ov = { ...(S.ov || {}) }; if (el.dataset.tier) ov.tiers = [el.dataset.tier]; else delete ov.tiers; return quickSearch(S.query.intent.text, ov); }
    if ((el = t.closest(".type-row"))) { $("#q").value = TYPE_QUERY[el.dataset.type]; return runSearch($("#q").value); }
    if ((el = t.closest("[data-scope]"))) { S.suppScope = el.dataset.scope; updateTabs(); renderRail(); refreshMarkers(); return; }
    if ((el = t.closest("[data-reason]"))) { S.suppReason = el.dataset.reason || null; renderRail(); return; }
    if ((el = t.closest("[data-promote]"))) {
      e.stopPropagation();
      const id = el.closest(".rj").dataset.id;
      const r = await api.promote(id);
      toast(`Candidate #${id.slice(2)} promoted to review`, "", "analyst override written to the audit trail");
      emit("feedback", r);
      return;
    }
    const card = t.closest("[data-id]");
    if (card && !card.classList.contains("mk")) {
      const kind = card.dataset.kind;
      if (kind === "tile") return;
      if (kind === "stable") { flyTo(card.dataset.id); return toast("Stable site", "", "Looks alike, but no change history in 24 months."); }
      return openDossier(card.dataset.id, kind);
    }
  });
  $("#rail-body").addEventListener("mouseover", (e) => { const c = e.target.closest("[data-id]"); if (c && S.hoverId !== c.dataset.id) { S.hoverId = c.dataset.id; refreshMarkers(); } });
  $("#rail-body").addEventListener("mouseleave", () => { S.hoverId = null; refreshMarkers(); });
  $("#lead").addEventListener("click", (e) => { const t = e.target.closest(".tl"); if (t) openDossier(t.dataset.id, "event"); });
  $("#lead").addEventListener("mouseover", (e) => { const t = e.target.closest(".tl"); const id = t ? t.dataset.id : null; if (S.hoverId !== id) { S.hoverId = id; refreshMarkers(); } });

  // map HUD
  $("#sensor-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.base = b.dataset.v; setBase(S.base);
    $$("#sensor-seg button").forEach((x) => x.classList.toggle("on", x === b));
  });
  $("#lens-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.lens = b.dataset.v;
    $$("#lens-seg button").forEach((x) => x.classList.toggle("on", x === b));
    syncBody(); refreshMarkers();
    if (S.lens === "conventional") toast("Conventional two-date difference", "bad", "every visual difference is flagged — season, cloud, shadow and misregistration included");
    else toast("ChronoLens", "ok", "seasonal baseline + verification layers applied · suppressed candidates recorded, not shown as alerts");
  });
  $("#stage").addEventListener("click", (e) => { if (e.target.closest(".mk, .hud, .lead")) return; S.selectedId = null; refreshMarkers(); });

  // keyboard
  addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
    if (e.key === "/" && !typing) { e.preventDefault(); $("#q").focus(); return; }
    if (e.key === "Escape") {
      if ($(".modal-back")) { $(".modal-back").remove(); return; }
      if (typing) { document.activeElement.blur(); return; }
      if (S.view === "dossier") return closeDossier();
      if (S.view === "discovery") return exitDiscovery();
      if (S.tab !== "results") { S.tab = "results"; updateTabs(); renderRail(); refreshMarkers(); }
      return;
    }
    if (typing) return;
    if (e.key === " ") { e.preventDefault(); isPlaying() ? stopPlay() : play(); }
    else if (e.key === "ArrowRight") { stopPlay(); setCursor(S.cursor + 15 * DAY, "key"); }
    else if (e.key === "ArrowLeft") { stopPlay(); setCursor(S.cursor - 15 * DAY, "key"); }
    else if (e.key.toLowerCase() === "p") { S.present = !S.present; syncBody(); }
  });
  addEventListener("resize", () => { if (S.view !== "dossier") emit("cursor"); });
}

async function quickSearch(text, ov) {
  const res = await api.search(text, ov, false);
  S.ov = ov;
  const host = $("#rail-body");
  flip(host, () => { S.query = res; renderRail(); }, ".ev-card");
  updateTabs();
  refreshMarkers();
  redrawChrono();
}

boot().catch((e) => { console.error(e); document.body.insertAdjacentHTML("beforeend", `<pre style="position:fixed;inset:60px;color:#ff6b6b;z-index:999;background:#000;padding:20px;white-space:pre-wrap">${esc(e.stack || e)}</pre>`); });
