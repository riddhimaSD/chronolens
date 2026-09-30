"""
ChronoLens demo — local API.

    python -m uvicorn backend.app:app --port 8000        (from the chronolens/ folder)

Serves the JSON API under /api, the rendered imagery under /assets and the front end at /.
No network access is required or used.
"""
from __future__ import annotations
import asyncio
import json
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .engine import Store

ROOT = Path(__file__).resolve().parent.parent
FRONT = ROOT / "frontend"
ASSETS = ROOT / "assets"

app = FastAPI(title="ChronoLens demo API", version="0.1", docs_url="/api/docs", openapi_url="/api/openapi.json")
store = Store()


class SearchBody(BaseModel):
    query: str
    overrides: dict = {}
    replay: bool = True


class FeedbackBody(BaseModel):
    decision: str                 # confirm | reject | reopen | relevant | not_relevant
    reason: str = ""
    note: str = ""
    context: dict = {}


class PromoteBody(BaseModel):
    note: str = ""


def nf(x):
    if x is None:
        raise HTTPException(404, "not found")
    return x


@app.get("/api/system")
def system():
    return store.system()


@app.get("/api/aoi")
def aoi():
    return store.aoi


@app.post("/api/search")
async def search(body: SearchBody):
    res = store.search(body.query, body.overrides)
    if body.replay:
        await asyncio.sleep(0.18)      # a real retrieval would take a moment; the UI animates the pipeline
    return res


@app.get("/api/events")
def events(type: Optional[str] = None, tier: Optional[str] = None, stage: Optional[str] = None):
    out = []
    for e in store.events.values():
        if type and e["type"] != type:
            continue
        if tier and e["confidence"]["tier"] != tier:
            continue
        if stage and e["stage"] != stage:
            continue
        out.append(store.summary(e))
    out.sort(key=lambda s: -s["confidence"]["score"])
    return dict(events=out, total=len(out))


@app.get("/api/events/{eid}")
def event(eid: str):
    e = nf(store.events.get(eid))
    d = dict(e)
    d["status"] = store.status[eid]
    d["reason"] = store.reasons.get(eid)
    d.pop("facets", None)
    d.pop("appearance", None)
    return d


@app.get("/api/events/{eid}/trajectory")
def trajectory(eid: str):
    return nf(store.trajectory(eid))


@app.get("/api/events/{eid}/evidence")
def evidence(eid: str):
    return nf(store.evidence(eid))


@app.get("/api/events/{eid}/imagery")
def imagery(eid: str):
    return nf(store.imagery(eid))


@app.get("/api/events/{eid}/provenance")
def provenance(eid: str):
    return nf(store.provenance(eid))


@app.get("/api/events/{eid}/similar")
def similar(eid: str, mode: str = "process", weights: Optional[str] = None):
    w = None
    if weights:
        try:
            w = [float(x) for x in weights.split(",")]
            if len(w) != 5:
                w = None
        except ValueError:
            w = None
    return nf(store.similar(eid, mode, w))


@app.get("/api/events/{eid}/appearance-similar")
def appearance_similar(eid: str):
    return nf(store.similar(eid, "appearance"))


@app.post("/api/events/{eid}/feedback")
def feedback(eid: str, body: FeedbackBody):
    if body.decision not in ("confirm", "reject", "reopen", "relevant", "not_relevant"):
        raise HTTPException(400, "bad decision")
    return nf(store.feedback(eid, body.decision, body.reason, body.note, body.context))


@app.get("/api/rejected")
def rejected(query_id: Optional[str] = None, reason: Optional[str] = None):
    return store.rejected(query_id, reason)


@app.get("/api/rejected/{cid}")
def rejected_one(cid: str):
    c = nf(store.cands.get(cid))
    d = store.cand_summary(c)
    d["geometry"] = c["geometry"]
    d["context"] = c["context"]
    return d


@app.get("/api/rejected/{cid}/trajectory")
def rejected_trajectory(cid: str):
    return nf(store.trajectory(cid))


@app.get("/api/rejected/{cid}/imagery")
def rejected_imagery(cid: str):
    return nf(store.imagery(cid))


@app.get("/api/rejected/{cid}/provenance")
def rejected_prov(cid: str):
    return nf(store.provenance(cid))


@app.post("/api/rejected/{cid}/promote")
def promote(cid: str, body: PromoteBody = PromoteBody()):
    return nf(store.promote(cid, body.note))


@app.get("/api/sites/{sid}/imagery")
def site_imagery(sid: str):
    return nf(store.imagery(sid))


@app.get("/api/sites/{sid}/trajectory")
def site_traj(sid: str):
    return nf(store.trajectory(sid))


@app.get("/api/stable")
def stable():
    return dict(sites=list(store.decoys.values()))


@app.get("/api/audit")
def audit():
    return dict(entries=list(reversed(store.audit)), total=len(store.audit), weights=store.weights, facet_names=["shape", "type", "magnitude", "sensor", "context"])


@app.get("/api/export")
def export(ids: str = Query(...), format: str = "geojson"):
    fc = store.export([i for i in ids.split(",") if i])
    return Response(json.dumps(fc, ensure_ascii=False, indent=1), media_type="application/geo+json",
                    headers={"Content-Disposition": "attachment; filename=chronolens_export.geojson"})


@app.post("/api/reset")
def reset():
    store.reset()
    return dict(ok=True)


# --------------------------------------------------------------------- static
app.mount("/assets", StaticFiles(directory=str(ASSETS)), name="assets")
app.mount("/static", StaticFiles(directory=str(FRONT)), name="static")


@app.get("/")
def index():
    return FileResponse(FRONT / "index.html", headers={"Cache-Control": "no-cache"})
