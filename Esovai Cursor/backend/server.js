import express from "express";
import OpenAI from "openai";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import { createAgentRouter } from "./agent.js";
import { createAuthRouter } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Provider Registry ─────────────────────────────────────
// ollama  = default (self-hosted, no API key needed)
// opencode-go = Mitglied-Option (requires OPENCODE_API_KEY)
// nvidia  = optional cloud fallback (requires NVIDIA_API_KEY)
const PROVIDER_REGISTRY = {
  ollama: {
    getApiKey: () => "ollama",
    baseURL: "http://ollama:11434/v1",
    getModel: () => process.env.OLLAMA_MODEL || "kimi-k2.5:cloud",
    requiresEnv: null,
  },
  "opencode-go": {
    getApiKey: () => process.env.OPENCODE_API_KEY,
    baseURL: process.env.OPENCODE_BASE_URL || "https://api.opencode.ai/v1",
    getModel: () => process.env.OPENCODE_MODEL || "kimi-k2.5",
    requiresEnv: "OPENCODE_API_KEY",
  },
  nvidia: {
    getApiKey: () => process.env.NVIDIA_API_KEY,
    baseURL: "https://integrate.api.nvidia.com/v1",
    getModel: () => process.env.NVIDIA_MODEL || "moonshotai/kimi-k2-instruct-0905",
    requiresEnv: "NVIDIA_API_KEY",
  },
};

const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || "ollama";

// ── Startup Env-Check ─────────────────────────────────────
const REQUIRED_ENV = ["ALLOWED_TOKEN", "FRONTEND_ORIGIN"];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: "${key}" fehlt in .env — Server startet nicht.`);
    process.exit(1);
  }
}

if (!(DEFAULT_PROVIDER in PROVIDER_REGISTRY)) {
  console.error(`FATAL: DEFAULT_PROVIDER="${DEFAULT_PROVIDER}" nicht in Registry.`);
  process.exit(1);
}

// ── FIM-Check ─────────────────────────────────────────────
const HASHES_FILE = path.join(__dirname, ".fim_hashes.json");

function fimCheck() {
  if (!fs.existsSync(HASHES_FILE)) {
    console.error("FIM FATAL: .fim_hashes.json fehlt — Server stoppt.");
    process.exit(1);
  }
  const known = JSON.parse(fs.readFileSync(HASHES_FILE));
  for (const [file, expectedHash] of Object.entries(known)) {
    const full = path.join(__dirname, file);
    let actual;
    try {
      actual = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    } catch {
      console.error(`FIM FATAL: ${file} nicht lesbar — Server stoppt.`);
      process.exit(1);
    }
    if (actual !== expectedHash) {
      console.error(`FIM FAIL: ${file} wurde verändert! Server stoppt.`);
      process.exit(1);
    }
  }
  console.log("FIM: OK ✓");
}

fimCheck();

// ── SQLite + JWT Setup ─────────────────────────────────────
const DB_PATH = process.env.DB_PATH || "/data/kimi.db";
const JWT_SECRET = process.env.JWT_SECRET || null;
const GH_CLIENT_ID = process.env.GITHUB_CLIENT_ID || null;
const GH_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || null;

let db = null;
if (JWT_SECRET) {
  try {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        github_id TEXT UNIQUE NOT NULL,
        username TEXT,
        avatar_url TEXT,
        email TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    console.log("SQLite: OK ✓");
  } catch (e) {
    console.warn("SQLite init failed:", e.message, "— sessions disabled");
    db = null;
  }
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, avatar_url: user.avatar_url },
    JWT_SECRET,
    { expiresIn: "90d" }
  );
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// ── Express ───────────────────────────────────────────────
const app = express();

app.set("trust proxy", 1); // Cloudflare Tunnel → korrekte Client-IP für Rate Limiting
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN }));
app.use(express.json({ limit: "10mb" }));

// Health — VOR Auth (Wazuh/Monitoring kann pollen ohne Token)
app.get("/health", (_req, res) =>
  res.json({ status: "ok" }) // kein provider/model nach außen
);

// ── GitHub OAuth — VOR Auth-Guard (kein Bearer-Token von GitHub) ──
app.get("/auth/github", (req, res) => {
  if (!GH_CLIENT_ID) return res.status(503).json({ error: "GitHub OAuth nicht konfiguriert" });
  const redirect_uri = `${process.env.FRONTEND_ORIGIN}/auth/github/callback`;
  res.redirect(
    `https://github.com/login/oauth/authorize?client_id=${GH_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirect_uri)}&scope=user:email`
  );
});

app.get("/auth/github/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect(`${process.env.FRONTEND_ORIGIN}/?auth_error=missing_code`);
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: GH_CLIENT_ID, client_secret: GH_CLIENT_SECRET, code }),
    });
    const { access_token, error } = await tokenRes.json();
    if (!access_token || error) return res.redirect(`${process.env.FRONTEND_ORIGIN}/?auth_error=${error || "no_token"}`);

    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${access_token}`, "User-Agent": "kimi-app" },
    });
    const ghUser = await userRes.json();
    if (!db) return res.redirect(`${process.env.FRONTEND_ORIGIN}/?auth_error=db_unavailable`);

    const userId = `gh_${ghUser.id}`;
    db.prepare(`
      INSERT INTO users (id, github_id, username, avatar_url, email)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(github_id) DO UPDATE SET username=excluded.username, avatar_url=excluded.avatar_url, email=excluded.email
    `).run(userId, String(ghUser.id), ghUser.login, ghUser.avatar_url || "", ghUser.email || "");

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    const token = signToken(user);
    res.redirect(`${process.env.FRONTEND_ORIGIN}/?auth_token=${token}`);
  } catch (e) {
    console.error("GitHub OAuth error:", e.message);
    res.redirect(`${process.env.FRONTEND_ORIGIN}/?auth_error=server_error`);
  }
});

app.get("/auth/me", (req, res) => {
  if (!JWT_SECRET || !db) return res.status(503).json({ error: "Auth nicht konfiguriert" });
  const token = req.headers["x-user-token"];
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: "Unauthorized" });
  const user = db.prepare("SELECT id, username, avatar_url FROM users WHERE id = ?").get(payload.sub);
  if (!user) return res.status(404).json({ error: "User nicht gefunden" });
  res.json(user);
});

// ── Provider Auth routes (Copilot, etc.) — VOR Auth-Guard ────
app.use("/auth", createAuthRouter());

// Auth Guard — timing-safe Vergleich (verhindert Timing-Angriffe)
function timingSafeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // gleiche Zeit, false zurück
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

app.use((req, res, next) => {
  const token = req.headers["authorization"]?.replace("Bearer ", "") ?? "";
  if (!token || !timingSafeCompare(token, process.env.ALLOWED_TOKEN)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Rate Limit — kein eigener keyGenerator: Default in express-rate-limit ≥8 ist IPv6-/::ffff:-sicher
// (manueller req.ip-Key löst ERR_ERL_KEY_GEN_IPV6 aus)
app.use("/api/chat", rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Agent Endpoint (Shell / Web / File / Git — Permissions via toggles)
app.use("/api/agent", createAgentRouter());

// Providers-Endpoint — zeigt verfügbare Provider (ohne API-Keys)
app.get("/api/providers", (_req, res) => {
  const available = Object.entries(PROVIDER_REGISTRY)
    .filter(([, cfg]) => !cfg.requiresEnv || process.env[cfg.requiresEnv])
    .map(([name, cfg]) => ({ name, model: cfg.getModel(), isDefault: name === DEFAULT_PROVIDER }));
  res.json({ providers: available, default: DEFAULT_PROVIDER });
});

// ── Helper: resolve provider from request ─────────────────
function resolveProvider(req) {
  // Frontend sends X-Provider header; body.provider as fallback
  const requested = req.headers["x-provider"] ?? req.body.provider ?? DEFAULT_PROVIDER;
  const name = (requested in PROVIDER_REGISTRY) ? requested : DEFAULT_PROVIDER;
  return { name, cfg: PROVIDER_REGISTRY[name] };
}

// Chat Endpoint
app.post("/api/chat", async (req, res) => {
  const { messages, system } = req.body;
  const max_tokens = Math.min(req.body.max_tokens ?? 1000, 4000);

  const { name: providerName, cfg: providerCfg } = resolveProvider(req);

  if (providerCfg.requiresEnv && !process.env[providerCfg.requiresEnv]) {
    return res.status(503).json({ error: `Provider "${providerName}" nicht konfiguriert.` });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages[] fehlt oder leer" });
  }
  for (const m of messages) {
    if (!m.role || typeof m.content !== "string") {
      return res.status(400).json({ error: "Ungültiges messages-Format" });
    }
  }

  // X-Model header überschreibt Registry-Default
  const model = req.headers["x-model"] ?? req.body.model ?? providerCfg.getModel();

  const client = new OpenAI({ apiKey: providerCfg.getApiKey(), baseURL: providerCfg.baseURL });

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        system ? { role: "system", content: system } : null,
        ...messages,
      ].filter(Boolean),
      max_tokens,
    });

    res.json({
      content: response.choices[0].message.content,
      usage: response.usage,
      provider: providerName,
      model,
    });
  } catch (err) {
    console.error(`LLM Error [${providerName}/${model}]:`, err.message);
    res.status(500).json({ error: err.message || "Interner Fehler" });
  }
});

// ── Flashcards Endpoint ───────────────────────────────────
app.use("/api/flashcards", rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false }));

app.post("/api/flashcards", async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text fehlt", cards: [] });

  const cfg = PROVIDER_REGISTRY[DEFAULT_PROVIDER];
  const client = new OpenAI({ apiKey: cfg.getApiKey(), baseURL: cfg.baseURL });

  try {
    const response = await client.chat.completions.create({
      model: cfg.getModel(),
      messages: [{
        role: "user",
        content: `Erstelle aus dem folgenden Text Lernkarteikarten als Frage/Antwort-Paare. Antworte NUR mit validem JSON, kein Text davor oder danach:\n{"cards":[{"question":"...","answer":"..."}]}\n\nText:\n${text.slice(0, 4000)}`,
      }],
      max_tokens: 2000,
    });

    const raw = response.choices[0].message.content || "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: "KI hat kein JSON geliefert", cards: [] });

    const data = JSON.parse(match[0]);
    res.json({ cards: Array.isArray(data.cards) ? data.cards : [] });
  } catch (err) {
    console.error("Flashcards Error:", err.message);
    res.status(500).json({ error: err.message, cards: [] });
  }
});

// ── GitHub Copilot OAuth Device-Flow Proxy ────────────────
const COPILOT_CLIENT_ID = process.env.GITHUB_COPILOT_CLIENT_ID || "Iv1.b507a08c87ecfe98";

app.post("/api/copilot-auth", async (req, res) => {
  const { action, device_code } = req.body;
  try {
    if (action === "start") {
      const r = await fetch("https://github.com/login/device/code", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: "copilot" }),
      });
      res.json(await r.json());
    } else if (action === "poll") {
      if (!device_code) return res.status(400).json({ error: "device_code fehlt" });
      const r = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: COPILOT_CLIENT_ID,
          device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      res.json(await r.json());
    } else {
      res.status(400).json({ error: "Unbekannte action" });
    }
  } catch (err) {
    console.error("Copilot OAuth Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Chat Persistence ──────────────────────────────────────
app.get("/api/chats", (req, res) => {
  if (!db || !JWT_SECRET) return res.json({ chats: [] });
  const payload = verifyToken(req.headers["x-user-token"] || "");
  if (!payload) return res.status(401).json({ error: "Unauthorized" });
  const rows = db.prepare("SELECT data FROM chats WHERE user_id = ? ORDER BY updated_at DESC").all(payload.sub);
  res.json({ chats: rows.map(r => JSON.parse(r.data)) });
});

app.post("/api/chats/sync", (req, res) => {
  if (!db || !JWT_SECRET) return res.json({ ok: true });
  const payload = verifyToken(req.headers["x-user-token"] || "");
  if (!payload) return res.status(401).json({ error: "Unauthorized" });
  const { chats } = req.body;
  if (!Array.isArray(chats)) return res.status(400).json({ error: "chats[] fehlt" });

  const upsert = db.prepare(`
    INSERT INTO chats (id, user_id, data, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at
  `);
  const sync = db.transaction((userId, chats) => {
    // Delete chats no longer in the list
    const ids = chats.map(c => c.id);
    if (ids.length > 0) {
      db.prepare(`DELETE FROM chats WHERE user_id = ? AND id NOT IN (${ids.map(() => "?").join(",")})`)
        .run(userId, ...ids);
    } else {
      db.prepare("DELETE FROM chats WHERE user_id = ?").run(userId);
    }
    for (const chat of chats.slice(0, 500)) {
      const safe = { ...chat, messages: (chat.messages || []).slice(-200) };
      upsert.run(chat.id, userId, JSON.stringify(safe));
    }
  });

  try {
    sync(payload.sub, chats);
    res.json({ ok: true, count: chats.length });
  } catch (e) {
    console.error("Chat sync error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 3010, () =>
  console.log(`✓ Backend | Default-Provider: ${DEFAULT_PROVIDER} | Model: ${PROVIDER_REGISTRY[DEFAULT_PROVIDER].getModel()}`)
);
