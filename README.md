# ChronoLens — interactive demo

**Search by change events, not images.**

A working front end + local API that behaves like a complete ChronoLens system. The intelligence layer is **curated**: no ML runs. Events, trajectories, verification checks and similarity relationships are precomputed and served deterministically. Everything else is real: the UI calls a real backend, search runs a real (rule-based) parser and computes a real funnel, "Find More Like This" ranks over per-event facet features, feedback updates state and a real Rocchio-style weight update, and every screen is driven by API responses.

> **Honesty note.** The imagery is **synthetic** (a procedurally generated floodplain rendered from the same surface-state model that produces the time series), and scene IDs are prefixed `SYN_`. The header shows *DEMO INDEX · CURATED*, every API response carries `"mode": "curated"`, and the provenance panel says so. Say it plainly if asked: *the intelligence layer is curated for the demo, and this API contract is what the real pipeline plugs into.*

## Run

```powershell
pip install -r requirements.txt
python -m uvicorn backend.app:app --port 8000
# open http://localhost:8000
```

or double-click `run.bat`. Fully offline: fonts, MapLibre, basemaps and chips are all local (the header's *External requests* counter reads `0`). A first load renders faster on a machine with a GPU-backed browser; use a full-screen window at 1920×1080 for judging (1440×900 also works).

`Reset demo state` (Audit tab) restores the seeded audit trail and learned weights; the server also starts from a clean state.

## The 90-second judge flow

| # | Do | What it proves |
|---|---|---|
| 1 | Click the first suggestion: *Find newly constructed structures near a river.* | Query is **parsed into intent** (change · spatial · time · sensors). Watch the **verification funnel** count down `35 → 16 → 11 → 9 → 8 → 7 → 5` while the map dims what is removed and stopped candidates flash coral. Editing `500 m` re-filters live. |
| 2 | Open the top event | The **Dossier**: linked imagery, trajectory instrument, S1/S2 lanes, verification ladder, confidence components, provenance. |
| 3 | Watch or **drag the time cursor** | Imagery, stage stepper, trajectory cursor, chrono-rail and lane readouts move together. The curve leaves the *location-specific seasonal band* at the change point; the amber gap is "what this place should have done". The monsoon gap in S2 is bridged by Sentinel-1. |
| 4 | Toggle **BEFORE / AFTER** and **S2 / S1 / FUSED** | Cross-sensor evidence is separate and visible. |
| 5 | Close, click **CONVENTIONAL** (top right), then **CHRONOLENS** | A two-date difference flags **35** changes; ChronoLens keeps **26** events and records **9** suppressed candidates. |
| 6 | Open the **⊘ WHY WE DIDN'T ALERT** tab, open *Seasonal vegetation* | The same candidate under two systems (auto-flips). The mint dashed line shows the baseline shifted 21 days fitting the observations, and the ladder shows exactly which layer stopped it. |
| 7 | Back on an event: **FIND MORE LIKE THIS** | Prototype → sweep → arcs to 11 matches by **trajectory similarity**; lead-time lanes show **8 earlier-stage locations**. Tune the five facet weights live; **Align at change point** stacks trajectories. |
| 8 | Switch to **VISUAL APPEARANCE** | Same seed, image-similarity ranking: it returns stable buildings that **never changed** and **misses** the earlier-stage sites (bare ground doesn't look like a finished building). |
| 9 | **Confirm** one, **Reject** one with a reason, open **AUDIT** | State changes for real; ranking re-orders; every action is in the audit trail. |
| 10 | **EXPORT GEOJSON** | Features carry source scenes, processing steps, quality flags and analyst decisions. |

Keyboard: `/` search · `Esc` back · `Space` play history · `←/→` step time · `P` presentation mode.

## Layout

```
chronolens/
  backend/           FastAPI app (app.py) + deterministic engine (engine.py) + data/*.json
  frontend/          index.html, css/app.css, js/*.js (ES modules), vendor/ (MapLibre), fonts/
  assets/            maps/ (3 basemaps) and chips/ (rendered S2/S1 frames per site)
  datagen/           world.py (synthetic world + renderer), build.py (dataset), appearance.py
```

### Regenerating the dataset

```powershell
pip install -r requirements-dev.txt
python datagen/build.py            # data + ~2,000 imagery chips + basemaps (~4 min)
python datagen/build.py --no-chips # data only (keeps existing chips; skips appearance vectors)
```

The build is deterministic. It generates one coherent archive: 26 Change Events, 9 suppressed candidates, 6 stable look-alike sites, 48 observations per sensor per entity. A CCDC-style detector runs over the generated series to derive onset windows, persistence, sensor evidence states and confidence, so the numbers in the UI follow from the data rather than being typed in.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/system` | Header status (`mode`, `offline`, counts) |
| `GET /api/aoi` | AOI bounds, CRS, river/roads, basemaps, time grid |
| `POST /api/search` `{query, overrides}` | Parsed intent, funnel stages, ranked events, suppressed ids |
| `GET /api/events` · `GET /api/events/{id}` | Index / full Change Event |
| `GET /api/events/{id}/trajectory` | Observations, baseline band, change point, agreement, stage track |
| `GET /api/events/{id}/evidence` · `/imagery` · `/provenance` | Ladder + confidence · frames · scenes, processing, CRS, audit |
| `GET /api/events/{id}/similar?weights=` | Change-process similarity (facets, stage relation, lead-time) |
| `GET /api/events/{id}/appearance-similar` | Visual-appearance ranking + places it misses |
| `POST /api/events/{id}/feedback` | confirm · reject · relevant · not_relevant → audit + Rocchio |
| `GET /api/rejected` · `/{id}` · `POST /{id}/promote` | Suppressed candidates, override |
| `GET /api/audit` · `GET /api/export?ids=` · `POST /api/reset` | Audit trail, GeoJSON, reset |

Interactive docs at `/api/docs`.

## Swapping in the real pipeline

The front end depends only on these response shapes. To go live, implement the same endpoints on top of the real event index (Qdrant + PostGIS + STAC) and drop the `mode: "curated"` flag; no UI change is needed.

## What is and isn't real here

| Real | Curated / synthetic |
|---|---|
| Rule-based query parser, funnel counts computed from data, live river-distance re-filter | Scene imagery and time series (synthetic, internally consistent) |
| Facet similarity, live re-ranking, Rocchio weight update from feedback | The "foundation-model" embeddings, change-head and CLIP grounding (not present) |
| Audit trail, promote/confirm/reject state, GeoJSON export | Confidence components (derived from the data, then weighted by a fixed formula, not calibrated) |
| Offline operation, local fonts/maps/assets | Sentinel scene IDs and processing timestamps (schema only) |

## Third-party

MapLibre GL JS (BSD-3-Clause, vendored in `frontend/vendor/`) · Inter, Space Grotesk, JetBrains Mono (SIL OFL 1.1, in `frontend/fonts/`). Licences must be re-checked before any real deployment.

## Deploying (Render)

`render.yaml` is a Render Blueprint: one free web service that serves the API, the front end and all imagery. Start command: `uvicorn backend.app:app --host 0.0.0.0 --port $PORT`; health check: `/api/system`. Notes: the free tier sleeps after ~15 min idle (first request then takes ~1 minute), and demo state (feedback, audit trail) lives in memory, is shared by all visitors, and resets on restart or via *Reset demo state* in the Audit tab.
