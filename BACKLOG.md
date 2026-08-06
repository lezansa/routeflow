# Backlog

Ideas captured for later. Not committed work — just notes so nothing gets lost.

---

## 🌸 GPS Art Routes ("run a shape")

Generate a route whose GPS trace looks like a recognizable shape — a heart,
star, flower, simple letters — in the spirit of "Strava art." The output is
inherently shareable (the whole point is posting the picture), so this doubles
as a growth feature: every shared shape-run is an ad for the app.

### How it would work
Builds on the existing flow (waypoints → GraphHopper street routing):
1. Store a small library of **shape templates** as sequences of normalized
   points (sample them from SVG paths).
2. User picks a shape, a **center point**, and a **size** (e.g. "fit in a 2 km box").
3. Transform the shape's points to real lat/lon around the center (reuse the
   `destination()` math in `src/utils.js`).
4. Feed the points to GraphHopper as waypoints; it snaps the path onto streets.

### Realistic MVP scope
- 4–5 forgiving shapes (heart, star, simple flower beat anything fine-detailed).
- Let the user **drag / rotate / scale** the shape over the map and re-route —
  manual nudging bridges the gap between the ideal shape and the street grid.
- One-tap **"share image"** of the finished map (this button *is* the growth strategy).
- Position it playfully: "Run a heart for Valentine's," "propose at 5 km."

### Hard parts / constraints (be honest in the UI)
- **Approximation, not pixel-perfect.** The router follows real streets, so the
  shape comes out recognizable-ish, not clean. Perfect auto-shapes is a genuinely
  hard optimization problem — even dedicated GPS-art tools need manual tweaking.
- **Waypoint budget / cost.** A detailed shape needs many points per request;
  GraphHopper's free tier caps points per request and bills more for bigger ones.
  May need to simplify shapes to the point budget, or check the plan's limit.
- **Needs a grid-like area.** Works best in dense, grid-ish street networks
  (parts of central Sydney); turns into a blob in winding suburbs. Tell the user.

---

## Related ideas (growth / retention)

Smaller notes from the same conversation — capture now, scope later.

- **Share-route image / link.** A "here's the loop I ran — try it" share, beyond
  just GPS art. Gives a reason to spread routes runner-to-runner (network edge).
- **Saved / favourite routes.** A reason to come back, and the natural first
  candidate for a future premium tier.
- **Privacy-respecting analytics.** Add GoatCounter or Plausible (no cookies, no
  personal data) so "100 users" is a fact, not a vibe — needed before any growth push.
- **Route variety.** Avoid handing back the same loop twice from the same start.
- **`SCENIC_WEIGHT` tuning.** The dial in `src/utils.js` (currently 0.2) — revisit
  after real-world use; raise if scenery should beat exact distance more often.
