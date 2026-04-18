# EsoBot — Personal AI Agent Stack

Autonomer persönlicher Agent mit Jobsuche, SOC-Monitoring, Multi-Agent-Workflows und Web-Push-Notifications.

## Stack

| Service | Beschreibung | Port |
|---|---|---|
| `backend` | Node.js API, Agent-Tools, Job-Crawler, Scheduler, Monitor | 3010 |
| `mobile-frontend` | React PWA (remote.esovai.tech) | 3012 |
| `frontend` | Desktop-Frontend (kamikimi.esovai.tech) | 3011 |
| `eso-bot` | Tool-Executor (Shell, Web, FS, Git) | 3020 |
| `langchain-agent` | LangGraph Multi-Agent Pipeline (FastAPI) | 8001 |
| `searxng` | Selbstgehostete Metasuchmaschine | 8080 |
| `ollama` | LLM-Inference (Kimi K2.5 cloud) | 11434 |

## Deployment

```bash
cp env.example .env
# .env anpassen (ALLOWED_TOKEN, ESO_BOT_TOKEN, VAPID-Keys, ...)

docker compose up -d
```

Nach Änderungen:
```bash
# Nur Backend neu starten (kein Rebuild nötig für .js-Änderungen)
docker compose restart backend

# Mit Rebuild (Dockerfile-Änderungen, neue npm-Packages)
docker compose up -d --build backend
```

## Features

### Job-Crawler
Läuft alle 6 Stunden automatisch. Sucht in drei Profilen:
- **IT Security** — Junior SOC/Security Analyst, IAM, ISMS (München + Remote)
- **Kaufmännisch** — Sachbearbeiter Einkauf/Vertrieb/Innendienst (Erding/München)
- **IT Support Remote** — Helpdesk, SaaS Onboarding, IT Consultant (nur Remote)

**Datenquellen:**
1. Bundesagentur für Arbeit REST-API (strukturiert, Vollbeschreibung via Detail-API)
2. SearXNG mit `site:`-Queries auf Stepstone/Indeed/Xing/Join → direkter web_fetch auf Job-URLs
3. Fallback auf Tavily/Serper/Brave wenn SearXNG 0 Treffer liefert

**Filter-Pipeline:**
- 24h-Aktualitätsfilter (beide Quellen)
- Regex-Vorfilter auf Jobtitel
- LLM-Filter (JA/NEIN pro Stelle, `max_tokens=10`) mit Kimi K2.5 cloud
- Deduplizierung via kanonischer URL

Manueller Run: `curl -X POST http://localhost:3010/api/agent/jobs/run`

### SOC Monitor
Prüft alle 10 Minuten: Ollama, SearXNG, Disk, RAM. Schreibt Alerts ins Postfach + Web Push.

### Multi-Agent Workflow (LangGraph)
Pipeline: Researcher → Coder → QA → Fixer (bis 3 Iterationen)

```bash
curl -X POST http://localhost:8001/workflow/run \
  -H "Content-Type: application/json" \
  -d '{"task": "Schreibe ein Python-Script das Hello World ausgibt"}'
```

LLM: Kimi K2.5 via Ollama cloud (1042B Parameter, kostenloses Abo).
NVIDIA als automatischer Fallback wenn `NVIDIA_API_KEY` gesetzt.

### Scheduler
Zeitgesteuerte Tasks via natürlicher Sprache: *"Erinnere mich in 30 Minuten..."*

### Web Push
PWA-Notifications für Job-Alerts, Monitor-Alerts, Scheduler-Tasks.
Benötigt VAPID-Keys in `.env`.

## Umgebungsvariablen

```env
# Auth
ALLOWED_TOKEN=...          # API-Token für Backend
ESO_BOT_TOKEN=...          # Token für eso-bot

# LLM
DEFAULT_PROVIDER=ollama
OLLAMA_BASE_URL=http://ollama:11434/v1
OLLAMA_MODEL=kimi-k2.5:cloud
NVIDIA_API_KEY=            # optional — Fallback

# Suche
SEARCH_PROVIDER=auto       # auto | searxng | tavily | serper | brave
TAVILY_API_KEY=            # optional
SERPER_API_KEY=            # optional
BRAVE_API_KEY=             # optional

# Push
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:...

# eso-bot
ALLOW_SHELL=true
ALLOW_GIT=false
```

## Ollama Setup (Kimi K2.5 cloud)

```bash
# Einmalig im Ollama-Container einloggen
docker exec -it ollama ollama login
# Browser-URL öffnen und mit Ollama-Account authentifizieren

# Modell laden
docker exec -it ollama ollama pull kimi-k2.5:cloud
```

## FIM (File Integrity Monitoring)

Nach jeder Änderung an `backend/server.js`:
```bash
docker compose exec backend npm run fim:gen
```

## Struktur

```
backend/         Node.js Backend (Express)
  agent.js       Agent-Router, Tool-Handler, Job-Crawler-Start
  job-crawler.js BA API + SearXNG Hybrid Crawler
  monitor.js     SOC Health Monitor
  scheduler.js   Task Scheduler
  push.js        Web Push (VAPID)
  server.js      HTTP-Server, Auth, FIM

eso-bot/         Tool-Executor (Node.js, Alpine)
langchain-agent/ LangGraph Multi-Agent (Python 3.12, FastAPI)
  agents/        researcher.py, coder.py, qa_reviewer.py, fixer.py
  config.py      LLM-Routing (Ollama + NVIDIA Fallback)
  main.py        FastAPI + LangGraph Workflow

frontend/        Desktop-Frontend + nginx
mobile-frontend/ React PWA + nginx
searxng/         SearXNG-Konfiguration
```
