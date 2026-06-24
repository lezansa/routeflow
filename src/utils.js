const PROXY = 'https://kxwj3jmncesgk3koupy7mxdudq0xolyz.lambda-url.ap-southeast-2.on.aws/';
const geocodeCache = new Map();
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Geo math ─────────────────────────────────────────────────────────────────

const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function bearingBetween([lat1, lon1], [lat2, lon2]) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
  return (toDeg(Math.atan2(
    Math.sin(Δλ) * Math.cos(φ2),
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  )) + 360) % 360;
}

export const cardinalFromBearing = deg =>
  ['North','NE','East','SE','South','SW','West','NW'][Math.round(deg / 45) % 8];

export function haversine([lat1, lon1], [lat2, lon2]) {
  const R = 6371000, φ1 = toRad(lat1), φ2 = toRad(lat2);
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2
    + Math.cos(φ1) * Math.cos(φ2) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function closestOnRoute(coords, lat, lng) {
  let minDist = Infinity, minIdx = 0;
  coords.forEach((c, i) => {
    const d = haversine(c, [lat, lng]);
    if (d < minDist) { minDist = d; minIdx = i; }
  });
  return { index: minIdx, distM: minDist };
}

export function distanceRemaining(coords, fromIdx) {
  let d = 0;
  for (let i = fromIdx; i < coords.length - 1; i++) d += haversine(coords[i], coords[i + 1]);
  return d;
}

export function stepForIndex(instructions, coordIdx) {
  for (let i = 0; i < instructions.length; i++) {
    const [s, e] = instructions[i].interval || [0, 0];
    if (coordIdx >= s && coordIdx <= e) return i;
  }
  return Math.max(0, instructions.length - 1);
}

export const fmtDist = m => m < 950 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`;

export const turnIcon = sign =>
  ({ '0':'↑','1':'↗','2':'→','3':'↱','-1':'↖','-2':'←','-3':'↰','4':'🏁','6':'⟳','7':'→','-7':'←' })[String(sign)] ?? '↑';

// ── Internal: destination point ───────────────────────────────────────────────

function destination(lat, lon, km, bearing) {
  const R = 6371, b = toRad(bearing), φ1 = toRad(lat), λ1 = toRad(lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(km / R) + Math.cos(φ1) * Math.sin(km / R) * Math.cos(b));
  const λ2 = λ1 + Math.atan2(
    Math.sin(b) * Math.sin(km / R) * Math.cos(φ1),
    Math.cos(km / R) - Math.sin(φ1) * Math.sin(φ2)
  );
  return [toDeg(φ2), toDeg(λ2)];
}

// ── Scenic scoring ────────────────────────────────────────────────────────────
// Higher = nicer for running. Off-road foot/cycle paths (parks, foreshore
// promenades, greenways) score top; arterials (Pacific Hwy = trunk/primary) bottom.
const ROAD_CLASS_SCORE = {
  path: 1, footway: 1, cycleway: 1, track: 0.95, pedestrian: 0.9,
  living_street: 0.8, residential: 0.7, unclassified: 0.6, service: 0.5,
  road: 0.5, tertiary: 0.45, steps: 0.25,
  secondary: 0.2, primary: 0.1, trunk: 0.05, motorway: 0,
};
// Bonus only — never penalises paved (most waterfront promenades are sealed),
// just nudges toward natural park-trail surfaces.
const SURFACE_BONUS = {
  gravel: 0.1, fine_gravel: 0.1, compacted: 0.08, ground: 0.08, dirt: 0.06, grass: 0.05,
};

// How strongly scenery competes with distance accuracy when picking a route.
const SCENIC_WEIGHT = 0.2;

// Returns 0..1 from GraphHopper path `details` (road_class + surface), weighted
// by real segment length. Falls back to neutral 0.5 when details are absent.
function scoreScenic(coords, details) {
  if (!details?.road_class?.length) return 0.5;

  const segLen = (a, b) => {
    let d = 0;
    for (let i = a; i < b && i + 1 < coords.length; i++) d += haversine(coords[i], coords[i + 1]);
    return d;
  };

  let total = 0, classAcc = 0, surfAcc = 0;
  for (const [s, e, cls] of details.road_class) {
    const len = segLen(s, e);
    total += len;
    classAcc += len * (ROAD_CLASS_SCORE[cls] ?? 0.5);
  }
  if (total === 0) return 0.5;

  for (const [s, e, sf] of details.surface || [])
    surfAcc += segLen(s, e) * (SURFACE_BONUS[sf] ?? 0);

  return clamp(classAcc / total + surfAcc / total, 0, 1);
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function geocode(query) {
  const key = query.toLowerCase().trim();
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  const data = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(key)}&countrycodes=au&viewbox=113,-44,154,-10&bounded=1`
  ).then(r => r.json());
  if (!data?.length) return null;
  const result = { lat: +data[0].lat, lon: +data[0].lon, name: data[0].display_name };
  geocodeCache.set(key, result);
  return result;
}

async function fetchRoute(waypoints) {
  try {
    const ps = waypoints.map(([lat, lon]) => `${lat},${lon}`).join('|');
    const res = await fetch(`${PROXY}?profile=foot&points=${encodeURIComponent(ps)}`);
    if (res.status === 429) return { rateLimited: true };
    if (!res.ok) return null;
    const { paths } = await res.json();
    if (!paths?.length) return null;
    const p = paths[0];
    const coordinates = p.points.coordinates.map(([lon, lat]) => [lat, lon]);
    return {
      coordinates,
      distanceKm:   p.distance / 1000,
      durationSec:  p.time / 1000,
      instructions: p.instructions || [],
      scenic:       scoreScenic(coordinates, p.details),
    };
  } catch {
    return null;   // network/CORS failure → treat as no route so the UI shows the error state
  }
}

// ── Route generation ──────────────────────────────────────────────────────────

export async function generateLoop(lat, lng, targetKm) {
  const t = clamp(targetKm, 1, 50);
  const MAX = t <= 5 ? 5 : 8;
  const tol = t <= 5 ? 0.20 : 0.25;          // acceptable distance error
  let best = null, bestCost = Infinity;

  for (let i = 0; i < MAX; i++) {
    const n = t <= 8 ? 2 : 3;
    const r = t <= 5  ? t * (0.18 + Math.random() * 0.08)
            : t <= 12 ? t * (0.22 + Math.random() * 0.08)
                      : t * (0.30 + Math.random() * 0.15);

    const wps = [
      [lat, lng],
      ...Array.from({ length: n }, (_, j) => destination(lat, lng, r, i * 360 / MAX + 360 / n * j)),
      [lat, lng],
    ];

    const route = await fetchRoute(wps);
    if (route?.rateLimited) return null;
    if (!route || route.distanceKm > t * (t <= 5 ? 1.4 : 1.3)) { await delay(150); continue; }

    // Blend distance accuracy with scenery; lower cost wins.
    const distErr = Math.abs(route.distanceKm - t) / t;
    const cost = distErr + SCENIC_WEIGHT * (1 - route.scenic);
    if (cost < bestCost) { bestCost = cost; best = route; }

    // Stop early only when a route is both close to target *and* genuinely scenic.
    if (distErr <= (t <= 5 ? 0.12 : 0.15) && route.scenic >= 0.75) return route;
    await delay(150);
  }

  return best && Math.abs(best.distanceKm - t) / t <= tol ? best : null;
}

export async function generateP2P(lat, lng, targetKm) {
  const t = clamp(targetKm, 1, 50);
  let best = null, bestCost = Infinity;

  for (const b of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330])
    for (const m of [0.8, 0.9, 1.0, 1.1, 1.2]) {
      const route = await fetchRoute([[lat, lng], destination(lat, lng, t * m, b)]);
      if (!route) continue;
      const distErr = Math.abs(route.distanceKm - t) / t;
      const cost = distErr + SCENIC_WEIGHT * (1 - route.scenic);
      if (cost < bestCost) { bestCost = cost; best = route; }
      if (distErr < 0.15 && route.scenic >= 0.75) return route;
    }

  return best && Math.abs(best.distanceKm - t) / t < 0.25 ? best : null;
}
