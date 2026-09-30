// Map layer: MapLibre with LOCAL imagery only (no tiles, no external style, no glyph server).
import { miniStrand } from "./strand.js";
import { $, tween, ease } from "./util.js";

export const M = { map: null, markers: new Map(), arcs: [], aoi: null, handlers: {} };
const NS = "http://www.w3.org/2000/svg";

export function initMap(aoi, handlers) {
  M.aoi = aoi;
  M.handlers = handlers || {};
  const [w, s, e, n] = aoi.bounds;
  const map = new maplibregl.Map({
    container: "map",
    style: { version: 8, sources: {}, layers: [] },
    bounds: [[w, s], [e, n]],
    fitBoundsOptions: { padding: 24 },
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    maxPitch: 0,
    renderWorldCopies: false,
    fadeDuration: 0,
  });
  map.touchZoomRotate.disableRotation();
  M.map = map;
  return new Promise((res) => {
    map.on("load", () => {
      const pad = 0.012;
      map.setMaxBounds([[w - pad * 3, s - pad * 3], [e + pad * 3, n + pad * 3]]);
      for (const k of ["s2", "s1", "fused"]) {
        map.addSource("base-" + k, { type: "image", url: aoi.basemaps[k], coordinates: aoi.image_coordinates });
        map.addLayer({
          id: "base-" + k, type: "raster", source: "base-" + k,
          paint: { "raster-opacity": k === "s2" ? 1 : 0, "raster-opacity-transition": { duration: 600 }, "raster-saturation": k === "s1" ? -0.1 : -0.42, "raster-contrast": 0.1, "raster-brightness-max": 0.84, "raster-fade-duration": 0 },
        });
      }
      // graticule (2 km)
      const feats = [];
      const dx = (e - w) / 6.4, dy = (n - s) / 6.4;
      for (let i = 1; i < 6; i++) {
        feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[w + dx * i * 1.0667, s], [w + dx * i * 1.0667, n]] } });
        feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[w, s + dy * i * 1.0667], [e, s + dy * i * 1.0667]] } });
      }
      map.addSource("grat", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
      map.addLayer({ id: "grat", type: "line", source: "grat", paint: { "line-color": "#9fb6d3", "line-opacity": 0.09, "line-width": 1 } });
      map.addSource("aoi-b", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [[w, n], [e, n], [e, s], [w, s], [w, n]] } } });
      map.addLayer({ id: "aoi-b", type: "line", source: "aoi-b", paint: { "line-color": "#dde5ee", "line-opacity": 0.28, "line-width": 1, "line-dasharray": [2, 3] } });
      map.addSource("roads", { type: "geojson", data: { type: "FeatureCollection", features: aoi.roads.map((r) => ({ type: "Feature", properties: { name: r.name }, geometry: { type: r.type, coordinates: r.coordinates } })) } });
      map.addLayer({ id: "roads", type: "line", source: "roads", paint: { "line-color": "#c9d3df", "line-opacity": 0.32, "line-width": 1, "line-dasharray": [1, 2] } });
      map.addSource("river", { type: "geojson", data: { type: "Feature", geometry: aoi.river } });
      map.addLayer({ id: "river-glow", type: "line", source: "river", paint: { "line-color": "#3fd0e8", "line-opacity": 0.13, "line-width": 12, "line-blur": 8 } });
      map.addLayer({ id: "river-line", type: "line", source: "river", paint: { "line-color": "#7fd8ee", "line-opacity": 0.55, "line-width": 1.1 } });
      map.on("move", renderArcs);
      map.on("mousemove", (ev) => {
        const c = $("#coords");
        if (c) c.textContent = `${ev.lngLat.lat.toFixed(4)}°N  ${ev.lngLat.lng.toFixed(4)}°E`;
      });
      res(map);
    });
  });
}

export function setBase(v) {
  const m = M.map;
  for (const k of ["s2", "s1", "fused"]) m.setPaintProperty("base-" + k, "raster-opacity", k === v ? 1 : 0);
}

export function fitAOI(opts = {}) {
  const [w, s, e, n] = M.aoi.bounds;
  M.map.fitBounds([[w, s], [e, n]], { padding: opts.padding ?? 24, duration: opts.duration ?? 900 });
}

// ------------------------------------------------------------------ markers
function markerEl(ent) {
  const el = document.createElement("div");
  el.className = "mk is-idx";
  el.dataset.id = ent.id;
  const conf = ent.kind === "event" ? ent.confidence.score : ent.kind === "candidate" ? ent.candidate_score : 0.0;
  const C = 2 * Math.PI * 17;
  el.innerHTML = `<div class="mki">
    <svg width="46" height="46" viewBox="-23 -23 46 46">
      <circle class="ring-bg" r="17" stroke-width="1.5"/>
      <circle class="ring-c" r="17" stroke-width="3" stroke-dasharray="${(conf * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90)"/>
      ${ent.kind === "stable" ? '<rect x="-6" y="-4" width="12" height="8" fill="none" stroke="#66768a" stroke-width="1.2"/>' : miniStrand(ent.strand)}
      <g class="x-mark"><path d="M-5 -5L5 5M5 -5L-5 5" stroke="#ff6b6b" stroke-width="1.8" opacity=".9"/></g>
    </svg>
    <span class="delta">Δ</span>
    <div class="mk-lbl"></div><div class="mk-badge"></div>
    <div class="mk-pips"><i></i><i></i><i></i><i></i></div></div>`;
  el.addEventListener("click", (e) => { e.stopPropagation(); M.handlers.click && M.handlers.click(ent.id, ent.kind); });
  el.addEventListener("mouseenter", () => M.handlers.hover && M.handlers.hover(ent.id, ent.kind, true));
  el.addEventListener("mouseleave", () => M.handlers.hover && M.handlers.hover(ent.id, ent.kind, false));
  return el;
}

export function addMarkers(list) {
  for (const ent of list) {
    if (M.markers.has(ent.id)) continue;
    const el = markerEl(ent);
    const mk = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(ent.centroid).addTo(M.map);
    M.markers.set(ent.id, { mk, el, ent });
  }
}

// model: Map(id -> {cls:[..], badge, label, pips})
export function applyModel(model) {
  for (const [id, r] of M.markers) {
    const m = model.get(id);
    if (!m) { r.el.className = "mk is-hidden"; continue; }
    const cls = "mk " + m.cls.join(" ");
    if (r.el.className !== cls) r.el.className = cls;
    const lbl = r.el.querySelector(".mk-lbl"), bd = r.el.querySelector(".mk-badge");
    if (lbl.textContent !== (m.label ?? "")) lbl.textContent = m.label ?? "";
    if (bd.textContent !== (m.badge ?? "")) bd.textContent = m.badge ?? "";
    const ps = r.el.querySelectorAll(".mk-pips i");
    ps.forEach((p, i) => p.classList.toggle("on", m.pips != null && i < m.pips));
    r.el.style.zIndex = m.z ?? "";
  }
}

export function flyTo(id, zoom = 13.9, dur = 900) {
  const r = M.markers.get(id);
  if (!r) return;
  M.map.easeTo({ center: r.ent.centroid, zoom: Math.max(M.map.getZoom(), zoom), duration: dur });
}
export function flyToBounds(ids, pad = 90) {
  const pts = ids.map((i) => M.markers.get(i)?.ent.centroid).filter(Boolean);
  if (!pts.length) return;
  const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
  pts.forEach((p) => b.extend(p));
  M.map.fitBounds(b, { padding: { top: pad, bottom: pad + 90, left: pad, right: pad }, duration: 1000, maxZoom: 13.6 });
}

// ------------------------------------------------------------------ arcs + sweep
export function setArcs(list) {
  const svg = $("#arcs");
  svg.innerHTML = "";
  M.arcs = list.map((a, i) => {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", a.color || "#ffb020");
    p.setAttribute("stroke-width", a.width || 1.6);
    p.setAttribute("stroke-linecap", "round");
    p.style.opacity = "0";
    if (a.dash) p.setAttribute("stroke-dasharray", a.dash);
    else { p.setAttribute("pathLength", "1"); p.style.strokeDasharray = "1"; p.style.strokeDashoffset = "1"; }
    svg.appendChild(p);
    const rec = { ...a, el: p };
    setTimeout(() => {
      p.style.transition = a.dash ? "opacity .5s" : "stroke-dashoffset .8s cubic-bezier(.2,.7,.2,1), opacity .3s";
      p.style.opacity = String(a.alpha ?? 0.7);
      if (!a.dash) p.style.strokeDashoffset = "0";
    }, (a.delay ?? 0) + 30);
    return rec;
  });
  renderArcs();
}
export function clearArcs() { setArcs([]); }

function renderArcs() {
  if (!M.arcs.length) return;
  for (const a of M.arcs) {
    const p1 = M.map.project(a.from), p2 = M.map.project(a.to);
    const dx = p2.x - p1.x, dy = p2.y - p1.y, d = Math.hypot(dx, dy) || 1;
    const k = 0.2;
    const cx = (p1.x + p2.x) / 2 - dy * k, cy = (p1.y + p2.y) / 2 + dx * k;
    a.el.setAttribute("d", `M${p1.x.toFixed(1)} ${p1.y.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`);
  }
}

export function sweep(lnglat, color = "#ffb020") {
  const svg = $("#arcs");
  const p = M.map.project(lnglat);
  const mk = (w, delay) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", p.x); c.setAttribute("cy", p.y); c.setAttribute("r", 0);
    c.setAttribute("fill", "none"); c.setAttribute("stroke", color); c.setAttribute("stroke-width", w);
    svg.appendChild(c);
    setTimeout(() => {
      tween(1300, (t) => { c.setAttribute("r", 30 + t * 980); c.style.opacity = String((1 - t) * 0.65); }, ease.out).then(() => c.remove());
    }, delay);
  };
  mk(1.5, 0); mk(1, 160);
}

export const project = (ll) => M.map.project(ll);
export const resize = () => M.map && M.map.resize();
