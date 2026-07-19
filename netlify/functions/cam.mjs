// Allowlisted CORS proxy for NYC DOT camera snapshots (hunt mode).
// The camera host sends no Access-Control-Allow-Origin header, so the browser
// can't fetch frames directly; this adds CORS for exactly our 12 cameras.
// Keep in sync with site/data/cameras.json.
const ALLOW = new Set([
  "81db80c2-13fe-4ae7-8b47-c08aa42d512f", // 5 Ave @ 66 St
  "b062d611-e0e8-40be-a180-c583391276f5", // Park Ave @ 72 St
  "65440c6b-ee6c-4406-8542-2992b6edf3f5", // Lexington @ 72 St
  "cd949f21-54b2-4d11-8aae-4ffba8654271", // 5 Ave @ 60 St
  "b5a78bda-3ca9-4ad4-bd03-4cee70baba2d", // 5 Ave @ 59 St
  "421960d6-54a8-4f12-a5ee-7a07390def4c", // Madison @ 57 St
  "f4d2c0f5-0148-45e7-95ba-a5185d8e8060", // Park Ave @ 57 St
  "5674d0ea-703a-43c3-bea7-2b372d1eb00b", // 2 Ave @ 72 St
  "180dcc87-d861-43e3-8898-9ad5ee1a26a9", // Lexington @ 57 St
  "3df06012-4c10-46e1-81d0-55405342e8df", // 3 Ave @ 76 St
  "a4bb497d-7e15-47c4-9787-374b013efbbe", // Madison @ 79 St
  "41397b64-d035-4b41-a03e-170fe4103d89", // Park Ave @ 79 St
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
