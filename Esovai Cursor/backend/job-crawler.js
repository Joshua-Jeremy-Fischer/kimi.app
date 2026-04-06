import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright-core";

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium-browser";

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

// ── Standort-Logik: NUR Remote ODER München↔Mühldorf Korridor ───────────────
// Linie: München → Trudering → Riem → Feldkirchen → Vaterstetten → Baldham →
//   Zorneding → Poing → Markt Schwaben → Ottenhofen → Hörlkofen →
//   Walpertskirchen → Dorfen → Schwindegg → Ampfing → Mettenheim → Mühldorf
// Bus-Ast: St. Wolfgang, Ebersberg
// Alles andere (NRW, BW, Norddeutschland, "deutschlandweit" ohne Remote) → raus

const REMOTE_KEYWORDS = [
  "remote", "homeoffice", "home office", "home-office",
  "vollständig remote", "komplett remote", "100% remote", "100 % remote",
  "full remote", "fully remote", "arbeitest von zu hause", "arbeiten von zu hause",
];

const MUNICH_CORRIDOR = [
  "münchen", "munich", "muenchen",
  "trudering", "riem", "feldkirchen",
  "vaterstetten", "baldham", "zorneding",
  "poing", "markt schwaben", "ottenhofen",
  "hörlkofen", "hoerlkofen", "walpertskirchen",
  "dorfen", "schwindegg", "ampfing",
  "mettenheim", "mühldorf", "muehldorf",
  "ebersberg", "st. wolfgang", "st wolfgang", "sankt wolfgang",
];

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

// Schritt 2: Standortfilter nach Detail-Fetch — Remote ODER München↔Mühldorf Korridor
function passesLocationFilter(enriched) {
  const text = `${enriched.title || ""} ${enriched.location || ""} ${enriched.snippet || ""}`.toLowerCase();
  // Remote hat höchste Priorität
  if (REMOTE_KEYWORDS.some(k => text.includes(k))) return true;
  // Korridor-Check
  if (MUNICH_CORRIDOR.some(place => text.includes(place))) return true;
  // Alles andere raus — auch "deutschlandweit", "Bayern", "irgendwo in DE"
  return false;
}

// Datum-Suffix für Google after: — ab 1. April des aktuellen Jahres
const AFTER_DATE = `after:${new Date().getFullYear()}-04-01`;

const PROFILES = [
  {
    id: "it-security",
    label: "IT Security",
    browserKeywords: "Junior IT Security Analyst SOC",
    queries: [
      `site:stepstone.de/stellenangebote Junior SOC Analyst München Remote ${AFTER_DATE}`,
      `site:stellenanzeigen.de/job Junior IT Security Analyst Remote Deutschland ${AFTER_DATE}`,
      `site:de.indeed.com/viewjob Junior IT Security Analyst München Remote ${AFTER_DATE}`,
      `site:de.indeed.com/rc/clk Junior ISMS IAM Analyst Remote Deutschland ${AFTER_DATE}`,
      `site:linkedin.com/jobs/view Junior SOC Analyst IT Security München Remote ${AFTER_DATE}`,
    ],
  },
  {
    id: "kaufmaennisch",
    label: "Kaufmännisch",
    browserKeywords: "Sachbearbeiter Innendienst Kaufmännisch",
    queries: [
      `site:stepstone.de/stellenangebote Sachbearbeiter Innendienst München Erding ${AFTER_DATE}`,
      `site:stellenanzeigen.de/job Kaufmännischer Mitarbeiter Innendienst Mühldorf Rosenheim ${AFTER_DATE}`,
      `site:de.indeed.com/viewjob Sachbearbeiter Großhandel Innendienst München ${AFTER_DATE}`,
      `site:de.indeed.com/rc/clk Disponent ERP Warenwirtschaft München Remote ${AFTER_DATE}`,
      `site:linkedin.com/jobs/view Kaufmännisch Innendienst Junior München Erding ${AFTER_DATE}`,
    ],
  },
  {
    id: "it-support-remote",
    label: "IT Support Remote",
    browserKeywords: "Junior IT Support Helpdesk Service Desk",
    queries: [
      `site:stepstone.de/stellenangebote Junior IT Support Helpdesk Remote Deutschland ${AFTER_DATE}`,
      `site:stellenanzeigen.de/job Junior IT Support Service Desk Remote Homeoffice ${AFTER_DATE}`,
      `site:de.indeed.com/viewjob Junior IT Support Specialist Remote Deutschland ${AFTER_DATE}`,
      `site:de.indeed.com/rc/clk Helpdesk Onboarding Remote Junior Deutschland ${AFTER_DATE}`,
      `site:linkedin.com/jobs/view Junior IT Support Remote Deutschland Quereinsteiger ${AFTER_DATE}`,
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

      // Alterscheck: Job vor dem 1. April des aktuellen Jahres → überspringen
      if (job.datePosted) {
        const posted = new Date(job.datePosted);
        const cutoff = new Date(`${new Date().getFullYear()}-04-01`);
        if (posted < cutoff) {
          console.log(`[JOB-CRAWLER] Überspringe alten Job (${job.datePosted}): ${job.title}`);
          continue;
        }
      }

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
        postedDate: job.datePosted || "",
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

      // Stelle bereits offline/abgelaufen → überspringen
      const expired = [
        "diese anzeige ist nicht mehr online",
        "stellenangebot nicht mehr verfügbar",
        "diese stelle ist nicht mehr verfügbar",
        "this job has expired",
        "job is no longer available",
        "anzeige wurde deaktiviert",
        "es werden keine bewerbungen mehr angenommen",
      ];
      const htmlLower = html.slice(0, 5000).toLowerCase();
      if (expired.some(s => htmlLower.includes(s))) {
        console.log(`[JOB-CRAWLER] Überspringe abgelaufene Stelle: ${url}`);
        return null;
      }

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

// ── Hilfsfunktion: Browser starten, Seite laden, Jobs extrahieren ─────────────
async function browserFetchJobs(url, extractFn, label) {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-setuid-sandbox", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "de-DE,de;q=0.9" });
    await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
    console.log(`[BROWSER] ${label} → ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const jobs = await extractFn(page).catch(() => []);
    const valid = jobs.filter(j => j.title && j.url);
    console.log(`[BROWSER] ${label}: ${valid.length} Jobs`);
    return valid;
  } catch (e) {
    console.warn(`[BROWSER] ${label} Fehler: ${e.message}`);
    return [];
  } finally {
    await browser?.close();
  }
}

// ── Stepstone ─────────────────────────────────────────────────────────────────
async function browserSearchStepstone(keywords, opts = {}) {
  const slug = keywords.replace(/\s+/g, "-").toLowerCase();
  const url = opts.remote
    ? `https://www.stepstone.de/stellenangebote/${encodeURIComponent(slug)}.html?homeoffice=2&sort=2`
    : `https://www.stepstone.de/stellenangebote/${encodeURIComponent(slug)}/in-münchen.html?sort=2&radius=50`;
  return browserFetchJobs(url, async (page) => {
    await page.waitForSelector('[data-at="job-item"]', { timeout: 8_000 }).catch(() => {});
    return page.$$eval('[data-at="job-item"]', (cards) =>
      cards.slice(0, 15).map(c => ({
        title: c.querySelector('[data-at="job-item-title"]')?.innerText?.trim() || "",
        company: c.querySelector('[data-at="job-item-company-name"]')?.innerText?.trim() || "",
        location: c.querySelector('[data-at="job-item-location"]')?.innerText?.trim() || "",
        url: c.querySelector('a[href*="stellenangebote"]')?.href || "",
        snippet: c.querySelector('[data-at="job-item-description"]')?.innerText?.trim() || "",
      }))
    );
  }, `Stepstone/${opts.remote ? "remote" : "münchen"}`);
}

// ── Indeed ────────────────────────────────────────────────────────────────────
async function browserSearchIndeed(keywords, opts = {}) {
  const q = encodeURIComponent(keywords);
  const url = opts.remote
    ? `https://de.indeed.com/jobs?q=${q}&remotejob=032b3046-06a3-4876-8dfd-474eb5e7ed11&sort=date&fromage=30`
    : `https://de.indeed.com/jobs?q=${q}&l=M%C3%BCnchen&radius=50&sort=date&fromage=30`;
  return browserFetchJobs(url, async (page) => {
    await page.waitForSelector(".job_seen_beacon, [data-jk]", { timeout: 8_000 }).catch(() => {});
    return page.$$eval(".job_seen_beacon", (cards) =>
      cards.slice(0, 15).map(c => ({
        title: c.querySelector(".jobTitle a span, .jobTitle span")?.innerText?.trim() || "",
        company: c.querySelector('[data-testid="company-name"]')?.innerText?.trim() || "",
        location: c.querySelector('[data-testid="text-location"]')?.innerText?.trim() || "",
        url: "https://de.indeed.com" + (c.querySelector(".jobTitle a")?.getAttribute("href") || ""),
        snippet: c.querySelector(".job-snippet")?.innerText?.trim() || "",
      }))
    );
  }, `Indeed/${opts.remote ? "remote" : "münchen"}`);
}

// ── Bundesagentur für Arbeit API (kostenlos, offiziell, kein Browser nötig) ──
async function searchBundesagentur(keywords, location = null) {
  try {
    const url = new URL("https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs");
    url.searchParams.set("was", keywords);
    if (location) { url.searchParams.set("wo", location); url.searchParams.set("umkreis", "50"); }
    url.searchParams.set("angebotsart", "1");
    url.searchParams.set("page", "1");
    url.searchParams.set("size", "25");
    url.searchParams.set("zeitraum", "30");
    const r = await fetch(url.toString(), {
      headers: { "User-Agent": "Mozilla/5.0", "OAuthAccessToken": "jobboerse-jobsuche" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) { console.warn(`[BA] API ${r.status}`); return []; }
    const data = await r.json();
    const results = (data.stellenangebote || []).map(job => ({
      title: job.titel || "",
      company: job.arbeitgeber || "",
      location: job.arbeitsort?.ort || "",
      url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${job.hashId}`,
      snippet: `${job.beruf || ""} ${job.arbeitgeber || ""}`.trim(),
      postedDate: job.modifikationsTimestamp
        ? new Date(job.modifikationsTimestamp).toISOString().slice(0, 10) : "",
    }));
    console.log(`[BA] Bundesagentur (${location || "remote"}): ${results.length} Jobs`);
    return results;
  } catch (e) { console.warn(`[BA] Fehler: ${e.message}`); return []; }
}

// ── Alle Quellen für ein Profil zusammenführen ────────────────────────────────
async function browserSearchAll(profile) {
  const kw = profile.browserKeywords || profile.label;
  const [stLocal, stRemote, inLocal, inRemote, baLocal, baRemote] = await Promise.all([
    browserSearchStepstone(kw, { remote: false }),
    browserSearchStepstone(kw, { remote: true }),
    browserSearchIndeed(kw, { remote: false }),
    browserSearchIndeed(kw, { remote: true }),
    searchBundesagentur(kw, "München"),
    searchBundesagentur(kw + " Homeoffice Remote"),
  ]);
  return [...stLocal, ...stRemote, ...inLocal, ...inRemote, ...baLocal, ...baRemote];
}

async function runSearch(profile, webSearch, makeLLMClient) {
  const provider = nextProvider();
  console.log(`[JOB-CRAWLER] Starte Suche: ${profile.label} via ${provider} + Browser`);
  const allRaw = [];

  // SearXNG + Browser parallel starten
  const [, browserResults] = await Promise.all([
    // SearXNG-Queries
    (async () => {
      for (const query of profile.queries) {
        try {
          const result = await webSearch(query, provider);
          if (result.results?.length) {
            for (const r of result.results) {
              if (!allRaw.find(x => x.url === r.url)) allRaw.push(r);
            }
          }
        } catch (e) {
          console.error(`[JOB-CRAWLER] Suche fehlgeschlagen (${query}):`, e.message);
        }
      }
    })(),
    // Headless Browser direkt auf Stepstone
    browserSearchAll(profile).catch(e => {
      console.warn(`[BROWSER] Fehler: ${e.message}`);
      return [];
    }),
  ]);

  // Browser-Ergebnisse dedupliziert hinzufügen
  for (const r of browserResults) {
    if (r.url && !allRaw.find(x => x.url === r.url)) allRaw.push(r);
  }
  console.log(`[JOB-CRAWLER] ${profile.label}: ${allRaw.length} gesamt (SearXNG + Browser)`);

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

  return locationFiltered.map(r => {
    const datePart = r.postedDate ? ` · ${new Date(r.postedDate).toLocaleDateString("de-DE")}` : "";
    return `Titel: ${r.title}${r.company ? ` — ${r.company}` : ""}${r.location ? ` (${r.location})` : ""}${datePart}\nURL: ${r.url}\nBeschreibung: ${(r.snippet || "").slice(0, 250)}`;
  }).join("\n---\n");
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
