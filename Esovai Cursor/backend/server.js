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

// ── Startup Env-Check ─────────────────────────────────────
const PROVIDER = process.env.LLM_PROVIDER || "nvidia";

const REQUIRED_ENV = ["ALLOWED_TOKEN", "FRONTEND_ORIGIN"];
if (PROVIDER === "nvidia") REQUIRED_ENV.push("NVIDIA_API_KEY"); // nur bei nvidia nötig

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: "${key}" fehlt in .env — Server startet nicht.`);
    process.exit(1);
  }
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

fimCheck(); // ← wird aufgerufen

// ── Provider Setup ────────────────────────────────────────
const client = new OpenAI({
  apiKey: PROVIDER === "nvidia" ? process.env.NVIDIA_API_KEY : "ollama",
  baseURL: PROVIDER === "nvidia"
    ? "https://integrate.api.nvidia.com/v1"
    : "http://ollama:11434/v1",
});

const MODEL = PROVIDER === "nvidia"
  ? (process.env.NVIDIA_MODEL || "moonshotai/kimi-k2-instruct-0905")
  : (process.env.OLLAMA_MODEL || "llama3.1:8b");

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

// Rate Limit — CVE-2026-30827 Fix: safeKeyGenerator
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

// Chat Endpoint
app.post("/api/chat", async (req, res) => {
  const { messages, system } = req.body;
  const max_tokens = Math.min(req.body.max_tokens ?? 1000, 4000);

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages[] fehlt oder leer" });
  }
  for (const m of messages) {
    if (!m.role || typeof m.content !== "string") {
      return res.status(400).json({ error: "Ungültiges messages-Format" });
    }
  }

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        system ? { role: "system", content: system } : null,
        ...messages,
      ].filter(Boolean),
      max_tokens,
    });

    res.json({
      content: response.choices[0].message.content,
      usage: response.usage,
    });
  } catch (err) {
    console.error("LLM Error:", err.message);
    res.status(500).json({ error: "Interner Fehler" });
  }
});

app.listen(process.env.PORT || 3010, () =>
  console.log(`✓ Backend | Provider: ${PROVIDER} | Model: ${MODEL}`)
);
