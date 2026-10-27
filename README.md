# Browser Theme Hospital – Versus (1v1 Wettkampf)

Portierung der Open-Source-Engine **[CorsixTH](https://corsixth.com)** für den Webbrowser (WebAssembly / SDL2 / Lua) mit integriertem **1v1-Versus-Multiplayer**, Quest-Chooser, Echtzeit-Statistik-Dashboard, Chat und Live-Timer.

---

## ⚖️ Copyright & Rechtliches (Wichtig)

- Dieses Repository enthält **keinerlei urheberrechtlich geschützte Daten von Theme Hospital (Bullfrog / Electronic Arts)**.
- Es werden weder originale Spieldateien, Grafiken, Animationen, Level noch Audio- oder Musikdateien bereitgestellt oder gespeichert.
- Enthalten ist ausschließlich die quelloffene, unter der **MIT-Lizenz** stehende CorsixTH-Engine, kompiliert nach WebAssembly.
- Spieler laden ihre eigenen Spieldaten (z. B. aus der Theme-Hospital-Demo oder der Vollversion von GOG/EA) lokal im Browser per Drag & Drop (`.zip` oder entpackter Ordner). Die Spieldaten verbleiben vollständig im Browser (IndexedDB) und verlassen niemals den eigenen Rechner.

---

## 🎮 Features

1. **1v1 Versus-Wettkampf**:
   - Beide Spieler treten auf derselben Karte in Echtzeit gegeneinander an.
   - **Modularer Quest-Chooser**: Der Host kann beliebige Zielbedingungen kombinieren (z. B. *25 Patienten heilen* AND *$100.000 Barvermögen* AND *30 Minuten Zeitlimit*).
   - Wer zuerst alle gesetzten Ziele erreicht, gewinnt! Bei Ablauf des Zeitlimits gewinnt das höchste Barvermögen.
2. **Rivalen-Dashboard & Quests-Block**:
   - Live-Vergleich von Barvermögen, geheilten Patienten, Räumen, Mitarbeitern und Krankenhaus-Gesamtwert.
   - Freie Größenanpassung (Resizable) und Verschiebbarkeit von Quest- und Chat-Fenstern.
3. **Plattformunabhängig**:
   - Läuft in jedem modernen Browser ohne Plugins oder lokale Installation.

---

## 🚀 Deployment-Anleitung

### 1. Auf GitHub hochladen

```bash
# Falls noch kein GitHub-Remote hinterlegt ist:
git remote add github https://github.com/DEIN-BENUTZERNAME/browser-theme-hospital.git

# Änderungen stagen und committen
git add .
git commit -m "feat: Versus mode with Quest-Chooser, resizable HUD and Vercel support"

# Auf GitHub pushen
git push -u github main
```

*(Hinweis: Durch die `.gitignore` ist sichergestellt, dass keine ZIP-Dateien oder Spieldaten hochgeladen werden!)*

---

### 2. Frontend auf Vercel deployen (Serverless Multiplayer)

1. Melde dich bei [vercel.com](https://vercel.com) an.
2. Klicke auf **"Add New Project"** und importiere dein GitHub-Repository.
3. Vercel erkennt automatisch die beiliegende `vercel.json` (Output Directory: `dist`).
4. Klicke auf **"Deploy"**.

> [!TIP]
> **Zero-Setup Multiplayer auf Vercel:**
> Das Spiel verfügt über eine **voll integrierte WebRTC P2P-Direktverbindung**!
> Auf Vercel verbindet sich das Spiel automatisch direkt Browser-zu-Browser (Host ↔ Gast) über WebRTC DataChannels mit extrem niedriger Latenz.
> **Du musst keinen externen Server aufsetzen!**
> Einfach Raum erstellen, Einladungslink an deinen Freund senden und sofort loslegen.

---

### 3. Optional: Eigener WebSocket-Relay-Server (z. B. auf Render.com)

Falls du statt WebRTC lieber einen zentralen WebSocket-Server nutzen möchtest (z. B. bei extrem restriktiven Firmen-Firewalls):

1. Melde dich bei [render.com](https://render.com) an (kostenloser Account).
2. Klicke auf **New +** -> **Web Service**.
3. Wähle dasselbe GitHub-Repository aus (`render.yaml` ist bereits enthalten).
4. Nach dem Deployment erhältst du deine URL: `wss://mein-hospital-relay.onrender.com/ws`.
5. Klicke auf der Webseite unten auf **⚙️ Netzwerk** und trage die WebSocket-URL ein.

---

## 💻 Lokaler Start

```bash
npm install
npm start
```
Öffne danach `http://localhost:8085` im Browser.

---

## 📜 Lizenz
- CorsixTH-Engine & Web-Code: [MIT-Lizenz](third_party/CorsixTH/LICENSE.txt)
- Theme Hospital Spiel-Assets: © Bullfrog / Electronic Arts
