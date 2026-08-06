/**
 * RouteFlow routing proxy — Cloudflare Worker.
 *
 * Keeps the GraphHopper API key server-side and adds CORS headers so the
 * browser app can call it. Ported from the original AWS Lambda handler.
 *
 * Deploy: paste into a Worker (or `wrangler deploy`), then set the secret:
 *   wrangler secret put GRAPHHOPPER_KEY
 * Dashboard equivalent: Settings → Variables → add GRAPHHOPPER_KEY, click Encrypt.
 */

const ALLOWED_ORIGINS = [
  "https://lezansa.github.io",
  "http://localhost:5173",   // Vite dev server
  "http://127.0.0.1:5173",
];

const DEFAULT_ORIGIN = "https://lezansa.github.io";

export default {
  async fetch(request, env) {
    const requestOrigin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.includes(requestOrigin)
      ? requestOrigin
      : DEFAULT_ORIGIN;

    const headers = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Content-Type": "application/json",
      "Vary": "Origin",
      "X-Routeflow-Cors": "worker",
    };

    const fail = (status, error) =>
      new Response(JSON.stringify({ error }), { status, headers });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    try {
      const apiKey = env.GRAPHHOPPER_KEY;
      if (!apiKey) return fail(500, "Missing GRAPHHOPPER_KEY secret");

      const qs = new URL(request.url).searchParams;
      const profile = qs.get("profile") || "foot";
      const pointsParam = qs.get("points");

      if (!pointsParam) return fail(400, "Missing points parameter");

      const rawPoints = pointsParam.split("|");
      if (rawPoints.length < 2) return fail(400, "Need at least two points");

      const url = new URL("https://graphhopper.com/api/1/route");
      url.searchParams.set("key", apiKey);
      url.searchParams.set("profile", profile);
      url.searchParams.set("points_encoded", "false");
      url.searchParams.set("instructions", "true");
      url.searchParams.append("details", "road_class");  // drives scenic scoring
      url.searchParams.append("details", "surface");

      rawPoints.forEach((p) => url.searchParams.append("point", p));

      const upstream = await fetch(url.toString());
      const body = await upstream.text();

      return new Response(body, { status: upstream.status, headers });
    } catch (err) {
      return fail(500, String(err));
    }
  },
};
