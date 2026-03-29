import express from "express";
import { runAgentLoop } from "./agent.js";
import { getPermissions, setPermissions } from "./permissions.js";

const app  = express();
const PORT = process.env.AGENT_PORT || 3020;

app.use(express.json({ limit: "10mb" }));

// ── Health ────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, service: "eso-bot" }));

// ── Permissions: GET ─────────────────────────────────────────
app.get("/permissions", (_req, res) => {
  res.json(getPermissions());
});

// ── Permissions: SET (live, kein Neustart) ───────────────────
app.post("/permissions", (req, res) => {
  const updated = setPermissions(req.body);
  res.json({ ok: true, permissions: updated });
});

// ── Task ausführen ────────────────────────────────────────────
// POST /task  { messages, system?, maxIterations?, model? }
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
  console.log(`
  ███████╗███████╗ ██████╗       ██████╗  ██████╗ ████████╗
  ██╔════╝██╔════╝██╔═══██╗      ██╔══██╗██╔═══██╗╚══██╔══╝
  █████╗  ███████╗██║   ██║      ██████╔╝██║   ██║   ██║
  ██╔══╝  ╚════██║██║   ██║      ██╔══██╗██║   ██║   ██║
  ███████╗███████║╚██████╔╝      ██████╔╝╚██████╔╝   ██║
  ╚══════╝╚══════╝ ╚═════╝       ╚═════╝  ╚═════╝    ╚═╝
  `);
  console.log(`✓ Eso Bot läuft auf Port ${PORT}`);
  console.log(`  Shell: ${perms.shell ? "✅ ON" : "🔴 OFF"}`);
  console.log(`  Web:   ${perms.web   ? "✅ ON" : "🔴 OFF"}`);
  console.log(`  Files: ${perms.files ? "✅ ON" : "🔴 OFF"}`);
  console.log(`  Git:   ${perms.git   ? "✅ ON" : "🔴 OFF"}`);
});
