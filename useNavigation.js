import { useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import { closestOnRoute, distanceRemaining, stepForIndex, haversine, fmtDist, turnIcon } from '../utils';

export function useNavigation(mapRef) {
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [display, setDisplay] = useState({
    icon: '↑', instruction: 'Getting location…', distance: '', next: '', progress: 0,
  });

  // All mutable nav state lives in a ref so callbacks never go stale
  const n = useRef({
    watchId: null, stepIdx: 0, lastAnnounced: -1,
    approachDone: false, offRouteWarned: false, muted: false,
    userMarker: null, ring: null,
    coords: [], steps: [], totalKm: 0,
  });

  const say = useCallback((text) => {
    if (n.current.muted || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.92;
    window.speechSynthesis.speak(u);
  }, []);

  const stop = useCallback(() => {
    const map = mapRef.current;
    setActive(false);
    if (n.current.watchId != null) {
      navigator.geolocation.clearWatch(n.current.watchId);
      n.current.watchId = null;
    }
    if (n.current.userMarker) { map?.removeLayer(n.current.userMarker); n.current.userMarker = null; }
    if (n.current.ring)       { map?.removeLayer(n.current.ring);       n.current.ring = null; }
    window.speechSynthesis?.cancel();
  }, [mapRef]);

  const handlePosition = useCallback(({ coords: { latitude: lat, longitude: lng, accuracy } }) => {
    const map = mapRef.current;
    if (!map || n.current.watchId == null) return;

    // ── Update user dot ───────────────────────────────────────────────────────
    const pos = [lat, lng];
    if (!n.current.userMarker) {
      n.current.userMarker = L.marker(pos, {
        icon: L.divIcon({
          className: '',
          html: '<div style="width:16px;height:16px;background:#3b82f6;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 5px rgba(59,130,246,.25)"></div>',
          iconSize: [16, 16], iconAnchor: [8, 8],
        }),
        zIndexOffset: 1000,
      }).addTo(map);
      n.current.ring = L.circle(pos, {
        radius: accuracy || 10, color: '#3b82f6',
        fillColor: '#3b82f6', fillOpacity: 0.07, weight: 1,
      }).addTo(map);
    } else {
      n.current.userMarker.setLatLng(pos);
      n.current.ring?.setLatLng(pos).setRadius(accuracy || 10);
    }
    map.panTo(pos, { animate: true, duration: 0.5 });

    // ── Snap to route ─────────────────────────────────────────────────────────
    const { index, distM } = closestOnRoute(n.current.coords, lat, lng);

    if (distM > 80 && !n.current.offRouteWarned) {
      n.current.offRouteWarned = true;
      say('You appear to be off route. Head back to the green path.');
    } else if (distM <= 80) {
      n.current.offRouteWarned = false;
    }

    // ── Step (only advances, never goes back) ─────────────────────────────────
    n.current.stepIdx = Math.max(n.current.stepIdx, stepForIndex(n.current.steps, index));
    const step = n.current.steps[n.current.stepIdx];
    if (!step) return;

    const turnCoord  = n.current.coords[step.interval?.[1] ?? index];
    const distToTurn = turnCoord ? haversine([lat, lng], turnCoord) : 0;
    const distLeft   = distanceRemaining(n.current.coords, index);
    const progress   = Math.max(0, (n.current.totalKm * 1000 - distLeft) / (n.current.totalKm * 1000));
    const isFinish   = step.sign === 4;
    const nextStep   = n.current.steps[n.current.stepIdx + 1];

    setDisplay({
      icon:        turnIcon(step.sign ?? 0),
      instruction: isFinish ? "You've arrived!" : step.text,
      distance:    isFinish ? 'Route complete 🎉' : `In ${fmtDist(distToTurn)}`,
      next:        isFinish
        ? `Total: ${n.current.totalKm.toFixed(1)}km`
        : nextStep
          ? `Then: ${turnIcon(nextStep.sign ?? 0)} ${nextStep.text}`
          : `${fmtDist(distLeft)} remaining`,
      progress,
    });

    // ── Voice ─────────────────────────────────────────────────────────────────
    if (n.current.stepIdx !== n.current.lastAnnounced) {
      n.current.lastAnnounced = n.current.stepIdx;
      n.current.approachDone  = false;
      say(isFinish ? "You've completed your route. Great run!" : step.text);
    }

    // Approaching-turn alert (once per step, at 200m)
    if (!n.current.approachDone && distToTurn < 200 && distToTurn > 30
        && nextStep?.sign !== 0 && nextStep?.sign !== 4) {
      n.current.approachDone = true;
      say(`In ${fmtDist(distToTurn)}, ${nextStep.text}`);
    }
  }, [mapRef, say]);

  const start = useCallback((routeData) => {
    if (!navigator.geolocation) {
      alert('GPS not available. Open RouteFlow on your phone to navigate.');
      return;
    }
    stop();

    Object.assign(n.current, {
      stepIdx: 0, lastAnnounced: -1, approachDone: false, offRouteWarned: false, muted: false,
      coords: routeData.coordinates,
      steps:  routeData.instructions || [],
      totalKm: routeData.distanceKm,
    });

    setActive(true);
    setMuted(false);
    say(`Navigation started. ${n.current.steps[0]?.text || 'Follow the green route.'}`);

    n.current.watchId = navigator.geolocation.watchPosition(
      handlePosition,
      (err) => { if (err.code === 1) { alert('Location access denied.'); stop(); } },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }, [stop, handlePosition, say]);

  const toggleMute = useCallback(() => {
    n.current.muted = !n.current.muted;
    setMuted(n.current.muted);
    if (!n.current.muted) say('Sound on.');
  }, [say]);

  return { active, display, muted, start, stop, toggleMute };
}
