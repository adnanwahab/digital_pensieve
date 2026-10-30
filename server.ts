// Petal Wind static server: serves ./public with Bun.serve.
import { join, normalize, extname } from "node:path";

const ROOT = join(import.meta.dir, "public");
const PORT = Number(process.env.PORT ?? 8080);
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg"]);
const gzCache = new Map<string, Uint8Array>();

function cacheControl(path: string): string {
  if (path.startsWith("/vendor/")) return "public, max-age=31536000, immutable"; // pinned three.js
  if (path.endsWith(".html") || path === "/") return "no-cache";
  return "public, max-age=3600";
}

async function serveFile(req: Request, urlPath: string): Promise<Response | null> {
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(ROOT, safe);
  if (!filePath.startsWith(ROOT)) return null;
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  const headers = new Headers({
    "Content-Type": file.type,
    "Cache-Control": cacheControl(urlPath),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    Vary: "Accept-Encoding",
  });

  const wantsGzip = (req.headers.get("accept-encoding") ?? "").includes("gzip");
  if (wantsGzip && COMPRESSIBLE.has(extname(filePath))) {
    let gz = gzCache.get(filePath);
    if (!gz) {
      gz = Bun.gzipSync(new Uint8Array(await file.arrayBuffer()));
      gzCache.set(filePath, gz);
    }
    headers.set("Content-Encoding", "gzip");
    return new Response(gz, { headers });
  }
  return new Response(file, { headers });
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/healthz") return new Response("ok\n");
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    if (pathname === "/") {
      return (
        (await serveFile(req, "/index.html")) ??
        (await serveFile(req, "/petal-wind.html")) ??
        new Response("Not found", { status: 404 })
      );
    }

    const path = pathname.endsWith("/") ? pathname + "index.html" : pathname;
    return (
      (await serveFile(req, decodeURIComponent(path))) ??
      (extname(path)
        ? new Response("Not found", { status: 404 })
        : ((await serveFile(req, "/index.html")) ??
          (await serveFile(req, "/petal-wind.html")) ??
          new Response("Not found", { status: 404 })))
    );
  },
});

console.log(`Petal Wind listening on http://${server.hostname}:${server.port}`);
