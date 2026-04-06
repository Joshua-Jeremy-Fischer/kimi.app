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
// Großraum München erreichbar ohne Auto (S-Bahn/Regionalbahn von Dorfen)
// Linie: Dorfen → Isen → Markt Schwaben → München Ost → München Hbf
// Mühldorf-Linie: Mühldorf → Ampfing → Haag → Rosenheim
const LOCATION_OK = ["remote", "homeoffice", "home office", "home-office", "deutschlandweit", "bundesweit",
  "deutschland", "germany", "deutschlandweit", "überall",
  "münchen", "munich", "erding", "dorfen", "mühldorf", "rosenheim",
  "markt schwaben", "isen", "ebersberg", "haag", "ampfing", "wasserburg",
  "poing", "zorneding", "grafing"];

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

// Schritt 1: Nur Keyword-Scoring (kein Standortfilter hier — Ort kommt oft erst aus Detail-Fetch)
function scoreKeywords(result, profileId) {
  const text = `${result.title} ${result.snippet || ""}`.toLowerCase();
  const filter = PROFILE_FILTERS[profileId];
  if (!filter) return 1;
  // Harte Keyword-Ausschlüsse
  for (const ex of filter.exclude) {
    if (new RegExp(ex, "i").test(text)) return -1;
  }
  let score = 0;
  for (const inc of filter.include) {
    if (text.includes(inc.toLowerCase())) score++;
  }
  return score;
}

// Schritt 2: Standortfilter nach Detail-Fetch auf angereichertem Text
function passesLocationFilter(enriched) {
  const text = `${enriched.title || ""} ${enriched.company || ""} ${enriched.location || ""} ${enriched.snippet || ""}`.toLowerCase();
  const hasOkLocation = LOCATION_OK.some(loc => text.includes(loc));
  if (!hasOkLocation) return false;
  const hasBadLocation = LOCATION_EXCLUDE.some(loc => text.includes(loc));
  if (hasBadLocation && !text.includes("remote") && !text.includes("homeoffice") && !text.includes("home office")) return false;
  return true;
}

const PROFILES = [
  {
    id: "it-security",
    label: "IT Security",
    queries: [
      // site:/stellenangebote-- zwingt Stepstone zur Einzelstellen-URL
      "site:stepstone.de/stellenangebote Junior SOC Analyst München Remote",
      "site:stellenanzeigen.de/job Junior IT Security Analyst Remote Deutschland",
      // Indeed viewjob = direkte Einzelstellen-URL
      "site:de.indeed.com/viewjob Junior IT Security Analyst München Remote",
      "site:de.indeed.com/rc/clk Junior ISMS IAM Analyst Remote Deutschland",
      "site:linkedin.com/jobs/view Junior SOC Analyst IT Security München Remote",
    ],
  },
  {
    id: "kaufmaennisch",
    label: "Kaufmännisch",
    queries: [
      "site:stepstone.de/stellenangebote Sachbearbeiter Innendienst München Erding",
      "site:stellenanzeigen.de/job Kaufmännischer Mitarbeiter Innendienst Mühldorf Rosenheim",
      "site:de.indeed.com/viewjob Sachbearbeiter Großhandel Innendienst München",
      "site:de.indeed.com/rc/clk Disponent ERP Warenwirtschaft München Remote",
      "site:linkedin.com/jobs/view Kaufmännisch Innendienst Junior München Erding",
    ],
  },
  {
    id: "it-support-remote",
    label: "IT Support Remote",
    queries: [
      "site:stepstone.de/stellenangebote Junior IT Support Helpdesk Remote Deutschland",
      "site:stellenanzeigen.de/job Junior IT Support Service Desk Remote Homeoffice",
      "site:de.indeed.com/viewjob Junior IT Support Specialist Remote Deutschland",
      "site:de.indeed.com/rc/clk Helpdesk Onboarding Remote Junior Deutschland",
      "site:linkedin.com/jobs/view Junior IT Support Remote Deutschland Quereinsteiger",
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

// ── User-Agent Rotation (verhindert 403/429 von Stepstone/Indeed) ──────────
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

// ── Erkennt ob eine URL auf eine Einzelstelle zeigt (nicht Übersichtsseite) ──
function isDetailUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname;
    const p = u.pathname;
    // Stepstone: muss Jobnummer-Suffix haben (--NNNNNNN.html oder /NNNNNNN)
    if (h.includes("stepstone.de"))
      return /stellenangebote\/.+--\d{6,}/.test(p) || /stellenangebote--/.test(p) || /stellenangebote-detail/.test(p);
    // Indeed: viewjob mit jk= oder rc/clk Redirect
    if (h.includes("indeed.com"))
      return p.includes("/viewjob") || u.searchParams.has("jk") || p.includes("/rc/clk") || p.includes("/pagead/clk");
    // LinkedIn: /jobs/view/NNNNN
    if (h.includes("linkedin.com"))
      return /\/jobs\/view\/\d+/.test(p);
    // Xing: /jobs/detail/
    if (h.includes("xing.com"))
      return p.includes("/jobs/detail/") || /\/jobs\/\d+/.test(p);
    // Stellenanzeigen.de: /job/
    if (h.includes("stellenanzeigen.de"))
      return p.includes("/job/");
    // Arbeitsagentur
    if (h.includes("arbeitsagentur.de"))
      return p.includes("/jobdetail") || p.includes("/angebot/");
    // Generisch: URL enthält Zahl >= 6 Stellen oder /job/ /stelle/ Pfad
    return /\/\d{6,}/.test(p) || p.includes("/job/") || p.includes("/stelle/") ||
      /jobware\.de\/job\//.test(url) || /glassdoor\.de\/job-listing\//.test(url) ||
      /remotely\.de\/job\//.test(url) || /zuhausejobs\.com\/job\//.test(url) ||
      /monster\.de\/jobs\/suche\/detail\//.test(url);
  } catch { return false; }
}

// ── LD+JSON Schema.org JobPosting Extraktion (Stepstone/Indeed befüllen das aktiv) ──
function extractLdJson(html) {
  const matches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of matches) {
    try {
      const data = JSON.parse(m[1]);
      // Direkt oder via @graph Array
      const job = data["@type"] === "JobPosting" ? data
        : (Array.isArray(data["@graph"]) ? data["@graph"].find(n => n["@type"] === "JobPosting") : null);
      if (!job) continue;
      const loc = job.jobLocation;
      const locStr = Array.isArray(loc)
        ? loc.map(l => l?.address?.addressLocality || l?.address?.addressRegion || "").filter(Boolean).join(", ")
        : (loc?.address?.addressLocality || loc?.address?.addressRegion || "");
      const isRemote = job.jobLocationType === "TELECOMMUTE"
        || (job.title || "").toLowerCase().includes("remote")
        || (job.description || "").toLowerCase().includes("remote");
      return {
        title: job.title || "",
        company: job.hiringOrganization?.name || "",
        location: isRemote ? (locStr ? `${locStr} / Remote` : "Remote") : locStr,
        snippet: (job.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 500),
        source: "ld+json",
      };
    } catch { /* weiter */ }
  }
  return null;
}

// ── Fallback: Meta-Tags + H1 ──────────────────────────────────────────────────
function extractFromHtml(html, fallbackTitle) {
  // 1. LD+JSON zuerst — beste Qualität
  const ldResult = extractLdJson(html);
  if (ldResult && ldResult.title) return ldResult;

  // 2. Open Graph / Meta-Tags
  const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]{5,100})"/i)?.[1]
    || html.match(/<meta[^>]+content="([^"]{5,100})"[^>]+property="og:title"/i)?.[1];
  const ogDesc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]{10,500})"/i)?.[1]
    || html.match(/<meta[^>]+content="([^"]{10,500})"[^>]+property="og:description"/i)?.[1];
  const h1 = html.match(/<h1[^>]*>([^<]{5,120})<\/h1>/i)?.[1]?.trim();

  // 3. Strukturierte Felder aus Text
  const clean = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const companyMatch = clean.match(/(?:Unternehmen|Arbeitgeber|Firma|Company)[:\s]+([^\n|,]{3,60})/i);
  const locationMatch = clean.match(/(?:Standort|Arbeitsort|Ort|Location|Einsatzort)[:\s]+([^\n|,]{3,60})/i);

  return {
    title: ogTitle?.trim() || h1 || fallbackTitle,
    company: companyMatch?.[1]?.trim() || "",
    location: locationMatch?.[1]?.trim() || "",
    snippet: ogDesc?.trim() || clean.slice(0, 500),
    source: "meta-fallback",
  };
}

// ── Fetch mit User-Agent Rotation + Retry/Backoff ────────────────────────────
async function fetchJobDetail(url, fallbackTitle) {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
          "Referer": "https://www.google.de/",
        },
        signal: AbortSignal.timeout(9_000),
      });
      if (r.status === 429) {
        // Rate-limited — kurz warten und nochmal
        await new Promise(res => setTimeout(res, 2500 * (attempt + 1)));
        continue;
      }
      if (!r.ok) return null;
      const html = await r.text();
      const result = extractFromHtml(html, fallbackTitle);
      console.log(`[JOB-CRAWLER] Fetch OK (${result.source}): ${result.title?.slice(0, 60)}`);
      return result;
    } catch (e) {
      if (attempt === 1) console.warn(`[JOB-CRAWLER] Fetch fehlgeschlagen: ${url} — ${e.message}`);
      await new Promise(res => setTimeout(res, 1500));
    }
  }
  return null;
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
    console.log(`[JOB-CRAWLER] ${profile.label}: 0 Suchergebnisse gefunden.`);
    return "Keine Suchergebnisse gefunden.";
  }

  // ── Stufe 1: Keyword-Filter (Standort noch NICHT prüfen — Ort fehlt oft im Snippet) ──
  const keywordScored = allRaw
    .map(r => ({ ...r, score: scoreKeywords(r, profile.id) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);

  console.log(`[JOB-CRAWLER] ${profile.label}: ${allRaw.length} gefunden → ${keywordScored.length} nach Keyword-Filter`);

  if (keywordScored.length === 0) return "Keine Stellen mit passenden Keywords.";

  // ── Stufe 2: Detail-URLs fetchen (LD+JSON liefert echten Standort) ──
  const top = keywordScored.slice(0, 15);
  const enriched = await Promise.all(top.map(async (r) => {
    if (isDetailUrl(r.url)) {
      console.log(`[JOB-CRAWLER] Fetch Detail: ${r.url}`);
      const detail = await fetchJobDetail(r.url, r.title);
      if (detail) return { ...r, title: detail.title || r.title, company: detail.company || r.company, location: detail.location || r.location, snippet: detail.snippet || r.snippet };
    }
    return r;
  }));

  // ── Stufe 3: Standortfilter auf angereichertem Text ──
  const locationFiltered = enriched.filter(r => passesLocationFilter(r));

  console.log(`[JOB-CRAWLER] ${profile.label}: ${enriched.length} nach Detail-Fetch → ${locationFiltered.length} nach Standortfilter`);

  if (locationFiltered.length === 0) {
    // Debug: zeige was rausgefiltert wurde
    const sample = enriched.slice(0, 3).map(r => `"${r.title}" (${r.location || "kein Ort"})`).join(", ");
    console.log(`[JOB-CRAWLER] ${profile.label}: Alle rausgefiltert. Beispiele: ${sample}`);
    return "Keine passenden Stellen in der Region (Remote/München-Gebiet).";
  }

  return locationFiltered.map(r =>
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
