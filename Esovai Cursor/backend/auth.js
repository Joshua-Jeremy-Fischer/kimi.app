import express from "express";
import crypto from "crypto";

// ── Crypto helpers (AES-256-GCM) ──────────────────────────
function deriveKey() {
  const hex = process.env.ENCRYPTION_KEY || "";
  if (hex.length !== 64) throw new Error("ENCRYPTION_KEY muss 64 Hex-Zeichen sein (openssl rand -hex 32)");
  return Buffer.from(hex, "hex");
}

function encrypt(text) {
  const key    = deriveKey();
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc    = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decrypt(stored) {
  const [ivHex, tagHex, encHex] = stored.split(":");
  const key      = deriveKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

// ── In-memory Token Store ──────────────────────────────────
const tokenStore = {
  githubToken:       null,
  copilotToken:      null,
  copilotExpiresAt:  null,
};

// ── OAuth State Map (CSRF protection) ─────────────────────
const pendingStates = new Map();

function cleanStates() {
  const now = Date.now();
  for (const [state, ts] of pendingStates) {
    if (now - ts > 10 * 60 * 1000) pendingStates.delete(state);
  }
}

// ── Router ─────────────────────────────────────────────────
export function createAuthRouter() {
  const router = express.Router();

  // GET /auth/copilot/start — GitHub OAuth for Copilot (separate from user OAuth)
  router.get("/copilot/start", (req, res) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) return res.status(503).json({ error: "GITHUB_CLIENT_ID nicht konfiguriert" });

    cleanStates();
    const state = crypto.randomBytes(16).toString("hex");
    pendingStates.set(state, Date.now());

    const params = new URLSearchParams({ client_id: clientId, scope: "read:user", state });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  // GET /auth/status — Provider connection status
  router.get("/status", (_req, res) => {
    res.json({
      github:  !!tokenStore.githubToken,
      copilot: !!tokenStore.copilotToken && new Date(tokenStore.copilotExpiresAt) > new Date(),
    });
  });

  // GET /auth/copilot/token — Get/refresh Copilot session token
  router.get("/copilot/token", async (req, res) => {
    if (!tokenStore.githubToken) {
      return res.status(401).json({ error: "Nicht authentifiziert — /auth/copilot/start aufrufen" });
    }

    if (tokenStore.copilotToken && tokenStore.copilotExpiresAt) {
      if (new Date(tokenStore.copilotExpiresAt) > new Date(Date.now() + 60_000)) {
        return res.json({ token: decrypt(tokenStore.copilotToken), expiresAt: tokenStore.copilotExpiresAt });
      }
    }

    try {
      const githubToken = decrypt(tokenStore.githubToken);
      const copilotRes  = await fetch("https://api.github.com/copilot_internal/v2/token", {
        headers: {
          "Authorization":         `token ${githubToken}`,
          "Accept":                "application/json",
          "Editor-Version":        "vscode/1.90.0",
          "Editor-Plugin-Version": "copilot/1.200.0",
          "User-Agent":            "GithubCopilot/1.200.0",
        },
      });

      if (!copilotRes.ok) {
        const err = await copilotRes.json().catch(() => ({}));
        return res.status(copilotRes.status).json({ error: err.message || "Copilot-Token-Anfrage fehlgeschlagen" });
      }

      const data         = await copilotRes.json();
      const expiresAt    = new Date(data.expires_at * 1000).toISOString();
      tokenStore.copilotToken     = encrypt(data.token);
      tokenStore.copilotExpiresAt = expiresAt;
      process.env.COPILOT_TOKEN   = data.token;

      res.json({ token: data.token, expiresAt });
    } catch (err) {
      console.error("Copilot token error:", err.message);
      res.status(500).json({ error: "Interner Fehler beim Abrufen des Copilot-Tokens" });
    }
  });

  // Handle OAuth callback for Copilot auth (state matches pending Copilot states)
  router.get("/github/copilot-callback", async (req, res) => {
    const { code, state } = req.query;
    if (!state || !pendingStates.has(state)) {
      return res.status(400).json({ error: "Ungültiger OAuth-State" });
    }
    pendingStates.delete(state);
    if (!code) return res.status(400).json({ error: "code fehlt" });

    const clientId     = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) return res.status(503).json({ error: "GitHub OAuth nicht konfiguriert" });
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
      return res.status(503).json({ error: "ENCRYPTION_KEY nicht konfiguriert" });
    }

    try {
      const tokenRes  = await fetch("https://github.com/login/oauth/access_token", {
        method:  "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body:    JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      });
      const tokenData = await tokenRes.json();
      if (tokenData.error || !tokenData.access_token) {
        return res.status(400).json({ error: tokenData.error_description || "Token-Austausch fehlgeschlagen" });
      }

      tokenStore.githubToken      = encrypt(tokenData.access_token);
      tokenStore.copilotToken     = null;
      tokenStore.copilotExpiresAt = null;

      res.redirect(`${process.env.FRONTEND_ORIGIN || "/"}?auth=copilot_connected`);
    } catch (err) {
      console.error("Copilot callback error:", err.message);
      res.status(500).json({ error: "Interner Fehler" });
    }
  });

  // DELETE /auth/copilot — disconnect
  router.delete("/copilot", (_req, res) => {
    tokenStore.githubToken       = null;
    tokenStore.copilotToken      = null;
    tokenStore.copilotExpiresAt  = null;
    process.env.COPILOT_TOKEN    = "";
    res.json({ ok: true });
  });

  return router;
}
