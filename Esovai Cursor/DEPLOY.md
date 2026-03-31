# Deploy Guide (Esovai Cursor)

Diese Datei ist die verbindliche Deploy-Anleitung fuer `kamikimi.esovai.tech`.

## Single Source of Truth

- Deploy-Pfad im Repo: `Esovai Cursor/`
- Server-Pfad: `/opt/kimi-app/Esovai Cursor`
- Nicht als Deploy-Quelle verwenden: `FIM/Files/Esovai Cursor/`

Wenn du in einem anderen Pfad aenderst, landet der Fix nicht im laufenden Stack.

## 0) Vor jedem Deploy

Lokal im richtigen Projektordner:

```bash
cd "d:\Programieren\FIM\Files\Esovai Cursor"
git status
```

Server im richtigen Ordner:

```bash
cd "/opt/kimi-app/Esovai Cursor"
pwd
```

## 1) Lokal committen und pushen

```bash
git add -A
git commit -m "Describe change"
git push origin claude/laughing-hopper
```

Wichtig: Ohne `git push` ist der Fix nicht auf GitHub und nicht per `git pull` deploybar.

## 2) Server: pull und neu bauen

```bash
cd "/opt/kimi-app/Esovai Cursor"
git fetch origin
git checkout claude/laughing-hopper
git pull origin claude/laughing-hopper
docker compose build --no-cache backend frontend
docker compose up -d --force-recreate backend frontend
```

## 3) Smoke-Checks (Pflicht)

```bash
docker compose ps
docker compose logs --tail=80 backend
docker exec kimi-backend wget -qO- http://127.0.0.1:3010/health
```

Erwartet:
- Health gibt `{"status":"ok"}` zurueck
- Kein `ERR_ERL_KEY_GEN_IPV6` in Backend-Logs

## 4) Kritische Quick-Checks

### Rate-Limit Fehler vermeiden

```bash
grep -n safeKeyGenerator backend/server.js || echo "OK: kein safeKeyGenerator"
```

### SQLite Schreibbarkeit (wenn JWT/DB aktiv)

```bash
grep -A20 '^  backend:' docker-compose.yml
docker exec kimi-backend sh -lc 'ls -la /data || true'
```

Erwartet:
- `volumes: - kimi_data:/data` vorhanden
- `DB_PATH=/data/kimi.db` (in `.env` oder compose environment)
- Prozess kann unter `/data` schreiben

## 5) .env Standort (haeufigster Fehler)

Die `.env` muss im gleichen Ordner liegen wie `docker-compose.yml`:

- korrekt: `/opt/kimi-app/Esovai Cursor/.env`
- falsch: `/opt/kimi-app/.env` (nur korrekt, wenn symlink bewusst gesetzt)

## 6) Wenn `git pull` blockiert (lokale Aenderungen)

Nur wenn du sicher bist, dass die lokale Aenderung verworfen werden darf:

```bash
git checkout -- "Esovai Cursor/backend/Dockerfile"
git pull origin claude/laughing-hopper
```

Alternativ vorher sichern:

```bash
git stash push -m "server temp changes"
git pull origin claude/laughing-hopper
```

## 7) Rollback (schnell)

```bash
git log --oneline -n 5
git checkout <known-good-commit>
docker compose build --no-cache backend frontend
docker compose up -d --force-recreate backend frontend
```

Danach Ursache analysieren, dann sauber vorwaerts fixen.
