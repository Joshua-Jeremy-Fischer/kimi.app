import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import OpenAI from "openai";
import { startJobCrawler, crawlJobs, getJobResults } from "./job-crawler.js";

const execAsync = promisify(exec);

// ── Agent Inbox ────────────────────────────────────────────
const INBOX_FILE = "/data/agent-inbox.json";

async function readInbox() {
  try { return JSON.parse(await fs.readFile(INBOX_FILE, "utf8")); } catch { return []; }
}

async function writeInbox(messages) {
  await fs.writeFile(INBOX_FILE, JSON.stringify(messages.slice(-200)));
}

export async function addInboxMessage(role, content) {
  const messages = await readInbox();
  messages.push({ id: Date.now() + Math.random(), role, content, timestamp: Date.now() });
  await writeInbox(messages);
}

// ── Postfach (cron job notifications, email-style) ─────────
const POSTFACH_FILE = "/data/agent-postfach.json";

async function readPostfach() {
  try { return JSON.parse(await fs.readFile(POSTFACH_FILE, "utf8")); } catch { return []; }
}

async function writePostfach(entries) {
  await fs.writeFile(POSTFACH_FILE, JSON.stringify(entries.slice(-100)));
}

export async function addPostfachEntry(title, content, type = "info") {
  const entries = await readPostfach();
  entries.unshift({ id: Date.now() + Math.random(), title, content, type, timestamp: Date.now(), read: false });
  await writePostfach(entries);
}

// ── Permissions (persistent in /data/permissions.json) ────
const PERMS_FILE = "/data/permissions.json";
const perms = { shell: false, web: false, fileSystem: false, git: false };

async function loadPerms() {
  try {
    const raw = await fs.readFile(PERMS_FILE, "utf8");
    const saved = JSON.parse(raw);
    for (const key of ["shell", "web", "fileSystem", "git"]) {
      if (typeof saved[key] === "boolean") perms[key] = saved[key];
    }
    console.log("[Perms] Geladen:", JSON.stringify(perms));
  } catch { /* Datei existiert noch nicht — defaults bleiben */ }
}

async function savePerms() {
  try { await fs.writeFile(PERMS_FILE, JSON.stringify(perms)); } catch {}
}

// ── LLM Client (mirrors server.js provider logic) ─────────
function makeLLMClient(overrideModel) {
  const provider = process.env.DEFAULT_PROVIDER || "ollama";
  let apiKey, baseURL, model;

  if (provider === "opencode-go" && process.env.OPENCODE_API_KEY) {
    apiKey  = process.env.OPENCODE_API_KEY;
    baseURL = process.env.OPENCODE_BASE_URL || "https://api.opencode.ai/v1";
    model   = process.env.OPENCODE_MODEL    || "kimi-k2.5";
  } else if (provider === "nvidia" && process.env.NVIDIA_API_KEY) {
    apiKey  = process.env.NVIDIA_API_KEY;
    baseURL = "https://integrate.api.nvidia.com/v1";
    model   = process.env.NVIDIA_MODEL || "moonshotai/kimi-k2-instruct-0905";
  } else {
    apiKey  = "ollama";
    baseURL = "http://ollama:11434/v1";
    model   = process.env.OLLAMA_MODEL || "kimi-k2.5:cloud";
  }

  return { client: new OpenAI({ apiKey, baseURL }), model: overrideModel || model };
}

// ── Web Search Provider Store ──────────────────────────────
// "auto" = Fallback-Kette, oder explizit: "tavily"|"serper"|"brave"|"duckduckgo"
let preferredSearchProvider = process.env.SEARCH_PROVIDER || "auto";

async function webSearch(query, forceProvider) {
  const provider = forceProvider || preferredSearchProvider;

  async function tryTavily() {
    if (!process.env.TAVILY_API_KEY) return null;
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: 5 }),
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    if (!d.results?.length) return null;
    return { source: "tavily", results: d.results.map(x => ({ title: x.title, url: x.url, snippet: x.content?.slice(0, 500) })) };
  }

  async function trySerper() {
    if (!process.env.SERPER_API_KEY) return null;
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": process.env.SERPER_API_KEY },
      body: JSON.stringify({ q: query, num: 5 }),
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    if (!d.organic?.length) return null;
    return { source: "serper", results: d.organic.map(x => ({ title: x.title, url: x.link, snippet: x.snippet })) };
  }

  async function tryBrave() {
    if (!process.env.BRAVE_API_KEY) return null;
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", "5");
    url.searchParams.set("search_lang", "de");
    url.searchParams.set("country", "DE");
    const r = await fetch(url.toString(), {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": process.env.BRAVE_API_KEY.trim(),
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) { console.warn(`[Brave] ${r.status}:`, await r.text().catch(() => "")); return null; }
    const d = await r.json();
    if (!d.web?.results?.length) return null;
    return { source: "brave", results: d.web.results.map(x => ({ title: x.title, url: x.url, snippet: x.description })) };
  }

  async function tryDuckDuckGo() {
    const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    const results = [];
    if (d.AbstractText) results.push({ title: d.Heading, url: d.AbstractURL, snippet: d.AbstractText });
    for (const t of (d.RelatedTopics || []).slice(0, 4)) {
      if (t.FirstURL) results.push({ title: t.Text?.slice(0, 80), url: t.FirstURL, snippet: t.Text?.slice(0, 300) });
    }
    return results.length ? { source: "duckduckgo", results } : null;
  }

  const providers = { tavily: tryTavily, serper: trySerper, brave: tryBrave, duckduckgo: tryDuckDuckGo };

  // Expliziter Provider gewählt
  if (provider !== "auto" && providers[provider]) {
    try {
      const result = await providers[provider]();
      if (result) return result;
      return { error: `Provider "${provider}" hat keine Ergebnisse geliefert (Key vorhanden?)` };
    } catch (e) {
      return { error: `Provider "${provider}" Fehler: ${e.message}` };
    }
  }

  // Auto: Fallback-Kette
  for (const fn of [tryTavily, trySerper, tryBrave, tryDuckDuckGo]) {
    try { const r = await fn(); if (r) return r; } catch {}
  }
  return { error: "Alle Suchanbieter fehlgeschlagen" };
}

// ── Tool definitions ───────────────────────────────────────
const TOOLS = {
  shell: [{
    type: "function",
    function: {
      name: "bash",
      description: "Execute a bash shell command in the /data directory.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Bash command to execute" } },
        required: ["command"],
      },
    },
  }],
  web: [
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current information. Uses Tavily, Serper, Brave, or DuckDuckGo automatically.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Search query" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch the full content of a specific URL.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL to fetch" } },
          required: ["url"],
        },
      },
    },
  ],
  fileSystem: [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file's content.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "File path (relative paths resolve to /data/)" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write content to a file (creates or overwrites).",
        parameters: {
          type: "object",
          properties: {
            path:    { type: "string", description: "File path" },
            content: { type: "string", description: "Content to write" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and directories at a path.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Directory path (default: /data)" } },
        },
      },
    },
  ],
  git: [{
    type: "function",
    function: {
      name: "git_command",
      description: "Run a git command in the /data directory.",
      parameters: {
        type: "object",
        properties: { args: { type: "string", description: "Git arguments, e.g. 'status' or 'log --oneline -10'" } },
        required: ["args"],
      },
    },
  }],
};

// ── Tool executor ──────────────────────────────────────────
async function executeTool(name, args) {
  try {
    switch (name) {
      case "bash": {
        if (!perms.shell) return { error: "Shell permission not granted" };
        const { stdout, stderr } = await execAsync(args.command ?? "", {
          timeout: 30_000,
          cwd: "/data",
          maxBuffer: 2 * 1024 * 1024,
        });
        return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000) };
      }
      case "web_search": {
        if (!perms.web) return { error: "Web permission not granted" };
        return await webSearch(args.query ?? "");
      }
      case "web_fetch": {
        if (!perms.web) return { error: "Web permission not granted" };
        const r = await fetch(args.url, { signal: AbortSignal.timeout(15_000) });
        const text = await r.text();
        return { status: r.status, content: text.slice(0, 20_000) };
      }
      case "read_file": {
        if (!perms.fileSystem) return { error: "File system permission not granted" };
        const p = (args.path ?? "").startsWith("/") ? args.path : `/data/${args.path}`;
        const content = await fs.readFile(p, "utf8");
        return { content: content.slice(0, 50_000) };
      }
      case "write_file": {
        if (!perms.fileSystem) return { error: "File system permission not granted" };
        const p = (args.path ?? "").startsWith("/") ? args.path : `/data/${args.path}`;
        await fs.writeFile(p, args.content ?? "", "utf8");
        return { ok: true, path: p };
      }
      case "list_files": {
        if (!perms.fileSystem) return { error: "File system permission not granted" };
        const p = args.path || "/data";
        const entries = await fs.readdir(p, { withFileTypes: true });
        return { files: entries.map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })) };
      }
      case "git_command": {
        if (!perms.git) return { error: "Git permission not granted" };
        const { stdout } = await execAsync(`git ${args.args ?? ""}`, {
          timeout: 15_000,
          cwd: "/data",
        });
        return { output: stdout.slice(0, 8000) };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── Agent Sleep/Wake State ─────────────────────────────────
const agentState = { awake: false, status: "Schläft...", tasks: [] };

// ── Router ─────────────────────────────────────────────────
export function createAgentRouter() {
  const router = express.Router();

  // GET /api/agent — Status
  router.get("/", (_req, res) => res.json(agentState));

  // GET /api/agent/search-providers — welche Provider verfügbar sind + aktiver
  router.get("/search-providers", (_req, res) => {
    res.json({
      active: preferredSearchProvider,
      available: [
        { id: "auto",       label: "Auto (Fallback-Kette)",  configured: true },
        { id: "tavily",     label: "Tavily",                 configured: !!process.env.TAVILY_API_KEY },
        { id: "serper",     label: "Serper (Google)",        configured: !!process.env.SERPER_API_KEY },
        { id: "brave",      label: "Brave Search",           configured: !!process.env.BRAVE_API_KEY },
        { id: "duckduckgo", label: "DuckDuckGo",             configured: true },
      ],
    });
  });

  // POST /api/agent/search-providers — aktiven Provider setzen
  router.post("/search-providers", (req, res) => {
    const { provider } = req.body;
    const valid = ["auto", "tavily", "serper", "brave", "duckduckgo"];
    if (!valid.includes(provider)) return res.status(400).json({ error: `Ungültig. Erlaubt: ${valid.join(", ")}` });
    preferredSearchProvider = provider;
    res.json({ active: preferredSearchProvider });
  });

  // GET /api/agent/jobs — Letzte Job-Crawler Ergebnisse
  router.get("/jobs", (_req, res) => res.json(getJobResults()));

  // POST /api/agent/jobs/run — Sofort-Durchlauf triggern
  router.post("/jobs/run", (_req, res) => {
    crawlJobs(webSearch, makeLLMClient);
    res.json({ ok: true, message: "Job-Crawler gestartet" });
  });

  // GET /api/agent/permissions
  router.get("/permissions", (_req, res) => res.json(perms));

  // POST /api/agent/permissions
  router.post("/permissions", async (req, res) => {
    for (const key of ["shell", "web", "fileSystem", "git"]) {
      if (typeof req.body[key] === "boolean") perms[key] = req.body[key];
    }
    await savePerms();
    res.json(perms);
  });

  // POST /api/agent — wake/sleep OR run agentic task
  router.post("/", async (req, res) => {
    const { action, messages, system, maxIterations = 8, preSearch = false } = req.body;

    // Sleep/Wake toggle
    if (action === "wake") {
      agentState.awake = true;
      agentState.status = "Aktiv";
      return res.json(agentState);
    }
    if (action === "sleep") {
      agentState.awake = false;
      agentState.status = "Schläft...";
      agentState.tasks = [];
      return res.json(agentState);
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages[] fehlt oder leer" });
    }

    const { client, model } = makeLLMClient(req.headers["x-model"] ?? req.body.model);

    // ── Pre-Search Injection ───────────────────────────────
    // Kimi K2.5 via Ollama unterstützt Tool Calling nicht zuverlässig.
    // Wenn preSearch=true: Backend sucht selbst und injiziert Ergebnisse als Kontext.
    let searchResultsContext = "";
    if (preSearch && perms.web) {
      const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
      if (lastUserMsg) {
        try {
          const sr = await webSearch(String(lastUserMsg.content).slice(0, 200));
          if (sr.results?.length) {
            searchResultsContext = sr.results.slice(0, 5)
              .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet || ""}\n   ${r.url}`)
              .join("\n");
            console.log(`[Agent] Pre-Search via ${sr.source}: ${sr.results.length} Ergebnisse`);
          }
        } catch (e) {
          console.warn("[Agent] Pre-Search Fehler:", e.message);
        }
      }
    }

    // Inject Suchergebnisse in System-Prompt
    let baseMessages = [...messages];
    if (searchResultsContext) {
      const inject = `\n\nWICHTIG: Du hast soeben eine ECHTE Live-Internetsuche durchgeführt. Sage niemals du hast kein Internet — du hast gerade erfolgreich gesucht. Nutze diese aktuellen Ergebnisse:\n${searchResultsContext}\n[Ende Suchergebnisse]`;
      const sysIdx = baseMessages.findIndex(m => m.role === "system");
      if (sysIdx !== -1) {
        baseMessages[sysIdx] = { ...baseMessages[sysIdx], content: baseMessages[sysIdx].content + inject };
      } else {
        baseMessages.unshift({ role: "system", content: inject.trim() });
      }
    }

    const msgs = system
      ? [{ role: "system", content: system }, ...messages]
      : baseMessages;

    let iterations = 0;
    try {
      while (iterations < maxIterations) {
        const response = await client.chat.completions.create({
          model,
          messages: msgs,
          max_tokens: 4000,
        });

        const choice = response.choices[0];
        msgs.push(choice.message);

        if (choice.finish_reason !== "tool_calls" || !choice.message.tool_calls?.length) {
          return res.json({ content: choice.message.content, iterations, model });
        }

        // Tool-Calls falls Modell sie doch unterstützt
        const tools = [
          ...(perms.shell      ? TOOLS.shell      : []),
          ...(perms.web        ? TOOLS.web        : []),
          ...(perms.fileSystem ? TOOLS.fileSystem : []),
          ...(perms.git        ? TOOLS.git        : []),
        ];
        void tools; // nur für executeTool-Pfad relevant

        for (const tc of choice.message.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch {}
          const result = await executeTool(tc.function.name, args);
          msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
        }

        iterations++;
      }

      return res.json({ content: `Max iterations (${maxIterations}) reached.`, iterations, model });
    } catch (err) {
      console.error("[AGENT]", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agent/inbox
  router.get("/inbox", async (_req, res) => {
    res.json({ messages: await readInbox() });
  });

  // POST /api/agent/inbox — User schreibt, Agent antwortet (mit Web-Suche + Postfach-Action)
  router.post("/inbox", async (req, res) => {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: "content fehlt" });

    const userMsg = content.trim();
    const webMode = req.body.webMode === true;
    await addInboxMessage("user", userMsg);

    // Erkennen ob User ins Postfach speichern will
    const wantsPostfach = /postfach|speicher|merk|notiz|abspeichern|ins postfach/i.test(userMsg);

    try {
      const { client, model } = makeLLMClient();
      const history = await readInbox();

      // Pre-Search Injection — nur wenn User den Globe-Button aktiviert hat
      let searchContext = "";
      if (webMode && perms.web) {
        try {
          const sr = await webSearch(userMsg.slice(0, 200));
          if (sr.results?.length) {
            searchContext = "\n\n[Aktuelle Web-Suchergebnisse — nutze diese für deine Antwort]\n" +
              sr.results.slice(0, 5)
                .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet || ""}\n   ${r.url}`)
                .join("\n") +
              "\n[Ende Suchergebnisse]";
            console.log(`[Inbox] Web-Suche: "${userMsg.slice(0, 60)}" → ${sr.results.length} Treffer (${sr.source})`);
          }
        } catch (e) {
          console.warn("[Inbox] Web-Suche fehlgeschlagen:", e.message);
        }
      }

      // Aktive Skills dem Agenten mitteilen
      const activeSkills = [];
      if (perms.web)        activeSkills.push("🌐 Web-Suche (aktuelle Informationen aus dem Internet abrufen)");
      if (perms.fileSystem) activeSkills.push("📁 Dateisystem (Dateien in /data lesen und schreiben)");
      if (perms.git)        activeSkills.push("🌿 Git (Git-Befehle in /data ausführen)");
      if (perms.shell)      activeSkills.push("💻 Shell (beliebige Bash-Befehle auf dem Server ausführen)");

      const skillsInfo = activeSkills.length > 0
        ? `\n\nDeine aktiven Fähigkeiten:\n${activeSkills.map(s => `- ${s}`).join("\n")}\nNutze diese Fähigkeiten wenn sie für die Anfrage sinnvoll sind.`
        : "";

      const systemPrompt = searchContext
        ? `Du bist ESO Bot, ein persönlicher KI-Assistent. Antworte hilfreich, präzise und auf Deutsch.` +
          skillsInfo +
          `\n\nWICHTIG: Du hast soeben eine ECHTE Live-Internetsuche durchgeführt. Die folgenden Suchergebnisse wurden gerade in Echtzeit abgerufen — sie sind aktuell und real. Sage NIEMALS dass du kein Internet hast, denn du hast gerade erfolgreich gesucht. Nutze diese Ergebnisse aktiv für deine Antwort:` +
          searchContext
        : `Du bist ESO Bot, ein persönlicher KI-Assistent. Antworte hilfreich, präzise und auf Deutsch.` +
          skillsInfo;

      const msgs = [
        { role: "system", content: systemPrompt },
        ...history.slice(-20).map(m => ({ role: m.role === "agent" ? "assistant" : m.role, content: m.content }))
      ];
      const response = await client.chat.completions.create({ model, messages: msgs, max_tokens: 2000 });
      const reply = response.choices[0].message.content;

      // Postfach-Action: wenn User ins Postfach speichern wollte, auch wirklich speichern
      if (wantsPostfach) {
        const date = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
        // Betreff aus den letzten Nachrichten ableiten
        const subject = userMsg.replace(/schreibe?.*postfach|speicher.*postfach|ins postfach.*|postfach/gi, "").trim().slice(0, 80) || "Notiz";
        await addPostfachEntry(`📝 ${subject} (${date})`, reply, "info");
        console.log(`[Inbox] Postfach-Eintrag erstellt: "${subject}"`);
      }

      await addInboxMessage("assistant", reply);
    } catch (e) {
      await addInboxMessage("assistant", `⚠️ Fehler: ${e.message}`);
    }

    res.json({ messages: await readInbox() });
  });

  // GET /api/agent/postfach
  router.get("/postfach", async (_req, res) => {
    res.json({ entries: await readPostfach() });
  });

  // POST /api/agent/postfach — neuen Eintrag manuell anlegen (z.B. vom Chat)
  router.post("/postfach", async (req, res) => {
    const { title, content, type = "info" } = req.body;
    if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: "title und content fehlen" });
    await addPostfachEntry(title.trim(), content.trim(), type);
    res.json({ ok: true, entries: await readPostfach() });
  });

  // POST /api/agent/postfach/:id/read — als gelesen markieren
  router.post("/postfach/:id/read", async (req, res) => {
    const entries = await readPostfach();
    const entry = entries.find(e => String(e.id) === String(req.params.id));
    if (entry) entry.read = true;
    await writePostfach(entries);
    res.json({ ok: true });
  });

  // Job-Crawler starten
  startJobCrawler(webSearch, makeLLMClient);

  // Permissions aus Disk laden
  loadPerms();

  return router;
}
