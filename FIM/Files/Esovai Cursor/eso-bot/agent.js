import OpenAI from "openai";
import { getActiveTools, executeTool } from "./tools.js";

// ── LLM Client (direkt zu Ollama oder konfigurierbarem Provider) ──
const client = new OpenAI({
  apiKey:  process.env.LLM_API_KEY  || "ollama",
  baseURL: process.env.LLM_BASE_URL || "http://ollama:11434/v1",
});
const DEFAULT_MODEL = process.env.LLM_MODEL || "kimi-k2.5:cloud";
const MAX_ITERATIONS = 20; // Sicherheits-Limit: max 20 Tool-Runden

// ── Agent Loop ────────────────────────────────────────────────
// Schickt Messages an LLM → führt Tools aus → wiederholt bis fertig
export async function runAgentLoop({ messages, system, maxIterations = MAX_ITERATIONS, model }) {
  const useModel = model || DEFAULT_MODEL;
  const tools    = getActiveTools();

  // System-Message vorbereiten
  const systemMsg = [
    "Du bist Eso Bot, der autonome ESOVAI-Assistent.",
    "Nutze die verfügbaren Tools um Aufgaben vollständig zu erledigen.",
    "Wenn du fertig bist, antworte mit einer klaren Zusammenfassung was du getan hast.",
    system,
  ].filter(Boolean).join("\n\n");

  // Message-History für diese Session
  const history = [
    { role: "system", content: systemMsg },
    ...messages,
  ];

  const toolCallLog = []; // Protokoll aller Tool-Aufrufe
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;
    console.log(`[AGENT] Iteration ${iteration}/${maxIterations}`);

    // LLM aufrufen
    const response = await client.chat.completions.create({
      model: useModel,
      messages: history,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? "auto" : undefined,
      max_tokens: 4000,
    });

    const msg = response.choices[0].message;
    history.push(msg);

    // Keine Tool-Calls → Antwort ist fertig
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log(`[AGENT] Fertig nach ${iteration} Iteration(en)`);
      return {
        content:   msg.content || "",
        toolCalls: toolCallLog,
        iterations: iteration,
        model:     useModel,
      };
    }

    // Tool-Calls ausführen (parallel)
    const toolResults = await Promise.all(
      msg.tool_calls.map(async (tc) => {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = {};
        }

        console.log(`[AGENT] Tool: ${tc.function.name}`, JSON.stringify(args).slice(0, 100));

        let result;
        try {
          result = await executeTool(tc.function.name, args);
        } catch (err) {
          result = { error: err.message };
        }

        toolCallLog.push({
          tool:   tc.function.name,
          args,
          result,
          ts:     new Date().toISOString(),
        });

        return {
          role:         "tool",
          tool_call_id: tc.id,
          content:      JSON.stringify(result),
        };
      })
    );

    // Tool-Ergebnisse zur History hinzufügen
    history.push(...toolResults);
  }

  // Max Iterations erreicht
  console.warn(`[AGENT] Max Iterations (${maxIterations}) erreicht`);
  return {
    content:    `Aufgabe nach ${maxIterations} Iterationen noch nicht abgeschlossen. Zwischenstand:\n${toolCallLog.map(t => `• ${t.tool}: ${JSON.stringify(t.result).slice(0, 100)}`).join("\n")}`,
    toolCalls:  toolCallLog,
    iterations: maxIterations,
    model:      useModel,
    incomplete: true,
  };
}
