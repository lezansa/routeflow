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
  const ps = waypoints.map(([lat, lon]) => `${lat},${lon}`).join('|');
  const res = await fetch(`${PROXY}?profile=foot&points=${encodeURIComponent(ps)}`);
  if (res.status === 429) return { rateLimited: true };
  if (!res.ok) return null;
  const { paths } = await res.json();
  if (!paths?.length) return null;
  return {
    coordinates:  paths[0].points.coordinates.map(([lon, lat]) => [lat, lon]),
    distanceKm:   paths[0].distance / 1000,
    durationSec:  paths[0].time / 1000,
    instructions: paths[0].instructions || [],
  };
}

// ── Route generation ──────────────────────────────────────────────────────────

export async function generateLoop(lat, lng, targetKm) {
  const t = clamp(targetKm, 1, 50);
  const MAX = t <= 5 ? 5 : 8;
  let best = null, bestDiff = Infinity;

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

    const diff = Math.abs(route.distanceKm - t);
    if (diff < bestDiff) { bestDiff = diff; best = route; }
    if (diff / t <= (t <= 5 ? 0.12 : 0.15)) return route;
    await delay(150);
  }

  return best && bestDiff / t <= (targetKm <= 5 ? 0.20 : 0.25) ? best : null;
}

export async function generateP2P(lat, lng, targetKm) {
  const t = clamp(targetKm, 1, 50);
  let best = null, bestDiff = Infinity;

  for (const b of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330])
    for (const m of [0.8, 0.9, 1.0, 1.1, 1.2]) {
      const route = await fetchRoute([[lat, lng], destination(lat, lng, t * m, b)]);
      if (!route) continue;
      const diff = Math.abs(route.distanceKm - t);
      if (diff < bestDiff) { bestDiff = diff; best = route; }
      if (diff / t < 0.15) return route;
    }

  return best && bestDiff / t < 0.25 ? best : null;
}
