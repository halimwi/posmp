// Runs the whole app on one local port: the frontend as static files and the
// Lambda handler behind /api, backed by an in-memory DynamoDB. Data is lost
// when the process stops.
//
//   npm install && npm run dev      then open http://localhost:8080
//   sign in as admin / localpass123 (a manager)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { startDynamo } from "./dynamo.mjs";

const PORT = Number(process.env.PORT || 8080);
const FRONTEND = fileURLToPath(new URL("../frontend/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

await startDynamo();
process.env.ADMIN_USERNAME ||= "admin";
process.env.ADMIN_PASSWORD ||= "localpass123";
process.env.JWT_SECRET ||= "local-dev-secret-not-for-production";
process.env.SHOP_NAME ||= "Jaya Mandiri";
const { handler } = await import("../backend/index.mjs");

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const out = await handler({
      rawPath: url.pathname,
      requestContext: { http: { method: req.method } },
      headers: req.headers,
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: chunks.length ? Buffer.concat(chunks).toString() : undefined,
    });
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body);
    return;
  }

  // Same-origin API, so the frontend needs no URL prompt.
  if (url.pathname === "/config.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(`window.POSMP_CONFIG = { apiUrl: "${url.origin}" };`);
    return;
  }

  const file = normalize(join(FRONTEND, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(FRONTEND)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => {
  console.log(`posmp running at http://localhost:${PORT}  (sign in as ${process.env.ADMIN_USERNAME} / ${process.env.ADMIN_PASSWORD})`);
});
