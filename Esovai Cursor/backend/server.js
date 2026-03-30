import express from "express";
import OpenAI from "openai";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

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

// Rate Limit
function safeKeyGenerator(req) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  return ip.startsWith("::ffff:") ? ip.substring(7) : ip; // IPv4-mapped IPv6 → reine IPv4
}

app.use("/api/chat", rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: safeKeyGenerator,
}));

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
app.use("/api/flashcards", rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: safeKeyGenerator }));

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

app.listen(process.env.PORT || 3010, () =>
  console.log(`✓ Backend | Default-Provider: ${DEFAULT_PROVIDER} | Model: ${PROVIDER_REGISTRY[DEFAULT_PROVIDER].getModel()}`)
);
