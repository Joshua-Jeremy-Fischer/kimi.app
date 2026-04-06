import fs from "fs/promises";
import path from "path";

const RESULTS_FILE = "/data/jobs.json";
const COUNTER_FILE = "/data/search-counter.json";
const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 Stunden

// Rotation: SearXNG kostenlos (selbst-gehostet) als Standard, paid APIs 1/10 je ~144/Monat
const PROVIDER_ROTATION = [
  "tavily", "serper", "brave",
  "searxng", "searxng", "searxng",
  "searxng", "searxng", "searxng", "searxng"
];

let searchCounter = 0;

async function loadCounter() {
  try {
    const raw = await fs.readFile(COUNTER_FILE, "utf8");
    searchCounter = JSON.parse(raw).count || 0;
  } catch { searchCounter = 0; }
}

async function saveCounter() {
  try { await fs.writeFile(COUNTER_FILE, JSON.stringify({ count: searchCounter }), "utf8"); } catch {}
}

function nextProvider() {
  const provider = PROVIDER_ROTATION[searchCounter % PROVIDER_ROTATION.length];
  searchCounter++;
  saveCounter();
  return provider;
}

// ── Keyword-Filter pro Profil ────────────────────────────────
// Score: +1 pro Include-Treffer, disqualifiziert bei Exclude-Treffer
const PROFILE_FILTERS = {
  "it-security": {
    include: ["security", "soc", "isms", "iam", "analyst", "cyber", "siem", "soar", "informationssicherheit", "it-sicherheit", "junior", "quereinsteiger", "remote", "homeoffice", "home office", "münchen", "erding", "dorfen"],
    exclude: ["senior", "lead", "head of", "studium erforderlich", "hochschulabschluss zwingend", "außendienst", "fahrer", "pflicht.*studium"],
  },
  "kaufmaennisch": {
    include: ["sachbearbeiter", "innendienst", "kaufmännisch", "einkauf", "vertrieb", "disponent", "erp", "warenwirtschaft", "auftragsabwicklung", "münchen", "erding", "dorfen", "mühldorf", "rosenheim", "landshut", "remote"],
    exclude: ["senior", "außendienst >20%", "lager", "produktion", "callcenter ohne", "pflicht.*studium"],
  },
  "it-support-remote": {
    include: ["it support", "helpdesk", "service desk", "onboarding", "technical support", "it consultant", "junior", "remote", "homeoffice", "home office", "deutschland"],
    exclude: ["senior", "vor-ort zwingend", "studium erforderlich", "außendienst", "hardware reparatur"],
  },
};

function scoreResult(result, profileId) {
  const text = `${result.title} ${result.snippet || ""}`.toLowerCase();
  const filter = PROFILE_FILTERS[profileId];
  if (!filter) return 1;
  for (const ex of filter.exclude) {
    if (new RegExp(ex, "i").test(text)) return -1; // disqualifiziert
  }
  let score = 0;
  for (const inc of filter.include) {
    if (text.includes(inc.toLowerCase())) score++;
  }
  return score;
}

const PROFILES = [
  {
    id: "it-security",
    label: "IT Security",
    queries: [
      "Junior SOC Analyst Stellenangebot München Remote 2025 2026",
      "Junior IT Security Analyst Stelle Großraum München Quereinsteiger",
      "ISMS Koordinator Junior Stelle Deutschland Remote",
      "IAM Engineer Junior Stelle München Erding",
    ],
  },
  {
    id: "kaufmaennisch",
    label: "Kaufmännisch",
    queries: [
      "Sachbearbeiter Einkauf Vertrieb Stelle Dorfen Erding München 2025 2026",
      "Kaufmännischer Mitarbeiter Innendienst Stelle Mühldorf Rosenheim Landshut",
      "Disponent ERP Stelle München Großraum",
      "Sales Coordinator Junior Account Manager B2B Stelle München",
    ],
  },
  {
    id: "it-support-remote",
    label: "IT Support Remote",
    queries: [
      "IT Support Specialist Remote Stelle Deutschland 2025 2026",
      "Junior IT Consultant Remote Stelle Deutschland Quereinsteiger",
      "SaaS Onboarding Specialist Junior Remote Deutschland",
      "Helpdesk IT Service Desk Remote Stelle Deutschland Junior",
    ],
  },
];

let jobStore = { lastRun: null, results: {}, running: false };

async function loadPersistedResults() {
  try {
    const raw = await fs.readFile(RESULTS_FILE, "utf8");
    jobStore = JSON.parse(raw);
  } catch {
    // Noch keine gespeicherten Ergebnisse
  }
}

async function saveResults() {
  try {
    await fs.mkdir(path.dirname(RESULTS_FILE), { recursive: true });
    await fs.writeFile(RESULTS_FILE, JSON.stringify(jobStore, null, 2), "utf8");
  } catch (e) {
    console.error("[JOB-CRAWLER] Speichern fehlgeschlagen:", e.message);
  }
}

async function runSearch(profile, webSearch, makeLLMClient) {
  const provider = nextProvider();
  console.log(`[JOB-CRAWLER] Starte Suche: ${profile.label} via ${provider}`);
  const allRaw = []; // raw result objects {title, url, snippet}

  for (const query of profile.queries) {
    try {
      const result = await webSearch(query, provider);
      if (result.results?.length) {
        for (const r of result.results) {
          // Deduplizieren nach URL
          if (!allRaw.find(x => x.url === r.url)) allRaw.push(r);
        }
      }
    } catch (e) {
      console.error(`[JOB-CRAWLER] Suche fehlgeschlagen (${query}):`, e.message);
    }
  }

  if (allRaw.length === 0) {
    return "Keine Suchergebnisse gefunden.";
  }

  // Keyword-Scoring: nur Treffer die zum Profil passen
  const scored = allRaw
    .map(r => ({ ...r, score: scoreResult(r, profile.id) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);

  console.log(`[JOB-CRAWLER] ${profile.label}: ${allRaw.length} gefunden → ${scored.length} nach Filterung`);

  if (scored.length === 0) return "Keine passenden Stellen gefunden.";

  return scored.slice(0, 12).map(r =>
    `Titel: ${r.title}\nURL: ${r.url}\nBeschreibung: ${(r.snippet || "").slice(0, 200)}`
  ).join("\n---\n");
}

export async function crawlJobs(webSearch, makeLLMClient) {
  if (jobStore.running) {
    console.log("[JOB-CRAWLER] Läuft bereits, überspringe.");
    return;
  }
  jobStore.running = true;
  jobStore.lastRun = new Date().toISOString();

  for (const profile of PROFILES) {
    jobStore.results[profile.id] = {
      label: profile.label,
      updatedAt: new Date().toISOString(),
      status: "running",
      content: "",
    };
  }

  for (const profile of PROFILES) {
    const content = await runSearch(profile, webSearch, makeLLMClient);
    jobStore.results[profile.id] = {
      label: profile.label,
      updatedAt: new Date().toISOString(),
      status: "done",
      content,
    };
  }

  jobStore.running = false;
  await saveResults();
  console.log(`[JOB-CRAWLER] Durchlauf abgeschlossen: ${jobStore.lastRun}`);

  // Ergebnisse ins Postfach schreiben
  try {
    const { addPostfachEntry } = await import("./agent.js");
    const profiles = Object.values(jobStore.results).filter(p => p.content);
    for (const p of profiles) {
      const blocks = (p.content || "").split("---").filter(b => b.includes("Titel:"));
      const count = blocks.length;
      const title = `💼 ${p.label}: ${count > 0 ? `${count} passende Stelle${count !== 1 ? "n" : ""} ✓` : "Keine passenden Stellen"}`;
      await addPostfachEntry(title, p.content, "jobs");
    }
  } catch (e) {
    console.warn("[JOB-CRAWLER] Postfach-Write fehlgeschlagen:", e.message);
  }
}

export async function startJobCrawler(webSearch, makeLLMClient) {
  await loadPersistedResults();
  await loadCounter();
  console.log("[JOB-CRAWLER] Gestartet — läuft alle 6 Stunden.");

  // Sofort einmal laufen lassen
  crawlJobs(webSearch, makeLLMClient);

  setInterval(() => {
    crawlJobs(webSearch, makeLLMClient);
  }, INTERVAL_MS);
}

export function getJobResults() {
  return jobStore;
}
