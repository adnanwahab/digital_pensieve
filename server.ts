// Petal Wind static server: serves ./public with Bun.serve.
import { join, normalize, extname } from "node:path";
import { readdir } from "node:fs/promises";

const ROOT = join(import.meta.dir, "public");
const VISUALIZATIONS_DIR = join(ROOT, "visualizations");
const PORT = Number(process.env.PORT ?? 8080);
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg"]);
const PREVIEWABLE_VISUALIZATION_EXTENSIONS = new Set([
  ".html",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".bmp",
  ".tif",
  ".tiff",
]);
const gzCache = new Map<string, ArrayBuffer>();

const BALLOT_MAX_ARTWORK_LENGTH = 200;
const BALLOT_MAX_AUTHOR_LENGTH = 80;
const BALLOT_MAX_COMMENT_LENGTH = 600;
const BALLOT_MAX_COMMENTS_PER_ARTWORK = 200;

const POLITICS_LAW_KEYWORDS = [
  "politic",
  "law",
  "legal",
  "vote",
  "voting",
  "ballot",
  "civic",
  "govern",
  "policy",
  "democracy",
  "justice",
  "rights",
  "court",
  "senate",
  "congress",
  "parliament",
  "constitution",
  "election",
  "atlas",
] as const;

type BallotComment = {
  id: string;
  author: string;
  text: string;
  createdAt: string;
};

type BallotEntry = {
  artwork: string;
  votes: number;
  comments: BallotComment[];
};

const ballotStore = new Map<string, BallotEntry>();

function cacheControl(path: string): string {
  if (path.startsWith("/vendor/")) return "public, max-age=31536000, immutable"; // pinned three.js
  if (path.endsWith(".html") || path === "/") return "no-cache";
  return "public, max-age=3600";
}

function apiHeaders(cacheControlValue = "no-cache"): HeadersInit {
  return {
    "Cache-Control": cacheControlValue,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

function normalizeArtwork(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > BALLOT_MAX_ARTWORK_LENGTH) return null;

  // Allow nested visualization paths (for folder/index.html), but block traversal.
  if (trimmed.startsWith("/") || trimmed.includes("\\") || trimmed.includes("..")) return null;
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;

  return trimmed;
}

function normalizeAuthor(input: unknown): string {
  if (typeof input !== "string") return "Anonymous";
  const trimmed = input.trim();
  if (!trimmed) return "Anonymous";
  return trimmed.slice(0, BALLOT_MAX_AUTHOR_LENGTH);
}

function normalizeComment(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > BALLOT_MAX_COMMENT_LENGTH) return null;
  return trimmed;
}

function getOrCreateBallotEntry(artwork: string): BallotEntry {
  const existing = ballotStore.get(artwork);
  if (existing) return existing;
  const created: BallotEntry = { artwork, votes: 0, comments: [] };
  ballotStore.set(artwork, created);
  return created;
}

function getBallotEntrySnapshot(entry: BallotEntry): BallotEntry {
  return {
    artwork: entry.artwork,
    votes: entry.votes,
    comments: entry.comments.map((comment) => ({ ...comment })),
  };
}

function ballotEntriesSorted(): BallotEntry[] {
  return [...ballotStore.values()]
    .sort((a, b) => a.artwork.localeCompare(b.artwork, undefined, { sensitivity: "base" }))
    .map(getBallotEntrySnapshot);
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: apiHeaders() });
}

function isPoliticsLawVisualization(path: string): boolean {
  const normalized = path.toLowerCase();
  return POLITICS_LAW_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function compareVisualizationPaths(a: string, b: string): number {
  const aIsPoliticsLaw = isPoliticsLawVisualization(a);
  const bIsPoliticsLaw = isPoliticsLawVisualization(b);

  // Keep politics/law works contiguous by assigning them a lower group weight.
  if (aIsPoliticsLaw !== bIsPoliticsLaw) {
    return aIsPoliticsLaw ? -1 : 1;
  }

  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

async function listVisualizationFiles(): Promise<string[]> {
  const entries = await readdir(VISUALIZATIONS_DIR, { withFileTypes: true });
  const directFiles = entries
    .filter((entry) => entry.isFile() && PREVIEWABLE_VISUALIZATION_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name);

  const folderPreviews = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const folderPath = join(VISUALIZATIONS_DIR, entry.name);
        const folderEntries = await readdir(folderPath, { withFileTypes: true });

        const indexHtml = folderEntries.find(
          (child) => child.isFile() && child.name.localeCompare("index.html", undefined, { sensitivity: "base" }) === 0
        );
        if (indexHtml) return `${entry.name}/index.html`;

        const firstRenderable = folderEntries
          .filter((child) => child.isFile() && PREVIEWABLE_VISUALIZATION_EXTENSIONS.has(extname(child.name).toLowerCase()))
          .map((child) => child.name)
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))[0];

        return firstRenderable ? `${entry.name}/${firstRenderable}` : null;
      })
  );

  return [...directFiles, ...folderPreviews.filter((value): value is string => Boolean(value))].sort(compareVisualizationPaths);
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
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/healthz") return new Response("ok\n");

    if (pathname === "/api/visualizations") {
      try {
        const files = await listVisualizationFiles();
        return Response.json(
          { files },
          {
            headers: apiHeaders(),
          }
        );
      } catch {
        return Response.json({ files: [] }, { status: 500, headers: apiHeaders() });
      }
    }

    if (pathname === "/api/ballot" && req.method === "GET") {
      const requestedArtwork = normalizeArtwork(url.searchParams.get("artwork"));
      if (url.searchParams.has("artwork") && !requestedArtwork) {
        return badRequest("Invalid artwork identifier.");
      }

      if (requestedArtwork) {
        const entry = ballotStore.get(requestedArtwork) ?? { artwork: requestedArtwork, votes: 0, comments: [] };
        return Response.json({ entry: getBallotEntrySnapshot(entry) }, { headers: apiHeaders() });
      }

      return Response.json({ entries: ballotEntriesSorted() }, { headers: apiHeaders() });
    }

    if (pathname === "/api/ballot/vote" && req.method === "POST") {
      let payload: unknown;
      try {
        payload = await req.json();
      } catch {
        return badRequest("Expected JSON body.");
      }

      const artwork = normalizeArtwork((payload as { artwork?: unknown })?.artwork);
      if (!artwork) return badRequest("A valid artwork field is required.");

      const entry = getOrCreateBallotEntry(artwork);
      entry.votes += 1;

      return Response.json({ entry: getBallotEntrySnapshot(entry) }, { headers: apiHeaders() });
    }

    if (pathname === "/api/ballot/comment" && req.method === "POST") {
      let payload: unknown;
      try {
        payload = await req.json();
      } catch {
        return badRequest("Expected JSON body.");
      }

      const artwork = normalizeArtwork((payload as { artwork?: unknown })?.artwork);
      if (!artwork) return badRequest("A valid artwork field is required.");

      const text = normalizeComment((payload as { text?: unknown })?.text);
      if (!text) {
        return badRequest(`Comment text is required (max ${BALLOT_MAX_COMMENT_LENGTH} chars).`);
      }

      const author = normalizeAuthor((payload as { author?: unknown })?.author);
      const entry = getOrCreateBallotEntry(artwork);
      const comment: BallotComment = {
        id: crypto.randomUUID(),
        author,
        text,
        createdAt: new Date().toISOString(),
      };

      entry.comments.push(comment);
      if (entry.comments.length > BALLOT_MAX_COMMENTS_PER_ARTWORK) {
        entry.comments.splice(0, entry.comments.length - BALLOT_MAX_COMMENTS_PER_ARTWORK);
      }

      return Response.json({ entry: getBallotEntrySnapshot(entry), comment: { ...comment } }, { headers: apiHeaders() });
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
