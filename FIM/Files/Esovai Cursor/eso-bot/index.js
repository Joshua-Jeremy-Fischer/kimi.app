import express from "express";
import crypto from "crypto";
import { runAgentLoop } from "./agent.js";
import { getPermissions, getCeiling, setPermissions } from "./permissions.js";

const app  = express();
const PORT = process.env.AGENT_PORT || 3020;

// Internes Bearer-Token (nur Backend darf eso-bot direkt ansprechen)
const BEARER_TOKEN = process.env.ESO_BOT_TOKEN || "";

app.use(express.json({ limit: "10mb" }));

// ── Auth Guard ────────────────────────────────────────────────
function timingSafeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) { crypto.timingSafeEqual(bufA, bufA); return false; }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAuth(req, res, next) {
  if (!BEARER_TOKEN) return next(); // kein Token konfiguriert = nur interne Docker-Nutzung
  const token = req.headers["authorization"]?.replace("Bearer ", "") ?? "";
  if (!token || !timingSafeCompare(token, BEARER_TOKEN)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── Health (öffentlich, kein Auth) ───────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, service: "eso-bot" }));

// ── Auth auf allen anderen Routes ────────────────────────────
app.use(requireAuth);

// ── Permissions: GET ─────────────────────────────────────────
app.get("/permissions", (_req, res) => {
  res.json({ current: getPermissions(), ceiling: getCeiling() });
});

// ── Permissions: SET (live, respektiert Env-Ceiling) ─────────
app.post("/permissions", (req, res) => {
  const updated = setPermissions(req.body);
  res.json({ ok: true, permissions: updated, ceiling: getCeiling() });
});

// ── Task ausführen ────────────────────────────────────────────
app.post("/task", async (req, res) => {
  const { messages, system, maxIterations, model } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages[] fehlt oder leer" });
  }

  console.log(`[ESO-BOT] Neuer Task | Permissions:`, getPermissions());

  try {
    const result = await runAgentLoop({ messages, system, maxIterations, model });
    res.json(result);
  } catch (err) {
    console.error("[ESO-BOT] Fehler:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  const perms = getPermissions();
  const ceil  = getCeiling();
  console.log(`
  ███████╗███████╗ ██████╗       ██████╗  ██████╗ ████████╗
  ██╔════╝██╔════╝██╔═══██╗      ██╔══██╗██╔═══██╗╚══██╔══╝
  █████╗  ███████╗██║   ██║      ██████╔╝██║   ██║   ██║
  ██╔══╝  ╚════██║██║   ██║      ██╔══██╗██║   ██║   ██║
  ███████╗███████║╚██████╔╝      ██████╔╝╚██████╔╝   ██║
  ╚══════╝╚══════╝ ╚═════╝       ╚═════╝  ╚═════╝    ╚═╝
  `);
  console.log(`✓ Eso Bot läuft auf Port ${PORT}`);
  console.log(`  Auth:  ${BEARER_TOKEN ? "🔐 Token aktiv" : "⚠️  Kein Token (nur Docker-intern)"}`);
  console.log(`  Shell: ${perms.shell ? "✅ ON" : "🔴 OFF"} (Ceiling: ${ceil.shell ? "erlaubt" : "gesperrt"})`);
  console.log(`  Web:   ${perms.web   ? "✅ ON" : "🔴 OFF"} (Ceiling: ${ceil.web   ? "erlaubt" : "gesperrt"})`);
  console.log(`  Files: ${perms.files ? "✅ ON" : "🔴 OFF"} (Ceiling: ${ceil.files ? "erlaubt" : "gesperrt"})`);
  console.log(`  Git:   ${perms.git   ? "✅ ON" : "🔴 OFF"} (Ceiling: ${ceil.git   ? "erlaubt" : "gesperrt"})`);
});
