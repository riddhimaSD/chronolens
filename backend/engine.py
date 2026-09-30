"""
ChronoLens demo backend — data store and deterministic 'intelligence' layer.

There is NO ML here. Search parsing is rule-based, similarity is computed from the curated
per-event facet features, and feedback is a real (tiny) Rocchio update over the five facet
weights. The API shapes are the contract a real pipeline would implement.
"""
from __future__ import annotations
import datetime as dt
import json
import math
import re
import threading
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"
STATE_FILE = Path(__file__).resolve().parent / "state.json"

DEFAULT_WEIGHTS = [0.40, 0.20, 0.15, 0.15, 0.10]      # shape, type, magnitude, sensor, context
FACETS = ["shape", "type", "magnitude", "sensor", "context"]
STAGE_ORDER = ["Vegetation", "Clearing", "Foundation", "Construction", "Completed"]
CONCEPTS = {
    "construction": dict(label="New Construction", detail="new built structure"),
    "clearance": dict(label="Vegetation Clearance", detail="vegetation removed, bare ground"),
    "water_extent": dict(label="Water-Extent Variation", detail="water body expanded or contracted"),
    "road": dict(label="Road Development", detail="new road corridor"),
    "other": dict(label="Surface Change", detail="unclassified surface change"),
}


def _load(name):
    with open(DATA / name, encoding="utf-8") as f:
        return json.load(f)


class Store:
    def __init__(self):
        self.lock = threading.RLock()
        self.aoi = _load("aoi.json")
        self.events = {e["id"]: e for e in _load("events.json")}
        self.cands = {c["id"]: c for c in _load("candidates.json")}
        self.decoys = {d["id"]: d for d in _load("decoys.json")}
        self.series = _load("series.json")
        self.scenes = _load("scenes.json")
        self.frames = _load("frames.json")
        self.pipeline = _load("pipeline.json")
        self.audit_seed = _load("audit_seed.json")
        self.queries: dict[str, dict] = {}
        self.qcount = 0
        self.reset(persist=False)      # every server start begins from the seeded demo state

    # ------------------------------------------------------------------ state
    def reset(self, persist=True):
        with self.lock:
            self.status = {i: "system_confirmed" for i in self.events}
            self.status["E-0445"] = "analyst_confirmed"
            self.status["E-0538"] = "analyst_confirmed"
            self.reasons = {}
            self.cand_state = {i: None for i in self.cands}       # None | promoted
            self.weights = list(DEFAULT_WEIGHTS)
            self.audit = [dict(a) for a in self.audit_seed]
            self.queries = {}
            self.qcount = 0
            if persist:
                self._save()

    def _save(self):
        try:
            with open(STATE_FILE, "w", encoding="utf-8") as f:
                json.dump(dict(status=self.status, reasons=self.reasons, cand_state=self.cand_state, weights=self.weights, audit=self.audit), f)
        except OSError:
            pass

    def _restore(self):
        if not STATE_FILE.exists():
            return
        try:
            st = json.load(open(STATE_FILE, encoding="utf-8"))
            self.status.update({k: v for k, v in st.get("status", {}).items() if k in self.events})
            self.reasons = st.get("reasons", {})
            self.cand_state.update({k: v for k, v in st.get("cand_state", {}).items() if k in self.cands})
            self.weights = st.get("weights", self.weights)
            self.audit = st.get("audit", self.audit)
        except Exception:
            pass

    # ------------------------------------------------------------------ accessors
    def record(self, rid):
        return self.events.get(rid) or self.cands.get(rid) or self.decoys.get(rid)

    def kind_of(self, rid):
        return "event" if rid in self.events else "candidate" if rid in self.cands else "stable" if rid in self.decoys else None

    def summary(self, e, rank=None, extra=None):
        checks = e.get("checks", [])
        s = dict(
            id=e["id"], num=e["num"], kind="event", site=e["site"], type=e["type"], type_label=e["type_label"], direction=e["direction"],
            stage=e["stage"], status=self.status[e["id"]], centroid=e["centroid"], px=e["px"], area_ha=e["area_ha"], tile_id=e["tile_id"],
            confidence=dict(score=e["confidence"]["score"], tier=e["confidence"]["tier"]),
            onset=dict(estimate=e["onset"]["estimate"], half_width_days=e["onset"]["half_width_days"], first_supporting=e["onset"]["first_supporting"],
                       last_clean_pre=e["onset"]["last_clean_pre"]),
            duration_days=e["duration_days"], persistence_obs=e["persistence_obs"], magnitude_sigma=e["magnitude_sigma"],
            river_dist_m=e["context"]["river_dist_m"], sensor_evidence=dict(s2=e["sensor_evidence"]["s2"], s1=e["sensor_evidence"]["s1"]),
            checks_passed=sum(1 for c in checks if c["status"] == "pass"), checks_total=len(checks), strand=e["strand"], cp_index=e.get("cp_index"),
            hero=e.get("hero", False), summary=e["summary"], reason=self.reasons.get(e["id"]), state_sequence=e.get("state_sequence"),
        )
        if rank is not None:
            s["rank"] = rank
        if extra:
            s.update(extra)
        return s

    def cand_summary(self, c, in_query=None):
        return dict(
            id=c["id"], num=c["num"], kind="candidate", status=c["status"], status_label=c["status_label"], reason_code=c["reason_code"], title=c["title"],
            apparent_type=c["apparent_type"], failed_step=c["failed_step"], explanation=c["explanation"], flags=c["flags"], centroid=c["centroid"], px=c["px"],
            river_dist_m=c["context"]["river_dist_m"], conventional=c["conventional"], candidate_score=c["candidate_score"], strand=c["strand"],
            flag_index=c.get("flag_index"), promoted=self.cand_state.get(c["id"]) == "promoted", in_query=in_query, tile_id=c["tile_id"],
            checks=c["checks"],
        )

    # ------------------------------------------------------------------ query parsing
    def parse_query(self, text: str, ov: dict | None = None):
        ov = ov or {}
        q = (text or "").strip()
        ql = q.lower()
        rules = [
            ("construction", ["construct", "built", "build", "structure", "building", "warehouse", "factory", "development", "compound", "new site"]),
            ("water_extent", ["water", "flood", "lake", "pond", "reservoir", "wetland", "inundat"]),
            ("road", ["road", "highway", "street", "route", "bypass", "lane"]),
            ("clearance", ["clear", "deforest", "vegetation loss", "felled", "cut down", "stripped", "bare"]),
            ("other", ["dump", "greenhouse", "polytunnel", "orchard", "plantation"]),
        ]
        concept = None
        for key, words in rules:
            if any(w in ql for w in words):
                concept = key
                break
        static = False
        if concept is None and any(w in ql for w in ["vehicle", "truck", "car ", "cars", "parking", "concentration", "aircraft", "ship", "tank"]):
            static = True
        # spatial
        spatial = None
        m = re.search(r"within\s+(\d+(?:\.\d+)?)\s*(km|m)\b", ql)
        near_river = bool(re.search(r"(near|by|along|beside|next to|close to|adjacent to|around)\s+(a|the)?\s*(river|riverbank|stream)", ql)) or "riverside" in ql or "river" in ql
        if near_river or (m and "river" in ql):
            dist = 500
            if m:
                dist = float(m.group(1)) * (1000 if m.group(2) == "km" else 1)
            spatial = dict(relation="river", max_m=int(ov.get("river_m", dist)))
        if spatial is None and "river_m" in ov:
            spatial = dict(relation="river", max_m=int(ov["river_m"]))
        if spatial:
            spatial["label"] = f"Within {spatial['max_m']:,} m of River"
        # time
        end = dt.date.fromisoformat(self.aoi["time"]["end"])
        months = 24
        mm = re.search(r"last\s+(\d+)\s+months?", ql)
        label = "Last 24 Months"
        if mm:
            months = int(mm.group(1))
            label = f"Last {months} Months"
        elif "this year" in ql or "recent" in ql or "recently" in ql:
            months = 6 if "recent" in ql else 6
            label = "Last 6 Months" if "recent" in ql else "This Year (2026)"
        elif "last year" in ql:
            months = 12
            label = "Last 12 Months"
        if "months" in ov:
            months = int(ov["months"])
            label = f"Last {months} Months"
        start = end - dt.timedelta(days=int(months * 30.4))
        # sensors
        sensors = ["S1", "S2"]
        if re.search(r"\b(sar|radar|sentinel-1|s1)\b", ql) and not re.search(r"\b(optical|sentinel-2|s2)\b", ql):
            sensors = ["S1"]
        elif re.search(r"\b(optical|sentinel-2|s2)\b", ql) and not re.search(r"\b(sar|radar|sentinel-1|s1)\b", ql):
            sensors = ["S2"]
        if "sensors" in ov and ov["sensors"]:
            sensors = ov["sensors"]
        sens_label = {"S1": "Sentinel-1 (SAR)", "S2": "Sentinel-2 (optical)"}
        s_label = " + ".join(sens_label[s].split(" ")[0] for s in sensors) if len(sensors) == 2 else sens_label[sensors[0]]
        s_label = "Sentinel-1 + Sentinel-2" if len(sensors) == 2 else s_label
        interpretation = None
        if concept is None and not static:
            concept = "construction"
            interpretation = "No supported change concept recognised — interpreted as the closest supported concept, new construction."
        intent = dict(
            text=q, static=static,
            concept=None if static else dict(key=concept, **CONCEPTS[concept]),
            spatial=spatial,
            time=dict(months=months, label=label, from_=start.isoformat(), to=end.isoformat()),
            sensors=dict(list=sensors, label=s_label),
            interpretation=interpretation,
        )
        return intent

    # ------------------------------------------------------------------ search
    def search(self, text, ov=None):
        ov = ov or {}
        intent = self.parse_query(text, ov)
        with self.lock:
            self.qcount += 1
            qid = f"Q-{self.qcount:04d}"
        if intent["static"]:
            res = self.static_search(intent)
            res["query_id"] = qid
            self.queries[qid] = dict(intent=intent, suppressed=[], results=[])
            return res
        concept = intent["concept"]["key"]
        sp = intent["spatial"]
        t_from = intent["time"]["from_"]
        pool = []
        for e in self.events.values():
            pool.append(dict(id=e["id"], kind="event", type=e["type"], stage=e["stage"], river=e["context"]["river_dist_m"], fails=None,
                             date=e["onset"]["first_supporting"], s1=e["sensor_evidence"]["s1"], s2=e["sensor_evidence"]["s2"]))
        for c in self.cands.values():
            t = "water_extent" if c["apparent_type"] == "water" else c["apparent_type"]
            dts = self.series[c["id"]]["s2"][c["flag_index"] if c.get("flag_index") is not None else 0]["date"]
            pool.append(dict(id=c["id"], kind="candidate", type=t, stage=None, river=c["context"]["river_dist_m"], fails=c["failed_step"], date=dts, s1=None, s2=None))
        stages = []

        def add(key, label, items, note=None, removed=None):
            stages.append(dict(key=key, label=label, count=len(items), removed=[r["id"] for r in (removed or [])], note=note))

        add("pool", "Candidate changes in AOI", pool, "events + suppressed candidates")
        cur = [p for p in pool if p["type"] == concept and (concept != "construction" or p["kind"] == "candidate" or p["stage"] in ("Construction", "Completed"))]
        add("concept", f"Concept · {intent['concept']['detail']}", cur, removed=[p for p in pool if p not in cur])
        if sp:
            nxt = [p for p in cur if p["river"] <= sp["max_m"]]
            add("spatial", f"≤ {sp['max_m']:,} m of river", nxt, removed=[p for p in cur if p not in nxt])
            cur = nxt
        nxt = [p for p in cur if p["kind"] == "candidate" or p["date"] >= t_from]
        if len(nxt) != len(cur):
            add("time", intent["time"]["label"], nxt, removed=[p for p in cur if p not in nxt])
            cur = nxt
        groups = [("qa", "Quality & registration valid", ("quality", "registration")), ("baseline", "Seasonal baseline exceeded", ("baseline",)),
                  ("persistence", "Persistent across observations", ("persistence",)), ("verify", "Context & cross-sensor verified", ("context", "sar"))]
        suppressed = []
        for key, label, fails in groups:
            nxt = [p for p in cur if p["fails"] not in fails]
            rem = [p for p in cur if p not in nxt]
            suppressed += [p["id"] for p in rem]
            add(key, label, nxt, removed=rem)
            cur = nxt
        # sensor filter
        sens = intent["sensors"]["list"]
        if len(sens) == 1:
            k = "s1" if sens[0] == "S1" else "s2"
            nxt = [p for p in cur if p["kind"] == "event" and p[k] in ("supports", "ambiguous")]
            add("sensor", f"{intent['sensors']['label']} evidence", nxt, removed=[p for p in cur if p not in nxt])
            cur = nxt
        # analyst-rejected events drop out
        cur = [p for p in cur if self.status.get(p["id"]) != "analyst_rejected"]
        events = [self.events[p["id"]] for p in cur if p["kind"] == "event"]
        # tier / type filters (post-retrieval controls)
        tiers = ov.get("tiers")
        if tiers:
            events = [e for e in events if e["confidence"]["tier"] in tiers]
        def rank_score(e):
            b = e["confidence"]["score"]
            if self.status[e["id"]] == "analyst_confirmed":
                b += 0.05
            return b
        events.sort(key=lambda e: -rank_score(e))
        alerts = [self.summary(e, rank=i + 1) for i, e in enumerate(events)]
        tiers_count = {t: sum(1 for a in alerts if a["confidence"]["tier"] == t) for t in ("high", "medium", "low")}
        add("alerts", "Alerts", alerts, note=f"{tiers_count['high']} high · {tiers_count['medium']} medium")
        # timings for the animation
        for i, s in enumerate(stages):
            s["ms"] = 340 if i else 260
        res = dict(
            query_id=qid, kind="events", intent=intent, pipeline=stages, results=alerts, tier_counts=tiers_count,
            suppressed_ids=suppressed, suppressed_count=len(suppressed), aoi_suppressed_count=len(self.cands),
            headline=f"{len(alerts)} Change Events" + (f" within {sp['max_m']:,} m of the river" if sp else ""),
        )
        self.queries[qid] = dict(intent=intent, suppressed=suppressed, results=[a["id"] for a in alerts])
        return res

    def static_search(self, intent):
        hits = []
        for i, (rid, sc, note) in enumerate([("D-01", 0.31, "Large hard-standing area, light-toned roofs"), ("D-05", 0.28, "Open yard between roof blocks"), ("E-0517", 0.24, "Paved yard beside new buildings"),
                                            ("D-04", 0.19, "Bare open ground, pale surface")]):
            rec = self.record(rid)
            hits.append(dict(id=rid, rank=i + 1, kind="tile", label=rec.get("label") or rec.get("summary", rid), score=sc, note=note, centroid=rec["centroid"], px=rec["px"],
                             strand=rec["strand"], frame_url=f"/assets/chips/{rid}/s2_{(46 if rid.startswith('D-') else 46):02d}.jpg"))
        return dict(kind="static", intent=intent, pipeline=[], results=hits, suppressed_ids=[], suppressed_count=0, aoi_suppressed_count=len(self.cands), tier_counts={},
                    notice="Static tile query: this is not a change query, so it is answered from the tile index. At 10 m resolution individual vehicles are not resolvable — results are low-confidence proxies for open hard-standing.",
                    headline="4 tile matches (low confidence)")

    # ------------------------------------------------------------------ similarity
    @staticmethod
    def _curve_sim(a, b, scale):
        pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None]
        if len(pairs) < 3:
            return 0.25, len(pairs)
        d = sum(abs(x - y) for x, y in pairs) / len(pairs)
        return max(0.0, 1 - d / scale), len(pairs)

    def facet_scores(self, a, b):
        fa, fb = a["facets"], b["facets"]
        shape, n = self._curve_sim(fa["curve"], fb["curve"], 0.55)
        sensor, _ = self._curve_sim(fa["curve1"], fb["curve1"], 0.6)
        amp = math.exp(-abs(math.log((fa["s1_amp"] + 2) / (fb["s1_amp"] + 2))) * 1.4)
        sensor = 0.7 * sensor + 0.3 * amp
        typ = 1.0 if a["type"] == b["type"] else 0.5 if {a["type"], b["type"]} == {"construction", "clearance"} else 0.2
        mag = math.exp(-abs(math.log((fa["peak"] + 1) / (fb["peak"] + 1))) * 1.5)
        ctx = 0.5 * (1.0 if fa["landcover"] == fb["landcover"] else 0.3) + 0.5 * math.exp(-abs(fa["river"] - fb["river"]) / 1500)
        return dict(shape=shape, type=typ, magnitude=mag, sensor=sensor, context=ctx), n

    def similar(self, eid, mode="process", weights=None):
        proto = self.events.get(eid)
        if not proto:
            return None
        if mode == "appearance":
            return self.appearance_similar(proto)
        w = list(weights) if weights else list(self.weights)
        s = sum(w) or 1
        w = [x / s for x in w]
        items = []
        for e in self.events.values():
            if e["id"] == eid or self.status[e["id"]] == "analyst_rejected":
                continue
            f, n = self.facet_scores(proto, e)
            total = sum(w[i] * f[FACETS[i]] for i in range(5))
            total = min(0.985, 0.5 + (total - 0.5) * 1.15)
            if f["type"] < 1.0:
                continue
            pi, ei = STAGE_ORDER.index(proto["stage"]), STAGE_ORDER.index(e["stage"]) if e["stage"] else 0
            rel = "same" if ei == pi else "earlier" if ei < pi else "later"
            items.append(dict(self.summary(e), similarity=round(total, 4), facets={k: round(v, 3) for k, v in f.items()}, stage_relation=rel,
                              overlap=n, coverage=round(n / 16, 2), trajectory_note=f"{n} of 16 trajectory segments observed"))
        items.sort(key=lambda x: -x["similarity"])
        items = [i for i in items if i["similarity"] >= 0.60][:12]
        for k, it in enumerate(items):
            it["rank"] = k + 1
        stage_groups = {st: [i["id"] for i in items if i["stage"] == st] for st in STAGE_ORDER[1:]}
        earlier = [i for i in items if i["stage_relation"] == "earlier"]
        return dict(mode="process", prototype=self.summary(proto), weights=w, facet_names=FACETS, results=items, stage_groups=stage_groups,
                    earlier_count=len(earlier), earlier_ids=[i["id"] for i in earlier], default_weights=DEFAULT_WEIGHTS,
                    headline=f"{len(items)} events share this change trajectory",
                    lead_time=f"{len(earlier)} location{'s' if len(earlier) != 1 else ''} at earlier stages of the same observed change trajectory.")

    def appearance_similar(self, proto):
        pa = proto.get("appearance")
        pool = []
        for e in self.events.values():
            if e["id"] != proto["id"] and e.get("appearance"):
                pool.append(("event", e))
        for c in self.cands.values():
            if c.get("appearance"):
                pool.append(("candidate", c))
        for d_ in self.decoys.values():
            if d_.get("appearance"):
                pool.append(("stable", d_))

        def cos(a, b):
            na = math.sqrt(sum(x * x for x in a)) or 1
            nb = math.sqrt(sum(x * x for x in b)) or 1
            return sum(x * y for x, y in zip(a, b)) / (na * nb)
        items = []
        for kind, r in pool:
            sim = (cos(pa, r["appearance"]) + 1) / 2
            it = dict(id=r["id"], kind=kind, centroid=r["centroid"], px=r["px"], strand=r["strand"], appearance_similarity=round(sim, 4))
            if kind == "event":
                f, n = self.facet_scores(proto, r)
                w = self.weights
                tot = sum(w[i] * f[FACETS[i]] for i in range(5)) / (sum(w) or 1)
                it.update(label=f"{r['type_label']} · {r['stage'] or ''}".strip(" ·"), process_match=round(tot, 3), verdict="same" if tot >= 0.6 else "different",
                          site=r["site"], stage=r["stage"], type=r["type"], history=f"Change event · {r['type_label'].lower()}")
            elif kind == "candidate":
                it.update(label=r["title"], process_match=0.0, verdict="suppressed", history=f"Suppressed candidate · {r['title'].lower()}", reason_code=r["reason_code"])
            else:
                it.update(label=r["label"], process_match=0.0, verdict="stable", history="Stable · no change in 24 months")
            items.append(it)
        items.sort(key=lambda x: -x["appearance_similarity"])
        items = items[:10]
        for k, it in enumerate(items):
            it["rank"] = k + 1
        no_change = sum(1 for i in items if i["verdict"] in ("stable", "suppressed"))
        # places that changed the same way but do NOT look alike — an appearance search never returns them
        proc = self.similar(proto["id"], "process")
        shown = {i["id"] for i in items}
        missed = [dict(id=r["id"], num=r["num"], stage=r["stage"], site=r["site"], process_match=r["similarity"], centroid=r["centroid"], stage_relation=r["stage_relation"])
                  for r in proc["results"] if r["id"] not in shown]
        note = f"{no_change} of {len(items)} look alike but have no comparable change history."
        if missed:
            note += f" It also misses {len(missed)} place{'s' if len(missed) != 1 else ''} that changed in the same way."
        return dict(mode="appearance", prototype=self.summary(proto), results=items, no_change_count=no_change, missed=missed,
                    headline="These places look similar", note=note)

    # ------------------------------------------------------------------ feedback
    def feedback(self, rid, decision, reason="", note="", ctx=None):
        ctx = ctx or {}
        e = self.events.get(rid)
        if not e:
            return None
        with self.lock:
            prev = self.status[rid]
            weights_before = list(self.weights)
            if decision == "confirm":
                self.status[rid] = "analyst_confirmed"
            elif decision == "reject":
                self.status[rid] = "analyst_rejected"
                self.reasons[rid] = reason
            elif decision == "reopen":
                self.status[rid] = "system_confirmed"
                self.reasons.pop(rid, None)
            # Rocchio over facet weights (only when a prototype context exists)
            proto = self.events.get(ctx.get("prototype_id") or "")
            updated = False
            if proto and proto["id"] != rid and decision in ("confirm", "reject", "relevant", "not_relevant"):
                f, _ = self.facet_scores(proto, e)
                vec = [f[k] for k in FACETS]
                pos = decision in ("confirm", "relevant")
                w = self.weights
                nw = [1.0 * w[i] + (0.55 * vec[i] * 0.4 if pos else -0.35 * vec[i] * 0.4) for i in range(5)]
                # pull toward facets on which the marked item agrees with the prototype
                nw = [max(0.03, x) for x in nw]
                s = sum(nw)
                self.weights = [x / s for x in nw]
                updated = True
            entry = dict(ts=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), analyst="analyst.k", event_id=rid, decision=decision, reason=reason, note=note,
                         prev_status=prev, query_id=ctx.get("query_id"), prototype_id=ctx.get("prototype_id"))
            self.audit.append(entry)
            self._save()
        return dict(entry=entry, event=self.summary(e), weights_before=weights_before, weights=self.weights, weights_updated=updated, facet_names=FACETS)

    def promote(self, cid, note=""):
        c = self.cands.get(cid)
        if not c:
            return None
        with self.lock:
            self.cand_state[cid] = "promoted"
            entry = dict(ts=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), analyst="analyst.k", event_id=cid, decision="promote", reason=c["reason_code"], note=note,
                         prev_status=c["status"], query_id=None, prototype_id=None)
            self.audit.append(entry)
            self._save()
        return dict(entry=entry, candidate=self.cand_summary(c))

    # ------------------------------------------------------------------ detail builders
    def trajectory(self, rid):
        so = self.series.get(rid)
        if not so:
            return None
        rec = self.record(rid)
        kind = self.kind_of(rid)
        seq = rec.get("state_sequence") if kind == "event" else None
        stage_track = None
        if seq:
            stage_track = []
            for i in range(48):
                d_ = self.aoi["time"]["s2_dates"][i]
                st = seq[0]["state"]
                for s in seq:
                    if s["start"] <= d_:
                        st = s["state"]
                stage_track.append(st)
        cp = None
        if kind == "event":
            on = rec["onset"]
            cp = dict(index=so["cp"], estimate=on["estimate"], half_width_days=on["half_width_days"], window_days=on["window_days"], last_clean_pre=on["last_clean_pre"],
                      first_supporting=on["first_supporting"], first_supporting_sensor=on["first_supporting_sensor"], persistence_obs=rec["persistence_obs"], duration_days=rec["duration_days"])
        elif kind == "candidate":
            cp = dict(index=rec.get("flag_index"), estimate=None, note="Candidate deviation (not confirmed)")
        metric = "NDVI"
        return dict(id=rid, kind=kind, s2=so["s2"], s1=so["s1"], agreement=so["agreement"], change_point=cp, state_sequence=seq, stage_track=stage_track,
                    metrics=dict(s2=dict(label="Vegetation index (NDVI)", short="NDVI", unit=""), s1=dict(label="Radar backscatter VV", short="VV", unit="dB")),
                    dates=dict(s2=self.aoi["time"]["s2_dates"], s1=self.aoi["time"]["s1_dates"]), haze_idx=self.aoi.get("haze_idx", []),
                    band_k=3, strand=so["strand"])

    def imagery(self, rid):
        so = self.series.get(rid)
        if not so:
            return None
        fr = self.frames.get(rid, dict(s2=[], s1=[]))
        def build(sensor, obs):
            out = []
            for i in fr[sensor]:
                o = obs[i]
                out.append(dict(i=i, date=o["date"], url=f"/assets/chips/{rid}/{sensor}_{i:02d}.jpg", usable=o["usable"], cloud_frac=o.get("cloud_frac", 0), mask_reason=o.get("mask_reason"),
                                scene_id=o["scene_id"]))
            return out
        return dict(id=rid, chip_km=1.1, s2=build("s2", so["s2"]), s1=build("s1", so["s1"]))

    def evidence(self, rid):
        rec = self.record(rid)
        kind = self.kind_of(rid)
        if kind == "event":
            return dict(id=rid, kind=kind, checks=rec["checks"], sensor_evidence=rec["sensor_evidence"], confidence=rec["confidence"], status=self.status[rid],
                        conventional=rec["conventional"], summary=rec["summary"])
        if kind == "candidate":
            return dict(id=rid, kind=kind, checks=rec["checks"], failed_step=rec["failed_step"], explanation=rec["explanation"], flags=rec["flags"], conventional=rec["conventional"],
                        candidate_score=rec["candidate_score"], status=rec["status"], status_label=rec["status_label"], title=rec["title"], reason_code=rec["reason_code"])
        return None

    def provenance(self, rid):
        rec = self.record(rid)
        kind = self.kind_of(rid)
        if not rec:
            return None
        so = self.series[rid]
        s2s, s1s = self.scenes["S2"], self.scenes["S1"]
        used = []
        if kind == "event":
            on = rec["onset"]
            picks = [("last clean pre-change", on["last_clean_pre_scene"] if "last_clean_pre_scene" in on else on.get("last_clean_scene")),
                     ("first supporting observation", on.get("first_supporting_scene"))]
        else:
            picks = []
        by_id = {s["scene_id"]: s for s in s2s + s1s}
        roles = {}
        for role, sid in picks:
            if sid:
                roles[sid] = role
        roles[s2s[-1]["scene_id"]] = "latest Sentinel-2"
        roles[s1s[-1]["scene_id"]] = "latest Sentinel-1"
        for sid, role in roles.items():
            sc = by_id.get(sid)
            if sc:
                used.append(dict(sc, role=role))
        used.sort(key=lambda s: s["acquired"])
        n_used = sum(1 for o in so["s2"] if o["usable"]) + len(so["s1"])
        steps = [dict(step=p["step"], description=p["description"], status="curated", timestamp="2026-06-17T04:12:09Z") for p in self.pipeline]
        return dict(id=rid, kind=kind, mode="curated", synthetic=True,
                    note="Curated demonstration dataset. Scenes and processing records are synthetic and mirror the schema a live pipeline would fill.",
                    crs=self.aoi["crs"], transform=self.aoi["transform"], tile_id=rec.get("tile_id"), centroid=rec["centroid"],
                    source_scenes=used, observations_used=n_used, scene_total=dict(s2=len(s2s), s1=len(s1s)), processing=steps,
                    processing_timestamp="2026-06-17T04:12:09Z",
                    chain=[dict(level="Change Event", value=rid), dict(level="Temporal observations", value=f"{n_used} usable observations"),
                           dict(level="Source assets", value="cog/<scene_id>.tif (local COG)"), dict(level="Source scenes", value=f"{len(s2s)} S2 + {len(s1s)} S1 in STAC"),
                           dict(level="Acquisition metadata", value="time · sensor · orbit · CRS preserved")],
                    audit=[a for a in self.audit if a["event_id"] == rid])

    def rejected(self, query_id=None, reason=None):
        q = self.queries.get(query_id) if query_id else None
        ids = set(q["suppressed"]) if q else set()
        out = []
        for c in self.cands.values():
            if reason and c["reason_code"] != reason:
                continue
            out.append(self.cand_summary(c, in_query=(c["id"] in ids) if q else None))
        out.sort(key=lambda c: (not c["in_query"] if c["in_query"] is not None else False, c["id"]))
        reasons = {}
        for c in self.cands.values():
            reasons[c["reason_code"]] = reasons.get(c["reason_code"], 0) + 1
        return dict(candidates=out, total=len(self.cands), in_query=len(ids) if q else None, reason_counts=reasons)

    def system(self):
        return dict(name="ChronoLens", mode="curated", offline=True, external_apis=0, local=dict(models="Local", archive="Local", external_apis="None"),
                    aoi=dict(id=self.aoi["id"], name=self.aoi["name"], size_km=self.aoi["size_km"], tiles=self.aoi["tiles"], crs=self.aoi["crs"]),
                    counts=dict(events=len(self.events), candidates=len(self.cands), stable_sites=len(self.decoys), scenes_s2=len(self.scenes["S2"]), scenes_s1=len(self.scenes["S1"]),
                                observations=sum(len(v["s2"]) + len(v["s1"]) for v in self.series.values())),
                    time=dict(start=self.aoi["time"]["start"], end=self.aoi["time"]["end"]), audit_entries=len(self.audit), weights=self.weights, facet_names=FACETS)

    def export(self, ids):
        feats = []
        for rid in ids:
            e = self.events.get(rid)
            if not e:
                continue
            prov = self.provenance(rid)
            feats.append(dict(type="Feature", geometry=e["geometry"], properties=dict(
                event_id=rid, type=e["type"], stage=e["stage"], status=self.status[rid], confidence=e["confidence"]["score"], confidence_tier=e["confidence"]["tier"],
                confidence_components=e["confidence"]["components"], onset_estimate=e["onset"]["estimate"], onset_half_width_days=e["onset"]["half_width_days"],
                last_clean_pre_change=e["onset"]["last_clean_pre"], first_supporting_observation=e["onset"]["first_supporting"],
                sensor_evidence=e["sensor_evidence"], checks=[dict(id=c["id"], status=c["status"], detail=c["detail"]) for c in e["checks"]],
                river_dist_m=e["context"]["river_dist_m"], crs=self.aoi["crs"], tile_id=e["tile_id"],
                provenance=dict(mode="curated-synthetic", source_scenes=prov["source_scenes"], processing=prov["processing"], processing_timestamp=prov["processing_timestamp"]),
                analyst_decisions=[a for a in self.audit if a["event_id"] == rid])))
        return dict(type="FeatureCollection", name="chronolens_export", crs=dict(type="name", properties=dict(name="urn:ogc:def:crs:OGC:1.3:CRS84")), features=feats,
                    properties=dict(generated=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), mode="curated-synthetic-demo", aoi=self.aoi["id"]))
