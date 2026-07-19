"""Poll NYC DOT cameras, count vehicles, update state.json + daily history JSONL.

Usage: python scraper/scrape.py --data <data-dir> [--cameras site/data/cameras.json]
                                [--model models/yolov8n.onnx]
"""
import argparse
import hashlib
import io
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from detect import Detector

SNAPSHOT = "https://webcams.nyctmc.org/api/cameras/{id}/image"
UA = {"User-Agent": "parkscout/1.0 (personal, low-volume)"}
HISTORY_KEEP = 48  # in-state points per camera (~4h at 5-min cadence)
EMA_ALPHA = 0.35


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch(url, tries=2, timeout=15):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 — record and retry
            last = e
    raise last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--cameras", default="site/data/cameras.json")
    ap.add_argument("--model", default="models/yolov8n.onnx")
    args = ap.parse_args()

    data_dir = Path(args.data)
    data_dir.mkdir(parents=True, exist_ok=True)
    state_path = data_dir / "state.json"
    cams = json.loads(Path(args.cameras).read_text())["cameras"]
    state = {"schema": 1, "updated_at": None, "cameras": {}}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text())
        except json.JSONDecodeError:
            pass  # corrupt state: start fresh rather than crash the cron

    det = Detector(args.model)
    ts = now_iso()
    run_counts = {}
    ok = 0
    for cam in cams:
        cid = cam["id"]
        prev = state["cameras"].get(cid, {})
        entry = {"name": cam["name"], "count": prev.get("count"),
                 "ema": prev.get("ema"), "hash": prev.get("hash"),
                 "changed": False, "error": None,
                 "history": prev.get("history", [])}
        try:
            raw = fetch(SNAPSHOT.format(id=cid))
            h = hashlib.sha256(raw).hexdigest()[:16]
            if h == entry["hash"]:
                # frozen frame: carry count forward, skip inference
                count = entry["count"]
            else:
                boxes = det.detect(Image.open(io.BytesIO(raw)))
                count = len(boxes)
                entry["changed"] = True
                entry["hash"] = h
            entry["count"] = count
            if count is not None:
                entry["ema"] = (round(EMA_ALPHA * count + (1 - EMA_ALPHA) * entry["ema"], 2)
                                if isinstance(entry.get("ema"), (int, float)) else float(count))
                entry["history"] = (entry["history"] + [[ts, count]])[-HISTORY_KEEP:]
            run_counts[cid] = count
            ok += 1
        except Exception as e:  # noqa: BLE001 — a dead camera must not kill the run
            entry["error"] = f"{type(e).__name__}: {e}"[:200]
            run_counts[cid] = None
        state["cameras"][cid] = entry

    state["updated_at"] = ts
    # drop entries for cameras no longer in the poll set
    keep = {cam["id"] for cam in cams}
    state["cameras"] = {k: v for k, v in state["cameras"].items() if k in keep}
    state_path.write_text(json.dumps(state, separators=(",", ":")) + "\n")

    hist_dir = data_dir / "history"
    hist_dir.mkdir(exist_ok=True)
    day = ts[:10]
    with (hist_dir / f"{day}.jsonl").open("a") as f:
        f.write(json.dumps({"ts": ts, "counts": run_counts}, separators=(",", ":")) + "\n")

    print(f"[{ts}] {ok}/{len(cams)} cameras ok; counts:",
          {state['cameras'][c]['name']: run_counts[c] for c in run_counts})
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
