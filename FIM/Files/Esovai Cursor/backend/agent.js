import express from "express";

const ESO_BOT_BASE = process.env.AGENT_BASE_URL || "http://eso-bot:3020";

export function createAgentRouter() {
  const router = express.Router();

  // POST /api/agent — Task an Eso Bot übergeben
  router.post("/", async (req, res) => {
    const { messages, system, maxIterations, model } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages[] fehlt oder leer" });
    }

    try {
      const response = await fetch(`${ESO_BOT_BASE}/task`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ messages, system, maxIterations, model }),
        signal:  AbortSignal.timeout(120_000), // 2 Minuten max
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return res.status(response.status).json({ error: err.error || "Eso Bot Fehler" });
      }

      res.json(await response.json());
    } catch (err) {
      console.error("[AGENT PROXY]", err.message);
      res.status(502).json({ error: "Eso Bot nicht erreichbar" });
    }
  });

  // GET /api/agent/permissions — aktuelle Permissions lesen
  router.get("/permissions", async (_req, res) => {
    try {
      const response = await fetch(`${ESO_BOT_BASE}/permissions`);
      res.json(await response.json());
    } catch (err) {
      res.status(502).json({ error: "Eso Bot nicht erreichbar" });
    }
  });

  // POST /api/agent/permissions — Permissions live ändern
  router.post("/permissions", async (req, res) => {
    try {
      const response = await fetch(`${ESO_BOT_BASE}/permissions`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(req.body),
      });
      res.json(await response.json());
    } catch (err) {
      res.status(502).json({ error: "Eso Bot nicht erreichbar" });
    }
  });

  return router;
}
