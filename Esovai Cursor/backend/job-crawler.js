import fs from "fs/promises";
import path from "path";

const RESULTS_FILE = "/data/jobs.json";
const INTERVAL_MS  = 6 * 60 * 60 * 1000; // 6 Stunden

// ─── Bundesagentur für Arbeit (BA) ────────────────────────────────────────────
// Nutzt die öffentliche BA-Jobboerse API — kein API-Key nötig, Standard User-Agent
const BA_API_BASE   = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs";
const BA_API_DETAIL = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails";
const BA_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BA_HEADERS = {
  "User-Agent": BA_UA,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "de-DE,de;q=0.9",
  "Origin": "https://www.arbeitsagentur.de",
  "Referer": "https://www.arbeitsagentur.de/",
};

async function fetchBAJobs({ keyword, location, radius = 50, size = 25 }) {
  const params = new URLSearchParams({ was: keyword, angebotsart: "1", page: "0", size: String(Math.min(size, 25)) });
  if (location) { params.set("wo", location); params.set("umkreis", String(radius)); }
  const res = await fetch(`${BA_API_BASE}?${params}`, { headers: BA_HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`BA-API ${res.status}`);
  return (await res.json()).stellenangebote || [];
}

async function fetchBADetail(refnr) {
  try {
    const res = await fetch(`${BA_API_DETAIL}/${encodeURIComponent(refnr)}`, {
      headers: BA_HEADERS, signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return (d.stellenbeschreibung || d.beschreibung || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  } catch { return null; }
}

// ─── Web-Fetch für SearXNG-Treffer ────────────────────────────────────────────
const DOMAIN_BLACKLIST = /linkedin\.com\/authwall|signup|login|join|captcha|accounts\./i;
const MAX_FETCH_BYTES  = 300_000; // 300 KB

async function fetchJobPage(url) {
  if (DOMAIN_BLACKLIST.test(url)) return null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; EsoBot/2.0)", "Accept-Language": "de,en;q=0.9" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("html")) return null;
    // Größenlimit
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > MAX_FETCH_BYTES) { reader.cancel(); break; }
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch { return null; }
}

/** HTML → lesbarer Text für LLM (Scripts/Styles raus, max 2000 Zeichen) */
function extractJobText(html) {
  if (!html) return null;
  // JSON-LD structured data (datePosted, description)
  let publishedAt = null;
  const jsonLdMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      const arr = Array.isArray(ld) ? ld : [ld];
      for (const item of arr) {
        if (item["@type"] === "JobPosting") {
          publishedAt = item.datePosted || item.dateModified || null;
          break;
        }
      }
    } catch {}
  }
  // Meta-Tags für Datum
  if (!publishedAt) {
    const metaMatch = html.match(/<meta[^>]+(?:property|name)="(?:article:published_time|datePublished)"[^>]+content="([^"]+)"/i);
    if (metaMatch) publishedAt = metaMatch[1];
  }

  // Text extrahieren
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);

  if (text.length < 100) return null; // kein brauchbarer Text

  return { text, publishedAt };
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function jobUrlBA(refnr) {
  return `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(refnr)}`;
}

function canonicalUrl(url) {
  try {
    const u = new URL(url);
    // Tracking-Parameter entfernen
    ["utm_source","utm_medium","utm_campaign","ref","source","trk","cmp"].forEach(p => u.searchParams.delete(p));
    return u.origin + u.pathname;
  } catch { return url; }
}

function isRemote(titleOrText) {
  return /homeoffice|remote|home.office|bundesweit|deutschlandweit/i.test(titleOrText);
}

function isLocationBad(text) {
  return /\b(berlin|hamburg|frankfurt|köln|cologne|stuttgart|düsseldorf|nürnberg|nuremberg|leipzig|dresden|hannover|bremen|essen|dortmund|landshut|freising)\b/i.test(text);
}

const MS_24H = 24 * 60 * 60 * 1000;

function isWithin24h(dateStr) {
  if (!dateStr) return false;
  const ms = new Date(dateStr).getTime();
  if (isNaN(ms)) return false;
  return Date.now() - ms <= MS_24H;
}

function formatCandidate(c) {
  const { title, company, location, remote, url, publishedAt } = c;
  const datum  = (publishedAt || "").split("T")[0];
  const remStr = remote ? "Remote/HO" : (location || "Vor Ort");
  return `${title} | ${company || "–"} | ${location || "–"} | ${remStr} | ${url} | ${datum}`;
}

// ─── Concurrent fetch helper ──────────────────────────────────────────────────
async function pMap(arr, fn, concurrency = 4) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < arr.length) {
      const i = idx++;
      results[i] = await fn(arr[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, arr.length) }, worker));
  return results;
}

// ─── Profile ──────────────────────────────────────────────────────────────────
const PROFILES = [
  {
    id: "it-security",
    label: "IT Security",
    baSearches: [
      ["SOC Analyst",            "München",  60],
      ["IT Security Analyst",    "München",  60],
      ["Informationssicherheit", "München",  60],
      ["IAM Engineer",           "München",  60],
      ["SOC Analyst",            null,        0],
      ["IT Security",            "Erding",   80],
    ],
    searxQueries: [
      "Junior SOC Analyst Stelle München 2026",
      "IT Security Analyst Junior Stelle München Quereinsteiger",
      "Junior IAM Engineer Stelle Remote Deutschland",
      "ISMS Koordinator Junior Stelle Deutschland",
    ],
    titleInclude:  /soc|security|sicherheit|iam|isms|cyber|siem|soar|pentest|compliance|analyst/i,
    titleExclude:  /senior|lead|head|architect|principal|manager|direktor|ciso/i,
    requireRemote: false,
    systemPrompt:  "Kandidat: IT-Quereinsteiger (kaufm. Hintergrund), Active Directory, Entra ID, Wazuh SIEM, MITRE ATT&CK, IAM, IHK-Zertifizierung Informationssicherheit laufend. KEIN Studium. Ziel: Junior SOC/Security Analyst, IAM/ISMS Junior. Ausschluss: Pflicht-Studium, Senior >3J, reiner Außendienst.",
  },
  {
    id: "kaufmaennisch",
    label: "Kaufmännisch",
    baSearches: [
      ["Sachbearbeiter Einkauf",     "Erding",  50],
      ["Sachbearbeiter Vertrieb",    "Erding",  50],
      ["Kaufmännischer Mitarbeiter", "Erding",  50],
      ["Disponent",                  "Erding",  50],
      ["Sachbearbeiter Innendienst", "München", 40],
      ["Sales Coordinator",          "München", 50],
    ],
    searxQueries: [
      "Sachbearbeiter Innendienst Stelle Erding München 2026",
      "Kaufmännischer Mitarbeiter Einkauf Stelle Erding Mühldorf",
      "Disponent ERP Stelle München Großraum",
    ],
    titleInclude:  /sachbearbeiter|kaufmänn|innendienst|disponent|einkauf|vertrieb|koordinator|account|warenwirtschaft|erp/i,
    titleExclude:  /senior|head|lead|direktor|außendienst/i,
    requireRemote: false,
    systemPrompt:  "Kandidat: Kaufmann im Groß- und Außenhandel, ERP (WW90/AS400), Stammdatenpflege. Ziel: Sachbearbeiter Einkauf/Vertrieb/Innendienst, Disponent. Ausschluss: reiner Außendienst >20%, reines Lager, Callcenter.",
  },
  {
    id: "it-support-remote",
    label: "IT Support Remote",
    baSearches: [
      ["IT Support Specialist",    null, 0],
      ["IT Helpdesk",              null, 0],
      ["Technical Support Remote", null, 0],
      ["SaaS Onboarding",          null, 0],
      ["IT Consultant Junior",     null, 0],
    ],
    searxQueries: [
      "IT Support Specialist Remote Stelle Deutschland 2026",
      "IT Helpdesk Homeoffice Stelle Deutschland Junior",
      "Junior IT Consultant Remote Stelle Deutschland",
      "SaaS Onboarding Specialist Remote Stelle Deutschland",
    ],
    titleInclude:  /support|helpdesk|consultant|onboarding|service.desk|technical|it.specialist/i,
    titleExclude:  /senior|lead|head/i,
    requireRemote: true,
    systemPrompt:  "Kandidat: Kaufm. Ausbildung mit IT-Bezug, Active Directory, Entra ID, ERP, Cybersecurity-Grundlagen. NUR Remote/Homeoffice. Ziel: IT Support Remote, Helpdesk, SaaS Onboarding, Junior IT Consultant. Ausschluss: Pflicht-Studium, reine Vor-Ort-IT.",
  },
];

// ─── Quelle A: Bundesagentur ──────────────────────────────────────────────────
async function fetchFromBA(profile) {
  const seen       = new Set();
  const candidates = [];

  for (const [keyword, location, radius] of profile.baSearches) {
    let jobs;
    try {
      jobs = await fetchBAJobs({ keyword, location: location || undefined, radius, size: 25 });
    } catch (e) {
      console.error(`[JOB-CRAWLER] BA Fehler (${keyword}): ${e.message}`);
      continue;
    }

    for (const job of jobs) {
      if (!job.refnr || seen.has(job.refnr)) continue;
      seen.add(job.refnr);

      const titel = job.titel || "";
      if (profile.titleInclude && !profile.titleInclude.test(titel)) continue;
      if (profile.titleExclude &&  profile.titleExclude.test(titel)) continue;

      // 24h-Filter (BA liefert verlässliche Datumsangaben)
      const pubDate = job.aktuelleVeroeffentlichungsdatum || "";
      if (!isWithin24h(pubDate)) continue;

      const remote = isRemote(`${titel} ${job.arbeitsort?.ort || ""}`);
      if (profile.requireRemote && !remote) continue;
      if (!remote && isLocationBad(job.arbeitsort?.ort || "")) continue;

      const text = await fetchBADetail(job.refnr);
      candidates.push({
        source:      "ba",
        url:         jobUrlBA(job.refnr),
        title:       titel,
        company:     job.arbeitgeber || "",
        location:    job.arbeitsort?.ort || "",
        publishedAt: pubDate,
        remote,
        text:        text || titel,
      });

      if (candidates.length >= 15) break;
    }
    if (candidates.length >= 15) break;
  }

  console.log(`[JOB-CRAWLER] BA: ${candidates.length} Kandidaten (${profile.id})`);
  return candidates;
}

// ─── Quelle B: SearXNG → URL-Finder → web_fetch ───────────────────────────────

/** site:-Queries für SearXNG → einfache Queries für Brave/Tavily/Serper */
function simplifyQuery(q) {
  return q.replace(/site:\S+\s*/g, "").trim();
}

async function fetchFromSearXNG(profile, webSearch) {
  if (!webSearch) return [];

  const urlsFound = new Set();

  // Stufe 1: SearXNG mit site:-Queries (präzise, jobportal-spezifisch)
  for (const query of profile.searxQueries) {
    try {
      const result = await webSearch(query, "searxng");
      for (const r of result.results || []) {
        if (r.url) urlsFound.add(canonicalUrl(r.url));
      }
    } catch (e) {
      console.warn(`[JOB-CRAWLER] SearXNG Fehler (${query}): ${e.message}`);
    }
  }

  // Stufe 2: Fallback auf auto (Tavily→Serper→Brave) wenn SearXNG nichts lieferte
  // site:-Operator wird entfernt da externe APIs ihn schlecht supporten
  if (urlsFound.size === 0) {
    console.log(`[JOB-CRAWLER] SearXNG 0 Treffer → Fallback auf auto (${profile.id})`);
    for (const query of profile.searxQueries) {
      try {
        const result = await webSearch(simplifyQuery(query), "auto");
        for (const r of result.results || []) {
          if (r.url) urlsFound.add(canonicalUrl(r.url));
        }
      } catch (e) {
        console.warn(`[JOB-CRAWLER] auto Fallback Fehler (${query}): ${e.message}`);
      }
    }
  }

  const urls = [...urlsFound].slice(0, 20); // max 20 URLs fetchen
  console.log(`[JOB-CRAWLER] SearXNG: ${urls.length} URLs gefunden (${profile.id})`);

  // Concurrent fetch (max 4 parallel)
  const fetched = await pMap(urls, async (url) => {
    const html    = await fetchJobPage(url);
    const parsed  = extractJobText(html);
    if (!parsed) return null;

    // Kein Datum → verwerfen (Option 1: Präzision)
    if (!parsed.publishedAt) return null;
    if (!isWithin24h(parsed.publishedAt)) return null;

    // Titel aus HTML <title>-Tag
    const titleMatch = html?.match(/<title[^>]*>([^<]+)<\/title>/i);
    const rawTitle   = (titleMatch?.[1] || "").replace(/\s*[|–\-]\s*.*$/, "").trim();

    if (profile.titleInclude && !profile.titleInclude.test(rawTitle)) return null;
    if (profile.titleExclude &&  profile.titleExclude.test(rawTitle)) return null;

    const remote = isRemote(`${rawTitle} ${parsed.text}`);
    if (profile.requireRemote && !remote) return null;
    if (!remote && isLocationBad(parsed.text)) return null;

    return {
      source:      "web",
      url,
      title:       rawTitle || url,
      company:     "",
      location:    "",
      publishedAt: parsed.publishedAt,
      remote,
      text:        parsed.text,
    };
  }, 4);

  const candidates = fetched.filter(Boolean);
  console.log(`[JOB-CRAWLER] SearXNG: ${candidates.length} Kandidaten nach Fetch+Filter (${profile.id})`);
  return candidates;
}

// ─── Merge + Deduplizierung ───────────────────────────────────────────────────
function mergeCandidates(baCandidates, webCandidates) {
  const seen = new Set(baCandidates.map(c => canonicalUrl(c.url)));
  const merged = [...baCandidates];
  for (const c of webCandidates) {
    if (!seen.has(canonicalUrl(c.url))) {
      seen.add(canonicalUrl(c.url));
      merged.push(c);
    }
  }
  return merged;
}

// ─── LLM-Filter (JA/NEIN pro Kandidat) ───────────────────────────────────────
async function llmFilter(candidates, profile, makeLLMClient) {
  const crawlerModel = (process.env.JOB_CRAWLER_MODEL || "").trim() || undefined;
  let client, model;
  try { ({ client, model } = makeLLMClient(crawlerModel)); }
  catch (e) { console.warn("[JOB-CRAWLER] LLM-Client init:", e.message); return []; }

  const results = [];

  for (const c of candidates) {
    const prompt = [
      `Profil: ${profile.label}`,
      profile.systemPrompt,
      "",
      `Stelle: ${c.title}`,
      c.company ? `Arbeitgeber: ${c.company}` : "",
      c.location ? `Ort: ${c.location}` : "",
      "",
      "Stellenbeschreibung (Auszug):",
      (c.text || "").slice(0, 1500),
      "",
      "Ist diese Stelle für das Profil geeignet? Antworte NUR mit JA oder NEIN.",
    ].filter(Boolean).join("\n");

    let answer = "";
    try {
      // Versuch 1
      const res = await client.chat.completions.create({
        model, temperature: 0.0, max_tokens: 10,
        messages: [{ role: "user", content: prompt }],
      });
      answer = (res.choices?.[0]?.message?.content || "").trim().toUpperCase();

      // Retry bei Tool-Call oder leer
      if (!answer || res.choices?.[0]?.finish_reason === "tool_calls") {
        const res2 = await client.chat.completions.create({
          model, temperature: 0.0, max_tokens: 10,
          messages: [
            { role: "user", content: prompt },
            { role: "user", content: "Antworte ausschließlich mit JA oder NEIN." },
          ],
        });
        answer = (res2.choices?.[0]?.message?.content || "").trim().toUpperCase();
      }
    } catch (e) {
      console.warn(`[JOB-CRAWLER] LLM-Filter Fehler (${c.title}): ${e.message}`);
      // Bei LLM-Fehler: Stelle behalten (kein stiller Verlust)
      results.push(c);
      continue;
    }

    const isYes = /^(JA|YES|J\b|Y\b)/.test(answer);
    console.log(`[JOB-CRAWLER] LLM: ${isYes ? "✓" : "✗"} ${c.title} → ${answer || "(leer)"}`);
    if (isYes) results.push(c);

    if (results.length >= 12) break;
  }

  return results;
}

// ─── runSearch (Orchestrierung) ───────────────────────────────────────────────
async function runSearch(profile, webSearch, makeLLMClient) {
  const [baCandidates, webCandidates] = await Promise.all([
    fetchFromBA(profile),
    fetchFromSearXNG(profile, webSearch),
  ]);

  const all = mergeCandidates(baCandidates, webCandidates);
  console.log(`[JOB-CRAWLER] Gesamt nach Merge: ${all.length} Kandidaten (${profile.id})`);

  if (all.length === 0) return "Keine passenden Stellen gefunden.";

  // LLM-Filter wenn verfügbar
  const filtered = makeLLMClient ? await llmFilter(all, profile, makeLLMClient) : all.slice(0, 12);
  if (filtered.length === 0) return "Keine passenden Stellen gefunden.";

  return filtered.map(formatCandidate).join("\n");
}

// ─── Store ────────────────────────────────────────────────────────────────────
let jobStore = { lastRun: null, results: {}, running: false };

async function loadPersistedResults() {
  try { jobStore = JSON.parse(await fs.readFile(RESULTS_FILE, "utf8")); } catch {}
}

async function saveResults() {
  try {
    await fs.mkdir(path.dirname(RESULTS_FILE), { recursive: true });
    await fs.writeFile(RESULTS_FILE, JSON.stringify(jobStore, null, 2), "utf8");
  } catch (e) { console.error("[JOB-CRAWLER] Speichern:", e.message); }
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function crawlJobs(webSearch, makeLLMClient) {
  if (jobStore.running) { console.log("[JOB-CRAWLER] Läuft bereits."); return; }
  jobStore.running = true;
  jobStore.lastRun = new Date().toISOString();

  for (const profile of PROFILES) {
    jobStore.results[profile.id] = { label: profile.label, updatedAt: new Date().toISOString(), status: "running", content: "" };
  }

  for (const profile of PROFILES) {
    console.log(`[JOB-CRAWLER] ── ${profile.label} ──`);
    const content = await runSearch(profile, webSearch, makeLLMClient);
    jobStore.results[profile.id] = {
      label: profile.label, updatedAt: new Date().toISOString(), status: "done", content,
    };
  }

  jobStore.running = false;
  await saveResults();
  console.log(`[JOB-CRAWLER] Abgeschlossen: ${jobStore.lastRun}`);

  try {
    const { addPostfachEntry } = await import("./agent.js");
    for (const p of Object.values(jobStore.results)) {
      if (!p?.content) continue;
      const raw    = String(p.content).trim();
      const isNone = /^Keine\s/i.test(raw);
      const lines  = isNone ? [] : raw.split("\n").filter(l => l.includes("|"));
      const count  = lines.length;
      await addPostfachEntry(
        `💼 ${p.label}: ${count > 0 ? `${count} Stelle${count !== 1 ? "n" : ""} gefunden` : "Keine Ergebnisse"}`,
        p.content,
        "jobs",
      );
    }
  } catch (e) { console.warn("[JOB-CRAWLER] Postfach:", e.message); }
}

export async function startJobCrawler(webSearch, makeLLMClient) {
  await loadPersistedResults();
  console.log("[JOB-CRAWLER] Gestartet (BA + SearXNG Hybrid) — alle 6h.");
  crawlJobs(webSearch, makeLLMClient);
  setInterval(() => crawlJobs(webSearch, makeLLMClient), INTERVAL_MS);
}

export function getJobResults() { return jobStore; }
