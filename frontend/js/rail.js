// Left rail: query → intent → verification funnel → Change Event cards · Why We Didn't Alert · Audit.
import { S, emit, on } from "./store.js";
import { api } from "./api.js";
import { strandSVG } from "./strand.js";
import { $, $$, esc, pct, fmtDate, sleep, tween, ease, stageAt, STAGES, toast, TYPE_UP, flip, ms } from "./util.js";

export const SUGGEST = [
  ["MAIN", "Find newly constructed structures near a river."],
  ["WATER", "Show water-extent changes this year."],
  ["CLEARANCE", "Where has vegetation been cleared recently?"],
  ["ROADS", "New roads"],
  ["STATIC", "Large vehicle concentrations on open ground"],
];
const REASON = {
  seasonal_variation: "Seasonal", cloud_shadow: "Cloud / shadow", registration_error: "Registration", temporary_flood: "Flood / water",
  river_course_shift: "River / sandbar", insufficient_persistence: "Persistence", insufficient_sar: "SAR corroboration", haze_radiometric: "Haze / radiometric",
};
const CHK_ABBR = { quality: "QUAL", registration: "REG", baseline: "BASE", persistence: "PERS", context: "CTX", optical: "OPT", sar: "SAR" };
let handlers = {};
export const initRail = (h) => { handlers = h; };
S.ov = {};

export function renderSuggest() {
  $("#suggest").innerHTML = SUGGEST.map(([k, q]) => `<button data-q="${esc(q)}"><i>${k}</i><span>${esc(q)}</span></button>`).join("");
}

export function updateTabs() {
  $("#tabs").hidden = false;
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
  $("#n-results").textContent = S.query && S.query.kind === "events" ? S.query.results.length : S.query?.results?.length ?? 0;
  $("#n-supp").textContent = S.suppScope === "query" && S.query?.kind === "events" ? S.query.suppressed_count : S.cands.length;
}

export function renderRail() {
  updateTabs();
  $("#suggest").hidden = !!S.query;
  const body = $("#rail-body");
  if (S.tab === "suppressed") return renderSuppressed(body);
  if (S.tab === "audit") return renderAudit(body);
  if (S.view === "discovery" && S.disc) return handlers.renderDiscovery(body);
  if (!S.query) return renderOverview(body);
  renderResults(body, false);
}

// ------------------------------------------------------------------ overview (before the first query)
function renderOverview(body) {
  const types = {};
  S.events.forEach((e) => (types[e.type] = (types[e.type] || 0) + 1));
  const mx = Math.max(...Object.values(types));
  body.innerHTML = `<div class="ov">
    <h4>CHANGE EVENT INDEX <span class="mono" style="letter-spacing:0">AOI-01</span></h4>
    <div class="ov-grid">
      <div><b>${S.events.length}</b><span>Change Events</span></div>
      <div><b style="color:var(--coral)">${S.cands.length}</b><span>Suppressed candidates</span></div>
      <div><b>${S.system.aoi.tiles.toLocaleString()}</b><span>256 m tiles</span></div>
      <div><b>${S.system.counts.scenes_s2 + S.system.counts.scenes_s1}</b><span>Scenes · S2 + S1</span></div>
    </div>
    <h4>BY CHANGE TYPE</h4>
    ${Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<div class="type-row" data-type="${t}"><span style="width:150px">${esc(TYPE_UP[t])}</span><div class="bar"><i style="width:${(n / mx) * 100}%"></i></div><b>${n}</b></div>`).join("")}
    <div class="note">The archive is searched as <b>Change Events</b> — a location, its temporal trajectory, when it departed from its own seasonal baseline, and the evidence that it is real. Ask a question, or drag the chrono-rail below to watch the AOI's history unfold.</div>
  </div>`;
}

// ------------------------------------------------------------------ search flow
export async function runSearch(text, ov = {}, { animate = true } = {}) {
  if (S.running || !text.trim()) return;
  S.ov = ov;
  S.tab = "results";
  if (S.view === "discovery") emit("disc:exit");
  S.running = true;
  $("#qgo").textContent = "…";
  let res;
  try { res = await api.search(text, ov, animate); }
  catch (e) { S.running = false; $("#qgo").textContent = "SEARCH"; toast("Search failed", "bad", String(e)); return; }
  S.query = res;
  S.suppScope = "query";
  updateTabs();
  const body = $("#rail-body");
  if (res.kind === "static") { S.running = false; $("#qgo").textContent = "SEARCH"; renderResults(body, animate); emit("markers"); return; }
  if (!animate) { S.running = false; $("#qgo").textContent = "SEARCH"; renderResults(body, false); emit("markers"); return; }

  // 1 · intent (editable chips) ------------------------------------------------
  body.innerHTML = `<div id="intent-host"></div><div id="funnel-host" class="funnel"></div><div id="cards-host"></div>`;
  $("#intent-host").innerHTML = intentHTML(res.intent);
  const rows = $$("#intent-host .intent-row");
  for (const r of rows) { await sleep(190); r.classList.add("in"); }
  await sleep(200);

  // 2 · funnel — the map and the rail verify together ------------------------------
  const fh = $("#funnel-host");
  fh.innerHTML = `<h4 class="sec-h">VERIFICATION FUNNEL <span class="mono" style="letter-spacing:0">${res.query_id}</span></h4>` +
    res.pipeline.map((s, i) => `<div class="f-row ${i === res.pipeline.length - 1 ? "final" : ""}" data-i="${i}"><span class="fl">${esc(s.label)}</span><span class="fc">0</span><div class="fb"><i></i></div><div class="fr"></div></div>`).join("") +
    `<div class="f-fold"></div><div class="f-sum" id="f-sum"></div>`;
  S.alive = new Set([...S.events.map((e) => e.id), ...S.cands.map((c) => c.id)]);
  S.flashed = new Set();
  emit("markers");
  const pool = res.pipeline[0].count;
  let prev = 0;
  const candIds = new Set(S.cands.map((c) => c.id));
  for (let i = 0; i < res.pipeline.length; i++) {
    const st = res.pipeline[i];
    const row = $(`.f-row[data-i="${i}"]`, fh);
    row.classList.add("in");
    $(".fb i", row).style.width = (st.count / pool) * 100 + "%";
    const fc = $(".fc", row);
    const from = prev;
    tween(360, (t) => (fc.textContent = Math.round(from + (st.count - from) * t)));
    if (st.removed.length && i > 0) {
      const cands = st.removed.filter((id) => candIds.has(id));
      const verify = ["qa", "baseline", "persistence", "verify"].includes(st.key);
      $(".fr", row).textContent = verify && cands.length ? "− " + cands.join(" · ") + "  (stopped, kept in ledger)" : `− ${st.removed.length} removed`;
      row.classList.add("rem");
      st.removed.forEach((id) => { S.alive.delete(id); if (verify && candIds.has(id)) S.flashed.add(id); });
    }
    prev = st.count;
    emit("markers");
    await sleep(st.ms + 60);
  }
  S.alive = null;
  S.running = false;
  $("#qgo").textContent = "SEARCH";
  const tc = res.tier_counts;
  $("#f-sum").innerHTML = `<span><b class="mono" style="color:var(--amber);font-size:15px">${res.results.length}</b> <span style="color:var(--tx2)">Change Events · ${tc.high} high · ${tc.medium} medium</span></span><a data-go="suppressed">⊘ ${res.suppressed_count} SUPPRESSED →</a>`;
  $("#f-sum").classList.add("in");
  emit("markers");
  updateTabs();
  await sleep(900);
  foldFunnel(res);
  await sleep(320);
  $("#cards-host").innerHTML = cardsHTML(res, true);
  $$("#cards-host .ev-card").forEach((c, i) => c.animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: i * 90, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }));
  handlers.fitResults && handlers.fitResults(res.results.map((r) => r.id));
  emit("results");
}

function chain(res) { return res.pipeline.map((s) => s.count).join('<i>→</i>'); }
function foldFunnel(res) {
  const fh = $("#funnel-host");
  if (!fh) return;
  S.funnelOpen = false;
  $(".f-fold", fh).innerHTML = chain(res);
  fh.classList.add("folded");
  $("#suggest").hidden = true;
}
export function toggleFunnel() { const fh = $(".funnel"); if (!fh) return; fh.classList.toggle("folded"); S.funnelOpen = !fh.classList.contains("folded"); }

function intentHTML(it) {
  if (it.static) {
    return `<div class="intent"><div class="intent-h"><span class="lbl">QUERY UNDERSTANDING</span><span class="chip mute">STATIC TILE QUERY</span></div>
      <div class="intent-row in"><span class="lbl">CONCEPT</span><div class="val">${esc(it.text)}<small>no change component · answered from the tile index</small></div></div></div>`;
  }
  const sp = it.spatial;
  return `<div class="intent">
    <div class="intent-h"><span class="lbl">QUERY UNDERSTANDING</span><span class="chip ok">PARSED LOCALLY</span></div>
    ${it.interpretation ? `<div class="interp">${esc(it.interpretation)}</div>` : ""}
    <div class="intent-row"><span class="lbl">CHANGE</span><div class="val">${esc(it.concept.label)}<small>${esc(it.concept.detail)}</small></div></div>
    <div class="intent-row"><span class="lbl">SPATIAL</span><div class="val">${sp ? esc(sp.label) : "Whole AOI"}<small>${sp ? "local river geometry · editable" : "no spatial constraint"}</small></div>
      ${sp ? `<div class="step"><button data-step="river" data-d="-100">−</button><span>${sp.max_m} m</span><button data-step="river" data-d="100">+</button></div>` : ""}</div>
    <div class="intent-row"><span class="lbl">TIME</span><div class="val">${esc(it.time.label)}<small>${esc(fmtDate(it.time.from_))} → ${esc(fmtDate(it.time.to))}</small></div>
      <div class="step"><button data-step="months" data-d="-6">−</button><span>${it.time.months} mo</span><button data-step="months" data-d="6">+</button></div></div>
    <div class="intent-row"><span class="lbl">SENSORS</span><div class="val">${esc(it.sensors.label)}<small>optical + SAR evidence</small></div></div>
  </div>`;
}

function renderResults(body, animate) {
  const res = S.query;
  if (!res) return;
  body.innerHTML = `<div id="intent-host">${intentHTML(res.intent)}</div>${res.kind === "events" ? funnelStatic(res) : ""}<div id="cards-host">${cardsHTML(res, false)}</div>`;
  $$("#intent-host .intent-row").forEach((r) => r.classList.add("in"));
  $$(".f-row").forEach((r) => r.classList.add("in"));
  const fs = $("#f-sum"); fs && fs.classList.add("in");
}

function funnelStatic(res) {
  const pool = res.pipeline[0].count;
  const tc = res.tier_counts;
  return `<div class="funnel ${S.funnelOpen ? "" : "folded"}"><h4 class="sec-h">VERIFICATION FUNNEL <span class="mono" style="letter-spacing:0">${res.query_id}</span></h4>` +
    res.pipeline.map((s, i) => `<div class="f-row in ${i === res.pipeline.length - 1 ? "final" : ""} ${s.removed.length && i ? "rem" : ""}"><span class="fl">${esc(s.label)}</span><span class="fc">${s.count}</span><div class="fb"><i style="width:${(s.count / pool) * 100}%"></i></div><div class="fr">${s.removed.length && i ? "− " + s.removed.length + " removed" : ""}</div></div>`).join("") +
    `<div class="f-sum in"><span><b class="mono" style="color:var(--amber);font-size:15px">${res.results.length}</b> <span style="color:var(--tx2)">Change Events · ${tc.high} high · ${tc.medium} medium</span></span><a data-go="suppressed">⊘ ${res.suppressed_count} SUPPRESSED →</a></div><div class="f-fold">${chain(res)}</div></div>`;
}

function cardsHTML(res, fresh) {
  if (res.kind === "static") {
    return `<div class="interp" style="border:1px solid var(--line2);margin-bottom:12px">${esc(res.notice)}</div><div class="cards">${res.results.map((h) => `
      <article class="ev-card" data-id="${h.id}" data-kind="tile" style="padding-left:14px"><div class="ev-top"><span class="ev-rank">${String(h.rank).padStart(2, "0")}</span><span class="ev-type">${esc(h.label)}</span><span class="conf low"><b>${pct(h.score)}%</b>LOW</span></div>
      <div style="display:flex;gap:12px;margin-top:9px"><img src="${h.frame_url}" style="width:92px;height:92px;object-fit:cover;border:1px solid var(--line2)"><div class="ev-id" style="margin:0;line-height:1.7">${esc(h.note)}<br>static tile match · not a change event<br>resolution-limited at 10 m</div></div></article>`).join("")}</div>`;
  }
  const tiers = S.ov.tiers || null;
  const tf = `<div class="reasons" style="margin:0 0 12px"><button data-tier="" class="${tiers ? "" : "on"}" style="color:var(--tx)">ALL <i>${res.tier_counts.high + res.tier_counts.medium + (res.tier_counts.low || 0)}</i></button><button data-tier="high" class="${tiers && tiers[0] === "high" ? "on" : ""}">HIGH <i>${res.tier_counts.high}</i></button><button data-tier="medium" class="${tiers && tiers[0] === "medium" ? "on" : ""}">MEDIUM <i>${res.tier_counts.medium}</i></button></div>`;
  if (!res.results.length) return tf + `<div class="empty">No Change Events survive verification for this query.<br><a data-go="suppressed" style="color:var(--coral);cursor:pointer">See what was suppressed →</a></div>`;
  return `<h4 class="sec-h" style="margin-top:4px">RANKED CHANGE EVENTS</h4>${tf}<div class="cards">${res.results.map((e) => evCard(e)).join("")}</div>`;
}

export function evCard(e, extra = "") {
  const st = e.type === "construction" ? STAGES.indexOf(e.stage) : null;
  const pips = st != null ? `<div class="pips"><small>${esc(e.stage)}</small>${[1, 2, 3, 4].map((i) => `<i class="${i < st ? "on" : i === st ? "cur" : ""}"></i>`).join("")}</div>` : `<div class="pips"><small>${esc(e.direction)}</small></div>`;
  const s2 = e.sensor_evidence.s2, s1 = e.sensor_evidence.s1;
  const chipS = (k, v) => `<span class="chip ${v === "supports" ? "s" + k[1] : v === "contradicts" ? "bad" : "warn"}">${k.toUpperCase()} ${v === "supports" ? "✓" : v === "contradicts" ? "✕" : "~"}</span>`;
  return `<article class="ev-card t-${e.confidence.tier} ${e.status === "analyst_confirmed" ? "confirmed" : ""} ${S.selectedId === e.id ? "sel" : ""}" data-id="${e.id}" data-kind="event">
    <div class="ev-top"><span class="ev-rank">${e.rank ? String(e.rank).padStart(2, "0") : "·"}</span><span class="ev-type">${esc(e.type_label)}</span>
      <span class="conf ${e.confidence.tier}"><b>${pct(e.confidence.score)}%</b>${e.confidence.tier.toUpperCase()}</span></div>
    <div class="ev-id">CHANGE EVENT #${e.num} · ${esc(e.site)} · ${esc(e.tile_id)}</div>
    <div class="ev-strand">${strandSVG(e.strand, { w: 360, h: 44, pad: 4 })}</div>
    <div class="ev-grid">
      <div><span>ONSET</span><b>${fmtDate(e.onset.estimate)} ±${Math.round(e.onset.half_width_days)}D</b></div>
      <div><span>DURATION</span><b>${e.duration_days} D · ${e.persistence_obs} OBS</b></div>
      <div><span>RIVER</span><b>${e.river_dist_m} m</b></div>
      <div><span>AREA / MAGNITUDE</span><b>${e.area_ha} ha · ${e.magnitude_sigma}σ</b></div>
    </div>
    <div class="ev-foot">${chipS("s2", s2)}${chipS("s1", s1)}<span class="chip ${e.checks_passed === e.checks_total ? "ok" : "warn"}">${e.checks_passed}/${e.checks_total} CHECKS</span>${pips}</div>${extra}
  </article>`;
}

// ------------------------------------------------------------------ Why We Didn't Alert
export async function renderSuppressed(body) {
  const qid = S.query?.query_id;
  const data = await api.rejected(S.suppScope === "query" ? qid : qid);
  S.rejected = data;
  const inq = (c) => (S.suppScope === "query" && qid ? c.in_query : true);
  let list = data.candidates.filter(inq);
  const all = data.candidates.filter(inq);
  const counts = {};
  all.forEach((c) => (counts[c.reason_code] = (counts[c.reason_code] || 0) + 1));
  if (S.suppReason) list = list.filter((c) => c.reason_code === S.suppReason);
  const scope = qid ? `<div class="scope"><button data-scope="query" class="${S.suppScope === "query" ? "on" : ""}">THIS QUERY · ${data.in_query}</button><button data-scope="all" class="${S.suppScope === "all" ? "on" : ""}">ALL AOI · ${data.total}</button></div>` : "";
  body.innerHTML = `<div style="margin-bottom:14px">
      <h4 class="sec-h" style="margin-bottom:6px"><span style="color:var(--coral)">⊘ WHY WE DIDN'T ALERT</span></h4>
      <div style="font:400 12px/1.55 var(--f-ui);color:var(--tx2)">ChronoLens keeps every candidate it stops — and says <b style="color:var(--tx)">which verification layer</b> stopped it, so a suppressed change is auditable, not silent.</div></div>
    ${scope}
    <div class="reasons"><button data-reason="" class="${S.suppReason ? "" : "on"}">ALL<i>${all.length}</i></button>${Object.entries(counts).map(([k, n]) => `<button data-reason="${k}" class="${S.suppReason === k ? "on" : ""}">${esc(REASON[k])}<i>${n}</i></button>`).join("")}</div>
    <div id="rj-list">${list.map(rjCard).join("") || '<div class="empty">Nothing suppressed for this filter.</div>'}</div>`;
}

function rjCard(c) {
  const down = c.status === "downgraded";
  const promoted = c.promoted;
  return `<article class="rj ${down ? "down" : ""} ${promoted ? "promoted" : ""}" data-id="${c.id}" data-kind="candidate">
    <div class="rj-top"><span class="stat ${down ? "down" : ""}">${esc(c.status_label)}</span><span class="cid">CANDIDATE #${c.num} · ${esc(c.tile_id)} · ${c.river_dist_m} m from river</span></div>
    <h6>${esc(c.title)}</h6>
    <div class="ev-strand" style="height:42px;margin:8px -2px 4px">${strandSVG(c.strand, { w: 360, h: 42, pad: 4 })}</div>
    <div class="conv"><b>CONVENTIONAL:</b> CHANGE DETECTED — ${esc(c.conventional.guess.replace("Possible ", "possible "))} · ${esc(c.conventional.delta)}</div>
    <div class="ex">${esc(c.explanation)}</div>
    <div class="mini-lad">${c.checks.map((k) => `<i class="${k.status}" title="${esc(k.label)}: ${esc(k.detail)}"></i>`).join("")}</div>
    <div class="mini-lab">${c.checks.map((k) => `<span>${CHK_ABBR[k.id]}</span>`).join("")}</div>
    <div class="rj-act"><button class="btn" data-open="1">OPEN EVIDENCE</button><button class="btn" data-promote="1">↑ PROMOTE</button></div>
  </article>`;
}

// ------------------------------------------------------------------ audit
export async function renderAudit(body) {
  const a = await api.audit();
  const names = a.facet_names;
  const def = [0.4, 0.2, 0.15, 0.15, 0.1];
  body.innerHTML = `<h4 class="sec-h">SIMILARITY WEIGHTS · <span style="color:var(--amber)">LEARNED FROM FEEDBACK</span></h4>
    <div style="margin-bottom:18px">${names.map((n, i) => `<div class="slider" style="grid-template-columns:78px 1fr 40px"><span>${n}</span><div style="height:4px;background:var(--bg4);position:relative"><i style="position:absolute;left:0;top:0;bottom:0;width:${a.weights[i] * 100}%;background:var(--amber)"></i><i style="position:absolute;left:${def[i] * 100}%;top:-3px;bottom:-3px;width:1px;background:var(--tx2)"></i></div><b>${pct(a.weights[i])}</b></div>`).join("")}
      <div style="font:400 10.5px var(--f-ui);color:var(--tx3);margin-top:8px">white tick = default weight. Rocchio-style update over the five facets, from confirmed / rejected examples.</div></div>
    <h4 class="sec-h">AUDIT TRAIL · ${a.total} ENTRIES <button data-reset="1" class="lbl" style="color:var(--coral)">RESET DEMO STATE</button></h4>
    ${a.entries.map((x) => `<div class="audit-item"><span class="ts">${esc(x.ts.replace("T", " ").replace("Z", " UTC"))}</span><br><b class="d-${x.decision}">${esc(x.decision.replace("_", " ").toUpperCase())}</b> · ${esc(x.event_id)} · ${esc(x.analyst)}${x.reason ? " · " + esc(x.reason) : ""}${x.note ? `<br><span style="color:var(--tx3)">${esc(x.note)}</span>` : ""}${x.query_id ? `<br><span class="ts">under ${esc(x.query_id)}</span>` : ""}</div>`).join("")}`;
  $("#n-audit").textContent = a.total;
}
