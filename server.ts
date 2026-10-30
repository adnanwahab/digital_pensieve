// Petal Wind static server: serves ./public with Bun.serve.
import { join, normalize, extname } from "node:path";
import { readdir } from "node:fs/promises";

const ROOT = join(import.meta.dir, "public");
const VISUALIZATIONS_DIR = join(ROOT, "visualizations");
const PORT = Number(process.env.PORT ?? 8080);
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg"]);
const gzCache = new Map<string, ArrayBuffer>();

function cacheControl(path: string): string {
  if (path.startsWith("/vendor/")) return "public, max-age=31536000, immutable"; // pinned three.js
  if (path.endsWith(".html") || path === "/") return "no-cache";
  return "public, max-age=3600";
}

async function listVisualizationFiles(): Promise<string[]> {
  const entries = await readdir(VISUALIZATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
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
      const packed = Bun.gzipSync(new Uint8Array(await file.arrayBuffer()));
      gz = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) as ArrayBuffer;
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
    if (pathname === "/api/visualizations") {
      try {
        const files = await listVisualizationFiles();
        return Response.json(
          { files },
          {
            headers: {
              "Cache-Control": "no-cache",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "strict-origin-when-cross-origin",
            },
          }
        );
      } catch {
        return Response.json({ files: [] }, { status: 500 });
      }
    }
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
