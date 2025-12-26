/* ===== ROUTE FLOW APP (Leaflet Clean Map + Geocoding) ===== */
const toggleButton = document.getElementById("themeToggle");
const form = document.getElementById("routeForm");
const result = document.getElementById("result");

// THEME TOGGLE
toggleButton.addEventListener("click", () => {
  document.body.classList.toggle("dark");
  toggleButton.textContent = document.body.classList.contains("dark")
    ? "☀️"
    : "🌙";
});

// INITIALIZE CLEAN MAP
const map = L.map("map").setView([51.505, -0.09], 13);
L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 19,
  }
).addTo(map);

// HELPER: pick random item from array
const randomPick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// GENERATE ROUTE FUNCTION
function generateRoute(distance, terrain, elevation, pace) {
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
    road: [
      "paved roads and footpaths",
      "city streets and sidewalks",
      "smooth asphalt and paths",
    ],
    trail: [
      "natural trails and off-road paths",
      "dirt tracks and scenic trails",
      "woodland paths and rugged trails",
    ],
    mixed: [
      "a mix of roads and trails",
      "both paved and natural paths",
      "a combination of streets and trails",
    ],
  };

  const distanceNum = parseFloat(distance);
  const paceNum = parseFloat(pace);

  // Estimated time
  const timeMinutes = distanceNum * paceNum;
  const hours = Math.floor(timeMinutes / 60);
  const minutes = Math.round(timeMinutes % 60);
  const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  return {
    distance: distanceNum,
    description: `This ${distanceNum} km run follows ${randomPick(
      terrainOptions[terrain]
    )}, featuring ${randomPick(elevationOptions[elevation])}.`,
    estimatedTime: timeStr,
  };
}

// RANDOMIZED DEMO ROUTE POINTS
function generateRandomRoute(startLat, startLng, distanceKm) {
  const points = [];
  const numPoints = 5; // number of points along the route
  points.push([startLat, startLng]);

  for (let i = 1; i < numPoints; i++) {
    const offsetLat = (Math.random() - 0.5) * 0.01;
    const offsetLng = (Math.random() - 0.5) * 0.01;
    const lastPoint = points[points.length - 1];
    points.push([lastPoint[0] + offsetLat, lastPoint[1] + offsetLng]);
  }

  return points;
}

// GEOCODE LOCATION INPUT USING Nominatim
async function geocodeLocation(location) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
    location
  )}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data && data.length > 0) {
      return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
    } else {
      alert("Location not found, defaulting to London.");
      return [51.505, -0.09];
    }
  } catch (err) {
    alert("Error fetching location, defaulting to London.");
    return [51.505, -0.09];
  }
}

// SHOW RESULT + MAP
function showResult(route, startLat, startLng) {
  result.classList.remove("hidden");

  result.innerHTML = `
    <h3>Your Route</h3>
    <p>${route.description}</p>
    <p><strong>Estimated Time:</strong> ${route.estimatedTime}</p>
    <button class="primary-btn" id="regenBtn">Regenerate</button>
  `;

  // Clear previous route & markers
  if (window.currentRoute) map.removeLayer(window.currentRoute);
  if (window.startMarker) map.removeLayer(window.startMarker);
  if (window.endMarker) map.removeLayer(window.endMarker);

  // Generate random route
  const routePoints = generateRandomRoute(startLat, startLng, route.distance);

  // Add polyline
  window.currentRoute = L.polyline(routePoints, {
    color: "#8BC34A", // soft green
    weight: 4,
  }).addTo(map);

  // Add start/end markers
  window.startMarker = L.circleMarker(routePoints[0], {
    color: "#4CAF50",
    radius: 6,
  }).addTo(map);
  window.endMarker = L.circleMarker(routePoints[routePoints.length - 1], {
    color: "#CDDC39",
    radius: 6,
  }).addTo(map);

  // Zoom map to show route
  map.fitBounds(window.currentRoute.getBounds());

  // REGENERATE BUTTON
  document.getElementById("regenBtn").addEventListener("click", handleSubmit);
}

// CENTRALIZED SUBMIT HANDLER
async function handleSubmit() {
  const locationInput = document.getElementById("location").value || "London";
  const [startLat, startLng] = await geocodeLocation(locationInput);

  const distance = document.getElementById("distance").value;
  const terrain = document.getElementById("terrain").value;
  const elevation = document.getElementById("elevation").value;
  const pace = parseFloat(document.getElementById("pace").value);

  if (!distance || !pace || pace <= 0) {
    alert("Please enter valid distance and pace.");
    return;
  }

  const route = generateRoute(distance, terrain, elevation, pace);
  showResult(route, startLat, startLng);
}

// FORM SUBMIT
form.addEventListener("submit", (e) => {
  e.preventDefault();
  handleSubmit();
});
