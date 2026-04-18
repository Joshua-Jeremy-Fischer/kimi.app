import fs from "fs/promises";
import path from "path";

const RESULTS_FILE = "/data/jobs.json";
const INTERVAL_MS  = 6 * 60 * 60 * 1000; // 6 Stunden

// ─── Arbeitnow API (kostenlos, kein Auth, deutsche Jobs) ─────────────────────
// Docs: https://arbeitnow.com/api
const ARBEITNOW_BASE = "https://arbeitnow.com/api/job-board-api";

async function fetchArbeitnowJobs({ keyword, location, remote = false, page = 1 }) {
  const params = new URLSearchParams({ page: String(page) });
  if (keyword)  params.set("search", keyword);
  if (location) params.set("location", location);
  if (remote)   params.set("remote", "true");

  const res = await fetch(`${ARBEITNOW_BASE}?${params}`, {
    headers: { "Accept": "application/json", "User-Agent": "EsoBot-JobCrawler/2.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Arbeitnow ${res.status}`);
  const data = await res.json();
  return data.data || [];
}

/** Arbeitnow-Job → einheitliches Kandidaten-Objekt */
function arbeitnowToCandidate(job) {
  return {
    source:      "arbeitnow",
    url:         job.url || `https://arbeitnow.com/jobs/${job.slug}`,
    title:       job.title || "",
    company:     job.company_name || "",
    location:    job.location || "",
    publishedAt: job.created_at ? new Date(job.created_at * 1000).toISOString() : "",
    remote:      !!job.remote,
    text:        (job.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000),
  };
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

  if (!publishedAt) {
    publishedAt = inferPublishedAt(text) || inferPublishedAt(html);
  }

  return { text, publishedAt };
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

/** HTML-Bereinigung + Längenbegrenzung für LLM-Input */
function sanitizeText(input, maxLen = 1400) {
  if (!input) return "";
  return String(input)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** Kimi K2.5 <think>…</think>-Blöcke entfernen */
const stripThink = (s) =>
  String(s || "")
    .replace(/<(?:think|redacted_thinking)>[\s\S]*?<\/(?:think|redacted_thinking)>/gi, "")
    .replace(/<\/?(?:think|redacted_thinking)>/gi, "")
    .trim();

/**
 * Binäre Entscheidung aus LLM-Rohtext extrahieren.
 * Reihenfolge: Direktmatch → isolierte 0/1 → JA/NEIN im Text → null
 */
function parseBinaryDecision(raw) {
  const stripped = stripThink(raw);
  if (!stripped) return null;
  const v = stripped.trim().toUpperCase();
  // Schnelle Matches: Text beginnt mit Entscheidungszeichen
  if (/^(1|JA\b|YES\b)/.test(v)) return 1;
  if (/^(0|NEIN\b|NO\b)/.test(v)) return 0;
  // Fallback: isolierte 0 oder 1 irgendwo im Text
  const numMatch = v.match(/\b([01])\b/);
  if (numMatch) return parseInt(numMatch[1], 10);
  // Fallback: JA/NEIN als Wort irgendwo
  if (/\b(JA|YES)\b/.test(v)) return 1;
  if (/\b(NEIN|NO)\b/.test(v))  return 0;
  return null; // echtes Unbekannt
}

/**
 * Regex-Gate: Entscheidung nur per Titel-Regex ohne LLM.
 * Fail-closed: wenn kein titleInclude-Match → 0 (verwerfen).
 */
function regexGate(candidate, profile) {
  const title = String(candidate.title || "");
  if (profile.titleExclude?.test(title)) return 0;
  if (profile.titleInclude?.test(title)) return 1;
  return 0;
}

/** Gleiche Regeln wie in fetchFromBA — zentral, damit Merge/Web nie „schlechte“ Titel durchlässt. */
function titleMatchesProfile(profile, title) {
  const t = String(title || "");
  if (profile.titleInclude && !profile.titleInclude.test(t)) return false;
  if (profile.titleExclude && profile.titleExclude.test(t)) return false;
  return true;
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

// Arbeitnow: 7-Tage-Fenster (dünne Portale; seenUrls-Dedup verhindert Dopplungen)
const MS_7DAYS = 7 * 24 * 60 * 60 * 1000;

function isWithin7Days(dateStr) {
  if (!dateStr) return false;
  const ms = new Date(dateStr).getTime();
  if (isNaN(ms)) return false;
  return Date.now() - ms <= MS_7DAYS;
}

// Rückwärtskompatibel: SearXNG-Seiten trotzdem auf 72h begrenzen
const MS_72H = 72 * 60 * 60 * 1000;
function isWithin72h(dateStr) {
  if (!dateStr) return false;
  const ms = new Date(dateStr).getTime();
  if (isNaN(ms)) return false;
  return Date.now() - ms <= MS_72H;
}

function inferPublishedAt(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return null;

  const now = Date.now();

  const h = raw.match(/\bvor\s+(\d{1,2})\s*(stunden|stunde|h)\b/);
  if (h) return new Date(now - Number(h[1]) * 60 * 60 * 1000).toISOString();

  const min = raw.match(/\bvor\s+(\d{1,3})\s*(minuten|minute|min)\b/);
  if (min) return new Date(now - Number(min[1]) * 60 * 1000).toISOString();

  if (/\bheute\b/.test(raw)) return new Date(now).toISOString();
  if (/\bgestern\b/.test(raw)) return new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const iso = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) {
    const ms = Date.parse(iso[1]);
    if (!isNaN(ms)) return new Date(ms).toISOString();
  }

  const de = raw.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/);
  if (de) {
    const day = Number(de[1]);
    const month = Number(de[2]);
    const year = Number(de[3]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const dt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
      if (!isNaN(dt.getTime())) return dt.toISOString();
    }
  }

  return null;
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
      // Breite Suche ohne Location-Einschränkung um mehr Treffer zu bekommen
      ["Security Analyst",       "",            0, false],
      ["SOC Analyst",            "",            0, false],
      ["Cybersecurity Analyst",  "",            0, false],
      ["Information Security",   "",            0, false],
      ["IT Security Analyst",    "Munich",      0, false],
      ["IAM Engineer",           "",            0, true],
      ["Security Operations",    "",            0, false],
    ],
    searxQueries: [
      "Junior SOC Analyst Stelle München 2026",
      "IT Security Analyst Junior Stelle München Quereinsteiger",
      "Junior IAM Engineer Stelle Remote Deutschland",
      "Cybersecurity Analyst Junior Deutschland Stelle",
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
      ["Sachbearbeiter Einkauf",     "München", 50, false],
      ["Sachbearbeiter Innendienst", "München", 50, false],
      ["Kaufmännischer Mitarbeiter", "München", 50, false],
      ["Disponent",                  "München", 50, false],
    ],
    searxQueries: [
      "Sachbearbeiter Innendienst Stelle Erding München 2026",
      "Kaufmännischer Mitarbeiter Einkauf Stelle Erding Mühldorf",
      "Disponent ERP Stelle München Großraum",
    ],
    titleInclude:  /sachbearbeiter|kaufmänn|innendienst|disponent|einkauf|vertriebsmitarbeiter|vertriebskoordinator|auftragsbearbeitung|warenwirtschaft/i,
    // SAP / reine Vertriebs-/Key-Account-Rollen / techn. Vertrieb oft Fehl-Treffer bei Arbeitnow
    titleExclude:  /senior|head|lead|direktor|außendienst|executive|ingenieur|techniker|entwickler|architect|consultant|\bsap\b|s\/4|s4hana|basis[\s-]?consultant|strategic\s+account|key[\s-]?account|account[\s-]?executive|vertriebsingenieur/i,
    requireRemote: false,
    systemPrompt:  "Kandidat: Kaufmann im Groß- und Außenhandel, ERP (WW90/AS400), Stammdatenpflege. Ziel: Sachbearbeiter Einkauf/Vertrieb/Innendienst, Disponent. Ausschluss: reiner Außendienst >20%, reines Lager, Callcenter.",
  },
  {
    id: "it-support-remote",
    label: "IT Support Remote",
    baSearches: [
      ["IT Support",          "Deutschland", 0, true],
      ["Technical Support",   "Deutschland", 0, true],
      ["IT Helpdesk",         "Deutschland", 0, true],
      ["SaaS Onboarding",     "Deutschland", 0, true],
    ],
    searxQueries: [
      "IT Support Specialist Remote Stelle Deutschland 2026",
      "IT Helpdesk Homeoffice Stelle Deutschland Junior",
      "Junior IT Consultant Remote Stelle Deutschland",
      "SaaS Onboarding Specialist Remote Stelle Deutschland",
    ],
    titleInclude:  /support.specialist|helpdesk|it.support|service.desk|onboarding.specialist|technical.support/i,
    titleExclude:  /senior|lead|head|\bsap\b|s\/4|basis[\s-]?consultant|erp\.?berater|architect|developer|entwickler/i,
    requireRemote: true,
    systemPrompt:  "Kandidat: Kaufm. Ausbildung mit IT-Bezug, Active Directory, Entra ID, ERP, Cybersecurity-Grundlagen. NUR Remote/Homeoffice. Ziel: IT Support Remote, Helpdesk, SaaS Onboarding, Junior IT Consultant. Ausschluss: Pflicht-Studium, reine Vor-Ort-IT.",
  },
];

// ─── Quelle A: Arbeitnow ──────────────────────────────────────────────────────
async function fetchFromBA(profile) {
  const seen       = new Set();
  const candidates = [];

  for (const [keyword, location, , remote] of profile.baSearches) {
    let jobs;
    try {
      jobs = await fetchArbeitnowJobs({
        keyword,
        location: location || undefined,
        remote:   !!remote || profile.requireRemote,
      });
    } catch (e) {
      console.error(`[JOB-CRAWLER] Arbeitnow Fehler (${keyword}): ${e.message}`);
      continue;
    }

    for (const job of jobs) {
      const id = job.slug || job.url;
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const c = arbeitnowToCandidate(job);
      if (!titleMatchesProfile(profile, c.title)) continue;
      if (!isWithin7Days(c.publishedAt)) continue;
      if (profile.requireRemote && !c.remote) continue;
      if (!c.remote && isLocationBad(c.location)) continue;

      candidates.push(c);
      if (candidates.length >= 15) break;
    }
    if (candidates.length >= 15) break;
  }

  console.log(`[JOB-CRAWLER] Arbeitnow: ${candidates.length} Kandidaten (${profile.id})`);
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
      if (result?.error) console.warn(`[JOB-CRAWLER] SearXNG: ${result.error} (${query.slice(0, 60)}…)`);
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
        if (result?.error) console.warn(`[JOB-CRAWLER] auto: ${result.error}`);
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

    // Datum: JSON-LD → Meta-Tag → Text-Extraktion → ohne Datum = akzeptieren
    const pubDate = parsed.publishedAt || inferPublishedAt(parsed.text);
    // Wenn Datum bekannt und älter als 72h → verwerfen
    if (pubDate && !isWithin72h(pubDate)) return null;

    // Titel aus HTML <title>-Tag
    const titleMatch = html?.match(/<title[^>]*>([^<]+)<\/title>/i);
    const rawTitle   = (titleMatch?.[1] || "").replace(/\s*[|–\-]\s*.*$/, "").trim();

    // Für Web-Seiten: nur titleExclude prüfen (titleInclude zu streng → viele False Negatives
    // durch generische <title>-Tags wie "Stellenanzeige | StepStone"). LLM filtert den Rest.
    if (profile.titleExclude?.test(rawTitle)) return null;

    const remote = isRemote(`${rawTitle} ${parsed.text}`);
    if (profile.requireRemote && !remote) return null;
    if (!remote && isLocationBad(parsed.text)) return null;

    return {
      source:      "web",
      url,
      title:       rawTitle || url,
      company:     "",
      location:    "",
      publishedAt: pubDate || "",
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

// ─── LLM-Prompts ──────────────────────────────────────────────────────────────

function buildPrimaryPrompt(candidate, profile) {
  return [
    "/no_think",
    "Du bist ein strikter Job-Classifier.",
    "Antworte NUR mit 1 oder 0. Keine Erklärung. Kein anderer Text.",
    "1 = Stelle passt zum Profil.  0 = Stelle passt nicht.",
    "",
    `Profil: ${profile.label}`,
    `Regeln: ${profile.systemPrompt || ""}`,
    "",
    `Titel: ${candidate.title || ""}`,
    candidate.company  ? `Firma: ${candidate.company}`    : "",
    candidate.location ? `Ort: ${candidate.location}`     : "",
    `Remote: ${candidate.remote ? "ja" : "nein"}`,
    "",
    `Stellenbeschreibung:\n${sanitizeText(candidate.text, 1400)}`,
    "",
    "Ausgabe: 1 oder 0",
  ].filter(Boolean).join("\n");
}

function buildRetryPrompt(candidate, profile) {
  return [
    "/no_think",
    `Profil: ${profile.label}`,
    `Jobtitel: ${candidate.title || ""}`,
    "Passt diese Stelle zum Profil?",
    "Antworte ausschließlich mit 1 (ja) oder 0 (nein). Kein anderer Text.",
  ].join("\n");
}

// ─── Einzelklassifikation: Primary → Retry → Regex-Gate ───────────────────────

/** Erzwingt Text-Antwort (kein tool_calls); bei Ollama-400 ohne tool_choice wiederholen */
async function chatClassify(client, body) {
  try {
    return await client.chat.completions.create({ ...body, tool_choice: "none" });
  } catch (e) {
    if (String(e?.message || "").includes("400") || String(e?.status || "") === "400") {
      return await client.chat.completions.create(body);
    }
    throw e;
  }
}

async function classifyCandidate(client, model, candidate, profile) {
  // Stufe 1: Primärer Prompt
  try {
    const r1 = await chatClassify(client, {
      model,
      temperature: 0.0,
      max_tokens: 512,
      messages: [{ role: "user", content: buildPrimaryPrompt(candidate, profile) }],
    });
    const d1 = parseBinaryDecision(r1?.choices?.[0]?.message?.content);
    if (d1 !== null) return { decision: d1, source: "primary" };
  } catch (e) {
    console.warn(`[JOB-CRAWLER] LLM Stufe-1 Fehler (${candidate.title}): ${e.message}`);
  }

  // Stufe 2: Emergency Retry — ultra-kurzer Prompt
  try {
    const r2 = await chatClassify(client, {
      model,
      temperature: 0.0,
      // Kimi (Ollama) braucht oft mehr Platz als nur „Thinking“ — sonst leeres content
      max_tokens: 256,
      messages: [{ role: "user", content: buildRetryPrompt(candidate, profile) }],
    });
    const d2 = parseBinaryDecision(r2?.choices?.[0]?.message?.content);
    if (d2 !== null) return { decision: d2, source: "retry" };
  } catch (e) {
    console.warn(`[JOB-CRAWLER] LLM Stufe-2 Fehler (${candidate.title}): ${e.message}`);
  }

  // Stufe 3: Regex-Gate (fail-closed)
  const rg = regexGate(candidate, profile);
  return { decision: rg, source: "regex_fallback" };
}

// ─── LLM-Filter ───────────────────────────────────────────────────────────────

/**
 * Entscheidungsmatrix:
 *   Primary  1  → behalten
 *   Primary  0  → verwerfen
 *   Primary leer → Retry
 *   Retry    1  → behalten
 *   Retry    0  → verwerfen
 *   Retry   leer → Regex-Gate
 *   Regex-Match  → behalten
 *   kein Match   → verwerfen  (fail-closed — kein Spam)
 */
async function llmFilter(candidates, profile, makeLLMClient) {
  const crawlerModel = (process.env.JOB_CRAWLER_MODEL || "").trim() || undefined;
  let client, model;
  try { ({ client, model } = makeLLMClient(crawlerModel)); }
  catch (e) { console.warn("[JOB-CRAWLER] LLM-Client init:", e.message); return []; }

  const kept = [];

  for (const c of candidates) {
    try {
      const { decision, source } = await classifyCandidate(client, model, c, profile);
      const keep = decision === 1;
      console.log(`[JOB-CRAWLER] LLM: ${keep ? "✓" : "✗"} ${c.title} → ${decision} (${source})`);
      if (keep) kept.push(c);
    } catch (e) {
      // Harter Fehler (z. B. Netzwerk) → Regex-Gate als letzter Ausweg
      const rg = regexGate(c, profile);
      console.warn(`[JOB-CRAWLER] LLM-Fehler "${c.title}" → regex_gate=${rg}: ${e.message}`);
      if (rg === 1) kept.push(c);
    }

    if (kept.length >= 12) break;
  }

  return kept;
}

// ─── runSearch (Orchestrierung) ───────────────────────────────────────────────
async function runSearch(profile, webSearch, makeLLMClient, seenUrls) {
  const [baCandidates, webCandidates] = await Promise.all([
    fetchFromBA(profile),
    fetchFromSearXNG(profile, webSearch),
  ]);

  const merged = mergeCandidates(baCandidates, webCandidates);
  // Bereits gezeigte Jobs überspringen (seenUrls-Dedup)
  const fresh = seenUrls
    ? merged.filter((c) => !seenUrls.has(canonicalUrl(c.url)))
    : merged;
  if (merged.length !== fresh.length) {
    console.log(`[JOB-CRAWLER] seenUrls-Dedup: ${merged.length} → ${fresh.length} (${profile.id})`);
  }
  console.log(`[JOB-CRAWLER] Gesamt nach Merge: ${fresh.length} Kandidaten (${profile.id})`);

  if (fresh.length === 0) return "Keine passenden Stellen gefunden.";

  // LLM-Filter wenn verfügbar
  const filtered = makeLLMClient ? await llmFilter(fresh, profile, makeLLMClient) : fresh.slice(0, 12);

  // Gefilterte (akzeptierte) URLs als "gesehen" markieren
  if (seenUrls) {
    for (const c of filtered) seenUrls.add(canonicalUrl(c.url));
    // Auch verworfene Kandidaten als gesehen markieren → nicht nochmal prüfen
    for (const c of fresh)    seenUrls.add(canonicalUrl(c.url));
  }

  if (filtered.length === 0) return "Keine passenden Stellen gefunden.";

  return filtered.map(formatCandidate).join("\n");
}

// ─── Store ────────────────────────────────────────────────────────────────────
let jobStore = { lastRun: null, results: {}, running: false, seenUrls: [] };

async function loadPersistedResults() {
  try {
    const loaded = JSON.parse(await fs.readFile(RESULTS_FILE, "utf8"));
    jobStore = { seenUrls: [], ...loaded };
  } catch {}
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

  // seenUrls als Set für O(1)-Lookup; maximal 2000 Einträge behalten
  const seenSet = new Set(Array.isArray(jobStore.seenUrls) ? jobStore.seenUrls : []);

  for (const profile of PROFILES) {
    jobStore.results[profile.id] = { label: profile.label, updatedAt: new Date().toISOString(), status: "running", content: "" };
  }

  for (const profile of PROFILES) {
    console.log(`[JOB-CRAWLER] ── ${profile.label} ──`);
    const content = await runSearch(profile, webSearch, makeLLMClient, seenSet);
    jobStore.results[profile.id] = {
      label: profile.label, updatedAt: new Date().toISOString(), status: "done", content,
    };
  }

  // seenUrls-Set zurück in Array (auf 2000 kappen)
  jobStore.seenUrls = [...seenSet].slice(-2000);
  jobStore.running = false;
  await saveResults();
  console.log(`[JOB-CRAWLER] Abgeschlossen: ${jobStore.lastRun}`);

  try {
    const { addPostfachEntry } = await import("./agent.js");
    for (const p of Object.values(jobStore.results)) {
      if (!p?.content) continue;
      const raw   = String(p.content).trim();
      const lines = raw.split("\n").filter(l => l.includes("|"));
      const count = lines.length;
      // Nur ins Postfach wenn echte Stellen gefunden — kein Spam bei 0 Ergebnissen
      if (count === 0) continue;
      await addPostfachEntry(
        `💼 ${p.label}: ${count} Stelle${count !== 1 ? "n" : ""} gefunden`,
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
