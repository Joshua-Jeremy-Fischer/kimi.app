/**
 * ESO Bot — Flexibler Task-Scheduler
 * Führt Aufgaben zu beliebigen Uhrzeiten aus (einmalig oder wiederkehrend).
 * Tasks werden in /data/scheduled-tasks.json gespeichert.
 */

import fs from "fs/promises";

const TASKS_FILE = "/data/scheduled-tasks.json";
const TICK_MS = 60_000; // jede Minute prüfen

let webSearchFn = null;
let addPostfachFn = null;
let sendEmailFn = null;
let llmClientFn = null;

// ── Task Storage ──────────────────────────────────────────────

async function loadTasks() {
  try { return JSON.parse(await fs.readFile(TASKS_FILE, "utf8")); }
  catch { return []; }
}

async function saveTasks(tasks) {
  await fs.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

// ── Task ausführen ────────────────────────────────────────────

async function executeTask(task) {
  console.log(`[Scheduler] Führe Task aus: "${task.instruction}" (ID: ${task.id})`);

  let result = "";

  // Web-Recherche immer durchführen (Scheduler-Tasks sind immer recherche-basiert)
  if (webSearchFn) {
    try {
      const sr = await webSearchFn(task.instruction);
      if (sr?.results?.length) {
        result = sr.results.slice(0, 5)
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.snippet || ""}\n   ${r.url}`)
          .join("\n\n");
      }
    } catch (e) {
      result = `(Suche fehlgeschlagen: ${e.message})`;
    }
  }

  // Mit LLM aufbereiten wenn Ergebnisse vorhanden
  if (result && llmClientFn) {
    try {
      const client = llmClientFn();
      const { model } = client._options || {};
      const resp = await client.chat.completions.create({
        model: model || "kimi-k2.5",
        messages: [
          { role: "system", content: "Du bist ESO Bot. Fasse die Suchergebnisse kompakt auf Deutsch zusammen. Max 5 Bullet-Points." },
          { role: "user", content: `Aufgabe: ${task.instruction}\n\nSuchergebnisse:\n${result}` }
        ],
        max_tokens: 800
      });
      result = (resp.choices[0].message.content || result)
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<\/?think>/gi, "")
        .trim();
    } catch {}
  }

  const content = result || `Aufgabe "${task.instruction}" wurde ausgeführt (keine Suchergebnisse).`;
  const title = `⏰ ${task.instruction.slice(0, 60)}${task.instruction.length > 60 ? "…" : ""}`;

  // Ins Postfach schreiben
  if (addPostfachFn) {
    await addPostfachFn(title, content, "info");
  }

  // E-Mail senden wenn gewünscht
  if (sendEmailFn && task.sendEmail) {
    try {
      await sendEmailFn(task.sendEmail, title, content);
    } catch (e) {
      console.error("[Scheduler] E-Mail Fehler:", e.message);
    }
  }

  console.log(`[Scheduler] Task abgeschlossen: "${task.instruction}"`);
}

// ── Scheduler Tick ────────────────────────────────────────────

async function tick() {
  const tasks = await loadTasks();
  const now = Date.now();
  let changed = false;

  for (const task of tasks) {
    if (task.done) continue;
    if (!task.executeAt) continue;

    const execTime = new Date(task.executeAt).getTime();
    if (now >= execTime) {
      try {
        await executeTask(task);
      } catch (e) {
        console.error(`[Scheduler] Fehler bei Task ${task.id}:`, e.message);
      }

      if (task.repeat) {
        // Nächsten Ausführungszeitpunkt berechnen
        task.executeAt = nextRepeatTime(task.repeat, execTime);
      } else {
        task.done = true;
      }
      changed = true;
    }
  }

  if (changed) await saveTasks(tasks);
}

function nextRepeatTime(repeat, fromMs) {
  const map = {
    daily: 24 * 60 * 60_000,
    hourly: 60 * 60_000,
    weekly: 7 * 24 * 60 * 60_000,
  };
  const interval = map[repeat];
  if (!interval) return null;
  // Nächster Zeitpunkt nach jetzt (nicht nur +interval, falls mehrere verpasst)
  let next = fromMs + interval;
  while (next < Date.now()) next += interval;
  return new Date(next).toISOString();
}

// ── Public API ────────────────────────────────────────────────

export async function createTask({ instruction, executeAt, repeat, sendEmail }) {
  const tasks = await loadTasks();
  const task = {
    id: `task-${Date.now()}`,
    instruction,
    executeAt,   // ISO string
    repeat,      // "daily" | "hourly" | "weekly" | null
    sendEmail,   // E-Mail-Adresse oder null
    done: false,
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  await saveTasks(tasks);
  console.log(`[Scheduler] Task angelegt: "${instruction}" um ${executeAt}`);
  return task;
}

export async function listTasks() {
  const tasks = await loadTasks();
  return tasks.filter(t => !t.done);
}

export async function deleteTask(id) {
  const tasks = await loadTasks();
  const updated = tasks.filter(t => t.id !== id);
  await saveTasks(updated);
}

export function startScheduler({ webSearch, addPostfach, sendEmail, makeLLMClient }) {
  webSearchFn = webSearch;
  addPostfachFn = addPostfach;
  sendEmailFn = sendEmail;
  llmClientFn = makeLLMClient;

  tick().catch(e => console.error("[Scheduler] Tick-Fehler:", e.message));
  setInterval(() => tick().catch(e => console.error("[Scheduler] Tick-Fehler:", e.message)), TICK_MS);
  console.log("[Scheduler] Gestartet — prüft jede Minute auf fällige Tasks.");
}
