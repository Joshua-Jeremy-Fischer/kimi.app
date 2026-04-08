import express from "express";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.AGENT_PORT || 3020);
const ROOT = process.env.SANDBOX_ROOT || "/workspace";

const BEARER_TOKEN = (process.env.ESO_BOT_TOKEN || "").trim();
const INSECURE_NO_AUTH = process.env.ESO_BOT_INSECURE_NO_AUTH === "true";

function timingSafeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAuth(req, res, next) {
  if (INSECURE_NO_AUTH && !BEARER_TOKEN) return next();
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token || !BEARER_TOKEN || !timingSafeCompare(token, BEARER_TOKEN)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

function resolveInsideRoot(p) {
  const raw = String(p || "");
  const abs = raw.startsWith("/") ? raw : path.join(ROOT, raw);
  const normalized = path.resolve(abs);
  const rootNorm = path.resolve(ROOT);
  if (normalized !== rootNorm && !normalized.startsWith(rootNorm + path.sep)) {
    throw new Error("Path escapes SANDBOX_ROOT");
  }
  return normalized;
}

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "eso-bot" }));

// All tool endpoints require auth.
app.use(requireAuth);

app.post("/tools/web_fetch", async (req, res) => {
  if (process.env.ALLOW_WEB === "false") return res.status(403).json({ error: "Web disabled" });
  const url = req.body?.url;
  if (typeof url !== "string" || !url) return res.status(400).json({ error: "url missing" });
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  return res.json({ status: r.status, content: text.slice(0, 20000) });
});

app.post("/tools/read_file", async (req, res) => {
  if (process.env.ALLOW_FILES === "false") return res.status(403).json({ error: "Files disabled" });
  const p = resolveInsideRoot(req.body?.path);
  const content = await fs.readFile(p, "utf8");
  return res.json({ path: p, content: content.slice(0, 50000) });
});

app.post("/tools/write_file", async (req, res) => {
  if (process.env.ALLOW_FILES === "false") return res.status(403).json({ error: "Files disabled" });
  const p = resolveInsideRoot(req.body?.path);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, String(req.body?.content ?? ""), "utf8");
  return res.json({ ok: true, path: p });
});

app.post("/tools/list_files", async (req, res) => {
  if (process.env.ALLOW_FILES === "false") return res.status(403).json({ error: "Files disabled" });
  const p = resolveInsideRoot(req.body?.path || ".");
  const entries = await fs.readdir(p, { withFileTypes: true });
  return res.json({
    path: p,
    files: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })),
  });
});

app.post("/tools/bash", async (req, res) => {
  if (process.env.ALLOW_SHELL !== "true") return res.status(403).json({ error: "Shell disabled" });
  const command = String(req.body?.command ?? "").trim();
  if (!command) return res.status(400).json({ error: "command missing" });
  // Use sh -lc for typical tool-like behavior; keep cwd within sandbox root.
  const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], {
    cwd: ROOT,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return res.json({ stdout: String(stdout).slice(0, 8000), stderr: String(stderr).slice(0, 2000) });
});

app.listen(PORT, () => {
  console.log(`✓ eso-bot listening on :${PORT} (root=${ROOT})`);
});

