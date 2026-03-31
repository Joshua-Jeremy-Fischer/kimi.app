# AGENTS.md

## Cursor Cloud specific instructions

### Projektstruktur

Das Hauptprojekt liegt unter `Esovai Cursor/` (Pfad mit Leerzeichen — Pfade immer in Anführungszeichen setzen). `FIM/` ist eine historische Kopie und nicht relevant für die Entwicklung.

| Komponente | Pfad | Tech |
|---|---|---|
| Backend | `Esovai Cursor/backend/` | Node.js 20+ / Express (ESM) |
| Frontend | `Esovai Cursor/frontend/public/` | Statisches HTML/JS (kein Build-Schritt) |
| Docker-Compose | `Esovai Cursor/docker-compose.yml` | Backend + Frontend + eso-bot + Ollama |

### Backend lokal starten (ohne Docker)

```bash
cd "Esovai Cursor/backend"
npm install
npm run fim:gen          # generiert .fim_hashes.json (FIM Integritätsprüfung)
```

Dann `.env` unter `Esovai Cursor/.env` erstellen (Vorlage: `env.example`). Pflichtfelder:
- `ALLOWED_TOKEN` — z. B. `openssl rand -base64 32`
- `FRONTEND_ORIGIN` — z. B. `http://localhost:8080` für lokale Entwicklung

Server starten:
```bash
set -a && source ../. env && set +a && node server.js
```

Backend lauscht auf Port 3010 (konfigurierbar via `PORT`).

### Frontend lokal servieren

Das Frontend ist reines statisches HTML unter `Esovai Cursor/frontend/public/`. In Produktion wird nginx als Reverse-Proxy verwendet, der `/api/` und `/health` zum Backend weiterleitet und den Auth-Token injiziert.

Für lokale Entwicklung braucht man einen Proxy-Server, der `/api/*` und `/health` an `localhost:3010` weiterleitet und den `Authorization: Bearer <ALLOWED_TOKEN>`-Header hinzufügt. Ein einfacher statischer Server (z. B. `http-server`) reicht **nicht**, da der Auth-Token fehlt und API-Requests 401 zurückgeben.

### Wichtige Hinweise

- **FIM-Prüfung**: Der Backend-Server prüft beim Start die SHA-256-Hashes von `server.js` gegen `.fim_hashes.json`. Nach jeder Änderung an `server.js` muss `npm run fim:gen` erneut ausgeführt werden, sonst startet der Server nicht.
- **express-rate-limit IPv6-Warnung**: Beim lokalen Start erscheint ein `ERR_ERL_KEY_GEN_IPV6` ValidationError — dieser ist nicht fatal und kann ignoriert werden.
- **LLM-Provider**: Standard ist `ollama` (benötigt laufenden Ollama-Service). Ohne Ollama schlägt `/api/chat` mit "Connection error." fehl, aber alle anderen Endpoints funktionieren.
- **Kein Linting/Testing-Framework**: Das Repo enthält kein ESLint, kein Prettier und keine automatisierten Tests. QA geschieht manuell über die API-Endpoints.
