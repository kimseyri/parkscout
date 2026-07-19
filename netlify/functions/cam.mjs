// Allowlisted CORS proxy for NYC DOT camera snapshots (hunt mode).
// The camera host sends no Access-Control-Allow-Origin header, so the browser
// can't fetch frames directly; this adds CORS for exactly our 12 cameras.
// Keep in sync with site/data/cameras.json.
const ALLOW = new Set([
  "81db80c2-13fe-4ae7-8b47-c08aa42d512f", // 5 Ave @ 66 St
  "b062d611-e0e8-40be-a180-c583391276f5", // Park Ave @ 72 St
  "65440c6b-ee6c-4406-8542-2992b6edf3f5", // Lexington @ 72 St
]);

export default async (req) => {
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !ALLOW.has(id)) {
    return new Response("unknown camera", { status: 400 });
  }
  const upstream = await fetch(
    `https://webcams.nyctmc.org/api/cameras/${id}/image`,
    { headers: { "user-agent": "parkscout/1.0 (personal, low-volume)" } },
  );
  if (!upstream.ok) {
    return new Response(`upstream ${upstream.status}`, { status: 502 });
  }
  return new Response(await upstream.arrayBuffer(), {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
};

export const config = { path: "/api/cam" };
