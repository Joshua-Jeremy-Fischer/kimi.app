import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { can } from "./permissions.js";

const execFileAsync = promisify(execFile);

// ── Workspace Root — alles außerhalb ist verboten ────────────
const WORKSPACE = process.env.SANDBOX_ROOT || "/workspace";

// Pfad-Traversal Schutz: immer auf WORKSPACE einschränken
function safePath(rel) {
  const resolved = path.resolve(WORKSPACE, rel.replace(/^\/+/, ""));
  if (!resolved.startsWith(WORKSPACE)) {
    throw new Error(`Pfad außerhalb Workspace verboten: ${rel}`);
  }
  return resolved;
}

// URL-Sicherheitscheck: keine lokalen Adressen, kein file://
function safeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Ungültige URL: ${url}`); }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error(`Protokoll nicht erlaubt: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  const blocked = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "169.254"];
  if (blocked.some(b => host.includes(b))) {
    throw new Error(`Lokale Adressen verboten: ${host}`);
  }
  return url;
}

// ── Tool Definitionen (OpenAI format) ────────────────────────
export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Ruft eine URL ab und gibt den Textinhalt zurück. Nur HTTPS/HTTP erlaubt, keine lokalen Adressen.",
      parameters: {
        type: "object",
        properties: {
          url:    { type: "string", description: "Die URL die abgerufen werden soll" },
          method: { type: "string", enum: ["GET", "POST"], default: "GET" },
          body:   { type: "string", description: "Request Body für POST (optional)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Liest eine Datei aus dem Workspace. Pfad relativ zu /workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Dateipfad relativ zu /workspace" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description: "Schreibt oder überschreibt eine Datei im Workspace.",
      parameters: {
        type: "object",
        properties: {
          path:    { type: "string", description: "Dateipfad relativ zu /workspace" },
          content: { type: "string", description: "Dateiinhalt" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "Listet Dateien in einem Workspace-Verzeichnis auf.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Verzeichnispfad relativ zu /workspace", default: "/" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_exec",
      description: "Führt einen Shell-Befehl im Workspace aus. Erfordert ALLOW_SHELL=true.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell-Befehl (z.B. 'npm install', 'node script.js')" },
          cwd:     { type: "string", description: "Arbeitsverzeichnis relativ zu /workspace", default: "/" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_op",
      description: "Führt Git-Operationen aus (status, diff, commit, push). Erfordert ALLOW_GIT=true.",
      parameters: {
        type: "object",
        properties: {
          args: { type: "string", description: "Git-Argumente (z.B. 'status', 'add -A', 'commit -m \"msg\"')" },
        },
        required: ["args"],
      },
    },
  },
];

// ── Tool Ausführung ──────────────────────────────────────────
export async function executeTool(name, args) {
  const log = (msg) => console.log(`[TOOL:${name}] ${msg}`);

  switch (name) {
    // ── web_fetch ───────────────────────────────────────────
    case "web_fetch": {
      if (!can("web")) return { error: "Web-Zugriff ist deaktiviert (ALLOW_WEB=false)" };
      const url = safeUrl(args.url);
      log(url);
      const res = await fetch(url, {
        method: args.method || "GET",
        body: args.body || undefined,
        headers: { "User-Agent": "EsoBot/1.0" },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      return {
        status: res.status,
        content: text.slice(0, 8000), // max 8k Zeichen
        truncated: text.length > 8000,
      };
    }

    // ── file_read ───────────────────────────────────────────
    case "file_read": {
      if (!can("files")) return { error: "Dateizugriff ist deaktiviert (ALLOW_FILES=false)" };
      const p = safePath(args.path);
      log(p);
      const content = await fs.readFile(p, "utf-8");
      return { content: content.slice(0, 16000), truncated: content.length > 16000 };
    }

    // ── file_write ──────────────────────────────────────────
    case "file_write": {
      if (!can("files")) return { error: "Dateizugriff ist deaktiviert (ALLOW_FILES=false)" };
      const p = safePath(args.path);
      log(p);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, args.content, "utf-8");
      return { ok: true, path: args.path, bytes: Buffer.byteLength(args.content) };
    }

    // ── list_files ──────────────────────────────────────────
    case "list_files": {
      if (!can("files")) return { error: "Dateizugriff ist deaktiviert (ALLOW_FILES=false)" };
      const p = safePath(args.path || "/");
      log(p);
      const entries = await fs.readdir(p, { withFileTypes: true });
      return {
        path: args.path || "/",
        entries: entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
        })),
      };
    }

    // ── shell_exec ──────────────────────────────────────────
    case "shell_exec": {
      if (!can("shell")) return { error: "Shell ist deaktiviert. In den Eso Bot Settings aktivieren." };
      const cwd = safePath(args.cwd || "/");
      log(`${args.command} (cwd: ${cwd})`);

      // Befehl als Shell-String ausführen (voller Bash-Zugriff wenn ALLOW_SHELL=true)
      const { stdout, stderr } = await execFileAsync("bash", ["-c", args.command], {
        cwd,
        timeout: 30_000,      // max 30 Sekunden
        maxBuffer: 1024 * 512, // max 512kb Output
        env: {
          ...process.env,
          HOME: WORKSPACE,
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        },
      });
      return {
        stdout: stdout.slice(0, 8000),
        stderr: stderr.slice(0, 2000),
        truncated: stdout.length > 8000,
      };
    }

    // ── git_op ──────────────────────────────────────────────
    case "git_op": {
      if (!can("git")) return { error: "Git ist deaktiviert. In den Eso Bot Settings aktivieren." };
      log(args.args);
      const { stdout, stderr } = await execFileAsync("bash", ["-c", `git ${args.args}`], {
        cwd: WORKSPACE,
        timeout: 30_000,
        maxBuffer: 1024 * 256,
      });
      return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000) };
    }

    default:
      return { error: `Unbekanntes Tool: ${name}` };
  }
}

// Gibt nur Tools zurück die aktuell erlaubt sind
export function getActiveTools() {
  return TOOL_DEFINITIONS.filter(t => {
    const n = t.function.name;
    if (n === "web_fetch")  return can("web");
    if (n === "shell_exec") return can("shell");
    if (n === "git_op")     return can("git");
    if (n === "file_read" || n === "file_write" || n === "list_files") return can("files");
    return true;
  });
}
