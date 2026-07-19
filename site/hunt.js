// Hunt mode: near-live curb watching while the dashboard is open.
// Frames come through /api/cam (the camera host sends no CORS headers), DETR
// runs locally via transformers.js. Boxes that persist across frames = parked
// cars; a long-tenured stable box vanishing = departure = spot likely opened.
//
// Red-light queues can sit still for a light cycle, so: stability needs 4
// consecutive frames, and departures only count for tracks seen ≥6 frames.
// False "arrivals" survive that filter occasionally — they only lower scores,
// which is the safe direction for a parking hunt.

const VEHICLE = new Set(["car", "truck", "bus", "motorcycle", "motorbike", "van"]);
const IOU_MATCH = 0.45;
const STABLE_SEEN = 4;
const TENURE_SEEN = 6;
const MISS_DROP = 2;
const WARMUP = 4;
const CYCLE_MS = 3500;
const THRESHOLD = 0.3;
const W = 352, H = 240;

function iou(a, b) {
  const x1 = Math.max(a.xmin, b.xmin), y1 = Math.max(a.ymin, b.ymin);
  const x2 = Math.min(a.xmax, b.xmax), y2 = Math.min(a.ymax, b.ymax);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.xmax - a.xmin) * (a.ymax - a.ymin);
  const areaB = (b.xmax - b.xmin) * (b.ymax - b.ymin);
  return inter / (areaA + areaB - inter + 1e-9);
}

class Tracker {
  constructor() { this.tracks = new Map(); this.nextId = 1; this.frames = 0; }

  update(dets) {
    this.frames++;
    const events = [];
    const unmatched = new Set(this.tracks.keys());
    for (const det of dets) {
      let bestId = null, best = IOU_MATCH;
      for (const id of unmatched) {
        const v = iou(det, this.tracks.get(id).box);
        if (v > best) { best = v; bestId = id; }
      }
      if (bestId != null) {
        const tr = this.tracks.get(bestId);
        tr.box = det; tr.seen++; tr.missed = 0;
        unmatched.delete(bestId);
        if (!tr.stable && tr.seen >= STABLE_SEEN) {
          tr.stable = true;
          if (this.frames > WARMUP) events.push("arrival");
        }
      } else {
        this.tracks.set(this.nextId++, { box: det, seen: 1, missed: 0, stable: false });
      }
    }
    for (const id of unmatched) {
      const tr = this.tracks.get(id);
      if (++tr.missed >= MISS_DROP) {
        this.tracks.delete(id);
        if (tr.stable && tr.seen >= TENURE_SEEN && this.frames > WARMUP) {
          events.push("departure");
        }
      }
    }
    return events;
  }

  boxes() { return [...this.tracks.values()].filter((t) => t.missed === 0); }
  stableCount() { return this.boxes().filter((t) => t.stable).length; }
}

// transformers.js pipeline percentage=true should give 0..1; normalize defensively.
function normBoxes(dets, iw, ih) {
  return dets
    .filter((d) => VEHICLE.has(d.label) && d.score >= THRESHOLD)
    .map((d) => {
      const b = { ...d.box };
      if (Math.max(b.xmax, b.ymax) > 1.5) {
        b.xmin /= iw; b.xmax /= iw; b.ymin /= ih; b.ymax /= ih;
      }
      return b;
    });
}

export function createHunt({ cameras, grid, onEvent, onStatus }) {
  const cams = cameras.cameras.map((c) => ({ ...c, tracker: new Tracker(), card: null }));
  let detector = null, running = false, timer = null, tick = 0, priority = [];

  for (const cam of cams) {
    const card = document.createElement("div");
    card.className = "hunt-cam";
    card.innerHTML = `<canvas width="${W}" height="${H}"></canvas>
      <div class="hunt-meta"><span>${cam.name}</span><span class="hunt-count">–</span></div>`;
    grid.appendChild(card);
    cam.card = card;
    cam.canvas = card.querySelector("canvas");
  }

  async function loadDetector() {
    onStatus("loading transformers.js…");
    let mod;
    try {
      mod = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3");
    } catch {
      mod = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm");
    }
    const progress = (p) => {
      if (p.status === "progress" && p.total) {
        onStatus(`downloading detector… ${Math.round((100 * p.loaded) / p.total)}%`);
      }
    };
    try {
      detector = await mod.pipeline("object-detection", "Xenova/detr-resnet-50",
        { device: "webgpu", progress_callback: progress });
      onStatus("detector ready (webgpu)");
    } catch {
      detector = await mod.pipeline("object-detection", "Xenova/detr-resnet-50",
        { progress_callback: progress });
      onStatus("detector ready (wasm)");
    }
  }

  function nextCam() {
    tick++;
    const pri = cams.filter((c) => priority.includes(c.id));
    const pool = pri.length && tick % 2 === 0 ? pri : cams;
    return pool[Math.floor(tick / (pool === pri ? 2 : 1)) % pool.length];
  }

  async function cycle() {
    if (!running) return;
    const cam = nextCam();
    try {
      const res = await fetch(`/api/cam?id=${cam.id}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`proxy ${res.status}`);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const url = URL.createObjectURL(blob);
      let dets;
      try {
        dets = await detector(url, { threshold: THRESHOLD, percentage: true });
      } finally {
        URL.revokeObjectURL(url);
      }
      const boxes = normBoxes(dets, bitmap.width, bitmap.height);
      const events = cam.tracker.update(boxes);
      draw(cam, bitmap);
      for (const type of events) {
        onEvent({ camId: cam.id, name: cam.name, type, ts: Date.now() });
      }
      cam.card.querySelector(".hunt-count").textContent =
        `${cam.tracker.stableCount()} parked`;
    } catch (e) {
      cam.card.querySelector(".hunt-count").textContent = "err";
      onStatus(`${cam.name}: ${e.message}`.slice(0, 80));
    }
    timer = setTimeout(cycle, CYCLE_MS);
  }

  function draw(cam, bitmap) {
    const ctx = cam.canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, W, H);
    for (const tr of cam.tracker.boxes()) {
      const b = tr.box;
      ctx.lineWidth = 2;
      ctx.strokeStyle = tr.stable ? "#0ca30c" : "rgba(137,135,129,.8)";
      ctx.setLineDash(tr.stable ? [] : [4, 3]);
      ctx.strokeRect(b.xmin * W, b.ymin * H, (b.xmax - b.xmin) * W, (b.ymax - b.ymin) * H);
    }
    ctx.setLineDash([]);
  }

  return {
    async start() {
      if (running) return;
      running = true;
      if (!detector) await loadDetector();
      if (running) cycle();
    },
    stop() {
      running = false;
      clearTimeout(timer);
      onStatus("hunt mode off");
    },
    setPriority(ids) { priority = ids; },
    get running() { return running; },
  };
}
