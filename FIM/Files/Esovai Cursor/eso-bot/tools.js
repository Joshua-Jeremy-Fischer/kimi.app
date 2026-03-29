import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { can } from "./permissions.js";

const execFileAsync = promisify(execFile);

// ── Workspace Root ────────────────────────────────────────────
const WORKSPACE = process.env.SANDBOX_ROOT || "/workspace";

// Pfad-Traversal Schutz
function safePath(rel) {
  const resolved = path.resolve(WORKSPACE, rel.replace(/^\/+/, ""));
  if (!resolved.startsWith(WORKSPACE + path.sep) && resolved !== WORKSPACE) {
    throw new Error(`Pfad außerhalb Workspace verboten: ${rel}`);
  }
  return resolved;
}

// SSRF-Schutz: blockiert localhost, private Ranges, cloud metadata
function safeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Ungültige URL: ${url}`); }

  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error(`Protokoll nicht erlaubt: ${parsed.protocol}`);
  }

  const host = parsed.hostname.toLowerCase();

  // Literale Hostnamen
  const blockedHosts = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1"];
  if (blockedHosts.includes(host)) throw new Error(`Blockierte Adresse: ${host}`);

  // IP-Range Check
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b, c, d] = ipv4.map(Number);
    if (
      a === 10 ||                                    // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||           // 172.16.0.0/12
      (a === 192 && b === 168) ||                    // 192.168.0.0/16
      (a === 169 && b === 254) ||                    // 169.254.0.0/16 (link-local / metadata)
      (a === 100 && b >= 64 && b <= 127) ||          // 100.64.0.0/10 (shared address space)
      a === 127 ||                                   // 127.0.0.0/8
      a === 0 ||                                     // 0.0.0.0/8
      (a === 198 && (b === 18 || b === 19)) ||       // 198.18.0.0/15 (benchmark)
      (a === 203 && b === 0 && c === 113) ||         // 203.0.113.0/24 (documentation)
      a >= 224                                       // multicast + reserved
    ) {
      throw new Error(`Private/reservierte IP verboten: ${host}`);
    }
  }

  // Metadata-Dienste
  if (host.includes("169.254") || host.includes("metadata") || host.includes("internal")) {
    throw new Error(`Metadata/interne Adressen verboten: ${host}`);
  }

  return url;
}

// Git-Subkommando Whitelist (verhindert Shell-Injection über git_op)
const GIT_ALLOWED_SUBCMDS = new Set([
  "status", "diff", "log", "show", "add", "commit", "push", "pull",
  "fetch", "clone", "checkout", "branch", "merge", "rebase", "stash",
  "tag", "remote", "init", "reset", "revert",
]);

function parseGitArgs(argsString) {
  // Rudimentäres Shell-Split (keine Pipe, kein ;, kein &&)
  if (/[;&|`$]/.test(argsString)) {
    throw new Error(`Shell-Metazeichen in git-Argumenten verboten`);
  }
  const parts = argsString.trim().split(/\s+/);
  const subcmd = parts[0];
  if (!GIT_ALLOWED_SUBCMDS.has(subcmd)) {
    throw new Error(`Git-Subkommando nicht erlaubt: ${subcmd}`);
  }
  return parts; // ["status"] oder ["commit", "-m", "msg"]
}

// ── Tool Definitionen ────────────────────────────────────────
export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Ruft eine URL ab. Nur HTTPS/HTTP, keine lokalen/privaten Adressen.",
      parameters: {
        type: "object",
        properties: {
          url:    { type: "string" },
          method: { type: "string", enum: ["GET", "POST"], default: "GET" },
          body:   { type: "string" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Liest eine Datei aus /workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description: "Schreibt eine Datei in /workspace.",
      parameters: {
        type: "object",
        properties: {
          path:    { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "Listet Dateien in einem /workspace Verzeichnis.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", default: "/" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_exec",
      description: "Führt Shell-Befehl in /workspace aus. Nur wenn ALLOW_SHELL=true.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd:     { type: "string", default: "/" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_op",
      description: "Git-Operationen (status/diff/add/commit/push etc.). Nur wenn ALLOW_GIT=true.",
      parameters: {
        type: "object",
        properties: {
          args: { type: "string", description: "z.B. 'status', 'add -A', 'commit -m msg'" },
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
    case "web_fetch": {
      if (!can("web")) return { error: "Web-Zugriff deaktiviert" };
      const url = safeUrl(args.url);
      log(url);
      const res = await fetch(url, {
        method: args.method || "GET",
        body: args.body || undefined,
        headers: { "User-Agent": "EsoBot/1.0" },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      return { status: res.status, content: text.slice(0, 8000), truncated: text.length > 8000 };
    }

    case "file_read": {
      if (!can("files")) return { error: "Dateizugriff deaktiviert" };
      const p = safePath(args.path);
      log(p);
      const content = await fs.readFile(p, "utf-8");
      return { content: content.slice(0, 16000), truncated: content.length > 16000 };
    }

    case "file_write": {
      if (!can("files")) return { error: "Dateizugriff deaktiviert" };
      const p = safePath(args.path);
      log(p);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, args.content, "utf-8");
      return { ok: true, path: args.path, bytes: Buffer.byteLength(args.content) };
    }

    case "list_files": {
      if (!can("files")) return { error: "Dateizugriff deaktiviert" };
      const p = safePath(args.path || "/");
      log(p);
      const entries = await fs.readdir(p, { withFileTypes: true });
      return { path: args.path || "/", entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })) };
    }

    case "shell_exec": {
      if (!can("shell")) return { error: "Shell deaktiviert. In Eso Bot Settings aktivieren." };
      const cwd = safePath(args.cwd || "/");
      log(`${args.command} (cwd: ${cwd})`);
      const { stdout, stderr } = await execFileAsync("bash", ["-c", args.command], {
        cwd,
        timeout: 30_000,
        maxBuffer: 1024 * 512,
        env: { ...process.env, HOME: WORKSPACE, PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
      });
      return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), truncated: stdout.length > 8000 };
    }

    case "git_op": {
      if (!can("git")) return { error: "Git deaktiviert. In Eso Bot Settings aktivieren." };
      const gitArgs = parseGitArgs(args.args); // wirft bei Injection-Versuch
      log(gitArgs.join(" "));
      const { stdout, stderr } = await execFileAsync("git", gitArgs, {
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

export function getActiveTools() {
  return TOOL_DEFINITIONS.filter(t => {
    const n = t.function.name;
    if (n === "web_fetch")  return can("web");
    if (n === "shell_exec") return can("shell");
    if (n === "git_op")     return can("git");
    if (["file_read", "file_write", "list_files"].includes(n)) return can("files");
    return true;
  });
}
