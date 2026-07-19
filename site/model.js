// Rules-first Bayesian scoring per block. Two mechanisms, kept separate on purpose:
// a diffusion (priors + evidence decaying on a ~10-min half-life) and jumps
// (observed arrivals/departures that move a block's odds immediately).

export const LIKELY = 0.35;
export const MAYBE = 0.18;
const HALF_LIFE_MIN = 10;
const POST_ASP_MIN = 45;        // churn window after street cleaning ends
const CAM_REACH_MI = 0.18;      // beyond this a camera says nothing about a block
const CAM_SCALE_MI = 0.07;      // distance decay constant

// P(≥1 open spot) baseline by NY hour, residential UES side street, weekday.
const PRIOR_HOURLY = [
  0.04, 0.03, 0.03, 0.03, 0.03, 0.04, 0.06, 0.09, 0.11, 0.12, 0.10, 0.09,
  0.08, 0.08, 0.08, 0.09, 0.11, 0.13, 0.16, 0.18, 0.16, 0.12, 0.08, 0.05,
];

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function haversineMiles(aLat, aLng, bLat, bLng) {
  const dy = (aLat - bLat) * 69.05;
  const dx = (aLng - bLng) * 69.17 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function nyNow(ts = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short",
    hour: "numeric", minute: "numeric", hourCycle: "h23",
  }).formatToParts(new Date(ts));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dow = DOW[get("weekday")] ?? 0;
  const minutes = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
  return { dow, minutes, hour: Math.floor(minutes / 60) };
}

export const fmtHM = (min) => {
  const h24 = Math.floor(min / 60), m = min % 60;
  const h = ((h24 + 11) % 12) + 1;
  return `${h}${m ? ":" + String(m).padStart(2, "0") : ""}${h24 < 12 ? "a" : "p"}`;
};
export const fmtAgeMs = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

function prior(block, t) {
  let p = PRIOR_HOURLY[t.hour];
  if (t.dow === 6 && t.hour >= 8 && t.hour < 18) p *= 1.4;
  if (t.dow === 0) p *= t.hour >= 17 && t.hour < 22 ? 0.7 : 1.25;
  const sides = Object.values(block.sides || {});
  if (sides.some((s) => s.meter >= 2) && t.hour >= 9 && t.hour < 19) p *= 1.3;
  const dead = sides.length >= 2 &&
    sides.every((s) => s.noStanding + s.noParking >= Math.max(3, s.signs * 0.6));
  if (dead) p *= 0.45;
  return clamp(p, 0.01, 0.4);
}

function aspEval(block, t) {
  const res = { boost: 0, churnNow: false, churnSide: null, churnEndsIn: null, why: [] };
  for (const [side, rules] of Object.entries(block.sides || {})) {
    const asp = rules.asp;
    if (!asp || !asp.days.includes(t.dow)) continue;
    if (t.minutes >= asp.start && t.minutes < asp.end) {
      res.churnNow = true;
      res.churnSide = side;
      res.churnEndsIn = asp.end - t.minutes;
      res.why.push({ t: `street cleaning on ${side} side now — big churn when it ends ${fmtHM(asp.end)}`, mag: 0.8 });
    } else if (t.minutes >= asp.end && t.minutes < asp.end + POST_ASP_MIN) {
      const ago = t.minutes - asp.end;
      const b = 1.5 * (1 - ago / POST_ASP_MIN);
      res.boost += b;
      res.why.push({ t: `cleaning on ${side} side ended ${ago}m ago — churn window`, mag: b });
    } else if (asp.start > t.minutes && asp.start - t.minutes <= 60) {
      res.why.push({ t: `cleaning on ${side} side starts ${fmtHM(asp.start)}`, mag: 0.1 });
    }
  }
  return res;
}

// Net count change per camera over ~15 min: negative delta = net outflow = good.
function camDelta(entry, nowTs) {
  const h = entry.history || [];
  if (h.length < 2 || entry.error) return null;
  const [tsN, cN] = h[h.length - 1];
  const tN = Date.parse(tsN);
  const target = tN - 15 * 60000;
  let best = null, bestGap = Infinity;
  for (const [ts, c] of h) {
    const tp = Date.parse(ts);
    const span = tN - tp;
    if (span < 6 * 60000 || span > 25 * 60000) continue;
    const gap = Math.abs(tp - target);
    if (gap < bestGap) { bestGap = gap; best = [tp, c]; }
  }
  if (!best || cN == null || best[1] == null) return null;
  return { delta: cN - best[1], ageMin: Math.max(0, (nowTs - tN) / 60000) };
}

export function scoreAll({ blocks, cameras, state, liveEvents = [], now = Date.now() }) {
  const t = nyNow(now);
  const camList = cameras.cameras.map((c) => ({
    ...c,
    entry: state?.cameras?.[c.id] || null,
  }));

  return blocks.blocks.map((block) => {
    const p0 = prior(block, t);
    const why = [{ t: `${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][t.dow]} ${fmtHM(t.minutes)} baseline ${Math.round(p0 * 100)}%`, mag: 0.01 }];
    let x = logit(p0);

    const asp = aspEval(block, t);
    x += asp.boost;
    why.push(...asp.why);

    let camSum = 0, liveSum = 0;
    for (const cam of camList) {
      const d = haversineMiles(block.lat, block.lng, cam.lat, cam.lng);
      if (d > CAM_REACH_MI) continue;
      const w = Math.exp(-d / CAM_SCALE_MI);

      if (cam.entry) {
        const cd = camDelta(cam.entry, now);
        if (cd && Math.abs(cd.delta) >= 2) {
          const decay = Math.pow(0.5, cd.ageMin / HALF_LIFE_MIN);
          const contrib = 0.45 * w * decay * clamp(-cd.delta, -3, 3);
          camSum += contrib;
          why.push({
            t: `net ${cd.delta < 0 ? "outflow" : "inflow"} of ${Math.abs(cd.delta)} @ ${cam.name} (${Math.round(cd.ageMin)}m old)`,
            mag: contrib,
          });
        }
      }
      for (const ev of liveEvents) {
        if (ev.camId !== cam.id) continue;
        const ageMin = (now - ev.ts) / 60000;
        if (ageMin > 25) continue;
        const contrib = ev.type === "departure"
          ? 1.3 * w * Math.pow(0.5, ageMin / 10)
          : -1.6 * w * Math.pow(0.5, ageMin / 12);
        liveSum += contrib;
        why.push({
          t: `${ev.type} seen ${fmtAgeMs(now - ev.ts)} @ ${cam.name}`,
          mag: contrib,
        });
      }
    }
    x += clamp(camSum, -2, 2) + clamp(liveSum, -2.5, 2.5);

    const p = clamp(sigmoid(x), 0.01, 0.92);
    const label = asp.churnNow ? "churn" : p >= LIKELY ? "likely" : p >= MAYBE ? "maybe" : "quiet";
    why.sort((a, b) => Math.abs(b.mag) - Math.abs(a.mag));
    return {
      id: block.id, block, p, label,
      churnNow: asp.churnNow, churnSide: asp.churnSide, churnEndsIn: asp.churnEndsIn,
      camSum, liveSum, prior: p0, why: why.slice(0, 4),
    };
  });
}

// Upcoming/current street-cleaning windows (they seed the best availability).
export function churnWindows(blocks, now = Date.now(), horizonMin = 240) {
  const t = nyNow(now);
  const seen = new Map();
  for (const block of blocks.blocks) {
    for (const [side, rules] of Object.entries(block.sides || {})) {
      const asp = rules.asp;
      if (!asp || !asp.days.includes(t.dow)) continue;
      if (asp.end + POST_ASP_MIN <= t.minutes || asp.start > t.minutes + horizonMin) continue;
      const key = `${asp.start}-${asp.end}-${side}`;
      if (!seen.has(key)) {
        seen.set(key, { start: asp.start, end: asp.end, side, blocks: [] });
      }
      seen.get(key).blocks.push(block.label);
    }
  }
  return [...seen.values()].sort((a, b) => a.start - b.start);
}
