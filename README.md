# ParkScout · UES

Personal street-parking predictor for the blocks within ~0.5 mi of E 68th St & Madison Ave, Manhattan.
It estimates, per side-street block, the probability that at least one curb spot is open **right now** —
and timestamps every prediction so you know how stale it is.

**This is a probabilistic hobby tool.** It never sees whole curbs. Obey posted signs; predictions are hints, not truth.

## How it works

Three signal layers, combined in a rules-first Bayesian score per block:

1. **Rulebook prior (strong evidence).** Per-blockface parking regulations from NYC Open Data
   (`nfid-uabd`): alternate-side (street-cleaning) windows, No Parking/No Standing zones, meters.
   The most predictable availability event in the neighborhood is the **post-street-cleaning churn
   window** (~the 45 min after an ASP window ends). Time-of-day / day-of-week turnover curves fill
   in the rest.
2. **Camera flux (weak, live evidence).** A GitHub Action polls 12 NYC DOT traffic cameras around
   the neighborhood every ~5–10 min, counts vehicles with YOLOv8-nano (ONNX), and commits the
   counts to the `data` branch. Net outflow near a block nudges its score up; net inflow kills
   predictions (a car that entered and didn't leave probably took the spot).
3. **Hunt mode (strong, live evidence — while the dashboard is open).** The browser polls the same
   cameras every ~12 s through a tiny proxy and runs DETR object detection locally
   (transformers.js). Boxes that persist across frames = parked cars; a stable box disappearing =
   a departure = **spot likely open**, stamped with camera + time. New stable boxes = arrivals =
   predictions killed.

Every predicted-open spot carries `firstPredictedAt` / `lastEvidenceAt`, decays with a ~10-minute
half-life (spots don't last), and is closed with a reason (`arrival-evidence` or `decayed`).
Your taps on "got a spot / struck out" are stored locally and scored (Brier) to calibrate the model.

## Layout

```
site/                  static dashboard (Netlify publish dir; no build step)
  data/cameras.json    the 12 polled cameras (id, name, lat/lng)
  data/blocks.json     ~100 side-street blocks w/ centroids + parsed ASP rules
netlify/functions/     cam.mjs — CORS proxy for camera JPEGs (allowlisted ids only)
scraper/               Python: fetch frames → YOLO counts → state.json (+ daily history)
models/yolov8n.onnx    exported detector (official ultralytics weights)
scripts/build_blocks.py  regenerate blocks.json (geometry fit + NYC Open Data signs parse)
scripts/dev.py         local dev server: static site + cam proxy + local state
.github/workflows/scrape.yml  the 5-min cron
```

State lives on the **`data` branch** (`state.json`, `history/YYYY-MM-DD.jsonl`) so the main branch
stays clean and Netlify never rebuilds on data commits. The site reads `/state/state.json`, which
Netlify proxies to `raw.githubusercontent.com/kimseyri/parkscout/data/`.

## Deploy (one-time)

The repo is Netlify-ready. Either:

- **UI:** app.netlify.com → Add new site → Import from GitHub → pick `kimseyri/parkscout`.
  Build settings are read from `netlify.toml` (publish `site/`, no build command). Done.
- **CLI:** `npm i -g netlify-cli && netlify login && netlify init` (pick this repo), or
  `netlify deploy --prod` from the repo root.

Local dev: `python3 scripts/dev.py` → http://localhost:8787 (serves the site, proxies cameras,
serves `data-local/` as state).

## Roadmap

- ASP suspension feed (needs a free NYC API Portal key) — suspended days shift the churn model
- Retune priors from accumulated `history/` + feedback taps
- Per-camera curb masks to separate parked lanes from moving traffic in the 5-min counts

## Data credits & posture

Camera imagery: NYC DOT via NYCTMC public feeds (low-volume, personal use; no plates, no
identities — vehicle counts only). Regulations: NYC Open Data. Not affiliated with NYC DOT.
