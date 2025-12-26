/* ===== ROUTE FLOW APP (Routing via AWS Lambda Proxy) ===== */

const toggleButton = document.getElementById("themeToggle");
const form = document.getElementById("routeForm");
const result = document.getElementById("result");

// ✅ Put your Lambda Function URL here (public is fine)
const ROUTE_PROXY_URL = "https://kxwj3jmncesgk3koupy7mxdudq0xolyz.lambda-url.ap-southeast-2.on.aws/";

// Central state (no window.* globals)
const state = {
  routeLayer: null,
  startMarker: null,
  endMarker: null,
  arrowDecorator: null,
  startArrowMarker: null,
  lastParams: null,
};

// ===== THEME TOGGLE =====
toggleButton?.addEventListener("click", () => {
  document.body.classList.toggle("dark");
  toggleButton.textContent = document.body.classList.contains("dark") ? "☀️" : "🌙";
});

// ===== MAP =====
const map = L.map("map").setView([51.505, -0.09], 13);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains: "abcd",
  maxZoom: 19,
}).addTo(map);

// ===== HELPERS =====
const randomPick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function toRad(d) {
  return (d * Math.PI) / 180;
}
function toDeg(r) {
  return (r * 180) / Math.PI;
}

function bearingBetween([lat1, lon1], [lat2, lon2]) {
  const φ1 = toRad(lat1),
    φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let θ = Math.atan2(y, x);
  θ = (toDeg(θ) + 360) % 360;
  return θ;
}

function cardinalFromBearing(deg) {
  const dirs = ["North", "North-East", "East", "South-East", "South", "South-West", "West", "North-West"];
  return dirs[Math.round(deg / 45) % 8];
}

// Geocode cache (saves Nominatim calls)
const geocodeCache = new Map();

// ===== GEOCODE (Nominatim) =====
async function geocodeLocation(location) {
  const query = location.trim();
  if (!query) return null;

  const key = query.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data && data.length > 0) {
      const obj = {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
        displayName: data[0].display_name || query,
      };
      geocodeCache.set(key, obj);
      return obj;
    }

    alert("Location not found. Please try a different address or suburb.");
    return null;
  } catch (err) {
    console.error("Geocoding error:", err);
    alert("Error finding location. Please try again.");
    return null;
  }
}

// ===== ROUTING VIA LAMBDA PROXY =====
async function getRouteFromProxy(points, profile = "foot") {
  if (!ROUTE_PROXY_URL || ROUTE_PROXY_URL.includes("PASTE_YOUR")) {
    console.error("Missing ROUTE_PROXY_URL");
    return null;
  }

  const pointsParam = points.map(([lat, lon]) => `${lat},${lon}`).join("|");

  const url =
    `${ROUTE_PROXY_URL}` +
    `?profile=${encodeURIComponent(profile)}` +
    `&points=${encodeURIComponent(pointsParam)}`;

  try {
    const res = await fetch(url);

    if (!res.ok) {
      const text = await res.text();
      console.error("Proxy error:", res.status, text);
      return null;
    }

    const data = await res.json();
    if (!data.paths || !data.paths.length) return null;

    const path = data.paths[0];

    // GraphHopper returns [lon, lat], Leaflet wants [lat, lon]
    const leafletCoords = path.points.coordinates.map(([lon, lat]) => [lat, lon]);

    return {
      coordinates: leafletCoords,
      distanceKm: path.distance / 1000,
      durationSec: path.time / 1000,
      instructions: path.instructions || [],
    };
  } catch (err) {
    console.error("Route fetch failed:", err);
    return null;
  }
}

// ===== DESTINATION POINT (bearing + distance) =====
function generateDestination(lat, lon, distanceKm, bearingDeg) {
  const R = 6371; // km
  const d = distanceKm;
  const brng = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d / R) + Math.cos(lat1) * Math.sin(d / R) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d / R) * Math.cos(lat1),
      Math.cos(d / R) - Math.sin(lat1) * Math.sin(lat2)
    );

  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

// ===== ROUTE SCORING (prefer fewer turns and avoid U-turns) =====
function scoreRoute(route, targetKm) {
  const distDiffRatio = Math.abs(route.distanceKm - targetKm) / targetKm;

  const instr = route.instructions || [];
  const turnCount = instr.filter((i) => {
    const t = (i.text || "").toLowerCase();
    return t.includes("turn") || t.includes("keep") || t.includes("u-turn");
  }).length;

  const uTurnCount = instr.filter((i) => (i.text || "").toLowerCase().includes("u-turn")).length;

  // Tune weights to taste:
  // Distance still matters most, but turns matter a lot, U-turns matter MORE.
  return distDiffRatio * 120 + turnCount * 2.2 + uTurnCount * 12;
}

// ===== LOOP ROUTE (adaptive radius + tighter acceptance) =====
async function generateLoopRoute(startLat, startLng, targetKm, terrain) {
  const profile = terrain === "trail" ? "hike" : "foot";
  const target = clamp(targetKm, 1, 60);

  let radius = clamp(target * 0.35, 1.0, 10.0); // better baseline for dense cities
  const numWaypoints = 2;
  const maxAttempts = 10;

  let bestRoute = null;
  let bestScore = Infinity;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const acceptRatio = attempt < 3 ? 0.18 : attempt < 7 ? 0.12 : 0.08; // tighten over time
    const maxTurns = attempt < 3 ? 18 : attempt < 7 ? 14 : 12;

    const baseAngle = Math.random() * 360;
    const jitter = 20; // lower jitter reduces chaotic zigzags

    const waypoints = [[startLat, startLng]];

    for (let i = 0; i < numWaypoints; i++) {
      const bearing = baseAngle + (360 / numWaypoints) * i + (Math.random() - 0.5) * jitter;
      const [lat, lon] = generateDestination(startLat, startLng, radius, bearing);
      waypoints.push([lat, lon]);
    }

    waypoints.push([startLat, startLng]); // close loop

    const route = await getRouteFromProxy(waypoints, profile);
    if (!route) continue;

    const score = scoreRoute(route, target);
    if (score < bestScore) {
      bestScore = score;
      bestRoute = route;
    }

    const diffRatio = Math.abs(route.distanceKm - target) / target;
    const turnCount = (route.instructions || []).filter((i) => {
      const t = (i.text || "").toLowerCase();
      return t.includes("turn") || t.includes("keep") || t.includes("u-turn");
    }).length;

    // Accept only if distance is close AND turns are reasonable
    if (diffRatio <= acceptRatio && turnCount <= maxTurns) {
      return route;
    }

    // Adaptive radius update based on whether route is too short/too long
    const tooShort = route.distanceKm < target;
    const factor = tooShort ? 1.18 : 0.86;

    const damp = clamp(1 - diffRatio * 0.4, 0.75, 1);
    radius = clamp(radius * (1 + (factor - 1) * damp), 1.0, 10.0);
  }

  return bestRoute;
}

// ===== POINT-TO-POINT ROUTE (closest to target) =====
async function generatePointToPointRoute(startLat, startLng, targetKm, terrain) {
  const profile = terrain === "trail" ? "hike" : "foot";
  const target = clamp(targetKm, 1, 60);

  let bestRoute = null;
  let bestScore = Infinity;

  const bearings = Array.from({ length: 12 }, (_, i) => i * 30);
  const multipliers = [0.7, 0.85, 1.0, 1.15, 1.3];

  for (const b of bearings) {
    for (const m of multipliers) {
      const bearing = b + (Math.random() - 0.5) * 10;
      const guessKm = target * m;

      const [endLat, endLng] = generateDestination(startLat, startLng, guessKm, bearing);
      const waypoints = [
        [startLat, startLng],
        [endLat, endLng],
      ];

      const route = await getRouteFromProxy(waypoints, profile);
      if (!route) continue;

      const score = scoreRoute(route, target);
      if (score < bestScore) {
        bestScore = score;
        bestRoute = route;
      }

      const diffRatio = Math.abs(route.distanceKm - target) / target;
      if (diffRatio <= 0.08) return route;
    }
  }

  return bestRoute;
}

// ===== DESCRIPTION =====
function generateRouteDescription(distance, terrain, elevation, isLoop) {
  const elevationOptions = {
    flat: [
      "a mostly flat route with minimal elevation gain",
      "an easy, flat run perfect for steady pacing",
      "mostly level ground, very comfortable",
    ],
    rolling: [
      "a gently rolling route with some variation",
      "moderate ups and downs to keep it interesting",
      "a route with light hills and flowing terrain",
    ],
    hilly: [
      "a challenging route with noticeable hills",
      "steep climbs and descents for a good workout",
      "a hilly run that will test your stamina",
    ],
  };

  const terrainOptions = {
    road: ["paved roads and footpaths", "city streets and sidewalks", "smooth asphalt and paths"],
    trail: ["natural trails and off-road paths", "dirt tracks and scenic trails", "woodland paths and rugged trails"],
    mixed: ["a mix of roads and trails", "both paved and natural paths", "a combination of streets and trails"],
  };

  const routeType = isLoop ? "loop" : "point-to-point route";
  return `This ${routeType} follows ${randomPick(terrainOptions[terrain])}, featuring ${randomPick(
    elevationOptions[elevation]
  )}.`;
}

// ===== DIRECTIONS (concise) =====
function makeStartInstruction(startName, coords) {
  if (!coords || coords.length < 2) return `Start at ${startName}.`;

  const brng = bearingBetween(coords[0], coords[1]);
  const dir = cardinalFromBearing(brng);
  return `Start at ${startName}. Head ${dir}.`;
}

function conciseInstructions(instructions, maxSteps = 8) {
  const instr = instructions || [];

  const isMajor = (inst) => {
    const t = (inst.text || "").toLowerCase();
    const d = inst.distance || 0;

    if (t.includes("waypoint") || t.includes("arrive")) return false;
    if (d < 90) return false; // drop tiny segments
    if (t.includes("slight") && d < 220) return false;
    if (t.includes("continue") && d < 320) return false;

    return true;
  };

  return instr.filter(isMajor).slice(0, maxSteps);
}

// ===== MAP LAYERS =====
function clearMapLayers() {
  if (state.routeLayer) map.removeLayer(state.routeLayer);
  if (state.startMarker) map.removeLayer(state.startMarker);
  if (state.endMarker) map.removeLayer(state.endMarker);
  if (state.arrowDecorator) map.removeLayer(state.arrowDecorator);
  if (state.startArrowMarker) map.removeLayer(state.startArrowMarker);

  state.routeLayer = null;
  state.startMarker = null;
  state.endMarker = null;
  state.arrowDecorator = null;
  state.startArrowMarker = null;
}

function addStartDirectionArrow(coords) {
  if (!coords || coords.length < 2) return null;

  const brng = bearingBetween(coords[0], coords[1]);
  const icon = L.divIcon({
    className: "start-arrow",
    html: `<div style="transform: rotate(${brng}deg); font-size: 28px; line-height: 28px;">➤</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });

  return L.marker(coords[0], { icon }).addTo(map).bindPopup("Start this way →");
}

// ===== RENDER RESULT + MAP =====
function showResult({ routeData, description, paceMinPerKm, start, isLoop }) {
  result.classList.remove("hidden");

  const actualDistance = routeData.distanceKm;
  const engineMinutes = Math.round(routeData.durationSec / 60);

  const paceMinutes = actualDistance * paceMinPerKm;
  const paceHours = Math.floor(paceMinutes / 60);
  const paceMins = Math.round(paceMinutes % 60);
  const paceStr = paceHours > 0 ? `${paceHours}h ${paceMins}m` : `${paceMins}m`;

  const engHours = Math.floor(engineMinutes / 60);
  const engMins = engineMinutes % 60;
  const engineStr = engHours > 0 ? `${engHours}h ${engMins}m` : `${engMins}m`;

  const startLine = makeStartInstruction(start.displayName, routeData.coordinates);
  const quickSteps = conciseInstructions(routeData.instructions, 8);

  const quickDirectionsHTML = `
    <div style="margin-top: 1rem; text-align: left;">
      <h4 style="margin: 0 0 0.5rem;">Quick Directions</h4>
      <p style="margin: 0 0 0.75rem;"><strong>${startLine}</strong></p>
      <ol style="padding-left: 1.5rem; margin: 0;">
        ${quickSteps
          .map((s) => {
            const d = s.distance || 0;
            const distStr = d < 1000 ? `${Math.round(d)}m` : `${(d / 1000).toFixed(1)}km`;
            return `<li style="margin-bottom: 0.5rem;"><strong>${s.text}</strong> <span style="color: var(--muted-text);">— ${distStr}</span></li>`;
          })
          .join("")}
      </ol>

      <button class="primary-btn" id="toggleFullDirections" style="margin-top: 0.9rem; padding: 0.6rem 1.2rem; font-size: 0.9rem;">
        Show Full Turn-by-Turn
      </button>

      <div id="fullDirections" style="display:none; margin-top: 0.8rem;">
        <h4 style="margin: 0 0 0.5rem;">Full Directions</h4>
        <ol style="padding-left: 1.5rem; margin: 0;">
          ${(routeData.instructions || [])
            .filter((i) => !(i.text || "").toLowerCase().includes("waypoint"))
            .map((i) => {
              const d = i.distance || 0;
              const distStr = d < 1000 ? `${Math.round(d)}m` : `${(d / 1000).toFixed(1)}km`;
              return `<li style="margin-bottom: 0.45rem;"><strong>${i.text}</strong> <span style="color: var(--muted-text);">— ${distStr}</span></li>`;
            })
            .join("")}
        </ol>
      </div>
    </div>
  `;

  result.innerHTML = `
    <h3>Your Route</h3>
    <p>${description}</p>
    <p><strong>Start:</strong> ${start.displayName}</p>
    <p><strong>Distance:</strong> ${actualDistance.toFixed(2)} km</p>
    <p><strong>At your pace:</strong> ${paceStr}</p>
    <p><strong>Routing engine estimate:</strong> ${engineStr}</p>
    ${quickDirectionsHTML}
    <button class="primary-btn" id="regenBtn" style="margin-top: 1rem;">Regenerate</button>
  `;

  // Toggle full directions
  document.getElementById("toggleFullDirections")?.addEventListener("click", () => {
    const panel = document.getElementById("fullDirections");
    const btn = document.getElementById("toggleFullDirections");
    if (!panel || !btn) return;

    const isHidden = panel.style.display === "none";
    panel.style.display = isHidden ? "block" : "none";
    btn.textContent = isHidden ? "Hide Full Turn-by-Turn" : "Show Full Turn-by-Turn";
  });

  // Draw on map
  clearMapLayers();

  state.routeLayer = L.polyline(routeData.coordinates, {
    color: "#8BC34A",
    weight: 4,
    opacity: 0.85,
  }).addTo(map);

  // Decorator arrows (optional plugin)
  if (typeof L.polylineDecorator === "function" && L.Symbol?.arrowHead) {
    const arrowSymbol = {
      offset: "50%",
      repeat: 180, // less confetti
      symbol: L.Symbol.arrowHead({
        pixelSize: 14,
        polygon: true,
        pathOptions: { color: "#8BC34A", fillOpacity: 1, weight: 1 },
      }),
    };

    state.arrowDecorator = L.polylineDecorator(state.routeLayer, {
      patterns: [arrowSymbol],
    }).addTo(map);
  }

  // Big start arrow marker (easier to read than tiny repeated arrows)
  state.startArrowMarker = addStartDirectionArrow(routeData.coordinates);

  // Start marker
  state.startMarker = L.circleMarker(routeData.coordinates[0], {
    color: "#4CAF50",
    fillColor: "#4CAF50",
    fillOpacity: 0.85,
    radius: 8,
  })
    .addTo(map)
    .bindPopup(isLoop ? "Start/Finish" : "Start");

  // End marker for point-to-point only
  if (!isLoop) {
    const lastPoint = routeData.coordinates[routeData.coordinates.length - 1];
    state.endMarker = L.circleMarker(lastPoint, {
      color: "#CDDC39",
      fillColor: "#CDDC39",
      fillOpacity: 0.85,
      radius: 8,
    })
      .addTo(map)
      .bindPopup("Finish");
  }

  map.fitBounds(state.routeLayer.getBounds(), { padding: [50, 50] });

  // Regen button
  document.getElementById("regenBtn")?.addEventListener("click", () => {
    if (state.lastParams) handleSubmit(state.lastParams);
    else handleSubmit();
  });
}

// ===== SUBMIT HANDLER =====
async function handleSubmit(forcedParams = null) {
  if (!ROUTE_PROXY_URL || ROUTE_PROXY_URL.includes("PASTE_YOUR")) {
    result.classList.remove("hidden");
    result.innerHTML = `
      <h3>⚠️ Backend URL Missing</h3>
      <p>You need to set <code>ROUTE_PROXY_URL</code> in <code>app.js</code> to your Lambda Function URL.</p>
    `;
    return;
  }

  const locationEl = document.getElementById("location");
  const distanceEl = document.getElementById("distance");
  const terrainEl = document.getElementById("terrain");
  const elevationEl = document.getElementById("elevation");
  const paceEl = document.getElementById("pace");
  const routeTypeEl = document.getElementById("routeType"); // add in HTML

  const params =
    forcedParams || {
      locationInput: locationEl?.value || "",
      distanceKm: parseFloat(distanceEl?.value),
      terrain: terrainEl?.value || "road",
      elevation: elevationEl?.value || "flat",
      paceMinPerKm: parseFloat(paceEl?.value),
      routeType: routeTypeEl?.value || "loop",
    };

  state.lastParams = { ...params };

  if (!params.locationInput.trim()) {
    alert("Please enter a starting location (address, suburb, or city).");
    return;
  }

  if (!params.distanceKm || !params.paceMinPerKm || params.paceMinPerKm <= 0) {
    alert("Please enter valid distance and pace.");
    return;
  }

  // Loading UI
  result.classList.remove("hidden");
  result.innerHTML = `<p style="text-align:center;">🏃 Generating your route...</p>`;

  const start = await geocodeLocation(params.locationInput);
  if (!start) return;

  map.setView([start.lat, start.lon], 15);

  const isLoop = params.routeType === "loop";
  let routeData = null;

  if (isLoop) {
    routeData = await generateLoopRoute(start.lat, start.lon, params.distanceKm, params.terrain);
  } else {
    routeData = await generatePointToPointRoute(start.lat, start.lon, params.distanceKm, params.terrain);
  }

  if (!routeData) {
    result.innerHTML = `
      <h3>Unable to generate route</h3>
      <p>This could be due to:</p>
      <ul style="text-align:left; margin:1rem 0;">
        <li>No suitable roads/paths in this area</li>
        <li>Distance too large for the location</li>
        <li>Backend timeout or rate limit</li>
      </ul>
      <p>Try a different location or distance. Check the browser console (F12) for details.</p>
      <button class="primary-btn" id="regenBtn">Try Again</button>
    `;
    document.getElementById("regenBtn")?.addEventListener("click", () => handleSubmit(params));
    return;
  }

  const description = generateRouteDescription(params.distanceKm, params.terrain, params.elevation, isLoop);

  showResult({
    routeData,
    description,
    paceMinPerKm: params.paceMinPerKm,
    start,
    isLoop,
  });
}

// ===== FORM SUBMIT =====
form?.addEventListener("submit", (e) => {
  e.preventDefault();
  handleSubmit();
});
