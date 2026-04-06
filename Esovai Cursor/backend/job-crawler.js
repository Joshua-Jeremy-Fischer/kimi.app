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
    systemPrompt: `Du bist ein Job-Crawler-Agent. Analysiere die Suchergebnisse und filtere passende Stellenangebote heraus.

ZIELROLLEN: Junior SOC Analyst, Junior IT-Security Analyst, Junior Koordinator Informationssicherheit, IT-Security Administrator, Junior IAM Engineer, ISMS-Koordinator (Junior)

KANDIDATENPROFIL: IT-Quereinsteiger mit kaufmännischem Hintergrund, Erfahrung: Active Directory, Entra ID, Wazuh SIEM, Shuffle SOAR, Splunk, MITRE ATT&CK, IAM im ERP WW90/AS400, laufende IHK-Zertifizierung Informationssicherheit (Herbst 2026), Homelab, Deutsch nativ, Englisch fließend, KEIN Hochschulstudium.

STANDORT: Dorfen/Erding/München (bis 60 km) ODER vollständig Remote/Home Office deutschlandweit.

AUSSCHLUSSKRITERIEN: Senior (>3 Jahre Pflicht), Pflicht-Studium, kein Security-Bezug, Außendienst >30%.

Gib nur passende Stellen aus im Format (eine pro Zeile):
Jobtitel | Unternehmen | Standort | Remote-Anteil | Bewerbungslink | Datum

Falls keine passenden Stellen gefunden: schreibe "Keine passenden Stellen gefunden."`,
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
    systemPrompt: `Du bist ein Job-Crawler-Agent. Analysiere die Suchergebnisse und filtere passende Stellenangebote heraus.

ZIELROLLEN: Sachbearbeiter Einkauf/Vertrieb/Auftragsabwicklung, Kaufmännischer Mitarbeiter Innendienst, Disponent, Mitarbeiter Warenwirtschaft/ERP, Sales Coordinator, Junior Account Manager B2B

KANDIDATENPROFIL: Ausgebildeter Kaufmann im Groß- und Außenhandel, Erfahrung ERP-Systeme (WW90/AS400), Stammdatenpflege, strukturierte Arbeitsweise, Deutsch nativ, Englisch fließend.

STANDORT: Dorfen, Erding, Mühldorf, Rosenheim, Landshut, München (bis 50 km) ODER vollständig Remote.

AUSSCHLUSSKRITERIEN: reiner Außendienst/Reisetätigkeit >20%, reiner Lager-/Logistikfokus, Callcenter ohne Sachbearbeitung.

Gib nur passende Stellen aus im Format (eine pro Zeile):
Jobtitel | Unternehmen | Standort | Remote-Anteil | Bewerbungslink | Datum

Falls keine passenden Stellen gefunden: schreibe "Keine passenden Stellen gefunden."`,
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
    systemPrompt: `Du bist ein Job-Crawler-Agent. Analysiere die Suchergebnisse und filtere passende Stellenangebote heraus.

ZIELROLLEN: IT Support Specialist (Remote), Technical Support Engineer, Junior IT Sales/SDR, Junior Account Manager IT/SaaS, SaaS Onboarding Specialist, IT Consultant (Junior), Helpdesk/IT Service Desk (Remote), Presales Support (Junior)

KANDIDATENPROFIL: Kaufmännische Ausbildung mit IT-Bezug, Erfahrung: Active Directory, Entra ID, ERP (WW90/AS400), Cybersecurity-Grundlagen, Cloud, kommunikationsstark Deutsch+Englisch, KEIN Hochschulstudium.

STANDORT: AUSSCHLIESSLICH Remote/Home Office deutschlandweit. Gelegentlich Präsenztage (max. 2-3x/Monat) akzeptiert.

AUSSCHLUSSKRITERIEN: reine Hardware/Vor-Ort-IT, Senior (>3 Jahre Pflicht), Pflicht-Studium, Außendienst >20%, Callcenter ohne technischen Anteil.

Gib nur passende Stellen aus im Format (eine pro Zeile):
Jobtitel | Unternehmen | Standort | Remote-Anteil | Bewerbungslink | Datum

Falls keine passenden Stellen gefunden: schreibe "Keine passenden Stellen gefunden."`,
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
  const allSnippets = [];

  for (const query of profile.queries) {
    try {
      const result = await webSearch(query, provider);
      if (result.results?.length) {
        for (const r of result.results) {
          allSnippets.push(`Titel: ${r.title}\nURL: ${r.url}\nBeschreibung: ${r.snippet || ""}`);
        }
      }
    } catch (e) {
      console.error(`[JOB-CRAWLER] Suche fehlgeschlagen (${query}):`, e.message);
    }
  }

  if (allSnippets.length === 0) {
    return "Keine Suchergebnisse gefunden.";
  }

  const { client, model } = makeLLMClient();
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: profile.systemPrompt },
        { role: "user", content: `Hier sind die Suchergebnisse:\n\n${allSnippets.slice(0, 20).join("\n\n---\n\n")}` },
      ],
      max_tokens: 2000,
    });
    return response.choices[0]?.message?.content || "Keine Antwort vom Modell.";
  } catch (e) {
    console.error("[JOB-CRAWLER] LLM-Fehler:", e.message);
    return `LLM-Fehler: ${e.message}`;
  }
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
      const lines = (p.content || "").split("\n").filter(l => l.trim() && !l.includes("Keine") );
      const count = lines.length;
      const title = `💼 ${p.label}: ${count > 0 ? `${count} Stelle${count !== 1 ? "n" : ""} gefunden` : "Keine Ergebnisse"}`;
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
