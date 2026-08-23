docker build -t duett .
docker run -d \
  --name duett \
  -p 3003:3003 \
  -v duett_data:/app/data \
  -e BASE_PATH=/duett \
  -e OVERVIEW_PASSWORD=geheim \
  --restart unless-stopped \
  duett

# Duett – Stream-Kommentar-Webinterface

Webinterface für gemeinsames Kommentieren mit Zeitstempel: ARD-Mediathek-/
ZDF-Mediathek-/m3u8-Videos, Spotify-Tracks/Alben/Playlists, YouTube-Videos/
Playlists, TikTok-Videos und Instagram-Reels/-Posts lassen sich beliebig zu einer
Playlist pro Session mischen. Per Share-Link können Zuschauer:innen Stellen
mit Zeitstempel kommentieren und aufeinander antworten. Keine Logins – nur
ein frei gewählter Anzeigename, der im Browser gemerkt wird.

## Lokal starten (ohne Docker)

```bash
npm install
npm start
```

Der Server läuft dann auf `http://localhost:3003`.

## Mit Docker

```bash
docker build -t duett .
docker run -d \
  --name duett \
  -p 3003:3003 \
  -v duett_data:/app/data \
  --restart unless-stopped \
  duett
```

Das Volume `duett_data` sorgt dafür, dass die SQLite-Datenbank
(`/app/data/app.db`) Container-Neustarts übersteht.

### docker-compose (optional)

```yaml
services:
  duett:
    build: .
    ports:
      - "3003:3003"
    volumes:
      - duett_data:/app/data
    restart: unless-stopped

volumes:
  duett_data:
```

## Nutzung

1. Auf der Startseite (`/`) führt ein dreischrittiger Assistent durchs Anlegen:
   Titel → optional eine erste Quelle (ARD-Mediathek-, ZDF-Mediathek-/m3u8-
   Link, Spotify, YouTube, TikTok oder Instagram – auch komplett
   überspringbar) → optional Kurzlink/Passwort. Es gibt keine
   Pflicht-Erstquelle: eine Session lässt sich auch leer anlegen und danach
   beliebig befüllen.
2. Nach dem Anlegen werden zwei Links angezeigt:
   - **Share-Link** (`/s/<id>`) – zum Teilen mit allen, die kommentieren sollen.
   - **Admin-Link** (`/s/<id>?admin=<token>`) – erlaubt zusätzlich das Löschen
     von Kommentaren, Playlist-Items und der gesamten Session. Nicht weitergeben!
3. Auf der Session-Seite: aktives Playlist-Item abspielen, per Button
   „Kommentar an aktueller Stelle" einen Zeitstempel-Kommentar hinterlassen,
   auf Kommentare antworten, per Klick auf einen Zeitstempel dorthin springen.
   Über „+ Hinzufügen" lassen sich jederzeit weitere Quellen ergänzen – auch
   von anderen Betrachtenden mit dem Share-Link, nicht nur vom Admin. Enthält
   eine Playlist mehr als ein Item, werden Kommentare nach Item gruppiert
   angezeigt (Gruppenkopf mit Icon + Titel, Klick springt zum Item); innerhalb
   einer Gruppe lässt sich per Umschalter zwischen früh/spät zuerst sortieren.
4. Neue Kommentare anderer Nutzer:innen erscheinen automatisch (Polling alle 10 s).
5. Wer einen Kommentar selbst verfasst hat, kann ihn über "bearbeiten" nachträglich
   ändern oder löschen – die Berechtigung dafür wird allein am aktuell eingestellten
   Anzeigenamen festgemacht (kein Login, kein Token: passt der Name, gilt der
   Kommentar als eigener, geräteübergreifend). Kehrseite: wer denselben Namen wie
   jemand anderes wählt, kann auch dessen Kommentare bearbeiten/löschen. Jede
   Person bekommt automatisch eine feste Farbe zur Wiedererkennung.
6. Der Vollbild-Button (⛶) neben den Sprung-Buttons öffnet einen Theater-Modus:
   auf breiten Bildschirmen Player links, Kommentare rechts; auf schmalen
   Bildschirmen gestapelt. Marker-Leiste, Sprung-zu-Timecode und Vollbildmodus
   funktionieren für jeden Provider außer Instagram (das liefert keine
   Positionsangabe).
7. Eine Liste aller Streams gibt es nicht mehr auf der Startseite (siehe
   „Übersichtsseite" unten für die passwortgeschützte Alternative).
8. Kommentare lassen sich per Button als „gelesen“ markieren; der Gelesen/
   Ungelesen-Status wird serverseitig gespeichert (Tabelle `comment_read_status`)
   und – wie Bearbeitungsrechte und Reactions auch – allein über den aktuell
   eingestellten Anzeigenamen zugeordnet, nicht über ein Gerät/Browser (kein
   Login, kein Token). Er ist damit geräteübergreifend verfügbar, sobald
   derselbe Name verwendet wird; Kehrseite wie überall sonst im Projekt: wer
   denselben Namen wie jemand anderes wählt, sieht auch dessen Gelesen-Status.
   Eigene Kommentare gelten automatisch als gelesen.

## Reverse-Proxy unter einem Unterpfad (z. B. /duett/)

Die App unterstützt Hosting unter einem Unterpfad einer bestehenden Domain
über die Env-Var `BASE_PATH`. Voraussetzung: der Proxy entfernt das Präfix,
bevor er die Anfrage an den Container weiterleitet.

```bash
docker run -d \
  --name duett \
  -p 3003:3003 \
  -v duett_data:/app/data \
  -e BASE_PATH=/duett \
  --restart unless-stopped \
  duett
```

Apache-Konfiguration (`mod_proxy` und `mod_proxy_http` müssen aktiv sein):

```apache
ProxyPreserveHost On
ProxyPass /duett/ http://192.168.2.189:3003/
ProxyPassReverse /duett/ http://192.168.2.189:3003/

# Aufruf ohne trailing slash auf die Variante mit Slash umleiten,
# sonst funktioniert die relative Pfadauflösung im Browser nicht:
RedirectMatch ^/duett$ /duett/
```

Ohne `BASE_PATH` erzeugt der Server absolute Pfade und Share-Links relativ zu
`/` – das funktioniert nur, wenn die App auf der Domain-Wurzel oder einer
eigenen (Sub-)Domain läuft. Mit `BASE_PATH=/duett` gilt:

- Der `<base href>`-Tag in den HTML-Seiten wird auf `/duett/` gesetzt, sodass
  alle relativen Asset- und API-Pfade korrekt aufgelöst werden.
- `share_url`/`admin_url` werden mit `/duett`-Präfix ausgegeben, sodass
  geteilte Links direkt funktionieren.

**Wichtig:** `BASE_PATH` muss zum tatsächlichen Proxy-Präfix passen. Bei einer
Änderung des Präfixes muss der Container mit neuem `BASE_PATH`-Wert neu
gestartet werden.

## Wichtig: CORS beim m3u8-Host

Der Server, der die m3u8-Playlist und die Video-Segmente ausliefert, muss
Cross-Origin-Requests erlauben, sonst kann `hls.js` im Browser die Datei nicht
laden. Der Host muss mindestens folgenden Header setzen:

```
Access-Control-Allow-Origin: *
```

(oder spezifisch auf die Domain, unter der Duett läuft). Bei nginx z. B.:

```nginx
location ~ \.(m3u8|ts)$ {
    add_header Access-Control-Allow-Origin *;
}
```

Ohne diesen Header schlägt das Laden des Streams im Browser fehl, auch wenn
die URL direkt im Browser aufrufbar erscheint.

## Playlist-Provider: ARD-Mediathek/ZDF-Mediathek/m3u8, Spotify, YouTube, TikTok, Instagram

Jede Session ist eine Playlist, die beliebig viele Items beliebiger Provider
mischen kann – ARD-/ZDF-Mediathek-/m3u8-Videos sind dabei ein Provider unter
mehreren, kein eigener Session-Typ mehr (frühere Versionen kannten eine feste
Wahl zwischen „ARD-Mediathek" und „Content-Mix"; das ist inzwischen zu einem
einzigen, einheitlichen Modell verschmolzen – keine Funktion ist dabei
verloren gegangen). Kommentare hängen am jeweils aktiven Playlist-Item
(Video/Song/Reel) statt an einem einzigen globalen Timecode.

- Erste Quelle beim Anlegen ist optional: ein ARD-Mediathek-, ZDF-Mediathek-/
  m3u8-, Spotify-, YouTube-, TikTok- oder Instagram-Link (Track/Video,
  Album/Playlist bei Spotify/YouTube; ARD/ZDF/TikTok/Instagram sind immer ein
  einzelnes Video/Reel/Post). Eine Session lässt sich auch ganz ohne
  Erstquelle anlegen. Weitere Quellen lassen sich jederzeit über
  „+ Hinzufügen" auf der Session-Seite ergänzen – auch von anderen
  Betrachtenden mit dem Share-Link, nicht nur vom Admin. Ein roher m3u8-/
  Video-Link ohne erkannten Anbieter wird ebenfalls als ARD/Video-Item
  übernommen (Titel wird aus dem letzten URL-Pfadsegment abgeleitet). ZDF-
  Links (zdf.de/video/… oder zdf.de/play/…) werden serverseitig über die
  öffentliche ZDF-API zu einem m3u8-Link aufgelöst, genau wie ARD-Mediathek-
  Links – kein API-Key nötig.
- Spotify-Playlists/Alben werden serverseitig komplett aufgelöst (alle
  enthaltenen Tracks), YouTube-Playlists clientseitig im Browser (über die
  offizielle YouTube-IFrame-Player-API), TikTok-Videos und Instagram-
  Reels/-Posts serverseitig über die jeweils öffentlichen, tokenlosen
  oEmbed-Endpunkte. Keine der vier Auflösungen braucht einen API-Key oder
  Zugangsdaten (Instagrams oEmbed verlangte bis Juni 2026 einen
  Meta-App-Access-Token – das hat Meta seitdem zurückgenommen). TikTok-
  Kurzlinks (`vm.tiktok.com/…`, `vt.tiktok.com/…`) werden dabei automatisch
  auf die kanonische Video-URL aufgelöst.
- Wiedergabe läuft automatisch weiter zum nächsten Item, auch beim Wechsel
  zwischen Spotify-, YouTube- und TikTok-Playern. TikTok-Videos werden über
  den offiziellen TikTok Embed Player gesteuert (eigenes Iframe pro Item,
  da dieser Player kein "lade neues Video" kennt). **Instagram-Reels/-Posts
  bilden eine Ausnahme:** Instagrams öffentliches `embed.js` bietet keine
  Steuerung von außen (kein Play/Pause/Seek, kein Ende-Signal) – hier gibt
  es deshalb keinen automatischen Wechsel zum nächsten Item, stattdessen
  einfach den „Nächstes ⏭"-Button nutzen.
- **Spotify-Hinweis:** Volle Wiedergabe erfordert Spotify Premium und Login im
  selben Browser – ohne das spielt Spotify nur eine kurze Vorschau
  (technische Grenze von Spotifys Embed-Player, keine Duett-Einschränkung).
  YouTube-, TikTok- und Instagram-Inhalte spielen immer vollständig.
- Instagram-Reels/-Posts müssen öffentlich sein (private/altersbeschränkte
  Accounts oder Accounts mit deaktivierten Embeds funktionieren nicht) –
  dieselbe Einschränkung gilt für jeden Instagram-Embed im Web, nicht nur
  für Duett.
- Instagram-Items zeigen in der Playlist-Leiste nur einen generischen Titel
  (z. B. „Instagram-Reel · abc123") und kein Vorschaubild – Instagrams
  tokenloser oEmbed-Zugriff liefert (anders als bei TikTok) keinen echten
  Post-Titel, Autor oder Thumbnail; das eigentliche Reel/Bild erscheint erst
  beim Abspielen selbst.
- Playlist-Items lassen sich im Admin-Modus einzeln wieder entfernen.
- Enthält ein Kommentar oder eine Antwort selbst einen Spotify-, YouTube-,
  TikTok- oder Instagram-Link, wird der zugehörige Titel beim Absenden
  automatisch der Playlist hinzugefügt (kein Duplikat, falls er schon
  enthalten ist). Der Link erscheint danach im Kommentar als Verlinkung zum
  Playlist-Item statt als externer Link – ein Klick scrollt in der
  Playlist-Leiste dorthin. Kommentare zu Instagram-Items haben dabei keinen
  Timecode (Instagram liefert keine Positionsangabe) – reine
  Item-Kommentare ohne Zeitbezug.

## Optionaler Passwortschutz pro Session

Beim Anlegen einer Session fragt die Startseite standardmäßig nach einem
Passwort (Feld „Passwort für diese Session“, leer lassen für offenen
Zugriff). Zusätzlich lässt sich über den Admin-Link (`?admin=<token>`) im
Bereich „Zugriffsschutz“ jederzeit ein Passwort für die Session setzen,
ändern oder wieder entfernen.
Ist ein Passwort gesetzt, verlangt sowohl die Seite als auch die zugehörige
API (Metadaten, Kommentare) eine korrekte Eingabe, bevor Titel oder Inhalte
ausgeliefert werden. Der Admin-Link selbst umgeht den Schutz immer, damit die
Verwaltung nie ausgesperrt wird.

- Passwörter werden mit bcrypt gehasht, nie im Klartext gespeichert.
- Nach erfolgreicher Eingabe merkt sich der Browser einen signierten
  Zugriffs-Token (localStorage) – kein erneutes Eintippen bei jedem Besuch.
- Ändert sich das Passwort, werden alle zuvor ausgestellten Tokens automatisch
  ungültig.
- Eigenes Rate-Limit auf den Login-Versuch (max. 10/Minute/IP) gegen
  Brute-Force, zusätzlich zum allgemeinen Rate-Limit.
- Das Signier-Secret (`APP_SECRET`) wird beim ersten Start automatisch erzeugt
  und in `data/app_secret.key` persistiert (überlebt Container-Neustarts dank
  Volume). Alternativ per Env-Var `APP_SECRET` selbst setzen.

## Übersichtsseite (`/overview`)

Die Startseite listet keine Streams mehr auf – wer alle bestehenden Sessions
sehen will, braucht die separate, per Passwort geschützte Übersichtsseite
unter `/overview`.

- Aktiviert wird sie über die Env-Var `OVERVIEW_PASSWORD`. Ist sie nicht
  gesetzt, ist `/overview` deaktiviert (404).
- Das Passwort ist global (ein Passwort für alle, die die Übersicht sehen
  dürfen) und unabhängig von den optionalen Passwörtern einzelner Sessions.
- Nach erfolgreicher Eingabe merkt sich der Browser einen signierten
  Zugriffs-Token (localStorage), genau wie beim Session-Passwortschutz.
- Die Liste zeigt pro Session Titel, Erstelldatum, Anzahl Playlist-Items und
  die enthaltenen Provider; ein Klick öffnet die jeweilige Session.

```bash
docker run -d \
  --name duett \
  -p 3003:3003 \
  -v duett_data:/app/data \
  -e OVERVIEW_PASSWORD=geheim \
  --restart unless-stopped \
  duett
```

## Sicherheit

- Rate-Limiting: max. 30 schreibende Anfragen/Minute pro IP (Stream/Kommentar
  anlegen, löschen), max. 10 Login-Versuche/Minute pro IP für den
  Passwortschutz.
- Längenlimits für Titel, URL, Name und Kommentartext.
- Ausgaben werden im Frontend escaped (kein HTML-Markup in Kommentaren möglich).
- Kein Login: Wer den Share-Link kennt (und ggf. das Session-Passwort), kann
  kommentieren. Der Admin-Link enthält ein zufälliges 24-stelliges Token und
  sollte nur an vertrauenswürdige Personen weitergegeben werden.

## Projektstruktur

```
Duett/
  server.js            Express + API + SQLite
  spotifyResolver.js    Spotify-Link -> Playlist-Items (serverseitig, ohne API-Key)
  tiktokResolver.js     TikTok-Link -> Playlist-Item (serverseitig, ohne API-Key)
  instagramResolver.js  Instagram-Reel/-Post-Link -> Playlist-Item (serverseitig, ohne API-Key)
  public/
    index.html          Startseite: dreischrittiger Assistent zum Anlegen einer Session
    session.html         Session-Seite: Playlist + Player (ARD/Spotify/YouTube/TikTok/Instagram) + Kommentare
    overview.html        Passwortgeschützte Übersicht aller Sessions (siehe OVERVIEW_PASSWORD)
    stream.html, mix.html  Nicht mehr verlinkt/geroutet (Vorgänger von session.html, technisch noch
                            vorhanden, aber funktionslos)
    app.js
    style.css
  package.json
  Dockerfile
  .dockerignore
  data/app.db          SQLite-Datei (persistent per Docker-Volume)
```
