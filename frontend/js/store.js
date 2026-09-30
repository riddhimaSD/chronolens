// Shared application state + a tiny pub/sub bus.
export const S = {
  aoi: null,
  system: null,
  events: [],
  eventMap: new Map(),
  cands: [],
  candMap: new Map(),
  stable: [],
  view: "explore",          // explore | dossier | discovery
  tab: "results",           // results | suppressed | audit
  query: null,              // last search response
  running: false,           // funnel animating
  alive: null,              // Set of ids still in the funnel
  flashed: new Set(),       // candidates that have just been stopped by a verification layer
  selectedId: null,
  hoverId: null,
  cursor: 0,                // ms since epoch, shared by imagery / trajectory / chrono-rail / map
  base: "s2",
  lens: "chronolens",       // chronolens | conventional
  disc: null,               // {protoId, mode, process, appearance, weights, align}
  suppScope: "query",
  suppReason: null,
  dossier: null,
  t0: 0,
  t1: 0,
};

const subs = {};
export const on = (ev, fn) => ((subs[ev] ||= []).push(fn), fn);
export const emit = (ev, p) => (subs[ev] || []).forEach((f) => f(p));

export function syncBody() {
  document.body.className = `view-${S.view} lens-${S.lens}` + (S.present ? " present" : "");
}
