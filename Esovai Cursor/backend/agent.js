import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import OpenAI from "openai";
import { startJobCrawler, crawlJobs, getJobResults } from "./job-crawler.js";
import { startScheduler, createTask, listTasks, deleteTask } from "./scheduler.js";
import { startMonitor, getMonitorStatus } from "./monitor.js";
import { chromium } from "playwright-core";
import nodemailer from "nodemailer";

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium-browser";

const execAsync = promisify(exec);

// ── Optional: Remote tool runner (eso-bot) ────────────────────
const ESO_BOT_BASE_URL = (process.env.AGENT_BASE_URL || "").trim().replace(/\/$/, "");
const ESO_BOT_TOKEN = (process.env.ESO_BOT_TOKEN || "").trim();

async function esoBotCall(path, body) {
  if (!ESO_BOT_BASE_URL) throw new Error("AGENT_BASE_URL fehlt (eso-bot nicht konfiguriert)");
  if (!ESO_BOT_TOKEN) throw new Error("ESO_BOT_TOKEN fehlt (eso-bot Auth)");
  const r = await fetch(`${ESO_BOT_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ESO_BOT_TOKEN}`,
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { error: data?.error || `eso-bot error (${r.status})` };
  return data;
}

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
const perms = { shell: false, web: false, fileSystem: false, git: false, browser: false, email: false };

async function loadPerms() {
  try {
    const raw = await fs.readFile(PERMS_FILE, "utf8");
    const saved = JSON.parse(raw);
    for (const key of ["shell", "web", "fileSystem", "git", "browser", "email"]) {
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

  async function trySearXNG() {
    const url = new URL("http://kimi-searxng:8080/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    // SearXNG akzeptiert z. B. "de" — "de-DE"/"de_DE" lösen ValidationException in preferences aus
    url.searchParams.set("language", "de");
    // DuckDuckGo triggert serverseitig häufig CAPTCHA → lieber Bing/Google nutzen
    url.searchParams.set("engines", "bing,google");
    url.searchParams.set("categories", "general");
    url.searchParams.set("time_range", "month"); // Nur Ergebnisse der letzten ~30 Tage
    const r = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.results?.length) return null;
    return {
      source: "searxng",
      results: d.results.slice(0, 5).map(x => ({ title: x.title, url: x.url, snippet: x.content?.slice(0, 400) })),
    };
  }

  const providers = { tavily: tryTavily, serper: trySerper, brave: tryBrave, searxng: trySearXNG, duckduckgo: trySearXNG };

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
  for (const fn of [tryTavily, trySerper, tryBrave, trySearXNG]) {
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
  email: [{
    type: "function",
    function: {
      name: "send_email",
      description: "Send an email on behalf of Joshua. Use for job applications, follow-ups, or any other email.",
      parameters: {
        type: "object",
        properties: {
          to:      { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject line" },
          body:    { type: "string", description: "Email body text (plain text or HTML)" },
          html:    { type: "boolean", description: "Set true if body contains HTML" },
        },
        required: ["to", "subject", "body"],
      },
    },
  }],
  browser: [
    {
      type: "function",
      function: {
        name: "browser_navigate",
        description: "Open a real headless browser and navigate to a URL. Works with JavaScript-heavy pages like job boards, LinkedIn, Stepstone etc. Returns page title and cleaned text content.",
        parameters: {
          type: "object",
          properties: {
            url:      { type: "string", description: "URL to open" },
            extract:  { type: "string", enum: ["text", "links", "structured"], description: "What to extract: text (default), links, or structured (title+text+links)" },
            waitFor:  { type: "string", description: "Optional CSS selector to wait for before extracting" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_click",
        description: "Click an element on the current browser page by CSS selector or text content.",
        parameters: {
          type: "object",
          properties: {
            url:      { type: "string", description: "URL to navigate to first" },
            selector: { type: "string", description: "CSS selector or visible text to click" },
          },
          required: ["url", "selector"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_fill",
        description: "Fill in a form on a web page (e.g. search box) and optionally submit.",
        parameters: {
          type: "object",
          properties: {
            url:      { type: "string", description: "URL to navigate to" },
            selector: { type: "string", description: "CSS selector of input field" },
            value:    { type: "string", description: "Text to type" },
            submit:   { type: "boolean", description: "Press Enter/submit after filling" },
          },
          required: ["url", "selector", "value"],
        },
      },
    },
  ],
};

function getActiveToolDefinitions() {
  return [
    ...(perms.shell ? TOOLS.shell : []),
    ...(perms.web ? TOOLS.web : []),
    ...(perms.fileSystem ? TOOLS.fileSystem : []),
    ...(perms.git ? TOOLS.git : []),
    ...(perms.browser ? TOOLS.browser : []),
    ...(perms.email ? TOOLS.email : []),
  ];
}

// ── Browser Helper (Playwright) ────────────────────────────
async function withAgentBrowser(fn) {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-setuid-sandbox", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" });
    return await fn(page);
  } finally {
    await browser?.close();
  }
}

// ── Tool executor ──────────────────────────────────────────
async function executeTool(name, args) {
  try {
    switch (name) {
      case "bash": {
        if (!perms.shell) return { error: "Shell permission not granted" };
        if (ESO_BOT_BASE_URL) return await esoBotCall("/tools/bash", { command: args.command ?? "" });
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
        if (ESO_BOT_BASE_URL) return await esoBotCall("/tools/web_fetch", { url: args.url });
        const r = await fetch(args.url, { signal: AbortSignal.timeout(15_000) });
        const text = await r.text();
        return { status: r.status, content: text.slice(0, 20_000) };
      }
      case "read_file": {
        if (!perms.fileSystem) return { error: "File system permission not granted" };
        if (ESO_BOT_BASE_URL) return await esoBotCall("/tools/read_file", { path: args.path });
        const p = (args.path ?? "").startsWith("/") ? args.path : `/data/${args.path}`;
        const content = await fs.readFile(p, "utf8");
        return { content: content.slice(0, 50_000) };
      }
      case "write_file": {
        if (!perms.fileSystem) return { error: "File system permission not granted" };
        if (ESO_BOT_BASE_URL) return await esoBotCall("/tools/write_file", { path: args.path, content: args.content ?? "" });
        const p = (args.path ?? "").startsWith("/") ? args.path : `/data/${args.path}`;
        await fs.writeFile(p, args.content ?? "", "utf8");
        return { ok: true, path: p };
      }
      case "list_files": {
        if (!perms.fileSystem) return { error: "File system permission not granted" };
        if (ESO_BOT_BASE_URL) return await esoBotCall("/tools/list_files", { path: args.path || "." });
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
      case "send_email": {
        if (!perms.email) return { error: "Email permission not granted" };
        const smtpConfig = {
          host: process.env.SMTP_HOST || "smtp.gmail.com",
          port: parseInt(process.env.SMTP_PORT || "587"),
          secure: false,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        };
        if (!smtpConfig.auth.user || !smtpConfig.auth.pass) {
          return { error: "SMTP nicht konfiguriert. Bitte SMTP_USER und SMTP_PASS als Umgebungsvariablen setzen." };
        }
        const transporter = nodemailer.createTransport(smtpConfig);
        const info = await transporter.sendMail({
          from: `"Joshua Fischer" <${smtpConfig.auth.user}>`,
          to: args.to,
          subject: args.subject,
          [args.html ? "html" : "text"]: args.body,
        });
        console.log(`[EMAIL] Gesendet an ${args.to}: ${info.messageId}`);
        return { ok: true, messageId: info.messageId, to: args.to };
      }
      case "browser_navigate": {
        if (!perms.browser) return { error: "Browser permission not granted" };
        return withAgentBrowser(async (page) => {
          await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          if (args.waitFor) await page.waitForSelector(args.waitFor, { timeout: 8_000 }).catch(() => {});
          const title = await page.title();
          if (args.extract === "links") {
            const links = await page.$$eval("a[href]", els =>
              els.slice(0, 50).map(a => ({ text: a.innerText.trim().slice(0, 80), href: a.href })).filter(l => l.text)
            );
            return { title, links };
          }
          // Text: clean HTML → plain text
          const text = await page.evaluate(() => {
            document.querySelectorAll("script,style,nav,footer,header").forEach(e => e.remove());
            return document.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 12_000) || "";
          });
          if (args.extract === "structured") {
            const links = await page.$$eval("a[href]", els =>
              els.slice(0, 30).map(a => ({ text: a.innerText.trim().slice(0, 80), href: a.href })).filter(l => l.text)
            );
            return { title, text, links };
          }
          return { title, text };
        });
      }
      case "browser_fill": {
        if (!perms.browser) return { error: "Browser permission not granted" };
        return withAgentBrowser(async (page) => {
          await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.fill(args.selector, args.value);
          if (args.submit) await page.keyboard.press("Enter");
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          const title = await page.title();
          const text = await page.evaluate(() =>
            document.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 8_000) || ""
          );
          return { title, text };
        });
      }
      case "browser_click": {
        if (!perms.browser) return { error: "Browser permission not granted" };
        return withAgentBrowser(async (page) => {
          await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.click(args.selector).catch(() => page.getByText(args.selector).first().click());
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          const title = await page.title();
          const text = await page.evaluate(() =>
            document.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 8_000) || ""
          );
          return { title, text };
        });
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
    for (const key of ["shell", "web", "fileSystem", "git", "browser", "email"]) {
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

    // Inject Suchergebnisse — neutral ohne "Internet/Web" Trigger-Wörter
    let baseMessages = [...messages];
    if (searchResultsContext) {
      const today = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
      const inject = `\n\n[Recherche-Daten vom ${today} — für deine Antwort verwenden]\n${searchResultsContext}\n[Ende Recherche-Daten]`;
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

    const toolDefs = getActiveToolDefinitions();

    let iterations = 0;
    try {
      while (iterations < maxIterations) {
        const completionOpts = {
          model,
          messages: msgs,
          max_tokens: 4000,
        };
        if (toolDefs.length) {
          completionOpts.tools = toolDefs;
          completionOpts.tool_choice = "auto";
        }

        const response = await client.chat.completions.create(completionOpts);

        const choice = response.choices[0];
        msgs.push(choice.message);

        if (choice.finish_reason !== "tool_calls" || !choice.message.tool_calls?.length) {
          return res.json({ content: choice.message.content, iterations, model });
        }

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

  // Hilfsfunktion: Zeitangabe aus User-Text entfernen → saubere Instruction für den Scheduler
  function extractInstruction(text) {
    return text
      .replace(/\[\s*jetzt\s*\+\s*\d+\s*(?:min|m)\s*\]/gi, "")  // [jetzt+3min]
      .replace(/\bjetzt\s*\+\s*\d+\s*(?:min|m)\b/gi, "")          // jetzt+3min
      .replace(/\bin\s+\d+\s*(?:minuten|min|m)\b/gi, "")           // in 3 Minuten
      .replace(/\bum\s+\d{1,2}[:.]\d{2}\s*uhr?\b/gi, "")          // um 13:40 / um 13:40 Uhr
      .replace(/\bschreib\s+(?:mir\s+)?(?:eine?\s+)?(?:nachricht\s+)?in\s+die\s+inbox\b/gi, "") // "schreib mir in die Inbox"
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // POST /api/agent/inbox — User schreibt, Agent antwortet (mit Web-Suche + Postfach-Action)
  router.post("/inbox", async (req, res) => {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: "content fehlt" });

    const userMsg = content.trim();
    const webMode = req.body.webMode === true;
    await addInboxMessage("user", userMsg);

    // Inbox ist als "Chatfenster für Postfach" gedacht:
    // Alles was hier entsteht, landet (zusätzlich) im Postfach, damit nichts verloren geht.
    // Optional kann der Client das explizit steuern: saveToPostfach=false deaktiviert.
    const saveToPostfach = req.body.saveToPostfach !== false;
    const wantsPostfach =
      saveToPostfach || /postfach|speicher|merk|notiz|abspeichern|ins postfach/i.test(userMsg);

    try {
      const { client, model } = makeLLMClient();
      const history = await readInbox();

      // Pre-Search Injection — Globe-Button reicht, kein Skill-Perm nötig (User entscheidet selbst)
      let searchContext = "";
      if (webMode) {
        try {
          const sr = await webSearch(userMsg.slice(0, 200));
          if (sr.results?.length) {
            searchContext = sr.results.slice(0, 5)
              .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet || ""}\n   ${r.url}`)
              .join("\n");
            console.log(`[Inbox] Web-Suche: "${userMsg.slice(0, 60)}" → ${sr.results.length} Treffer (${sr.source})`);
          }
        } catch (e) {
          console.warn("[Inbox] Web-Suche fehlgeschlagen:", e.message);
        }
      }

      // Inbox hat KEINE Tools: keine Tool-Liste in den System-Prompt schreiben,
      // sonst halluziniert das Modell Tool-/XML-Syntax.
      const now = new Date();
      const today = now.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
      const nowStr =
        `${today}, ` +
        `${now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr (Europe/Berlin)`;

      const systemPrompt = `Du bist ESO Bot — der persönliche autonome Agent von Joshua Fischer.
Datum: ${nowStr}

## Über Joshua (dein Nutzer)
- **Name:** Joshua Fischer
- **Adresse:** Oberdorfen 35, 84405 Dorfen (Landkreis Erding, Bayern)
- **Geburtsdatum:** 09.03.2000, ledig
- **E-Mail:** ficherjoshua@gmail.com
- **Telefon:** +49 1522 8809723
- **GitHub:** github.com/Joshua-Jeremy-Fischer
- **Kein Auto** — fährt mit S-Bahn/Regionalbahn (erreichbar: München, Erding, Mühldorf, Rosenheim, Poing, Markt Schwaben, Ampfing, Dorfen, Ebersberg, Trudering, Riem, Feldkirchen, Vaterstetten, Baldham, Zorneding, Ottenhofen, Hörlkofen, Walpertskirchen, Schwindegg, Mettenheim, St. Wolfgang)
- **Sprachen:** Deutsch (Muttersprache), Englisch (gut, KMK B1), Spanisch (Grundkenntnisse)

## Beruflicher Werdegang
- **IT-Mitarbeiter / Benutzer- und Berechtigungsmanagement** — Gienger München KG (08/2025–laufend)
  Vergabe/Änderung/Deaktivierung Zugriffsrechte, IAM nach Least-Privilege, AD, ERP WW90, First-Level-Support
- **Praktikum QA Testing** — FIRMATIO, Mérida (Mexiko) (01/2025–07/2025)
  Frontend-Tests, Bugreports, agiles Scrum-Team, internationales Umfeld
- **IT-Mitarbeiter** — Gienger München KG (02/2024–12/2024)
  Benutzerkontenverwaltung, Zugriffsrechte, Reports aus WW90, technische Dokumentation
- **Ausbildung: Kaufmann im Groß- und Außenhandelsmanagement** — Gienger München KG (09/2021–07/2024)
  Kundenkommunikation, Beratung, Angebotserstellung im Zentralverkauf, Einsätze in Logistik, Einkauf, Disposition, Buchhaltung

## Weiterbildung
- **Geprüfter Berufsspezialist für Informationssicherheit (IHK)** — CloudHelden GmbH (09/2025–laufend, Prüfung Herbst 2026)
  Risikoanalyse, BSI-Grundschutz, ISMS-Aufbau, ISO 27001/TISAX, Security Monitoring

## IT-Kenntnisse
- **Security:** IAM (AD, Entra ID/Azure AD, WW90/AS400), Wazuh SIEM, Shuffle SOAR, BSI-Grundschutz, Risikoanalyse, ISMS, Linux Hardening (SSH, fail2ban), Cloudflare Zero Trust, MITRE ATT&CK
- **Infrastruktur:** Docker, Hetzner Cloud, Proxmox, PowerShell, Bash
- **ERP:** WW90, AS/400 (produktiver Betrieb)

## Projekte
- Homelab: Proxmox, Docker, Hetzner Cloud — SIEM (Wazuh) + SOAR (Shuffle), Cloudflare Zero Trust
- File Integrity Monitor: PowerShell, Hash-basiert, GitHub-Projekt
- IAM-Auswertung: Python-Skript für Benutzerkontenverwaltung

## Zielstellen
Junior SOC Analyst, Junior IT-Security Analyst, ISMS-Koordinator, IAM Engineer, IT Support Remote, Kaufmännisch Innendienst/Großhandel, Sales Coordinator IT, Junior Account Manager B2B

---

## Anschreiben-Stil (Joshua's Bewerbungsstil — immer so schreiben!)

**Struktur:**
1. Absender: Joshua Fischer, Oberdorfen 35, 84405 Dorfen
2. Empfänger (Firma, Ansprechpartner, Adresse)
3. Ort und Datum: "Dorfen, den [Datum]"
4. Betreff: "Bewerbung als [Jobtitel] (m/w/d)"
5. Anrede: "Sehr geehrte/r [Name]," (falls kein Name: "Sehr geehrte Damen und Herren,")
6. Eröffnung: Was an der Stelle angesprochen hat / warum sie passt
7. Beruflicher Hintergrund: Aktuelle Position + relevante Erfahrungen (konkret, nicht allgemein)
8. Weitere Erfahrung: Praktikum Mexiko / Ausbildung / Projekte — je nach Relevanz
9. Bullet-Liste: 3–4 konkrete Stärken/Skills (mit •)
10. Weiterbildung IHK erwähnen (falls relevant für IT/Security)
11. Persönliche Eigenschaften (strukturiert, lösungsorientiert, kommunikativ)
12. Abschluss: Freude auf Rückmeldung / persönliches Gespräch
13. Gruß: "Mit freundlichen Grüßen" + "Joshua Fischer"

**Ton:** Professionell, selbstbewusst, klar. Keine Floskeln. Ich-Form. Keine Übertreibungen.
**Länge:** ca. 350–450 Wörter (eine DIN-A4-Seite).
**Kein Studium erwähnen** — Joshua hat keins. Stattdessen Ausbildung + praktische IT-Erfahrung betonen.
**Quereinsteiger-Framing:** IT-Wissen kommt aus Eigeninitiative + Ausbildungsbetrieb + Homelab — das ist eine Stärke, kein Nachteil.

**Beispiel-Eröffnung (Prianto-Stil):**
"Auf der Suche nach dem nächsten Schritt in meiner beruflichen Entwicklung hat mich Ihre Stellenausschreibung als [Titel] direkt angesprochen. Die Verbindung aus [Aspekt1] und [Aspekt2] passt sehr gut zu meinem bisherigen beruflichen Werdegang und den fachlichen Schwerpunkten, die ich künftig weiter ausbauen möchte."

**WICHTIG — Stil: echt, nicht KI-generiert:**
- Klingt wie ein Mensch, nicht wie eine KI. Keine übertriebene Eloquenz.
- Keine Marketing-Sprache ("ich brenne für", "meine Leidenschaft ist", "ich bin hochmotiviert").
- Natürliche Satzlänge — manchmal kurz, manchmal länger. Nicht zu gleichmäßig.
- Leicht unperfekt ist besser als poliert: lieber echte Formulierungen als glatte KI-Sätze.
- Spezifische Details aus der Stellenanzeige einbauen — zeigen, dass man die Stelle wirklich gelesen hat.

---

## Bewerbungs-Workflow (wenn Joshua eine Bewerbung will)

**Schritt 1 — Stellenanzeige analysieren:**
Lies die Stelle genau. Identifiziere:
- Geforderte Skills → welche hat Joshua? (Lebenslauf oben)
- Soft Skills / Teamkultur → wie formulieren die das?
- Sprache des Unternehmens (förmlich vs. modern) → Anschreiben entsprechend anpassen

**Schritt 2 — Anschreiben schreiben:**
- Passe JEDEN Abschnitt an die konkrete Stelle an (Jobtitel, geforderte Skills, Unternehmenskontext)
- Verknüpfe Joshua's echte Erfahrungen mit den Anforderungen (z.B.: "Ihre Anforderung X deckt sich mit meiner Erfahrung Y")
- Wenn die Stelle IT-Security betont → IAM, Wazuh, IHK-Fortbildung in den Vordergrund
- Wenn Kaufmännisch → Ausbildung, Zentralverkauf, ERP, Kundenkontakt betonen
- Wenn Remote IT Support → kommunikative Stärke + AD/Entra + kaufm. Hintergrund

**Schritt 3 — Vorzeigen und per E-Mail senden:**
Zeige das fertige Anschreiben im Chat.
Dann frage: "Soll ich das an [E-Mail der Firma / HR-Kontakt] schicken?"
Falls ja → send_email mit Betreff "Bewerbung als [Titel] — Joshua Fischer", Anschreiben im Body.
Joshua's E-Mail-Adresse als Absender: ficherjoshua@gmail.com

---

## Deine Aufgaben als Agent
Du arbeitest **autonom und proaktiv**:
- Jobs suchen, Stellenanzeigen lesen und bewerten
- **Bewerbungsschreiben** auf eine konkrete Stelle verfassen und per E-Mail senden
- Im Browser navigieren, Formulare ausfüllen, Seiten lesen
- Dateien erstellen, bearbeiten, speichern
- Shell-Befehle ausführen
- Recherchen durchführen

Wenn Joshua sagt "Bewirb dich für die Stelle" oder "Schreib eine Bewerbung", führe den Bewerbungs-Workflow oben aus.
Wenn Joshua sagt "Schreib eine E-Mail", verfasst du den vollständigen Text und fragst ob du absenden sollst.

---

---

## VERHALTENSREGELN — IMMER EINHALTEN

**TU ES EINFACH.**
Wenn Joshua dich um etwas bittet, mach es sofort. Erkläre nicht erst was du könntest. Nicht fragen ob du darf. Einfach anfangen.

**KEINE OPTION-LISTEN.**
Niemals "Option A / Option B / Option C" anbieten. Wenn mehrere Wege möglich sind, wähl den sinnvollsten und mach ihn. Wenn du wirklich eine Entscheidung brauchst, stelle EINE konkrete Frage — nicht fünf.

**KEINE CAPABILITY-DEMOS.**
Nie erklären was du alles kannst ("Ich kann Wazuh installieren, KQL schreiben, Sentinel integrieren..."). Wenn Joshua fragt ob du etwas kannst → kurz "ja" und direkt machen oder zeigen.

**KURZE ANTWORTEN.**
Wenn Joshua etwas wissen will → beantworte es direkt in 2-4 Sätzen. Kein Padding, keine Einleitungen, keine Zusammenfassungen am Ende.

**KEIN META-GEREDE.**
Nie über deine eigene Arbeitsweise philosophieren. Nie fragen "Wie soll ich als dein Agent arbeiten?". Nie erklären wie du lernen könntest. Einfach arbeiten.

**BEI AUFGABEN:** Tool aufrufen → Ergebnis zeigen → fertig. Keine Vorab-Erklärung was du gleich tun wirst.

**BEI UNKLARHEIT:** Eine kurze Frage, dann warten. Nicht 5 Szenarien durchspielen.

Antworte auf Deutsch. Sei knapp und direkt wie ein Kollege, nicht wie ein Assistent.
Du hast in diesem Chat KEINE Tool-Aufruf-Fähigkeiten. Schreibe KEINEN XML- oder Funktions-Code. Antworte nur als Text.
${searchContext ? `\n## Aktuelle Recherche-Daten (${today})\n${searchContext.replace(/\[Aktuelle Web-Suchergebnisse.*?\]\n/s, "").replace(/\n\[Ende Suchergebnisse\]/, "")}` : ""}`;

      const msgs = [
        { role: "system", content: systemPrompt },
        ...history.slice(-20).map(m => ({ role: m.role === "agent" ? "assistant" : m.role, content: m.content }))
      ];
      const response = await client.chat.completions.create({ model, messages: msgs, max_tokens: 2000 });
      const rawReply = (response.choices[0].message.content || "")
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<\/?think>/gi, "")
        // Strip halluzinierte XML-Tool-Calls (Modell schreibt Tool-Syntax als Text)
        .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "")
        .replace(/<invoke[\s\S]*?<\/invoke>/gi, "")
        .replace(/<parameter[\s\S]*?<\/antml:parameter>/gi, "")
        .trim();

      // ── Zeitplan-Erkennung: prüfe ob LLM einen Task anlegen will ──
      // Muster: "TASK: <ISO>|<instruction>" im Reply (vom LLM generiert)
      // Alternativ: direkte Uhrzeit-Erkennung im User-Input als Fallback
      let reply = rawReply;
      const taskDirective = rawReply.match(/SCHEDULE_TASK:\s*(\S+)\s*\|\s*(.+)/i);
      if (taskDirective) {
        const [, isoTime, instruction] = taskDirective;
        try {
          const task = await createTask({ instruction: instruction.trim(), executeAt: isoTime.trim(), repeat: null, sendEmail: null });
          // Wichtig: bei Scheduler immer eine kurze Bestätigung zurückgeben,
          // damit kein halluzinierter POST-/XML-Block im Reply stehen bleibt.
          reply = `Task angelegt — ich schreibe dir um ${new Date(task.executeAt).toLocaleTimeString("de-DE", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Europe/Berlin",
          })} Uhr in die Inbox.`;
          console.log(`[Inbox] Scheduler-Task angelegt via LLM: "${task.instruction}" um ${task.executeAt}`);
        } catch (e) {
          console.warn("[Inbox] Task-Anlage fehlgeschlagen:", e.message);
        }
      } else {
        // Fallback: relative Zeit erkennen (z.B. "jetzt+3min", "[jetzt+3min]", "in 3 Minuten")
        const relMatch =
          userMsg.match(/\[\s*jetzt\s*\+\s*(\d{1,4})\s*(?:min|m)\s*\]/i) ||
          userMsg.match(/\bjetzt\s*\+\s*(\d{1,4})\s*(?:min|m)\b/i) ||
          userMsg.match(/\bin\s+(\d{1,4})\s*(?:minuten|min|m)\b/i);

        const hasScheduleIntent =
          /später|um \d|schreib.*mir.*um|sende.*um|erinner|um \d{1,2}[:.]\d{2}|\bjetzt\s*\+|\bin\s+\d+\s*(?:minuten|min|m)\b/i.test(
            userMsg
          );

        if (relMatch && hasScheduleIntent) {
          const mins = Math.max(1, Math.min(24 * 60, parseInt(relMatch[1], 10) || 0));
          const execUTC = new Date(Date.now() + mins * 60_000);
          try {
            const task = await createTask({ instruction: extractInstruction(userMsg), executeAt: execUTC.toISOString(), repeat: null, sendEmail: null });
            reply = `Task angelegt — ich schreibe dir um ${new Date(task.executeAt).toLocaleTimeString("de-DE", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Europe/Berlin",
            })} Uhr in die Inbox.`;
            console.log(`[Inbox] Relative Zeit erkannt (+${mins}min) → Task angelegt: "${task.instruction}" um ${task.executeAt}`);
          } catch (e) {
            console.warn("[Inbox] Relative Fallback Task-Anlage fehlgeschlagen:", e.message);
          }
        }

        // Fallback: Uhrzeit im User-Prompt direkt erkennen (z.B. "um 13:40")
        const timeMatch = userMsg.match(/um\s+(\d{1,2})[:\.](\d{2})\s*uhr?/i);
        if (!relMatch && timeMatch && hasScheduleIntent) {
          const [, hh, mm] = timeMatch;
          const now = new Date();
          const exec = new Date(now);
          exec.setHours(parseInt(hh, 10), parseInt(mm, 10), 0, 0);
          // Falls Uhrzeit bereits vorbei ist → morgen
          if (exec <= now) exec.setDate(exec.getDate() + 1);
          // Zeitzone Europe/Berlin (UTC+2 Sommerzeit / UTC+1 Winter)
          const offsetMs = 2 * 60 * 60 * 1000; // vereinfacht UTC+2
          const execUTC = new Date(exec.getTime() - offsetMs);
          try {
            const task = await createTask({ instruction: extractInstruction(userMsg), executeAt: execUTC.toISOString(), repeat: null, sendEmail: null });
            reply = `Task angelegt — ich schreibe dir um ${exec.toLocaleTimeString("de-DE", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Europe/Berlin",
            })} Uhr in die Inbox.`;
            console.log(`[Inbox] Fallback-Scheduler-Task angelegt: "${task.instruction}" um ${task.executeAt}`);
          } catch (e) {
            console.warn("[Inbox] Fallback Task-Anlage fehlgeschlagen:", e.message);
          }
        }
      }

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

  // DELETE /api/agent/postfach/:id — Eintrag löschen
  router.delete("/postfach/:id", async (req, res) => {
    const entries = await readPostfach();
    const filtered = entries.filter(e => String(e.id) !== String(req.params.id));
    await writePostfach(filtered);
    res.json({ ok: true });
  });

  // DELETE /api/agent/postfach — alle gelesenen löschen
  router.delete("/postfach", async (req, res) => {
    const entries = await readPostfach();
    await writePostfach(entries.filter(e => !e.read));
    res.json({ ok: true });
  });

  // ── Scheduler API ─────────────────────────────────────────────
  // POST /api/agent/tasks — neuen Task anlegen
  router.post("/tasks", async (req, res) => {
    const { instruction, executeAt, repeat, sendEmail } = req.body;
    if (!instruction?.trim()) return res.status(400).json({ error: "instruction fehlt" });
    if (!executeAt) return res.status(400).json({ error: "executeAt (ISO string) fehlt" });
    const parsed = new Date(executeAt);
    if (isNaN(parsed.getTime())) return res.status(400).json({ error: "executeAt ist kein gültiges Datum" });
    try {
      const task = await createTask({ instruction: instruction.trim(), executeAt, repeat: repeat || null, sendEmail: sendEmail || null });
      res.json({ ok: true, task });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/agent/tasks — alle ausstehenden Tasks auflisten
  router.get("/tasks", async (_req, res) => {
    try {
      res.json({ tasks: await listTasks() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/agent/tasks/:id — Task löschen
  router.delete("/tasks/:id", async (req, res) => {
    try {
      await deleteTask(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Job-Crawler starten
  startJobCrawler(webSearch, makeLLMClient);

  // SOC Monitor starten
  startMonitor(addPostfachEntry);

  // Scheduler starten
  startScheduler({ webSearch, addPostfach: addPostfachEntry, sendEmail: null, makeLLMClient });

  // Permissions aus Disk laden
  loadPerms();

  return router;
}
