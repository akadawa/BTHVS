# Browser Theme Hospital (CorsixTH Web + Koop-Multiplayer)

Vollwertige Portierung der Open-Source-Engine **[CorsixTH](https://corsixth.com)** für den Webbrowser (WebAssembly / SDL2 / Lua) mit integriertem **Online-Koop-Multiplayer**, Raum-Codes, Live-Teammate-Cursor, geteiltem Krankenhaus und In-Game-Chat.

---

## Highlights

1. **Voll im Browser spielbar**:
   - CorsixTH v0.69.2 kompiliert nach WebAssembly mittels Emscripten.
   - Läuft in jedem modernen Browser (Chrome, Firefox, Safari, Edge) ohne Plugins oder Installation.
   - Flüssige Skalierung auf Fenstergröße und Vollbildmodus (`F11`).

2. **Lokaler Spieldaten-Import**:
   - Theme Hospital benötigt Spieldaten (z. B. aus der Demo oder der Vollversion).
   - Spieler wählen einfach die `HOSP.zip` oder einen Theme-Hospital-Ordner per Drag & Drop oder Dateiauswahl.
   - Daten werden sicher in der browserinternen **IndexedDB** gespeichert und verlassen niemals den eigenen Rechner.

3. **Koop-Multiplayer mit Raum-Codes**:
   - Host klickt auf **"Raum erstellen"** und erhält einen 5-stelligen Code (z. B. `D53UZ`) oder einen 1-Klick-Einladungslink (`?join=D53UZ`).
   - Mitspieler geben den Code ein und landen in der gemeinsamen Lobby.
   - Der Host startet das Spiel, sobald alle beigetreten sind.
   - **Gemeinsames Krankenhaus**: Beide Spieler bauen und verwalten dasselbe Hospital.
   - **Live Teammate Cursor & Nameplates**: Man sieht in Echtzeit, wo der Partner gerade hinschaut (`[Dr. Alice]`, `[Dr. Bob]`).
   - **Click-Pings**: Klicks auf Kacheln erzeugen animierte Zielkreise zur Absprache ("Hier bauen!").
   - **Gemeinsame Spielgeschwindigkeit**: Pause / Tempo gilt synchron für alle.
   - **In-Game Chat**: Bequemer Chat (`Enter` / Chat-Button oben rechts).
   - **Snapshot-Synchronisation**: Räume und Spielzustand werden bei Fertigstellung automatisch abgeglichen.

4. **Wählbare Spielmodi**:
   - **Endlosmodus (Freies Spiel)**: Kein Druck durch Pleiten oder Fristen – ideal für entspanntes gemeinsames Bauen.
   - **Level-Modus (Kampagne / Ziele)**: Echtes Theme Hospital mit Notfällen, VIP-Besuchen, Forschungsfortschritt und gemeinsamen Erfolgen.

---

## Schnellstart

### 1. Server starten
```bash
npm install
npm start
```
Der Server läuft standardmäßig auf `http://localhost:8085` (konfigurierbar per `PORT=...` oder `--port`).

### 2. Im Browser öffnen
1. Öffne `http://localhost:8085`.
2. Ziehe die beiliegende `HOSP.zip` in den Spieldaten-Bereich.
3. Wähle **Einzelspieler** oder erstelle einen **Koop-Raum**.

---

## Entwicklung & Tests

### WebAssembly bauen
Voraussetzung: Python, CMake, Ninja, Emscripten SDK (`tools/emsdk`).
```powershell
powershell -ExecutionPolicy Bypass -File web/build.ps1
```

### Automatisierte End-to-End-Tests (Playwright)
```bash
# E2E Multiplayer-Test mit zwei parallelen Browser-Clients
node tests/test_multiplayer.js

# Einzelspieler-Smoke-Test
node tests/smoke.js
```

---

## Lizenz
- CorsixTH-Engine: MIT-Lizenz
- Theme Hospital Spiel-Assets: © Bullfrog / Electronic Arts
