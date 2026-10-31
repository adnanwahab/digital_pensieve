// Petal Wind static server: serves ./public with Bun.serve.
import { join, normalize, extname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";

function loadDotEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    if (process.env[key] != null) continue;

    let value = (match[2] ?? "").trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // Support inline comments in unquoted dotenv values.
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    }

    process.env[key] = value;
  }
}

const PROJECT_ROOT = import.meta.dir;
loadDotEnvFile(join(PROJECT_ROOT, ".env"));
loadDotEnvFile(join(PROJECT_ROOT, ".env.local"));

const ROOT = join(PROJECT_ROOT, "public");
const VISUALIZATIONS_DIR = join(ROOT, "visualizations");
const PORT = Number(process.env.PORT ?? 8080);
const DEAR_CONGRESS_BASE = process.env.DEAR_CONGRESS_BASE ?? "https://dear-congress.fly.dev";
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg"]);
const gzCache = new Map<string, ArrayBuffer>();

const BALLOT_MAX_ARTWORK_LENGTH = 200;
const BALLOT_MAX_AUTHOR_LENGTH = 80;
const BALLOT_MAX_COMMENT_LENGTH = 600;
const BALLOT_MAX_COMMENTS_PER_ARTWORK = 200;

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-3-5-haiku-latest";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-3.1-pro-preview";
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const LABEL_MAX_INPUT_CHARS = 4000;
const LABEL_MAX_COUNT = 8;

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

function normalizeLabelInput(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text) return null;
  return text.slice(0, LABEL_MAX_INPUT_CHARS);
}

function sanitizeLabels(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of input) {
    if (typeof item !== "string") continue;
    const label = item.replace(/\s+/g, " ").trim().slice(0, 48);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= LABEL_MAX_COUNT) break;
  }

  return out;
}

function parseClaudeLabelJson(text: string): string[] {
  const trimmed = text.trim();

  try {
    const parsed = JSON.parse(trimmed) as { labels?: unknown } | unknown;
    if (parsed && typeof parsed === "object" && "labels" in parsed) {
      return sanitizeLabels((parsed as { labels?: unknown }).labels);
    }
    return sanitizeLabels(parsed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return [];
    try {
      const parsed = JSON.parse(match[0]) as { labels?: unknown };
      return sanitizeLabels(parsed.labels);
    } catch {
      return [];
    }
  }
}

function collectEntryCandidates(payload: unknown): Array<Record<string, unknown>> {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload.filter((v): v is Record<string, unknown> => !!v && typeof v === "object");
  if (typeof payload !== "object") return [];

  const p = payload as Record<string, unknown>;
  const candidates = [p.entries, p.data, p.journals, p.items].find(Array.isArray);
  if (Array.isArray(candidates)) {
    return candidates.filter((v): v is Record<string, unknown> => !!v && typeof v === "object");
  }

  if (p.entry && typeof p.entry === "object") return [p.entry as Record<string, unknown>];
  return [];
}

function entryTimestamp(entry: Record<string, unknown>, fallback: number): number {
  const raw =
    entry.createdAt ??
    entry.created_at ??
    entry.timestamp ??
    entry.ts ??
    entry.updatedAt ??
    entry.updated_at;

  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Date.parse(raw);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

async function fetchDearCongressLatestEntryId(): Promise<{ entryId: string; source: string } | null> {
  const endpoints = [
    `${DEAR_CONGRESS_BASE}/api/entries`,
    `${DEAR_CONGRESS_BASE}/api/journals`,
    `${DEAR_CONGRESS_BASE}/api/ballot_entries`,
    `${DEAR_CONGRESS_BASE}/api/state`,
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, { headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const payload = (await res.json()) as unknown;
      const entries = collectEntryCandidates(payload)
        .filter((e) => typeof e.id === "string" && e.id.trim().length > 0);

      if (!entries.length) continue;

      const sorted = entries
        .map((e, i) => ({ e, t: entryTimestamp(e, i) }))
        .sort((a, b) => b.t - a.t);

      const latest = sorted[0].e.id as string;
      return { entryId: latest.trim(), source: endpoint };
    } catch {
      continue;
    }
  }

  return null;
}

async function generateClaudeLabels(entryText: string): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[one-voice][server] ANTHROPIC_API_KEY not set; returning empty labels.");
    return [];
  }

  const prompt = [
    "You extract concise civic/social labels from one personal journal entry.",
    "Return ONLY JSON in this shape: {\"labels\":[\"...\"]}.",
    "Rules:",
    `- 3 to ${LABEL_MAX_COUNT} labels when possible.`,
    "- 1 to 4 words per label.",
    "- Prefer thematic tags (e.g., Transit, Childcare burden, School access, Housing cost, Civic trust).",
    "- No explanation, no markdown.",
    "Entry:",
    entryText,
  ].join("\n");

  console.info("[one-voice][server] Claude label request starting", {
    model: CLAUDE_MODEL,
    chars: entryText.length,
  });

  const res = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 220,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  console.info("[one-voice][server] Claude label response received", {
    ok: res.ok,
    status: res.status,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn("[one-voice][server] Claude non-OK response body", { status: res.status, body: errText });
    return [];
  }
  const payload = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = payload?.content?.filter(part => part?.type === "text").map(part => part.text ?? "").join("\n").trim() ?? "";
  console.info("[one-voice][server] Claude response text", { text });
  if (!text) {
    console.info("[one-voice][server] Claude returned empty text content.");
    return [];
  }

  const labels = parseClaudeLabelJson(text);
  console.info("[one-voice][server] Claude labels parsed", { count: labels.length, labels });
  return labels;
}

async function listGeminiGenerateContentModels(apiKey: string): Promise<string[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      console.warn("[one-voice][server] Gemini ListModels failed", { status: res.status, body });
      return [];
    }

    const payload = (await res.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };

    const models = (payload.models ?? [])
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => (m.name ?? "").replace(/^models\//, "").trim())
      .filter((name) => !!name && !/tts|audio/i.test(name));

    console.info("[one-voice][server] Gemini ListModels candidates", { count: models.length, models });
    return models;
  } catch (err) {
    console.warn("[one-voice][server] Gemini ListModels error", { err });
    return [];
  }
}

async function generateGeminiLabels(entryText: string): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[one-voice][server] GEMINI_API_KEY not set; returning empty labels.");
    return [];
  }

  const prompt = [
    "You extract concise civic/social labels from one personal journal entry.",
    "Return ONLY JSON in this shape: {\"labels\":[\"...\"]}.",
    "Rules:",
    `- 3 to ${LABEL_MAX_COUNT} labels when possible.`,
    "- 1 to 4 words per label.",
    "- Prefer thematic tags (e.g., Transit, Childcare burden, School access, Housing cost, Civic trust).",
    "- No explanation, no markdown.",
    "Entry:",
    entryText,
  ].join("\n");

  const normalizeModel = (m: string) => m.trim().replace(/^models\//, "");
  const preferred = normalizeModel(GEMINI_MODEL);
  const discovered = await listGeminiGenerateContentModels(apiKey);
  const modelCandidates = Array.from(new Set([
    preferred,
    ...discovered,
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
  ])).filter((name) => !!name && !/tts|audio/i.test(name));

  console.info("[one-voice][server] Gemini model candidates to try", { modelCandidates });

  for (const model of modelCandidates) {
    const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    console.info("[one-voice][server] Gemini label request starting", {
      model,
      chars: entryText.length,
    });

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 220,
        },
        contents: [{
          role: "user",
          parts: [{ text: prompt }],
        }],
      }),
    });

    console.info("[one-voice][server] Gemini label response received", {
      model,
      ok: res.ok,
      status: res.status,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn("[one-voice][server] Gemini non-OK response body", { model, status: res.status, body: errText });
      if (res.status === 404) continue;
      return [];
    }

    const payload = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = payload?.candidates?.[0]?.content?.parts?.map(part => part?.text ?? "").join("\n").trim() ?? "";
    console.info("[one-voice][server] Gemini response text", { model, text });
    if (!text) {
      console.info("[one-voice][server] Gemini returned empty text content.", { model });
      return [];
    }

    const labels = parseClaudeLabelJson(text);
    console.info("[one-voice][server] Gemini labels parsed", { model, count: labels.length, labels });
    return labels;
  }

  return [];
}

async function generateOpenAILabels(entryText: string): Promise<string[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[one-voice][server] OPENAI_API_KEY not set; returning empty labels.");
    return [];
  }

  const prompt = [
    "You extract concise civic/social labels from one personal journal entry.",
    "Return ONLY JSON in this shape: {\"labels\":[\"...\"]}.",
    "Rules:",
    `- 3 to ${LABEL_MAX_COUNT} labels when possible.`,
    "- 1 to 4 words per label.",
    "- Prefer thematic tags (e.g., Transit, Childcare burden, School access, Housing cost, Civic trust).",
    "- No explanation, no markdown.",
    "Entry:",
    entryText,
  ].join("\n");

  console.info("[one-voice][server] OpenAI label request starting", {
    model: OPENAI_MODEL,
    chars: entryText.length,
  });

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      max_output_tokens: 220,
      input: prompt,
    }),
  });

  console.info("[one-voice][server] OpenAI label response received", {
    ok: res.ok,
    status: res.status,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn("[one-voice][server] OpenAI non-OK response body", { status: res.status, body: errText });
    return [];
  }

  const payload = (await res.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  const text = (
    payload.output_text ??
    payload.output?.flatMap((o) => o.content ?? []).filter((c) => c?.type === "output_text").map((c) => c.text ?? "").join("\n") ??
    ""
  ).trim();

  console.info("[one-voice][server] OpenAI response text", { text });
  if (!text) {
    console.info("[one-voice][server] OpenAI returned empty text content.");
    return [];
  }

  const labels = parseClaudeLabelJson(text);
  console.info("[one-voice][server] OpenAI labels parsed", { count: labels.length, labels });
  return labels;
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

async function walkVisualizationFiles(dirPath: string, urlPrefix = ""): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const nextFsPath = join(dirPath, entry.name);
    const nextUrlPath = urlPrefix ? `${urlPrefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const nested = await walkVisualizationFiles(nextFsPath, nextUrlPath);
      paths.push(...nested);
      continue;
    }

    if (entry.isFile()) {
      paths.push(nextUrlPath);
    }
  }

  return paths;
}

async function listVisualizationFiles(): Promise<string[]> {
  const files = await walkVisualizationFiles(VISUALIZATIONS_DIR);
  return files.sort(compareVisualizationPaths);
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

    if (pathname === "/api/one-voice-labels" && req.method === "POST") {
      let payload: unknown;
      try {
        payload = await req.json();
      } catch {
        return badRequest("Expected JSON body.");
      }

      const entry = normalizeLabelInput((payload as { entry?: unknown })?.entry);
      if (!entry) return badRequest("A non-empty entry field is required.");

      try {
        const claudeLabels = await generateClaudeLabels(entry);
        if (claudeLabels.length) {
          return Response.json({ labels: claudeLabels, provider: "claude" }, { headers: apiHeaders("no-store") });
        }

        const geminiLabels = await generateGeminiLabels(entry);
        if (geminiLabels.length) {
          return Response.json({ labels: geminiLabels, provider: "gemini" }, { headers: apiHeaders("no-store") });
        }

        const openaiLabels = await generateOpenAILabels(entry);
        if (openaiLabels.length) {
          return Response.json({ labels: openaiLabels, provider: "openai" }, { headers: apiHeaders("no-store") });
        }

        return Response.json({ labels: [], provider: "none" }, { headers: apiHeaders("no-store") });
      } catch (err) {
        console.warn("[one-voice][server] Label generation failed across providers.", { err });
        return Response.json({ labels: [], provider: "error" }, { status: 502, headers: apiHeaders("no-store") });
      }
    }

    if (pathname === "/api/one-voice-latest-entry" && req.method === "GET") {
      try {
        const latest = await fetchDearCongressLatestEntryId();
        if (!latest) {
          return Response.json({ error: "latest entry not found" }, { status: 404, headers: apiHeaders("no-store") });
        }
        return Response.json(latest, { headers: apiHeaders("no-store") });
      } catch {
        return Response.json({ error: "latest entry lookup failed" }, { status: 502, headers: apiHeaders("no-store") });
      }
    }

    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    if (pathname === "/") {
      return (
        (await serveFile(req, "/mueseum-mode/index.html")) ??
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
        : ((await serveFile(req, "/mueseum-mode/index.html")) ??
          (await serveFile(req, "/index.html")) ??
          (await serveFile(req, "/petal-wind.html")) ??
          new Response("Not found", { status: 404 })))
    );
  },
});

const anthropicKeyPreview = process.env.ANTHROPIC_API_KEY
  ? `${process.env.ANTHROPIC_API_KEY.slice(0, 7)}… (${process.env.ANTHROPIC_API_KEY.length} chars)`
  : "missing";
const geminiKeyPreview = process.env.GEMINI_API_KEY
  ? `${process.env.GEMINI_API_KEY.slice(0, 7)}… (${process.env.GEMINI_API_KEY.length} chars)`
  : "missing";
const openaiKeyPreview = process.env.OPENAI_API_KEY
  ? `${process.env.OPENAI_API_KEY.slice(0, 7)}… (${process.env.OPENAI_API_KEY.length} chars)`
  : "missing";
console.log(`[one-voice][server] ANTHROPIC_API_KEY: ${anthropicKeyPreview}`);
console.log(`[one-voice][server] GEMINI_API_KEY: ${geminiKeyPreview}`);
console.log(`[one-voice][server] OPENAI_API_KEY: ${openaiKeyPreview}`);
console.log(`Petal Wind listening on http://${server.hostname}:${server.port}`);
