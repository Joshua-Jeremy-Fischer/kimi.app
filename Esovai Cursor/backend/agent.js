import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import OpenAI from "openai";

const execAsync = promisify(exec);

// ── Permissions (in-memory, reset on container restart) ────
const perms = { shell: false, web: false, fileSystem: false, git: false };

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

// ── Web Search (Tavily → Serper → Brave → DuckDuckGo) ─────
async function webSearch(query) {
  // 1. Tavily
  if (process.env.TAVILY_API_KEY) {
    try {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: 5 }),
        signal: AbortSignal.timeout(10_000),
      });
      const d = await r.json();
      if (d.results?.length) {
        return { source: "tavily", results: d.results.map(x => ({ title: x.title, url: x.url, snippet: x.content?.slice(0, 500) })) };
      }
    } catch {}
  }

  // 2. Serper (Google)
  if (process.env.SERPER_API_KEY) {
    try {
      const r = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": process.env.SERPER_API_KEY },
        body: JSON.stringify({ q: query, num: 5 }),
        signal: AbortSignal.timeout(10_000),
      });
      const d = await r.json();
      if (d.organic?.length) {
        return { source: "serper", results: d.organic.map(x => ({ title: x.title, url: x.link, snippet: x.snippet })) };
      }
    } catch {}
  }

  // 3. Brave
  if (process.env.BRAVE_API_KEY) {
    try {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
        headers: { "Accept": "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY },
        signal: AbortSignal.timeout(10_000),
      });
      const d = await r.json();
      if (d.web?.results?.length) {
        return { source: "brave", results: d.web.results.map(x => ({ title: x.title, url: x.url, snippet: x.description })) };
      }
    } catch {}
  }

  // 4. DuckDuckGo (kein Key nötig)
  try {
    const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    const results = [];
    if (d.AbstractText) results.push({ title: d.Heading, url: d.AbstractURL, snippet: d.AbstractText });
    for (const t of (d.RelatedTopics || []).slice(0, 4)) {
      if (t.FirstURL) results.push({ title: t.Text?.slice(0, 80), url: t.FirstURL, snippet: t.Text?.slice(0, 300) });
    }
    if (results.length) return { source: "duckduckgo", results };
  } catch {}

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

// ── Router ─────────────────────────────────────────────────
export function createAgentRouter() {
  const router = express.Router();

  // GET /api/agent/permissions
  router.get("/permissions", (_req, res) => res.json(perms));

  // POST /api/agent/permissions
  router.post("/permissions", (req, res) => {
    for (const key of ["shell", "web", "fileSystem", "git"]) {
      if (typeof req.body[key] === "boolean") perms[key] = req.body[key];
    }
    res.json(perms);
  });

  // POST /api/agent — Run agentic task with tool-calling loop
  router.post("/", async (req, res) => {
    const { messages, system, maxIterations = 8 } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages[] fehlt oder leer" });
    }

    const { client, model } = makeLLMClient(req.headers["x-model"] ?? req.body.model);

    const tools = [
      ...(perms.shell      ? TOOLS.shell      : []),
      ...(perms.web        ? TOOLS.web        : []),
      ...(perms.fileSystem ? TOOLS.fileSystem : []),
      ...(perms.git        ? TOOLS.git        : []),
    ];

    const msgs = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages,
    ];

    let iterations = 0;
    try {
      while (iterations < maxIterations) {
        const response = await client.chat.completions.create({
          model,
          messages: msgs,
          ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
          max_tokens: 4000,
        });

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

  return router;
}
