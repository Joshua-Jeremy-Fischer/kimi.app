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
// Standort-Whitelist: nur Remote ODER Großraum München
const LOCATION_OK = ["remote", "homeoffice", "home office", "home-office", "deutschlandweit", "bundesweit",
  "münchen", "munich", "erding", "dorfen", "mühldorf", "rosenheim", "landshut", "freising",
  "wasserburg", "haag", "ampfing", "markt schwaben", "ebersberg", "dachau", "fürstenfeldbruck",
  "starnberg", "wolfratshausen", "holzkirchen", "miesbach", "bad aibling", "rosenheim"];

// Städte die definitiv zu weit weg sind
const LOCATION_EXCLUDE = ["berlin", "hamburg", "frankfurt", "köln", "düsseldorf", "stuttgart",
  "hannover", "bremen", "leipzig", "dresden", "nürnberg", "dortmund", "essen", "bochum",
  "wuppertal", "bielefeld", "bonn", "mannheim", "karlsruhe", "freiburg", "augsburg",
  "wien", "zürich", "schweiz", "österreich", "luxemburg"];

// Score: +1 pro Include-Treffer, disqualifiziert bei Exclude-Treffer oder falschem Standort
const PROFILE_FILTERS = {
  "it-security": {
    include: ["security", "soc", "isms", "iam", "analyst", "cyber", "siem", "soar", "informationssicherheit", "it-sicherheit", "junior", "quereinsteiger"],
    exclude: ["senior", "lead", "head of", "studium erforderlich", "hochschulabschluss zwingend", "außendienst", "fahrer"],
  },
  "kaufmaennisch": {
    include: ["sachbearbeiter", "innendienst", "kaufmännisch", "einkauf", "vertrieb", "disponent", "erp", "warenwirtschaft", "auftragsabwicklung", "großhandel"],
    exclude: ["senior", "lager", "produktion", "callcenter ohne sachbearbeitung", "reine.*fahrtätigkeit"],
  },
  "it-support-remote": {
    include: ["it support", "helpdesk", "service desk", "onboarding", "technical support", "it consultant", "junior", "quereinsteiger"],
    exclude: ["senior", "studium erforderlich", "reine hardware", "außendienst"],
  },
};

function scoreResult(result, profileId) {
  const text = `${result.title} ${result.snippet || ""}`.toLowerCase();
  const filter = PROFILE_FILTERS[profileId];
  if (!filter) return 1;

  // Harte Ausschlüsse (Profil)
  for (const ex of filter.exclude) {
    if (new RegExp(ex, "i").test(text)) return -1;
  }

  // Standort-Check: Remote ODER Großraum München — sonst disqualifiziert
  const hasOkLocation = LOCATION_OK.some(loc => text.includes(loc));
  const hasBadLocation = LOCATION_EXCLUDE.some(loc => text.includes(loc));

  // Wenn explizit eine schlechte Stadt genannt wird und kein Remote → disqualifiziert
  if (hasBadLocation && !text.includes("remote") && !text.includes("homeoffice") && !text.includes("home office")) return -1;

  let score = hasOkLocation ? 2 : 0; // Standort-Bonus
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
      "site:stepstone.de Junior SOC Analyst München Remote",
      "site:stellenanzeigen.de Junior IT Security Analyst München Quereinsteiger",
      "site:indeed.de Junior ISMS Koordinator Remote Deutschland",
      "site:xing.com Junior IAM Engineer München Erding",
    ],
  },
  {
    id: "kaufmaennisch",
    label: "Kaufmännisch",
    queries: [
      "site:stepstone.de Sachbearbeiter Innendienst Erding München",
      "site:stellenanzeigen.de Kaufmännischer Mitarbeiter Innendienst Mühldorf Rosenheim",
      "site:indeed.de Disponent ERP Stelle München Großraum",
      "site:xing.com Sales Coordinator Junior Account Manager München",
    ],
  },
  {
    id: "it-support-remote",
    label: "IT Support Remote",
    queries: [
      "site:stepstone.de IT Support Specialist Remote Deutschland Junior",
      "site:stellenanzeigen.de Junior IT Consultant Remote Deutschland Quereinsteiger",
      "site:indeed.de SaaS Onboarding Specialist Junior Remote Deutschland",
      "site:xing.com Helpdesk IT Service Desk Remote Junior Deutschland",
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

// Erkennt ob eine URL auf eine einzelne Stellenanzeige zeigt (nicht eine Übersichtsseite)
function isDetailUrl(url) {
  if (!url) return false;
  // Typische Detail-URL-Muster auf deutschen Jobbörsen
  return (
    /stellenanzeigen\.de\/job\//.test(url) ||
    /stepstone\.de\/stellenangebote-detail\//.test(url) ||
    /stepstone\.de\/stellenangebote\/[^/]+-\d+/.test(url) ||
    /indeed\.com\/viewjob/.test(url) ||
    /de\.indeed\.com\/rc\/clk/.test(url) ||
    /xing\.com\/jobs\/detail\//.test(url) ||
    /linkedin\.com\/jobs\/view\//.test(url) ||
    /monster\.de\/jobs\/suche\/detail\//.test(url) ||
    /jobs\.de\/stellenangebote\//.test(url) ||
    /karriere\.at\/jobs\/[^/]+-\d+/.test(url) ||
    /jooble\.org\/jooble\/_\d+/.test(url) ||
    /jobware\.de\/job\//.test(url) ||
    /glassdoor\.de\/job-listing\//.test(url) ||
    /remotely\.de\/job\//.test(url) ||
    /zuhausejobs\.com\/job\//.test(url)
  );
}

// Extrahiert Jobtitel, Firma, Ort aus rohem HTML-Text
function extractFromHtml(text, fallbackTitle, fallbackUrl) {
  const clean = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 3000);
  const titleMatch = clean.match(/(?:Stellentitel|Job-Titel|Position|Jobtitel)[:\s]+([^\n|]{5,80})/i)
    || clean.match(/<h1[^>]*>([^<]{5,80})<\/h1>/i);
  const companyMatch = clean.match(/(?:Unternehmen|Arbeitgeber|Firma|Company)[:\s]+([^\n|]{3,60})/i);
  const locationMatch = clean.match(/(?:Standort|Arbeitsort|Ort|Location)[:\s]+([^\n|]{3,50})/i);
  return {
    title: titleMatch?.[1]?.trim() || fallbackTitle,
    company: companyMatch?.[1]?.trim() || "",
    location: locationMatch?.[1]?.trim() || "",
    snippet: clean.slice(0, 400),
  };
}

async function fetchJobDetail(url, fallbackTitle) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; JobBot/1.0)", "Accept-Language": "de-DE,de;q=0.9" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    return extractFromHtml(html, fallbackTitle, url);
  } catch {
    return null;
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

  // Top-Treffer: Detail-URLs direkt fetchen für echte Stelleninhalte
  const top = scored.slice(0, 12);
  const enriched = await Promise.all(top.map(async (r) => {
    if (isDetailUrl(r.url)) {
      console.log(`[JOB-CRAWLER] Fetch Detail: ${r.url}`);
      const detail = await fetchJobDetail(r.url, r.title);
      if (detail) return { ...r, title: detail.title || r.title, company: detail.company, location: detail.location, snippet: detail.snippet };
    }
    return r;
  }));

  return enriched.map(r =>
    `Titel: ${r.title}${r.company ? ` — ${r.company}` : ""}${r.location ? ` (${r.location})` : ""}\nURL: ${r.url}\nBeschreibung: ${(r.snippet || "").slice(0, 250)}`
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
