// Thin client over the local ChronoLens API. Every screen loads its data through here.
const cache = new Map();

async function j(url, opt) {
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const post = (url, body) => j(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
const memo = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};

export const api = {
  system: () => j("/api/system"),
  aoi: () => j("/api/aoi"),
  events: () => j("/api/events"),
  rejected: (queryId, reason) => j(`/api/rejected?${queryId ? "query_id=" + queryId : ""}${reason ? "&reason=" + reason : ""}`),
  stable: () => j("/api/stable"),
  search: (query, overrides = {}, replay = true) => post("/api/search", { query, overrides, replay }),
  event: (id) => memo("ev:" + id, () => j(`/api/events/${id}`)),
  trajectory: (id, kind) => memo("tr:" + id, () => j(kind === "candidate" ? `/api/rejected/${id}/trajectory` : `/api/events/${id}/trajectory`)),
  imagery: (id, kind) => memo("im:" + id, () => j(kind === "candidate" ? `/api/rejected/${id}/imagery` : `/api/events/${id}/imagery`)),
  evidence: (id) => j(`/api/events/${id}/evidence`),
  provenance: (id, kind) => j(kind === "candidate" ? `/api/rejected/${id}/provenance` : `/api/events/${id}/provenance`),
  similar: (id, weights) => j(`/api/events/${id}/similar${weights ? "?weights=" + weights.join(",") : ""}`),
  appearance: (id) => j(`/api/events/${id}/appearance-similar`),
  candidate: (id) => j(`/api/rejected/${id}`),
  feedback: (id, decision, reason = "", note = "", context = {}) => { cache.delete("ev:" + id); return post(`/api/events/${id}/feedback`, { decision, reason, note, context }); },
  promote: (id, note = "") => post(`/api/rejected/${id}/promote`, { note }),
  audit: () => j("/api/audit"),
  reset: () => post("/api/reset"),
  exportUrl: (ids) => `/api/export?ids=${ids.join(",")}`,
};
