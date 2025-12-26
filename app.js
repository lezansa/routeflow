/* ===== ROUTE FLOW APP (Real Routing with GraphHopper) ===== */
const toggleButton = document.getElementById("themeToggle");
const form = document.getElementById("routeForm");
const result = document.getElementById("result");

// IMPORTANT: You should not ship API keys in frontend for real products.
// For demo/prototype only.
const GRAPHHOPPER_API_KEY = "bd289842-f048-4989-a631-521d9405ff1d"; // <-- replace with your key

// Central state (replaces window.* globals)
const state = {
  routeLayer: null,
  startMarker: null,
  endMarker: null,
  arrowDecorator: null,
  lastParams: null, // store last submit params so regen can re-run without reading DOM
};

// THEME TOGGLE
toggleButton?.addEventListener("click", () => {
  document.body.classList.toggle("dark");
  toggleButton.textContent = document.body.classList.contains("dark") ? "☀️" : "🌙";
});

// INITIALIZE MAP
const map = L.map("map").setView([51.505, -0.09], 13);
L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains: "abcd",
  maxZoom: 19,
}).addTo(map);

// HELPER: pick random item from array
const randomPick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// HELPER: clamp number
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

// HELPER: Generate destination point at given distance and bearing
function generateDestination(lat, lon, distanceKm, bearingDeg) {
  const R = 6371; // Earth radius in km
  const d = distanceKm;
  const brng = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d / R) +
      Math.cos(lat1) * Math.sin(d / R) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d / R) * Math.cos(lat1),
      Math.cos(d / R) - Math.sin(lat1) * Math.sin(lat2)
    );

  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

// Simple in-memory geocode cache to reduce Nominatim spam
const geocodeCache = new Map();

// GEOCODE LOCATION INPUT USING Nominatim
async function geocodeLocation(location) {
  const query = location.trim();
  if (!query) return null;

  const key = query.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
    query
  )}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data && data.length > 0) {
      const resultObj = {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
        displayName: data[0].display_name || query,
      };
      geocodeCache.set(key, resultObj);
      return resultObj;
    }

    alert("Location not found. Please try a different address or suburb.");
    return null;
  } catch (err) {
    console.error("Geocoding error:", err);
    alert("Error finding location. Please try again.");
    return null;
  }
}

// GET REAL ROUTE FROM GRAPHHOPPER
async function getRouteFromGraphHopper(points, profile = "foot") {
  if (!GRAPHHOPPER_API_KEY || GRAPHHOPPER_API_KEY === "xx") {
    console.error("Missing GraphHopper API key");
    return null;
  }

  // Build URL with points
  let url = `https://graphhopper.com/api/1/route?key=${encodeURIComponent(
    GRAPHHOPPER_API_KEY
  )}`;

  points.forEach(([lat, lon]) => {
    url += `&point=${encodeURIComponent(`${lat},${lon}`)}`;
  });

  url += `&profile=${encodeURIComponent(profile)}&points_encoded=false&instructions=true`;

  try {
    const res = await fetch(url);

    if (!res.ok) {
      let errorData = null;
      try {
        errorData = await res.json();
      } catch {}
      console.error("GraphHopper error:", res.status, errorData);
      throw new Error(`API error: ${res.status}`);
    }

    const data = await res.json();

    if (data.paths && data.paths.length > 0) {
      const path = data.paths[0];
      // GraphHopper returns coordinates as [lon, lat]
      const leafletCoords = path.points.coordinates.map((coord) => [coord[1], coord[0]]);
      return {
        coordinates: leafletCoords,
        distanceKm: path.distance / 1000,
        durationSec: path.time / 1000,
        instructions: path.instructions || [],
      };
    }

    return null;
  } catch (err) {
    console.error("Error fetching route:", err);
    return null;
  }
}

/**
 * Adaptive loop generator
 * - Uses 2 waypoints (+ return to start)
 * - Adjusts radius based on whether route is too short/too long
 * - Tightens acceptance over time
 */
async function generateLoopRoute(startLat, startLng, targetKm, terrain) {
  const profile = terrain === "trail" ? "hike" : "foot";

  // If user asks for something silly, clamp a bit to reduce failures
  const target = clamp(targetKm, 1, 60);

  // Initial radius heuristic: good starting point for road networks
  // For 5km target, starts around ~1.6–2.0km (works better than tiny radii)
  let radius = clamp(target * 0.35, 0.8, 8);

  const numWaypoints = 2;
  const maxAttempts = 10;

  let bestRoute = null;
  let bestDiff = Infinity;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Tighten acceptance: early attempts more forgiving, later attempts stricter
    const acceptRatio = attempt < 3 ? 0.18 : attempt < 7 ? 0.12 : 0.08; // 18% -> 12% -> 8%

    // Randomize route shape each attempt
    const baseAngle = Math.random() * 360;
    const jitter = 35; // degrees

    const waypoints = [[startLat, startLng]];
    for (let i = 0; i < numWaypoints; i++) {
      const bearing =
        baseAngle + (360 / numWaypoints) * i + (Math.random() - 0.5) * jitter;

      const [lat, lon] = generateDestination(startLat, startLng, radius, bearing);
      waypoints.push([lat, lon]);
    }
    waypoints.push([startLat, startLng]);

    const route = await getRouteFromGraphHopper(waypoints, profile);
    if (!route) continue;

    const actual = route.distanceKm;
    const diff = Math.abs(actual - target);

    if (diff < bestDiff) {
      bestDiff = diff;
      bestRoute = route;
    }

    // If good enough, return it
    if (diff / target <= acceptRatio) {
      return route;
    }

    // Adaptive radius update:
    // - too short: increase radius
    // - too long: decrease radius
    // Use gentle step sizes to avoid oscillation
    const tooShort = actual < target;
    const factor = tooShort ? 1.18 : 0.86;

    // Additional damping based on how far off we are
    const ratioOff = diff / target; // e.g. 0.25 = 25% off
    const damp = clamp(1 - ratioOff * 0.4, 0.75, 1); // reduce changes if very off
    radius = clamp(radius * (1 + (factor - 1) * damp), 0.5, 10);
  }

  return bestRoute;
}

// GENERATE POINT-TO-POINT ROUTE (tries bearings/dist multipliers, picks closest)
async function generatePointToPointRoute(startLat, startLng, targetKm, terrain) {
  const profile = terrain === "trail" ? "hike" : "foot";
  const target = clamp(targetKm, 1, 60);

  let bestRoute = null;
  let bestDiff = Infinity;

  // Try a mix of bearings and distance multipliers to land near target
  const bearings = Array.from({ length: 12 }, (_, i) => i * 30);
  const multipliers = [0.7, 0.85, 1.0, 1.15, 1.3];

  for (let b = 0; b < bearings.length; b++) {
    for (let m = 0; m < multipliers.length; m++) {
      const bearing = bearings[b] + (Math.random() - 0.5) * 10;
      const guessKm = target * multipliers[m];

      const [endLat, endLng] = generateDestination(startLat, startLng, guessKm, bearing);

      const waypoints = [
        [startLat, startLng],
        [endLat, endLng],
      ];

      const route = await getRouteFromGraphHopper(waypoints, profile);
      if (!route) continue;

      const diff = Math.abs(route.distanceKm - target);

      if (diff < bestDiff) {
        bestDiff = diff;
        bestRoute = route;
      }

      if (diff / target <= 0.08) {
        return route; // within 8%
      }
    }
  }

  return bestRoute;
}

// GENERATE ROUTE DESCRIPTION
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

// Clear map layers safely
function clearMapLayers() {
  if (state.routeLayer) map.removeLayer(state.routeLayer);
  if (state.startMarker) map.removeLayer(state.startMarker);
  if (state.endMarker) map.removeLayer(state.endMarker);
  if (state.arrowDecorator) map.removeLayer(state.arrowDecorator);

  state.routeLayer = null;
  state.startMarker = null;
  state.endMarker = null;
  state.arrowDecorator = null;
}

// SHOW RESULT + MAP
function showResult({ routeData, description, paceMinPerKm, start, isLoop }) {
  result.classList.remove("hidden");

  const actualDistance = routeData.distanceKm;
  const engineMinutes = Math.round(routeData.durationSec / 60);

  // User pace estimate (min/km)
  const paceMinutes = actualDistance * paceMinPerKm;
  const paceHours = Math.floor(paceMinutes / 60);
  const paceMins = Math.round(paceMinutes % 60);
  const paceStr = paceHours > 0 ? `${paceHours}h ${paceMins}m` : `${paceMins}m`;

  const engHours = Math.floor(engineMinutes / 60);
  const engMins = engineMinutes % 60;
  const engineStr = engHours > 0 ? `${engHours}h ${engMins}m` : `${engMins}m`;

  // Build turn-by-turn directions HTML
  let directionsHTML = "";
  if (routeData.instructions && routeData.instructions.length > 0) {
    const meaningful = routeData.instructions.filter((inst) => {
      const text = (inst.text || "").toLowerCase();
      return (
        !text.includes("waypoint") &&
        !text.includes("arrive at destination") &&
        (inst.distance || 0) > 15
      );
    });

    // Simple simplification: keep “continue”, street_name, or long segments
    const simplified = [];
    let buffer = null;

    for (const inst of meaningful) {
      const text = (inst.text || "").toLowerCase();
      const keep = text.includes("continue") || inst.street_name || (inst.distance || 0) > 120;

      if (keep) {
        if (buffer) {
          simplified.push(buffer);
          buffer = null;
        }
        simplified.push(inst);
      } else {
        if (!buffer) buffer = { ...inst };
        else buffer.distance = (buffer.distance || 0) + (inst.distance || 0);
      }
    }
    if (buffer) simplified.push(buffer);

    directionsHTML = `
      <div class="directions-toggle" style="margin-top: 1rem;">
        <button class="primary-btn" id="toggleDirections" style="padding: 0.6rem 1.2rem; font-size: 0.9rem;">
          Show Directions (${simplified.length} steps)
        </button>
      </div>
      <div id="directions-panel" class="directions-panel" style="display: none; margin-top: 1rem; max-height: 300px; overflow-y: auto; text-align: left;">
        <h4 style="margin-top: 0;">Navigation (${simplified.length} main turns):</h4>
        <ol style="padding-left: 2rem; margin: 0; list-style-position: outside;">
          ${simplified
            .map((instruction) => {
              const d = instruction.distance || 0;
              const distStr = d < 1000 ? `${Math.round(d)}m` : `${(d / 1000).toFixed(1)}km`;

              let text = instruction.text || "Continue";
              if (instruction.street_name && !text.toLowerCase().includes(instruction.street_name.toLowerCase())) {
                text += ` onto ${instruction.street_name}`;
              }

              return `<li style="margin-bottom: 0.7rem; padding-left: 0.5rem;"><strong>${text}</strong> <span style="color: var(--muted-text); font-size: 0.9rem;">— ${distStr}</span></li>`;
            })
            .join("")}
        </ol>
      </div>
    `;
  }

  result.innerHTML = `
    <h3>Your Route</h3>
    <p>${description}</p>
    <p><strong>Start:</strong> ${start.displayName}</p>
    <p><strong>Distance:</strong> ${actualDistance.toFixed(2)} km</p>
    <p><strong>At your pace:</strong> ${paceStr}</p>
    <p><strong>Routing engine estimate:</strong> ${engineStr}</p>
    ${directionsHTML}
    <button class="primary-btn" id="regenBtn" style="margin-top: 1rem;">Regenerate</button>
  `;

  // Directions toggle
  const toggleBtn = document.getElementById("toggleDirections");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const panel = document.getElementById("directions-panel");
      if (!panel) return;

      const isHidden = panel.style.display === "none";
      panel.style.display = isHidden ? "block" : "none";
      toggleBtn.textContent = isHidden ? "Hide Turn-by-Turn Directions" : "Show Turn-by-Turn Directions";
    });
  }

  // Draw route on map
  clearMapLayers();

  state.routeLayer = L.polyline(routeData.coordinates, {
    color: "#8BC34A",
    weight: 4,
    opacity: 0.85,
  }).addTo(map);

  // Arrow decorator (guard if plugin not loaded)
  if (typeof L.polylineDecorator === "function" && L.Symbol?.arrowHead) {
    const arrowSymbol = {
      offset: "50%",
      repeat: 100,
      symbol: L.Symbol.arrowHead({
        pixelSize: 12,
        polygon: false,
        pathOptions: { color: "#8BC34A", fillOpacity: 1, weight: 2 },
      }),
    };

    state.arrowDecorator = L.polylineDecorator(state.routeLayer, {
      patterns: [arrowSymbol],
    }).addTo(map);
  }

  // Markers
  state.startMarker = L.circleMarker(routeData.coordinates[0], {
    color: "#4CAF50",
    fillColor: "#4CAF50",
    fillOpacity: 0.85,
    radius: 8,
  })
    .addTo(map)
    .bindPopup(isLoop ? "Start/Finish" : "Start");

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

  // Regen button: re-run with last parameters if possible
  document.getElementById("regenBtn")?.addEventListener("click", () => {
    if (state.lastParams) handleSubmit(state.lastParams);
    else handleSubmit();
  });
}

// Centralized submit handler
async function handleSubmit(forcedParams = null) {
  // API key check
  if (!GRAPHHOPPER_API_KEY || GRAPHHOPPER_API_KEY === "xx") {
    result.classList.remove("hidden");
    result.innerHTML = `
      <h3>⚠️ API Key Required</h3>
      <p>To use real routing, you need a GraphHopper API key.</p>
      <p style="font-size: 0.9rem; color: var(--muted-text);">
        Put it into <code>GRAPHHOPPER_API_KEY</code> in <code>app.js</code>.
      </p>
    `;
    return;
  }

  // Read inputs (unless forced)
  const locationEl = document.getElementById("location");
  const distanceEl = document.getElementById("distance");
  const terrainEl = document.getElementById("terrain");
  const elevationEl = document.getElementById("elevation");
  const paceEl = document.getElementById("pace");
  const routeTypeEl = document.getElementById("routeType"); // make sure this exists in HTML

  const params = forcedParams || {
    locationInput: locationEl?.value || "",
    distanceKm: parseFloat(distanceEl?.value),
    terrain: terrainEl?.value || "road",
    elevation: elevationEl?.value || "flat",
    paceMinPerKm: parseFloat(paceEl?.value),
    routeType: routeTypeEl?.value || "loop",
  };

  // Store last params for regen
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

  // Geocode
  const geocodeResult = await geocodeLocation(params.locationInput);
  if (!geocodeResult) return;

  // Center map
  map.setView([geocodeResult.lat, geocodeResult.lon], 15);

  // Route generation
  const isLoop = params.routeType === "loop";
  let routeData = null;

  if (isLoop) {
    routeData = await generateLoopRoute(geocodeResult.lat, geocodeResult.lon, params.distanceKm, params.terrain);
  } else {
    routeData = await generatePointToPointRoute(geocodeResult.lat, geocodeResult.lon, params.distanceKm, params.terrain);
  }

  if (!routeData) {
    result.innerHTML = `
      <h3>Unable to generate route</h3>
      <p>This could be due to:</p>
      <ul style="text-align:left; margin:1rem 0;">
        <li>No suitable roads/paths in this area</li>
        <li>Distance too large for the location</li>
        <li>API rate limit reached</li>
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
    start: geocodeResult,
    isLoop,
  });
}

// FORM SUBMIT
form?.addEventListener("submit", (e) => {
  e.preventDefault();
  handleSubmit();
});
