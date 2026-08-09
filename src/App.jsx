import { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-polylinedecorator';
import NavPanel from './NavPanel';
import { useNavigation } from './useNavigation';
import { geocode, reverseGeocode, generateLoop, generateP2P, bearingBetween, cardinalFromBearing } from './utils';
import './App.css';

export default function App() {
  const [dark, setDark]   = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  const [form, setForm]   = useState({ location: '', distance: '', type: 'loop' });
  const [phase, setPhase] = useState('idle'); // idle | loading | result | error
  const [route, setRoute] = useState(null);   // { data, start, targetKm, isLoop }
  const [myLoc, setMyLoc]     = useState(null);  // { lat, lon, name } when started from GPS
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState('');

  const mapDivRef = useRef(null);
  const mapRef    = useRef(null);
  const layers    = useRef({});
  const lastForm  = useRef(null);

  const nav = useNavigation(mapRef);

  // ── Map init ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current || !mapDivRef.current) return;
    mapRef.current = L.map(mapDivRef.current).setView([-33.88, 151.2], 13);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OSM', subdomains: 'abcd', maxZoom: 19,
    }).addTo(mapRef.current);
    return () => { mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  // ── Map helpers ─────────────────────────────────────────────────────────────
  function clearLayers() {
    Object.values(layers.current).forEach(l => l && mapRef.current?.removeLayer(l));
    layers.current = {};
  }

  function drawRoute(data, isLoop) {
    const map = mapRef.current;
    if (!map) return;
    clearLayers();

    const line = L.polyline(data.coordinates, { color: '#8BC34A', weight: 4, opacity: 0.85 }).addTo(map);
    layers.current.line = line;

    try {
      if (L.polylineDecorator && L.Symbol?.arrowHead) {
        layers.current.arrows = L.polylineDecorator(line, {
          patterns: [{ offset: '50%', repeat: 200, symbol: L.Symbol.arrowHead({
            pixelSize: 14, polygon: true, pathOptions: { color: '#8BC34A', fillOpacity: 1, weight: 1 },
          }) }],
        }).addTo(map);
      }
    } catch (_) {}

    const c = data.coordinates;
    if (c.length >= 2) {
      const bearing = bearingBetween(c[0], c[1]);
      layers.current.startArrow = L.marker(c[0], {
        icon: L.divIcon({
          className: '',
          html: `<div style="transform:rotate(${bearing}deg);font-size:28px">➤</div>`,
          iconSize: [30, 30], iconAnchor: [15, 15],
        }),
      }).addTo(map).bindPopup('Start this way →');
    }

    layers.current.start = L.circleMarker(c[0], {
      color: '#4CAF50', fillColor: '#4CAF50', fillOpacity: 0.85, radius: 8,
    }).addTo(map).bindPopup(isLoop ? 'Start / Finish' : 'Start');

    if (!isLoop) {
      layers.current.end = L.circleMarker(c[c.length - 1], {
        color: '#CDDC39', fillColor: '#CDDC39', fillOpacity: 0.85, radius: 8,
      }).addTo(map).bindPopup('Finish');
    }

    map.fitBounds(line.getBounds(), { padding: [50, 50] });
  }

  // ── Current location ────────────────────────────────────────────────────────
  function useMyLocation() {
    if (!navigator.geolocation) {
      setLocError('Your browser does not support location.');
      return;
    }
    setLocError('');
    setLocating(true);

    navigator.geolocation.getCurrentPosition(
      async ({ coords: { latitude: lat, longitude: lon } }) => {
        const name = (await reverseGeocode(lat, lon)) || 'Current location';
        setMyLoc({ lat, lon, name });
        setForm(f => ({ ...f, location: name }));
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setLocError(err.code === 1
          ? 'Location blocked. Allow location access, then try again.'
          : "Couldn't get your location — try typing it instead.");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  }

  // ── Route generation ─────────────────────────────────────────────────────────
  async function handleSubmit(override = null) {
    const p = override ?? { ...form, distance: parseFloat(form.distance), coords: myLoc };
    lastForm.current = p;
    setPhase('loading');

    // Exact GPS coords win over geocoding the typed text.
    const start = p.coords ?? await geocode(p.location).catch(() => null);
    if (!start) { setPhase('error'); return; }

    mapRef.current?.setView([start.lat, start.lon], 14);

    const isLoop = p.type === 'loop';
    const data   = isLoop
      ? await generateLoop(start.lat, start.lon, p.distance)
      : await generateP2P(start.lat, start.lon, p.distance);

    if (!data) { setPhase('error'); return; }

    setRoute({ data, start, targetKm: p.distance, isLoop });
    setPhase('result');
    drawRoute(data, isLoop);
  }

  // ── Derived result values ─────────────────────────────────────────────────
  const errorPct = route ? Math.abs(route.data.distanceKm - route.targetKm) / route.targetKm * 100 : 0;
  const accuracy = errorPct <= 5 ? 'good' : errorPct <= 15 ? 'ok' : 'rough';
  const startDir = route?.data.coordinates.length >= 2
    ? cardinalFromBearing(bearingBetween(route.data.coordinates[0], route.data.coordinates[1])) : '';
  const turns = route
    ? (route.data.instructions || [])
        .filter(i => !['waypoint','arrive'].some(w => i.text?.toLowerCase().includes(w)) && (i.distance || 0) > 100)
        .slice(0, 8)
    : [];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={`app${dark ? ' dark' : ''}`}>
      {nav.active && (
        <NavPanel
          display={nav.display}
          muted={nav.muted}
          onStop={nav.stop}
          onToggleMute={nav.toggleMute}
        />
      )}

      <header className="header">
        <h1>RouteFlow</h1>
        <button className="icon-btn" onClick={() => setDark(d => !d)} aria-label="Toggle theme">
          {dark ? '☀️' : '🌙'}
        </button>
      </header>

      <main className="layout" style={{ paddingTop: nav.active ? 130 : 0 }}>
        <aside className="sidebar">

          {/* ── Form ── */}
          <form className="route-form" onSubmit={e => { e.preventDefault(); handleSubmit(); }}>
            <div className="row">
              <input
                className={`field${myLoc ? ' from-gps' : ''}`}
                placeholder="Start location (e.g. Newtown, Sydney)"
                value={form.location}
                // Typing overrides the GPS fix, so drop the stored coords.
                onChange={e => { setMyLoc(null); setLocError(''); setForm(f => ({ ...f, location: e.target.value })); }}
                required
              />
              <button
                type="button"
                className="btn locate"
                onClick={useMyLocation}
                disabled={locating}
                title="Start from my current location"
                aria-label="Start from my current location"
              >
                {locating ? '⏳' : '📍'}
              </button>
            </div>

            {myLoc && <p className="loc-note">📍 Starting from your location</p>}
            {locError && <p className="loc-error">{locError}</p>}
            <div className="row">
              <input
                className="field"
                type="number" min="1" max="50"
                placeholder="Distance (km)"
                value={form.distance}
                onChange={e => setForm(f => ({ ...f, distance: e.target.value }))}
                required
              />
              <select className="field" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                <option value="loop">Loop</option>
                <option value="p2p">Point to point</option>
              </select>
            </div>
            <button className="btn primary" type="submit" disabled={phase === 'loading'}>
              {phase === 'loading' ? '🏃 Generating…' : 'Generate Route'}
            </button>
          </form>

          {/* ── Result ── */}
          {phase === 'result' && route && (
            <div className="result">
              <h3>Your Route</h3>
              <p className="distance-label">{route.data.distanceKm.toFixed(2)} km</p>

              <p className={`accuracy ${accuracy}`}>
                {accuracy === 'good' ? '✓' : '⚠'} Target {route.targetKm} km · Generated {route.data.distanceKm.toFixed(2)} km
                {accuracy === 'rough' && ' — Try regenerating'}
              </p>

              <p className="start-dir">Head {startDir} from {route.start.name.split(',')[0]}</p>

              {turns.length > 0 && (
                <div className="turns">
                  <h4>Key Turns</h4>
                  <ol>
                    {turns.map((t, i) => (
                      <li key={i}>
                        {t.text}
                        <span className="muted">
                          {' '}({t.distance < 1000 ? `${Math.round(t.distance)}m` : `${(t.distance / 1000).toFixed(1)}km`})
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              <div className="actions">
                <button className="btn primary" onClick={() => nav.start(route.data)}>
                  ▶ Start Navigation
                </button>
                <button className="btn ghost" onClick={() => handleSubmit(lastForm.current)}>
                  ↺ Try Another Route
                </button>
              </div>
              <p className="hint">Navigation uses GPS + voice — works best on mobile.</p>
            </div>
          )}

          {/* ── Error ── */}
          {phase === 'error' && (
            <div className="error-box">
              <h3>Couldn't generate route</h3>
              <p>Try a different distance or location — or swap loop / point-to-point.</p>
              <button className="btn ghost" style={{ marginTop: '0.75rem' }} onClick={() => setPhase('idle')}>
                ← Try Again
              </button>
            </div>
          )}

        </aside>

        <div ref={mapDivRef} className="map" />
      </main>
    </div>
  );
}
