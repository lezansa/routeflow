/* ===== SIMPLIFIED ROUTE FLOW - FOCUS ON RELIABILITY ===== */

const toggleButton = document.getElementById("themeToggle");
const form = document.getElementById("routeForm");
const result = document.getElementById("result");

const ROUTE_PROXY_URL = "https://kxwj3jmncesgk3koupy7mxdudq0xolyz.lambda-url.ap-southeast-2.on.aws/";

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
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
  subdomains: "abcd",
  maxZoom: 19,
}).addTo(map);

// ===== HELPERS =====
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const geocodeCache = new Map();

function toRad(d) { return (d * Math.PI) / 180; }
function toDeg(r) { return (r * 180) / Math.PI; }

function bearingBetween([lat1, lon1], [lat2, lon2]) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let θ = Math.atan2(y, x);
  return (toDeg(θ) + 360) % 360;
}

function cardinalFromBearing(deg) {
  const dirs = ["North", "NE", "East", "SE", "South", "SW", "West", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

// ===== GEOCODE =====
async function geocodeLocation(location) {
  const query = location.trim();
  if (!query) return null;

  const key = query.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  // Bias toward Australia by adding country code and bounding box
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=au&viewbox=113,-44,154,-10&bounded=1`;

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

    alert("Location not found. Try a different address.");
    return null;
  } catch (err) {
    console.error("Geocoding error:", err);
    alert("Error finding location. Please try again.");
    return null;
  }
}

// ===== ROUTING VIA LAMBDA =====
async function getRouteFromProxy(points) {
  const pointsParam = points.map(([lat, lon]) => `${lat},${lon}`).join("|");
  const url = `${ROUTE_PROXY_URL}?profile=foot&points=${encodeURIComponent(pointsParam)}`;

  try {
    const res = await fetch(url);

    // ⛔ Rate limit protection
    if (res.status === 429) {
      console.log("⛔ Rate limited (429).");
      return { rateLimited: true };
    }

    if (!res.ok) {
      console.log("Proxy error:", res.status);
      return null;
    }

    const data = await res.json();
    if (!data.paths || !data.paths.length) return null;

    const path = data.paths[0];
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

// ===== DESTINATION POINT =====
function generateDestination(lat, lon, distanceKm, bearingDeg) {
  const R = 6371;
  const d = distanceKm;
  const brng = toRad(bearingDeg);
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d / R) + Math.cos(lat1) * Math.sin(d / R) * Math.cos(brng)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(d / R) * Math.cos(lat1),
    Math.cos(d / R) - Math.sin(lat1) * Math.sin(lat2)
  );

  return [toDeg(lat2), toDeg(lon2)];
}

async function generateLoopRoute(startLat, startLng, targetKm) {
  const target = clamp(targetKm, 1, 50);
  const MAX_ATTEMPTS = target <= 5 ? 5 : 8;

  console.log(`🔄 Generating ${target}km loop...`);

  let bestRoute = null;
  let bestDiff = Infinity;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {

    // 🔍 NEW: attempt progress log
    console.log(`Attempt ${i + 1}/${MAX_ATTEMPTS}…`);

const numWaypoints = target <= 8 ? 2 : 3;
    const baseAngle = (i * 360 / MAX_ATTEMPTS);

let radius;

if (target <= 5) {
  radius = target * (0.18 + Math.random() * 0.08);
} else if (target <= 12) {
  // Mid-distance: still needs restraint
  radius = target * (0.22 + Math.random() * 0.08);
} else {
  radius = target * (0.30 + Math.random() * 0.15);
}

    const waypoints = [[startLat, startLng]];

    for (let j = 0; j < numWaypoints; j++) {
      const bearing = baseAngle + (360 / numWaypoints) * j;
      const [lat, lon] = generateDestination(startLat, startLng, radius, bearing);
      waypoints.push([lat, lon]);
    }

    waypoints.push([startLat, startLng]);

    const route = await getRouteFromProxy(waypoints);
    if (route?.rateLimited) {
  console.log("⛔ Rate limited. Stopping attempts to protect quota.");
  return null;
}

    if (!route) {
      await new Promise(r => setTimeout(r, 150));
      continue;
    }

    const bailOverPct = target <= 5 ? 0.40 : 0.30;
    const maxAcceptableKm = target * (1 + bailOverPct);

    if (route.distanceKm > maxAcceptableKm) {
      console.log(`  ❌ Bail early: ${route.distanceKm.toFixed(2)}km way too long`);
      await new Promise(r => setTimeout(r, 150));
      continue;
    }

    const diff = Math.abs(route.distanceKm - target);

    console.log(
      `  Result: ${route.distanceKm.toFixed(2)}km (error ${(diff / target * 100).toFixed(1)}%)`
    );

    if (diff < bestDiff) {
      bestDiff = diff;
      bestRoute = route;
    }

    const acceptPct = target <= 5 ? 0.12 : 0.15;
    if (diff / target <= acceptPct) {
      // ✅ NEW: acceptance quality log
      console.log(
        `✅ Accepted at attempt ${i + 1} (error ${(diff / target * 100).toFixed(1)}%)`
      );
      return route;
    }

    await new Promise(r => setTimeout(r, 150));
  }

  const fallbackPct = target <= 5 ? 0.20 : 0.25;
  if (bestRoute && bestDiff / target <= fallbackPct) {
    // ⚠️ NEW: fallback quality log
    console.log(
      `⚠️ Fallback accepted (best error ${(bestDiff / target * 100).toFixed(1)}%)`
    );
    return bestRoute;
  }

  console.log(`❌ No good loop found`);
  return null;
}

// ===== SIMPLE POINT-TO-POINT =====
async function generatePointToPointRoute(startLat, startLng, targetKm) {
  const target = clamp(targetKm, 1, 50);
  
  console.log(`➡️ Generating ${target}km point-to-point...`);
  
  let bestRoute = null;
  let bestDiff = Infinity;
  
  // Try different directions and distance multipliers
  const bearings = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  const multipliers = [0.8, 0.9, 1.0, 1.1, 1.2];
  
  for (const bearing of bearings) {
    for (const mult of multipliers) {
      const distance = target * mult;
      const [endLat, endLng] = generateDestination(startLat, startLng, distance, bearing);
      
      const waypoints = [[startLat, startLng], [endLat, endLng]];
      const route = await getRouteFromProxy(waypoints);
      
      if (!route) continue;
      
      const diff = Math.abs(route.distanceKm - target);
      
      if (diff < bestDiff) {
        bestDiff = diff;
        bestRoute = route;
      }
      
      // Accept if within 15%
      if (diff / target < 0.15) {
        console.log(`✅ Found: ${route.distanceKm.toFixed(2)}km (want ${target}km)`);
        return route;
      }
    }
  }
  
  // Accept best route if within 25%
  if (bestRoute && bestDiff / target < 0.25) {
    console.log(`✅ Accepting: ${bestRoute.distanceKm.toFixed(2)}km`);
    return bestRoute;
  }
  
  console.log(`❌ No good route found`);
  return null;
}

// ===== MAP DISPLAY =====
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

function addStartArrow(coords) {
  if (!coords || coords.length < 2) return null;
  
  const brng = bearingBetween(coords[0], coords[1]);
  const icon = L.divIcon({
    className: "start-arrow",
    html: `<div style="transform: rotate(${brng}deg); font-size: 28px;">➤</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
  
  return L.marker(coords[0], { icon }).addTo(map).bindPopup("Start this way →");
}

function showResult({ routeData, start, isLoop }) {
  result.classList.remove("hidden");
  
  const distance = routeData.distanceKm.toFixed(2);
  const target = state.lastParams?.distanceKm || 0;
  
  // Calculate accuracy
  const diff = Math.abs(routeData.distanceKm - target);
  const errorPct = ((diff / target) * 100).toFixed(1);
  const diffMeters = Math.round(diff * 1000);
  const diffDisplay = diffMeters < 1000 ? `${diffMeters}m` : `${diff.toFixed(2)}km`;
  
  // Determine if it's close, decent, or needs transparency
  let accuracyNote = '';
  if (errorPct <= 5) {
    accuracyNote = `<p style="color: #4CAF50; font-size: 0.9rem;">✓ Target: ${target} km, Generated: ${distance} km (${diffDisplay} difference)</p>`;
  } else if (errorPct <= 15) {
    accuracyNote = `<p style="color: #FFA726; font-size: 0.9rem;">⚠ Target: ${target} km, Generated: ${distance} km (${diffDisplay} difference)</p>`;
  } else {
    accuracyNote = `<p style="color: #FF7043; font-size: 0.9rem;">⚠ Target: ${target} km, Generated: ${distance} km (${diffDisplay} difference) - Try regenerating for a closer match</p>`;
  }
  
  // Simple directions
  const startDir = routeData.coordinates.length >= 2 ? 
    cardinalFromBearing(bearingBetween(routeData.coordinates[0], routeData.coordinates[1])) : "";
  
  const mainTurns = (routeData.instructions || [])
    .filter(i => {
      const t = (i.text || "").toLowerCase();
      return !t.includes("waypoint") && !t.includes("arrive") && (i.distance || 0) > 100;
    })
    .slice(0, 8);
  
  result.innerHTML = `
    <h3>Your Route</h3>
    <p><strong>Distance:</strong> ${distance} km</p>
    ${accuracyNote}
    <p><strong>Start:</strong> Head ${startDir} from ${start.displayName.split(',')[0]}</p>
    
    ${mainTurns.length > 0 ? `
      <div style="margin-top: 1rem; text-align: left;">
        <h4 style="margin: 0 0 0.5rem;">Key Turns:</h4>
        <ol style="padding-left: 1.5rem; margin: 0;">
          ${mainTurns.map(turn => {
            const dist = turn.distance < 1000 ? 
              `${Math.round(turn.distance)}m` : 
              `${(turn.distance/1000).toFixed(1)}km`;
            return `<li style="margin-bottom: 0.5rem;">${turn.text} <span style="color: var(--muted-text);">(${dist})</span></li>`;
          }).join('')}
        </ol>
      </div>
    ` : ''}
    
    <button class="primary-btn" id="regenBtn" style="margin-top: 1rem;">Try Another Route</button>
  `;
  
  // Draw map
  clearMapLayers();
  
  state.routeLayer = L.polyline(routeData.coordinates, {
    color: "#8BC34A",
    weight: 4,
    opacity: 0.85,
  }).addTo(map);
  
  // Arrows
  if (typeof L.polylineDecorator === "function" && L.Symbol?.arrowHead) {
    state.arrowDecorator = L.polylineDecorator(state.routeLayer, {
      patterns: [{
        offset: "50%",
        repeat: 200,
        symbol: L.Symbol.arrowHead({
          pixelSize: 14,
          polygon: true,
          pathOptions: { color: "#8BC34A", fillOpacity: 1, weight: 1 },
        }),
      }],
    }).addTo(map);
  }
  
  state.startArrowMarker = addStartArrow(routeData.coordinates);
  
  state.startMarker = L.circleMarker(routeData.coordinates[0], {
    color: "#4CAF50",
    fillColor: "#4CAF50",
    fillOpacity: 0.85,
    radius: 8,
  }).addTo(map).bindPopup(isLoop ? "Start/Finish" : "Start");
  
  if (!isLoop) {
    const end = routeData.coordinates[routeData.coordinates.length - 1];
    state.endMarker = L.circleMarker(end, {
      color: "#CDDC39",
      fillColor: "#CDDC39",
      fillOpacity: 0.85,
      radius: 8,
    }).addTo(map).bindPopup("Finish");
  }
  
  map.fitBounds(state.routeLayer.getBounds(), { padding: [50, 50] });
  
  document.getElementById("regenBtn")?.addEventListener("click", () => handleSubmit(state.lastParams));
}

// ===== SUBMIT =====
async function handleSubmit(forcedParams = null) {
  const locationEl = document.getElementById("location");
  const distanceEl = document.getElementById("distance");
  const routeTypeEl = document.getElementById("routeType");
  
  const params = forcedParams || {
    locationInput: locationEl?.value || "",
    distanceKm: parseFloat(distanceEl?.value),
    routeType: routeTypeEl?.value || "loop",
  };
  
  state.lastParams = { ...params };
  
  if (!params.locationInput.trim()) {
    alert("Please enter a starting location");
    return;
  }
  
  if (!params.distanceKm || params.distanceKm < 1) {
    alert("Please enter a valid distance");
    return;
  }
  
  result.classList.remove("hidden");
  result.innerHTML = `<p style="text-align:center;">🏃 Generating your route...</p>`;
  
  const start = await geocodeLocation(params.locationInput);
  if (!start) return;
  
  map.setView([start.lat, start.lon], 14);
  
  const isLoop = params.routeType === "loop";
  let routeData = null;
  
  if (isLoop) {
    routeData = await generateLoopRoute(start.lat, start.lon, params.distanceKm);
  } else {
    routeData = await generatePointToPointRoute(start.lat, start.lon, params.distanceKm);
  }
  
  if (!routeData) {
    const routeTypeText = isLoop ? "loop" : "point-to-point route";
    result.innerHTML = `
      <h3>Couldn't generate ${routeTypeText}</h3>
      <p>We couldn't find a good <strong>${params.distanceKm} km ${routeTypeText}</strong> in this area.</p>
      <p style="color: var(--muted-text); font-size: 0.95rem;">
        Try: <br>
        • A different distance (±2km)<br>
        • A different location<br>
        • ${isLoop ? 'Point-to-point' : 'Loop'} instead
      </p>
      <button class="primary-btn" id="regenBtn">Try Again</button>
    `;
    document.getElementById("regenBtn")?.addEventListener("click", () => handleSubmit(params));
    return;
  }
  
  showResult({ routeData, start, isLoop });
}

form?.addEventListener("submit", (e) => {
  e.preventDefault();
  handleSubmit();
});
