const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { customAlphabet } = require('nanoid');
const { resolveSpotify, parseSpotifyInput } = require('./spotifyResolver');
const { resolveTikTok, looksLikeTikTokUrl } = require('./tiktokResolver');
const { resolveInstagram, looksLikeInstagramUrl } = require('./instagramResolver');

// ---------- Setup ----------

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS streams (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    m3u8_url    TEXT NOT NULL,
    admin_token TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS comments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id     TEXT NOT NULL,
    parent_id     INTEGER,
    timecode_sec  REAL,
    author_name   TEXT NOT NULL,
    body          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_comments_stream ON comments(stream_id);
`);

// Migration: neue Spalten für bestehende Datenbanken nachrüsten
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('comments', 'edit_token', 'TEXT');
ensureColumn('comments', 'updated_at', 'INTEGER');
ensureColumn('streams', 'password_hash', 'TEXT');
ensureColumn('streams', 'type', "TEXT NOT NULL DEFAULT 'ard'");
ensureColumn('comments', 'item_id', 'INTEGER');
ensureColumn('streams', 'notes', 'TEXT');
ensureColumn('comments', 'author_color', 'TEXT');
ensureColumn('comments', 'image', 'TEXT');

// Content-Mix-Erweiterung: Playlist aus Spotify-/YouTube-Items pro Session.
// m3u8_url bleibt aus Kompatibilitätsgründen NOT NULL (siehe streams-Tabelle
// oben) – bei type='content_mix' wird dort bewusst ein leerer String statt
// NULL gespeichert, um eine aufwendige Tabellen-Migration zu vermeiden.
db.exec(`
  CREATE TABLE IF NOT EXISTS playlist_items (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id         TEXT NOT NULL,
    position          INTEGER NOT NULL,
    provider          TEXT NOT NULL,
    provider_uri      TEXT NOT NULL,
    title             TEXT NOT NULL,
    artist_or_channel TEXT,
    duration_ms       INTEGER,
    thumbnail_url     TEXT,
    added_at          INTEGER NOT NULL,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_playlist_items_stream ON playlist_items(stream_id);

  -- Reaction-Emojis auf Kommentare: pro (comment_id, emoji, author_name)
  -- höchstens eine Zeile – Klick auf ein bereits gesetztes Emoji entfernt es
  -- wieder (Toggle, siehe POST /api/comments/:cid/reactions). Identifikation
  -- wie bei Kommentaren selbst nur über den frei gewählten Anzeigenamen,
  -- kein Login/Token (siehe README).
  CREATE TABLE IF NOT EXISTS comment_reactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id  INTEGER NOT NULL,
    emoji       TEXT NOT NULL,
    author_name TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
    UNIQUE (comment_id, emoji, author_name)
  );

  CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment ON comment_reactions(comment_id);

  -- Gelesen-Status pro (Kommentar, Anzeigename) – serverseitig statt im
  -- localStorage des Browsers, damit der Status geräteübergreifend erhalten
  -- bleibt, sobald derselbe Name verwendet wird. Identifikation wie überall
  -- sonst im Projekt nur über den frei gewählten Anzeigenamen, kein
  -- Login/Token (siehe README). Eine Zeile bedeutet "gelesen"; es gibt
  -- bewusst kein read=false, sondern das Fehlen der Zeile bedeutet ungelesen.
  CREATE TABLE IF NOT EXISTS comment_read_status (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id  INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
    UNIQUE (comment_id, author_name)
  );

  CREATE INDEX IF NOT EXISTS idx_comment_read_status_comment ON comment_read_status(comment_id);
`);

// source_url: bei ARD-/ZDF-Items die ursprüngliche Mediathek-Seiten-URL
// (nicht der aufgelöste m3u8-Link) – ermöglicht ein erneutes Auflösen, falls
// die im m3u8-Link enthaltenen Zugriffs-Tokens der Sender zwischenzeitlich
// abgelaufen sind (siehe POST /api/items/:iid/refresh). NULL bei allen
// anderen Providern sowie bei direkt eingefügten m3u8-/Video-Links ohne
// erkannte Mediathek-Herkunft.
ensureColumn('playlist_items', 'source_url', 'TEXT');

// ---------- Migration: ARD-Mediathek und Content-Mix zu einem einzigen,
// playlist-basierten Modell vereinen ----------
//
// Vor dieser Vereinigung waren 'ard'-Sessions ein struktureller Sonderfall:
// genau ein globaler m3u8_url auf streams, keine playlist_items-Zeile, ein
// globaler Timecode direkt auf comments (item_id = NULL). Ab jetzt ist JEDE
// Session playlist-basiert (ein oder mehrere Items beliebigen Providers,
// inkl. 'ard' als weiterer Provider neben spotify/youtube/tiktok/instagram) –
// siehe PLAN.md. Diese einmalige, idempotente Migration läuft bei jedem
// Start: für jede bestehende Session mit gesetztem m3u8_url, die noch KEINE
// playlist_items hat, wird ein einzelnes 'ard'-Item daraus erzeugt und alle
// bisherigen (item_id-losen) Kommentare dieser Session auf dieses neue Item
// umgehängt. Content-Mix-Sessions (m3u8_url = '') sind davon nicht betroffen,
// ihre Kommentare haben schon immer ein item_id. Kein Feature-/Datenverlust:
// Titel, Timecodes und Kommentar-Threads bleiben vollständig erhalten.
function migrateLegacyArdStreamsToPlaylistItems() {
  const legacyStreams = db
    .prepare(
      `SELECT s.id, s.title, s.m3u8_url, s.created_at
       FROM streams s
       WHERE s.m3u8_url IS NOT NULL AND s.m3u8_url != ''
         AND NOT EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.stream_id = s.id)`
    )
    .all();
  if (legacyStreams.length === 0) return;

  const insertItem = db.prepare(
    'INSERT INTO playlist_items (stream_id, position, provider, provider_uri, title, artist_or_channel, duration_ms, thumbnail_url, added_at) VALUES (?, 0, ?, ?, ?, ?, NULL, NULL, ?)'
  );
  const reassignComments = db.prepare(
    'UPDATE comments SET item_id = ? WHERE stream_id = ? AND item_id IS NULL'
  );
  // 'type' ist seit der Vereinigung vestigial (siehe POST /api/streams), aber
  // ein altes 'ard' hier stehenzulassen würde frühere Type-Checks anderswo
  // verwirren, falls sie versehentlich wieder eingeführt werden – auf den
  // seitdem einheitlichen Wert normalisieren.
  const normalizeType = db.prepare("UPDATE streams SET type = 'content_mix' WHERE id = ?");

  const migrate = db.transaction((rows) => {
    for (const s of rows) {
      const info = insertItem.run(s.id, 'ard', s.m3u8_url, s.title, 'ARD Mediathek', s.created_at);
      reassignComments.run(info.lastInsertRowid, s.id);
      normalizeType.run(s.id);
    }
  });
  migrate(legacyStreams);
  console.log(`Migration: ${legacyStreams.length} ARD-Session(s) auf das vereinte Playlist-Modell umgestellt.`);
}
migrateLegacyArdStreamsToPlaylistItems();

// ---------- APP_SECRET: einmaliges Server-Secret zur Signierung von Access-Tokens ----------
//
// Priorität: Env-Var > bereits persistierte Datei im data/-Verzeichnis (per
// Docker-Volume dauerhaft) > neu generieren + persistieren. Ein Verlust des
// Secrets (z. B. Volume weg) invalidiert automatisch alle bestehenden
// Zugriffstokens für passwortgeschützte Sessions.

function loadOrCreateAppSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const secretPath = path.join(DATA_DIR, 'app_secret.key');
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}
const APP_SECRET = loadOrCreateAppSecret();

// ---------- Übersichtsseite (/overview): passwortgeschützte Liste ALLER
// Sessions ----------
//
// Ersetzt die frühere, ungeschützte Streamliste auf der Startseite (siehe
// PLAN.md/README.md) – die Startseite selbst listet keine Sessions mehr auf.
// Nur aktiv, wenn die Docker-Env-Var OVERVIEW_PASSWORD gesetzt ist; ohne sie
// antworten /overview und die zugehörigen API-Endpunkte mit 404, statt eine
// leere oder ungeschützte Seite auszuliefern. Anders als bei Session-
// Passwörtern gibt es hier bewusst keinen Datenbank-Hash: es ist ein
// einzelnes, betreiberseitig gesetztes Secret (wie APP_SECRET selbst), kein
// nutzerverwaltetes Passwort.
const OVERVIEW_PASSWORD = process.env.OVERVIEW_PASSWORD || '';

function makeOverviewAccessToken() {
  return crypto.createHmac('sha256', APP_SECRET).update(`overview:${OVERVIEW_PASSWORD}`).digest('hex');
}

function verifyOverviewAccessToken(token) {
  if (!OVERVIEW_PASSWORD || !token || typeof token !== 'string') return false;
  const expected = makeOverviewAccessToken();
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const nanoidId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);
const nanoidToken = customAlphabet(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  24
);

// ---------- Subpath-Hosting (Reverse-Proxy unter z. B. /duett/) ----------
//
// Wird per Env-Var BASE_PATH konfiguriert, z. B. BASE_PATH=/duett.
// Voraussetzung: der Reverse-Proxy entfernt das Präfix, bevor er die
// Anfrage weiterleitet (z. B. Apache "ProxyPass /duett/ http://.../"),
// sodass Express selbst weiterhin Pfade ohne Präfix sieht.
// BASE_PATH wird nur gebraucht, um (a) share_url/admin_url mit dem
// korrekten öffentlichen Präfix auszugeben und (b) den <base>-Tag im
// HTML zu setzen, an dem sich alle relativen Links/Requests orientieren.

let BASE_PATH = process.env.BASE_PATH || '';
if (BASE_PATH && !BASE_PATH.startsWith('/')) BASE_PATH = '/' + BASE_PATH;
BASE_PATH = BASE_PATH.replace(/\/+$/, ''); // kein trailing slash
const BASE_HREF = BASE_PATH + '/'; // z. B. "/duett/" oder "/"

// ---------- Helpers ----------

// Hinweis: HTML-Escaping der Kommentar-/Namensfelder erfolgt im Frontend
// (app.js, per textContent) beim Rendern. Die API liefert reines JSON.

const MAX_TITLE_LEN = 200;
const MAX_URL_LEN = 2000;
const MAX_NAME_LEN = 60;
const MAX_BODY_LEN = 2000;

// ---------- Kommentar-Bilder: als data: URL (base64) direkt in der
// comments.image-Spalte gespeichert, kein separates Datei-/Objektspeicher-
// Handling nötig. Das Frontend verkleinert/komprimiert Bilder bereits vor
// dem Senden (siehe app.js), MAX_IMAGE_BYTES ist trotzdem eine harte
// serverseitige Obergrenze gegen böswillig große Payloads.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB dekodiert
const IMAGE_DATA_URL_PATTERN = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

// Validiert einen vom Client gesendeten Bild-Wert. Gibt die (unveränderte)
// data-URL zurück, oder wirft einen Error mit nutzerverständlicher Meldung.
function validateImageDataUrl(value) {
  if (typeof value !== 'string') {
    throw new Error('Ungültiges Bildformat');
  }
  const match = IMAGE_DATA_URL_PATTERN.exec(value);
  if (!match) {
    throw new Error('Bild muss PNG, JPEG, GIF oder WebP sein');
  }
  const base64Body = match[2];
  // Größe aus der Base64-Länge schätzen, ohne komplett zu dekodieren.
  const approxBytes = Math.floor((base64Body.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    throw new Error(`Bild ist zu groß (max. ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB)`);
  }
  return value;
}

// Feste Farbpalette zur Selbst-Kennzeichnung neben dem Anzeigenamen (siehe
// name-modal in stream.html/mix.html). Bewusst keine freie Farbwahl, damit
// die Lesbarkeit auf dem dunklen Hintergrund garantiert ist und der Wert
// serverseitig strikt gegen eine Whitelist geprüft werden kann. Muss mit der
// Palette in public/app.js (AUTHOR_COLOR_PALETTE) synchron gehalten werden.
// Bewusst ohne Blautöne: --accent (die UI-eigene Akzentfarbe, siehe
// style.css) ist bereits blau, eine zusätzliche blaue Autor:innen-Farbe
// wäre davon kaum unterscheidbar.
const AUTHOR_COLOR_PALETTE = [
  '#db5762', '#db8357', '#dbaf57', '#d0db57', '#99db57',
  '#57db99', '#57dbd0', '#8e57db', '#db57d0', '#db5799',
];
const AUTHOR_COLOR_SET = new Set(AUTHOR_COLOR_PALETTE);

// Feste Auswahl an Reaction-Emojis für Kommentare (siehe POST
// /api/comments/:cid/reactions) – analog zur Farb-Palette oben bewusst auf
// eine feste, kleine Liste beschränkt statt beliebiger Emoji-Strings, um
// Spam/Missbrauch vorzubeugen. Muss mit REACTION_EMOJI_LIST in public/app.js
// synchron gehalten werden.
const REACTION_EMOJI_LIST = [
  '👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '👎',
  '😭', '😥', '💪', '🔥', '🙈', '😅', '🤷‍♂️', '👷', '😍', '🙄', '💯',
];
const REACTION_EMOJI_SET = new Set(REACTION_EMOJI_LIST);
const SLUG_MIN_LEN = 3;
const SLUG_MAX_LEN = 40;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ITEM_TITLE_LEN = 300;
const MAX_ITEM_ARTIST_LEN = 200;
const MAX_ITEM_URI_LEN = 300;
const MAX_ITEM_THUMBNAIL_LEN = 2000;
const MAX_NOTES_LEN = 5000;
const MAX_NOTES_LINES = 2000;

// ---------- Notizen: zeilenweise Autor-Zuordnung ----------
//
// Das gemeinsame Notizenfeld bleibt EIN Freitextfeld in der Bedienung, aber
// jede Zeile merkt sich, wer sie zuletzt bearbeitet hat (Name + gewählte
// Farbe), damit die Zeile clientseitig in genau dieser Farbe angezeigt
// werden kann (siehe app.js/createNotesController). Gespeichert wird das
// weiterhin in der bestehenden TEXT-Spalte `streams.notes` – migrationsfrei,
// nur die Serialisierung wechselt von rohem Text zu einem JSON-Array.
// Alte, rein textuelle Notizen (vor dieser Erweiterung) werden beim Lesen
// automatisch in autor-lose Zeilen umgewandelt, statt verloren zu gehen.

function parseNotesLines(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((l) => l && typeof l.text === 'string')
        .map((l) => ({
          text: l.text,
          author_name: typeof l.author_name === 'string' ? l.author_name : null,
          author_color:
            typeof l.author_color === 'string' && AUTHOR_COLOR_SET.has(l.author_color) ? l.author_color : null,
        }));
    }
  } catch {
    // Kein JSON -> Alt-Format, siehe Fallback unten
  }
  return String(raw)
    .split('\n')
    .map((text) => ({ text, author_name: null, author_color: null }));
}

function serializeNotesLines(lines) {
  return JSON.stringify(lines);
}

// Validiert die vom Client gesendeten Zeilen und normalisiert sie (unbekannte
// Zusatzfelder werden verworfen). Gibt bei ungültiger Eingabe null zurück.
function validateNotesLines(input) {
  if (!Array.isArray(input) || input.length > MAX_NOTES_LINES) return null;
  const out = [];
  let totalLen = 0;
  for (const l of input) {
    if (!l || typeof l.text !== 'string') return null;
    totalLen += l.text.length;
    if (totalLen > MAX_NOTES_LEN) return null;

    let author_name = null;
    if (l.author_name !== undefined && l.author_name !== null) {
      if (typeof l.author_name !== 'string' || l.author_name.length > MAX_NAME_LEN) return null;
      author_name = l.author_name;
    }
    let author_color = null;
    if (l.author_color !== undefined && l.author_color !== null && l.author_color !== '') {
      if (typeof l.author_color !== 'string' || !AUTHOR_COLOR_SET.has(l.author_color)) return null;
      author_color = l.author_color;
    }
    out.push({ text: l.text, author_name, author_color });
  }
  return out;
}
// YouTube-Playlist-Embeds deckeln traditionell bei ca. 200 Videos (siehe
// PLAN.md) – etwas Luft nach oben, aber klare Obergrenze gegen Missbrauch.
const MAX_CLIENT_ITEMS_PER_REQUEST = 300;

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidSlug(str) {
  return (
    str.length >= SLUG_MIN_LEN && str.length <= SLUG_MAX_LEN && SLUG_PATTERN.test(str)
  );
}

// ---------- Content-Mix: Playlist-Items ----------
//
// Spotify-Items kommen IMMER über spotifyResolver.js (serverseitig
// verifiziert). YouTube-Items werden clientseitig aufgelöst (siehe
// PLAN.md – YT.Player.getPlaylist() braucht einen echten Browser-Kontext)
// und hier nur noch validiert/bereinigt, nicht "vertraut" übernommen.
// Deshalb ist provider='spotify' im Client-Item-Pfad bewusst verboten.

function sanitizeClientItem(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Ungültiges Playlist-Item');
  }
  const { provider, provider_uri, title, artist_or_channel, duration_ms, thumbnail_url } = raw;

  if (provider !== 'youtube') {
    throw new Error('Nur clientseitig aufgelöste YouTube-Items sind hier erlaubt');
  }
  if (typeof provider_uri !== 'string' || !provider_uri.trim() || provider_uri.length > MAX_ITEM_URI_LEN) {
    throw new Error('provider_uri fehlt oder zu lang');
  }
  if (typeof title !== 'string' || !title.trim() || title.length > MAX_ITEM_TITLE_LEN) {
    throw new Error('Item-Titel fehlt oder zu lang');
  }

  return {
    provider: 'youtube',
    provider_uri: provider_uri.trim(),
    title: title.trim(),
    artist_or_channel:
      typeof artist_or_channel === 'string' ? artist_or_channel.trim().slice(0, MAX_ITEM_ARTIST_LEN) : '',
    duration_ms: Number.isFinite(duration_ms) ? Math.max(0, Math.floor(duration_ms)) : null,
    thumbnail_url:
      typeof thumbnail_url === 'string' ? thumbnail_url.trim().slice(0, MAX_ITEM_THUMBNAIL_LEN) : null,
  };
}

// Ermittelt einen brauchbaren Anzeigetitel für einen roh eingefügten
// Video-/m3u8-Link ohne eigene Metadaten (letztes Pfadsegment, von
// Dateiendung/Trennzeichen befreit) – Fallback "Video", falls das nicht
// gelingt (z. B. URL ohne Pfad).
function deriveTitleFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last) {
      const cleaned = decodeURIComponent(last)
        .replace(/\.[a-z0-9]{2,5}$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim();
      if (cleaned) return cleaned.slice(0, MAX_ITEM_TITLE_LEN);
    }
  } catch {
    // ignore
  }
  return 'Video';
}

function isArdMediathekUrl(rawUrl) {
  try {
    return /(^|\.)ardmediathek\.de$/i.test(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

// Löst eine Quelle (Spotify-/TikTok-/Instagram-/ARD-Mediathek-URL oder ein
// direkter m3u8-/Video-Link, serverseitig aufgelöst, ODER bereits
// clientseitig aufgelöste YouTube-Item-Liste) zu einem Array fertiger
// Playlist-Items auf. Genutzt sowohl beim Anlegen einer Session als auch
// beim nachträglichen Hinzufügen weiterer Items – ARD/m3u8 ist dabei ein
// Provider unter mehreren, kein Sonderfall mehr (siehe PLAN.md/Vereinigung
// ARD+Content-Mix). TikTok- und Instagram-Links liefern (wie Spotify-Track-
// und ARD-Links) immer genau ein Item – keiner dieser drei kennt ein
// Playlist-/Album-Konzept wie Spotify (Album/Playlist) oder YouTube.
async function resolveSourceToItems(url, items) {
  if (Array.isArray(items) && items.length > 0) {
    if (items.length > MAX_CLIENT_ITEMS_PER_REQUEST) {
      throw new Error(`Zu viele Items auf einmal (max. ${MAX_CLIENT_ITEMS_PER_REQUEST})`);
    }
    return items.map(sanitizeClientItem);
  }
  if (typeof url === 'string' && url.trim()) {
    const trimmed = url.trim();
    if (looksLikeTikTokUrl(trimmed)) {
      return await resolveTikTok(trimmed);
    }
    if (looksLikeInstagramUrl(trimmed)) {
      return await resolveInstagram(trimmed);
    }
    if (parseSpotifyInput(trimmed)) {
      return await resolveSpotify(trimmed);
    }
    if (isArdMediathekUrl(trimmed)) {
      const { m3u8_url, title } = await resolveArdMediathek(trimmed);
      return [
        {
          provider: 'ard',
          provider_uri: m3u8_url,
          title: title || 'ARD-Video',
          artist_or_channel: 'ARD Mediathek',
          duration_ms: null,
          thumbnail_url: null,
          source_url: trimmed,
        },
      ];
    }
    if (isZdfUrl(trimmed)) {
      const { m3u8_url, title } = await resolveZdfMediathek(trimmed);
      return [
        {
          provider: 'ard',
          provider_uri: m3u8_url,
          title: title || 'ZDF-Video',
          artist_or_channel: 'ZDF Mediathek',
          duration_ms: null,
          thumbnail_url: null,
          source_url: trimmed,
        },
      ];
    }
    if (isValidUrl(trimmed)) {
      // Kein erkannter Anbieter, aber eine gültige http(s)-URL: als direkter
      // Video-/m3u8-Link behandeln (deckt z. B. selbst gehostete m3u8-
      // Playlists ab, die nicht über ardmediathek.de laufen).
      return [
        {
          provider: 'ard',
          provider_uri: trimmed,
          title: deriveTitleFromUrl(trimmed),
          artist_or_channel: '',
          duration_ms: null,
          thumbnail_url: null,
        },
      ];
    }
    throw new Error('Das ist weder ein erkennbarer Link noch eine gültige URL');
  }
  throw new Error('Bitte eine Spotify-, YouTube-, TikTok-, Instagram- oder ARD-/Video-Quelle angeben');
}

// Hängt Items ans Ende der bestehenden Playlist eines Streams an
// (position fortlaufend), in einer Transaktion für Konsistenz. Items, die
// (per provider + provider_uri) bereits in der Playlist stehen, werden dabei
// übersprungen statt dupliziert – wichtig u. a. dafür, dass ein Link, der in
// mehreren Kommentaren gepostet wird, nicht bei jedem Mal einen neuen
// Playlist-Eintrag erzeugt (siehe automatisches Hinzufügen aus Kommentaren
// in app.js).
function insertPlaylistItems(streamId, items) {
  const existingKeys = new Set(
    db
      .prepare('SELECT provider, provider_uri FROM playlist_items WHERE stream_id = ?')
      .all(streamId)
      .map((r) => `${r.provider}:${r.provider_uri}`)
  );

  const maxPos = db
    .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM playlist_items WHERE stream_id = ?')
    .get(streamId).m;
  const insert = db.prepare(
    'INSERT INTO playlist_items (stream_id, position, provider, provider_uri, title, artist_or_channel, duration_ms, thumbnail_url, added_at, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const now = Date.now();
  const insertMany = db.transaction((rows) => {
    let pos = maxPos + 1;
    for (const item of rows) {
      const key = `${item.provider}:${item.provider_uri}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      insert.run(
        streamId,
        pos,
        item.provider,
        item.provider_uri,
        item.title,
        item.artist_or_channel || '',
        item.duration_ms,
        item.thumbnail_url,
        now,
        item.source_url || null
      );
      pos += 1;
    }
  });
  insertMany(items);
}

const PLAYLIST_ITEM_COLUMNS =
  'id, stream_id, position, provider, provider_uri, title, artist_or_channel, duration_ms, thumbnail_url, added_at, source_url';

// ---------- Passwortschutz pro Session ----------
//
// Der Access-Token ist ein HMAC über stream_id + password_hash mit dem
// serverseitigen APP_SECRET. Ändert sich das Passwort (also der
// password_hash), werden dadurch automatisch alle zuvor ausgestellten
// Tokens ungültig, ohne eine eigene Sessions-Tabelle führen zu müssen.

function makeAccessToken(streamId, passwordHash) {
  return crypto.createHmac('sha256', APP_SECRET).update(`${streamId}:${passwordHash}`).digest('hex');
}

function verifyAccessToken(streamId, passwordHash, token) {
  if (!token || typeof token !== 'string') return false;
  const expected = makeAccessToken(streamId, passwordHash);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Prüft bei passwortgeschützten Streams den Zugriff (Access-Token ODER
// Admin-Token). Sendet bei fehlendem/ungültigem Zugriff selbst eine 401-
// Antwort ohne Titel-/Inhalts-Leak. Unprotected Streams (password_hash =
// NULL) sind immer zugänglich.
function checkStreamAccess(req, res, stream) {
  if (!stream.password_hash) return true;

  const adminToken = req.get('X-Admin-Token') || req.body?.admin_token || req.query?.admin_token;
  if (adminToken && adminToken === stream.admin_token) return true;

  const accessToken = req.get('X-Stream-Access') || req.query?.access_token;
  if (verifyAccessToken(stream.id, stream.password_hash, accessToken)) return true;

  res.status(401).json({ error: 'Passwort erforderlich', password_required: true });
  return false;
}

// Lädt einen Stream inkl. interner Felder (admin_token/password_hash) und
// prüft dabei gleich den Zugriffsschutz. Gibt bei 404/401 null zurück
// (Response wurde bereits gesendet) – Aufrufer müssen selbst entscheiden,
// welche Felder sie an den Client zurückgeben (admin_token/password_hash
// dürfen nie im JSON landen).
function getAuthorizedStream(req, res) {
  const stream = db
    .prepare(
      'SELECT id, title, m3u8_url, admin_token, password_hash, type, notes, created_at FROM streams WHERE id = ?'
    )
    .get(req.params.id);
  if (!stream) {
    res.status(404).json({ error: 'Stream nicht gefunden' });
    return null;
  }
  if (!checkStreamAccess(req, res, stream)) return null;
  return stream;
}

function requireAdmin(req, res, streamId) {
  const token = req.get('X-Admin-Token') || req.body?.admin_token || req.query?.admin_token;
  const row = db.prepare('SELECT admin_token FROM streams WHERE id = ?').get(streamId);
  if (!row) {
    res.status(404).json({ error: 'Stream nicht gefunden' });
    return false;
  }
  if (!token || token !== row.admin_token) {
    res.status(403).json({ error: 'Ungültiges oder fehlendes Admin-Token' });
    return false;
  }
  return true;
}

function renderTemplate(res, fileName) {
  const filePath = path.join(__dirname, 'public', fileName);
  let html = fs.readFileSync(filePath, 'utf8');
  html = html.split('__BASE_HREF__').join(BASE_HREF);
  res.type('html').send(html);
}

// ---------- ARD-Mediathek: m3u8-Link aus Seiten-URL auflösen ----------
//
// Erwartet eine ardmediathek.de-Video-URL, z. B.
// https://www.ardmediathek.de/video/<slug>/<slug>/<sender>/<ID>
// Das letzte Pfadsegment ist die Video-ID, die an die öffentliche
// page-gateway-API übergeben wird. Aus der Antwort wird der erste
// HLS-Stream (mimeType application/vnd.apple.mpegurl) extrahiert.

async function resolveArdMediathek(pageUrl) {
  let parsed;
  try {
    parsed = new URL(pageUrl);
  } catch {
    throw new Error('Das ist keine gültige URL');
  }
  if (!/(^|\.)ardmediathek\.de$/i.test(parsed.hostname)) {
    throw new Error('Das ist kein ardmediathek.de-Link');
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  const id = segments[segments.length - 1];
  if (!id) {
    throw new Error('Konnte keine Video-ID aus dem Link extrahieren');
  }

  const apiUrl = `https://api.ardmediathek.de/page-gateway/pages/ard/item/${encodeURIComponent(
    id
  )}?embedded=false&mcV6=true`;

  let apiRes;
  try {
    apiRes = await fetch(apiUrl, {
      headers: { Accept: 'application/vnd.ard.page+json, application/json' },
    });
  } catch {
    throw new Error('ARD-Mediathek-API war nicht erreichbar');
  }
  if (!apiRes.ok) {
    throw new Error(`ARD-Mediathek-API antwortete mit ${apiRes.status}`);
  }

  const data = await apiRes.json();
  const widgets = Array.isArray(data.widgets) ? data.widgets : [];

  let m3u8Url = null;
  for (const widget of widgets) {
    const streams = widget?.mediaCollection?.embedded?.streams || [];
    for (const stream of streams) {
      const media = stream?.media || [];
      const hls = media.find((m) => m?.mimeType === 'application/vnd.apple.mpegurl');
      if (hls?.url) {
        m3u8Url = hls.url;
        break;
      }
    }
    if (m3u8Url) break;
  }

  if (!m3u8Url) {
    throw new Error('Kein HLS-Stream (m3u8) in diesem ARD-Video gefunden');
  }

  const title = data.title || widgets[0]?.title || widgets[0]?.mediaCollection?.embedded?.meta?.title || '';

  return { m3u8_url: m3u8Url, title };
}

// ---------- ZDF-Mediathek: m3u8-Link aus Seiten-URL auflösen ----------
//
// Erwartet einen zdf.de/video/... oder zdf.de/play/...-Link, z. B.
// https://www.zdf.de/play/dokus/.../schuld-und-suehne-ein-duesterer-verdacht-der-fall-dorota-g-100
// Das letzte Pfadsegment ist die "canonical"-ID. Ablauf (nachgebildet nach
// der öffentlichen, tokenlosen API, die auch die offizielle ZDF-Android-App
// nutzt):
//   1. Kurzlebiges API-Token von der Token-API holen (gecacht, siehe
//      zdfTokenCache).
//   2. GraphQL-Query VideoByCanonical liefert Titel + ein "ptmdTemplate"
//      (Platzhalter-URL für die eigentlichen Stream-Metadaten).
//   3. Das Template (Platzhalter {playerId}) auflösen und abrufen (PTMD =
//      "Playout Timed Media Document") -> daraus den ersten HLS-Track
//      (.m3u8) extrahieren.
// Ähnlich wie bei ARD landet das Ergebnis als generisches 'ard'-Item (siehe
// resolveSourceToItems) – 'ard' ist seit der ARD/Content-Mix-Vereinigung der
// Provider-Name für "beliebiges HLS-/Video-Element", kein ARD-Sonderfall
// mehr.

let zdfTokenCache = null; // { value: 'Bearer <token>', expiresAt: <unix-sekunden> }

async function getZdfApiToken() {
  const now = Math.floor(Date.now() / 1000);
  if (zdfTokenCache && zdfTokenCache.expiresAt > now + 30) {
    return zdfTokenCache.value;
  }
  let res;
  try {
    res = await fetch('https://zdf-prod-futura.zdf.de/mediathekV2/token');
  } catch {
    throw new Error('ZDF-Token-API war nicht erreichbar');
  }
  if (!res.ok) {
    throw new Error(`ZDF-Token-API antwortete mit ${res.status}`);
  }
  const data = await res.json();
  if (!data?.token || !data?.type) {
    throw new Error('ZDF-Token-API lieferte kein Token');
  }
  zdfTokenCache = {
    value: `${data.type} ${data.token}`,
    expiresAt: Number(data.expires) || now + 300,
  };
  return zdfTokenCache.value;
}

const ZDF_GRAPHQL_VIDEO_QUERY = `
query VideoByCanonical($canonical: String!) {
  videoByCanonical(canonical: $canonical) {
    canonical
    title
    currentMedia {
      nodes {
        ptmdTemplate
      }
    }
  }
}
`;

function isZdfUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return /(^|\.)zdf\.de$/i.test(parsed.hostname) && /^\/(video|play)\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function resolveZdfMediathek(pageUrl) {
  let parsed;
  try {
    parsed = new URL(pageUrl);
  } catch {
    throw new Error('Das ist keine gültige URL');
  }
  if (!isZdfUrl(pageUrl)) {
    throw new Error('Das ist kein zdf.de/video- oder zdf.de/play-Link');
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  const canonical = segments[segments.length - 1];
  if (!canonical) {
    throw new Error('Konnte keine Video-ID aus dem Link extrahieren');
  }

  const apiToken = await getZdfApiToken();

  let gqlRes;
  try {
    gqlRes = await fetch('https://api.zdf.de/graphql', {
      method: 'POST',
      headers: {
        'Api-Auth': apiToken,
        'Apollo-Require-Preflight': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        operationName: 'VideoByCanonical',
        query: ZDF_GRAPHQL_VIDEO_QUERY,
        variables: { canonical },
      }),
    });
  } catch {
    throw new Error('ZDF-API war nicht erreichbar');
  }
  if (!gqlRes.ok) {
    throw new Error(`ZDF-API antwortete mit ${gqlRes.status}`);
  }
  const gqlData = await gqlRes.json();
  const video = gqlData?.data?.videoByCanonical;
  if (!video) {
    throw new Error('Kein ZDF-Video unter diesem Link gefunden');
  }

  const nodes = video?.currentMedia?.nodes || [];
  const ptmdTemplate = nodes.find((n) => n?.ptmdTemplate)?.ptmdTemplate;
  if (!ptmdTemplate) {
    throw new Error('Kein abspielbarer Stream für dieses ZDF-Video gefunden');
  }
  const ptmdUrl = new URL(ptmdTemplate.replace('{playerId}', 'android_native_6'), 'https://api.zdf.de').toString();

  let ptmdRes;
  try {
    ptmdRes = await fetch(ptmdUrl, { headers: { 'Api-Auth': apiToken } });
  } catch {
    throw new Error('ZDF-Stream-API war nicht erreichbar');
  }
  if (!ptmdRes.ok) {
    throw new Error(`ZDF-Stream-API antwortete mit ${ptmdRes.status}`);
  }
  const ptmd = await ptmdRes.json();

  let m3u8Url = null;
  outer: for (const p of ptmd?.priorityList || []) {
    for (const f of p?.formitaeten || []) {
      for (const q of f?.qualities || []) {
        for (const t of q?.audio?.tracks || []) {
          if (typeof t?.uri === 'string' && t.uri.includes('.m3u8')) {
            m3u8Url = t.uri;
            break outer;
          }
        }
      }
    }
  }

  if (!m3u8Url) {
    throw new Error('Kein HLS-Stream (m3u8) in diesem ZDF-Video gefunden');
  }

  return { m3u8_url: m3u8Url, title: video.title || '' };
}

// ---------- App ----------

const app = express();
app.set('trust proxy', 1);
// Limit angehoben (statt 100kb), damit base64-kodierte Kommentarbilder
// (siehe MAX_IMAGE_BYTES) den JSON-Body nicht sprengen. Base64 + JSON-
// Overhead sowie Body-Text on top von MAX_IMAGE_BYTES eingerechnet.
app.use(express.json({ limit: '6mb' }));

// ---------- Seiten (vor express.static, damit der <base>-Tag injiziert wird) ----------

app.get('/', (req, res) => {
  renderTemplate(res, 'index.html');
});

app.get('/s/:id', (req, res) => {
  // Jede Session (ARD-Video, Spotify/YouTube/TikTok/Instagram oder eine
  // Mischung daraus) nutzt seit der Vereinigung dieselbe Seiten-Vorlage.
  renderTemplate(res, 'session.html');
});

app.get('/overview', (req, res) => {
  renderTemplate(res, 'overview.html');
});

// index: false verhindert, dass express.static "/" mit der rohen,
// nicht-templated index.html beantwortet, bevor obige Route greift.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Rate limiting: schreibende Endpunkte pro IP begrenzen
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen, bitte kurz warten.' },
});

// Strengeres Limit speziell für Login-Versuche gegen ein Session-Passwort
// (Brute-Force-Schutz), zusätzlich zum allgemeinen writeLimiter.
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Versuche, bitte kurz warten.' },
});

// ---------- API ----------

// Alle Streams auflisten (chronologisch absteigend, für die Startseite).
// Titel von passwortgeschützten Streams werden hier NICHT ausgegeben (nur
// das Faktum, dass ein Schutz besteht) – sonst könnte man den Schutz einfach
// umgehen, indem man sich die Inhaltsübersicht auf der Startseite ansieht.
app.get('/api/streams', (req, res) => {
  const rows = db
    .prepare('SELECT id, title, created_at, password_hash, type FROM streams ORDER BY created_at DESC')
    .all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      title: r.password_hash ? null : r.title,
      type: r.type || 'ard',
      password_protected: !!r.password_hash,
      created_at: r.created_at,
    }))
  );
});

// ARD-Mediathek-Link zu m3u8-URL auflösen
app.post('/api/resolve-ard', writeLimiter, async (req, res) => {
  const { url } = req.body || {};
  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'URL fehlt' });
  }
  try {
    const result = await resolveArdMediathek(url.trim());
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'ARD-Link konnte nicht aufgelöst werden' });
  }
});

// Session anlegen. Eine erste Quelle (url ODER items) ist bewusst optional –
// eine Session kann auch komplett leer starten und beliebige Quellen
// (Spotify/YouTube/TikTok/Instagram/ARD-Mediathek/m3u8) später über
// "+ Hinzufügen" auf der Session-Seite bekommen (siehe POST
// /api/streams/:id/items), genau wie eine mit Erstquelle angelegte Session.
app.post('/api/streams', writeLimiter, async (req, res) => {
  const { title, slug, url, items, password } = req.body || {};

  if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LEN) {
    return res.status(400).json({ error: `Titel fehlt oder zu lang (max ${MAX_TITLE_LEN} Zeichen)` });
  }

  // Passwort ist optional und kann bereits beim Anlegen vergeben werden
  // (Frontend fragt standardmäßig danach) statt erst nachträglich über den
  // Admin-Link (PUT /api/streams/:id/password, dieselbe Validierung dort).
  let passwordHash = null;
  if (password !== undefined && password !== null && password !== '') {
    if (typeof password !== 'string' || password.length < 4 || password.length > 200) {
      return res.status(400).json({ error: 'Passwort muss 4–200 Zeichen lang sein' });
    }
    passwordHash = bcrypt.hashSync(password, 10);
  }

  let initialItems = [];
  const hasSource = (typeof url === 'string' && url.trim()) || (Array.isArray(items) && items.length > 0);
  if (hasSource) {
    try {
      initialItems = await resolveSourceToItems(url, items);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Quelle konnte nicht aufgelöst werden' });
    }
  }

  // Optionaler eigener Kurzlink (statt der zufällig generierten ID). Leer/
  // nicht angegeben -> wie bisher zufällige ID.
  let id;
  const trimmedSlug = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
  if (trimmedSlug) {
    if (!isValidSlug(trimmedSlug)) {
      return res.status(400).json({
        error: `Kurzlink muss ${SLUG_MIN_LEN}–${SLUG_MAX_LEN} Zeichen lang sein und darf nur Kleinbuchstaben, Zahlen und Bindestriche enthalten (nicht am Anfang/Ende, nicht doppelt).`,
      });
    }
    const existing = db.prepare('SELECT id FROM streams WHERE id = ?').get(trimmedSlug);
    if (existing) {
      return res.status(409).json({ error: 'Dieser Kurzlink ist bereits vergeben.' });
    }
    id = trimmedSlug;
  } else {
    id = nanoidId();
  }

  const adminToken = nanoidToken();
  const createdAt = Date.now();

  // m3u8_url/type sind vestigiale Spalten aus der Zeit vor der Vereinigung
  // von ARD-Mediathek und Content-Mix (siehe migrateLegacyArdStreamsToPlaylistItems
  // oben) – jede neue Session ist playlist-basiert, unabhängig vom Provider
  // ihrer Items.
  db.prepare(
    "INSERT INTO streams (id, title, m3u8_url, admin_token, created_at, type, password_hash) VALUES (?, ?, '', ?, ?, 'content_mix', ?)"
  ).run(id, title.trim(), adminToken, createdAt, passwordHash);

  if (initialItems.length > 0) {
    insertPlaylistItems(id, initialItems);
  }

  res.status(201).json({
    id,
    title: title.trim(),
    admin_token: adminToken,
    password_protected: !!passwordHash,
    items: initialItems.map((it) => ({ provider: it.provider, title: it.title })),
    share_url: `${BASE_PATH}/s/${id}`,
    admin_url: `${BASE_PATH}/s/${id}?admin=${adminToken}`,
  });
});

// Stream-Metadaten
app.get('/api/streams/:id', (req, res) => {
  const stream = getAuthorizedStream(req, res);
  if (!stream) return;
  res.json({
    id: stream.id,
    title: stream.title,
    created_at: stream.created_at,
    password_protected: !!stream.password_hash,
    notes: parseNotesLines(stream.notes),
  });
});

// Notizen abrufen: eigener, leichter Endpoint (statt der vollen
// Stream-Metadaten) fürs regelmäßige Polling, damit Notizen anderer
// Betrachtender zeitnah sichtbar werden.
app.get('/api/streams/:id/notes', (req, res) => {
  const stream = getAuthorizedStream(req, res);
  if (!stream) return;
  res.json({ lines: parseNotesLines(stream.notes) });
});

// Notizen speichern. Wie bei Playlist-Items und Kommentaren gilt das
// No-Login-Prinzip: jede Person mit Zugriff auf die Session (Share-Link,
// ggf. + Passwort) kann das gemeinsame Notizenfeld bearbeiten – kein
// Admin-Zwang, kein Owner-Konzept für dieses Feld. Erwartet wird das
// vollständige, clientseitig bereits zeilenweise dem jeweils bearbeitenden
// Autor zugeordnete Array (siehe validateNotesLines).
app.put('/api/streams/:id/notes', writeLimiter, (req, res) => {
  const stream = getAuthorizedStream(req, res);
  if (!stream) return;

  const lines = validateNotesLines((req.body || {}).lines);
  if (!lines) {
    return res.status(400).json({ error: `Ungültige Notizen (max ${MAX_NOTES_LINES} Zeilen, max ${MAX_NOTES_LEN} Zeichen gesamt)` });
  }

  db.prepare('UPDATE streams SET notes = ? WHERE id = ?').run(serializeNotesLines(lines), req.params.id);
  res.json({ lines });
});

// Passwort einer geschützten Session prüfen und einen Access-Token ausstellen
app.post('/api/streams/:id/auth', authLimiter, (req, res) => {
  const stream = db
    .prepare('SELECT id, password_hash FROM streams WHERE id = ?')
    .get(req.params.id);
  if (!stream) {
    return res.status(404).json({ error: 'Stream nicht gefunden' });
  }
  if (!stream.password_hash) {
    return res.status(400).json({ error: 'Diese Session ist nicht passwortgeschützt' });
  }

  const { password } = req.body || {};
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Passwort fehlt' });
  }

  const ok = bcrypt.compareSync(password, stream.password_hash);
  if (!ok) {
    return res.status(403).json({ error: 'Falsches Passwort' });
  }

  const accessToken = makeAccessToken(stream.id, stream.password_hash);
  res.json({ access_token: accessToken });
});

// Passwortschutz setzen/ändern/entfernen (nur Admin). Leeres/fehlendes
// Passwort entfernt den Schutz wieder.
app.put('/api/streams/:id/password', writeLimiter, (req, res) => {
  const stream = db.prepare('SELECT id FROM streams WHERE id = ?').get(req.params.id);
  if (!stream) {
    return res.status(404).json({ error: 'Stream nicht gefunden' });
  }
  if (!requireAdmin(req, res, req.params.id)) return;

  const { password } = req.body || {};

  if (password === undefined || password === null || password === '') {
    db.prepare('UPDATE streams SET password_hash = NULL WHERE id = ?').run(req.params.id);
    return res.json({ password_protected: false });
  }

  if (typeof password !== 'string' || password.length < 4 || password.length > 200) {
    return res.status(400).json({ error: 'Passwort muss 4–200 Zeichen lang sein' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE streams SET password_hash = ? WHERE id = ?').run(passwordHash, req.params.id);
  res.json({ password_protected: true });
});

// ---------- Übersichtsseite: Auth + Session-Liste ----------

app.post('/api/overview/auth', authLimiter, (req, res) => {
  if (!OVERVIEW_PASSWORD) {
    return res.status(404).json({ error: 'Übersichtsseite ist nicht aktiviert' });
  }
  const { password } = req.body || {};
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Passwort fehlt' });
  }
  const a = Buffer.from(password);
  const b = Buffer.from(OVERVIEW_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    return res.status(403).json({ error: 'Falsches Passwort' });
  }
  res.json({ access_token: makeOverviewAccessToken() });
});

// Liefert ALLE Sessions inkl. Titel (auch bei passwortgeschützten Sessions –
// anders als /api/streams, das für die alte, öffentliche Startseiten-Liste
// gedacht war). Nur mit gültigem Übersichts-Access-Token erreichbar.
app.get('/api/overview/streams', (req, res) => {
  if (!OVERVIEW_PASSWORD) {
    return res.status(404).json({ error: 'Übersichtsseite ist nicht aktiviert' });
  }
  const token = req.get('X-Overview-Access') || req.query?.access_token;
  if (!verifyOverviewAccessToken(token)) {
    return res.status(401).json({ error: 'Passwort erforderlich' });
  }

  const rows = db
    .prepare('SELECT id, title, created_at, password_hash FROM streams ORDER BY created_at DESC')
    .all();
  const itemStats = db
    .prepare(
      'SELECT stream_id, COUNT(*) AS n, GROUP_CONCAT(DISTINCT provider) AS providers FROM playlist_items GROUP BY stream_id'
    )
    .all();
  const statsMap = new Map(itemStats.map((r) => [r.stream_id, r]));

  res.json(
    rows.map((r) => {
      const stats = statsMap.get(r.id);
      return {
        id: r.id,
        title: r.title,
        created_at: r.created_at,
        password_protected: !!r.password_hash,
        item_count: stats ? stats.n : 0,
        providers: stats ? stats.providers.split(',') : [],
      };
    })
  );
});

// Alle Playlist-Items einer Content-Mix-Session, geordnet
app.get('/api/streams/:id/items', (req, res) => {
  const stream = getAuthorizedStream(req, res);
  if (!stream) return;

  const rows = db
    .prepare(`SELECT ${PLAYLIST_ITEM_COLUMNS} FROM playlist_items WHERE stream_id = ? ORDER BY position ASC`)
    .all(req.params.id);

  res.json(rows);
});

// Weiteres Item hinzufügen: entweder { url } (Spotify, serverseitig
// aufgelöst) oder { items: [...] } (YouTube, bereits clientseitig aufgelöst
// und hier nur noch validiert). Auch von anderen Betrachtenden mit dem
// Share-Link nutzbar, nicht nur vom Admin.
app.post('/api/streams/:id/items', writeLimiter, async (req, res) => {
  const stream = getAuthorizedStream(req, res);
  if (!stream) return;

  const { url, items } = req.body || {};
  let resolved;
  try {
    resolved = await resolveSourceToItems(url, items);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Quelle konnte nicht aufgelöst werden' });
  }

  insertPlaylistItems(stream.id, resolved);

  const rows = db
    .prepare(`SELECT ${PLAYLIST_ITEM_COLUMNS} FROM playlist_items WHERE stream_id = ? ORDER BY position ASC`)
    .all(stream.id);

  res.status(201).json(rows);
});

// Item entfernen: wie das Hinzufügen (POST .../items) auch von anderen
// Betrachtenden mit Zugriff auf die Session nutzbar, nicht nur vom Admin.
app.delete('/api/items/:iid', writeLimiter, (req, res) => {
  const item = db.prepare('SELECT id, stream_id FROM playlist_items WHERE id = ?').get(req.params.iid);
  if (!item) {
    return res.status(404).json({ error: 'Item nicht gefunden' });
  }
  const stream = db
    .prepare('SELECT id, admin_token, password_hash FROM streams WHERE id = ?')
    .get(item.stream_id);
  if (!stream) {
    return res.status(404).json({ error: 'Stream nicht gefunden' });
  }
  if (!checkStreamAccess(req, res, stream)) return;

  db.prepare('DELETE FROM playlist_items WHERE id = ?').run(item.id);
  res.json({ ok: true });
});

// Frischen m3u8-Link für ein ARD-/ZDF-Item nachladen: Die von den Sendern
// ausgegebenen Stream-URLs enthalten häufig kurzlebige Zugriffs-Tokens
// (siehe resolveArdMediathek/resolveZdfMediathek), die in einer über Stunden
// oder Tage laufenden Session ablaufen können, während der beim Hinzufügen
// aufgelöste provider_uri unverändert in der DB steht ("Fehler beim Laden
// des Videos..." im Player ist meist genau das, kein echtes CORS-Problem).
// Client ruft diesen Endpoint bei einem fatalen HLS-Ladefehler auf, bevor er
// die Fehlermeldung anzeigt (siehe loadArdItem in app.js).
app.post('/api/items/:iid/refresh', writeLimiter, async (req, res) => {
  const item = db
    .prepare('SELECT id, stream_id, provider, source_url FROM playlist_items WHERE id = ?')
    .get(req.params.iid);
  if (!item) {
    return res.status(404).json({ error: 'Item nicht gefunden' });
  }
  const stream = db
    .prepare('SELECT id, admin_token, password_hash FROM streams WHERE id = ?')
    .get(item.stream_id);
  if (!stream) {
    return res.status(404).json({ error: 'Stream nicht gefunden' });
  }
  if (!checkStreamAccess(req, res, stream)) return;

  if (item.provider !== 'ard' || !item.source_url) {
    return res.status(400).json({ error: 'Für dieses Item gibt es keine Quelle zum Neuauflösen' });
  }

  try {
    const { m3u8_url } = isZdfUrl(item.source_url)
      ? await resolveZdfMediathek(item.source_url)
      : await resolveArdMediathek(item.source_url);
    db.prepare('UPDATE playlist_items SET provider_uri = ? WHERE id = ?').run(m3u8_url, item.id);
    res.json({ provider_uri: m3u8_url });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Konnte nicht neu aufgelöst werden' });
  }
});

// Alle Kommentare eines Streams
app.get('/api/streams/:id/comments', (req, res) => {
  const stream = getAuthorizedStream(req, res);
  if (!stream) return;

  // Bei Content-Mix-Sessions sortieren wir nach (Item-Position, Timecode
  // innerhalb des Items) statt nach einem globalen Session-Timecode – ein
  // LEFT JOIN reicht, da ard-Kommentare kein item_id haben (COALESCE -> 0).
  const rows = db
    .prepare(
      `SELECT c.id, c.stream_id, c.parent_id, c.timecode_sec, c.item_id, c.author_name, c.author_color, c.body, c.image, c.created_at, c.updated_at
       FROM comments c
       LEFT JOIN playlist_items pi ON pi.id = c.item_id
       WHERE c.stream_id = ?
       ORDER BY COALESCE(pi.position, 0) ASC, COALESCE(c.timecode_sec, 1e18) ASC, c.created_at ASC`
    )
    .all(req.params.id);

  // Reaktionen separat laden und pro Kommentar anhängen (statt JOIN), damit
  // die Kommentar-Zeilen nicht pro Reaktion dupliziert werden. Aggregation
  // (Zählung, "habe ich selbst reagiert") übernimmt bewusst der Client – so
  // wie auch Antworten (parent_id) clientseitig gruppiert werden.
  const reactionsByComment = new Map();
  if (rows.length > 0) {
    const placeholders = rows.map(() => '?').join(',');
    const reactionRows = db
      .prepare(
        `SELECT comment_id, emoji, author_name FROM comment_reactions WHERE comment_id IN (${placeholders})`
      )
      .all(...rows.map((r) => r.id));
    reactionRows.forEach((rr) => {
      if (!reactionsByComment.has(rr.comment_id)) reactionsByComment.set(rr.comment_id, []);
      reactionsByComment.get(rr.comment_id).push({ emoji: rr.emoji, author_name: rr.author_name });
    });
  }
  rows.forEach((r) => {
    r.reactions = reactionsByComment.get(r.id) || [];
  });

  // Gelesen-Status: nur relevant, wenn der Client einen Anzeigenamen mitgibt
  // (Query-Param author_name, analog zu den Reactions). Eigene Kommentare
  // gelten immer als gelesen; für alle anderen entscheidet, ob eine Zeile in
  // comment_read_status existiert.
  const readAuthorName =
    typeof req.query.author_name === 'string' ? req.query.author_name.trim() : '';
  if (readAuthorName && rows.length > 0) {
    const placeholders = rows.map(() => '?').join(',');
    const readRows = db
      .prepare(
        `SELECT comment_id FROM comment_read_status WHERE author_name = ? AND comment_id IN (${placeholders})`
      )
      .all(readAuthorName, ...rows.map((r) => r.id));
    const readIds = new Set(readRows.map((r) => r.comment_id));
    rows.forEach((r) => {
      r.read = r.author_name === readAuthorName || readIds.has(r.id);
    });
  }

  res.json(rows);
});

// Kommentar oder Antwort erstellen
app.post('/api/streams/:id/comments', writeLimiter, (req, res) => {
  const stream = getAuthorizedStream(req, res);
  if (!stream) return;

  const { parent_id, timecode_sec, item_id, author_name, author_color, body, image } = req.body || {};

  if (typeof author_name !== 'string' || !author_name.trim() || author_name.length > MAX_NAME_LEN) {
    return res.status(400).json({ error: `Name fehlt oder zu lang (max ${MAX_NAME_LEN} Zeichen)` });
  }
  // Bildkommentare dürfen ohne Text auskommen (reines Bild) – Pflicht ist nur,
  // dass mindestens eines von Text/Bild vorhanden ist.
  const hasImage = image !== undefined && image !== null && image !== '';
  if (typeof body !== 'string' || body.length > MAX_BODY_LEN || (!body.trim() && !hasImage)) {
    return res.status(400).json({ error: `Kommentartext fehlt oder zu lang (max ${MAX_BODY_LEN} Zeichen)` });
  }
  let imageValue = null;
  if (hasImage) {
    try {
      imageValue = validateImageDataUrl(image);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  // author_color ist optional – wer keine Farbe gewählt hat, bekommt weiterhin
  // die deterministische, aus dem Namen abgeleitete Farbe (clientseitig in
  // app.js, siehe authorColor()/resolveAuthorColor()). Nur Werte aus der
  // festen Palette werden akzeptiert (siehe AUTHOR_COLOR_PALETTE oben).
  let authorColorValue = null;
  if (author_color !== undefined && author_color !== null && author_color !== '') {
    if (typeof author_color !== 'string' || !AUTHOR_COLOR_SET.has(author_color)) {
      return res.status(400).json({ error: 'Ungültige Farbe' });
    }
    authorColorValue = author_color;
  }

  let parentIdValue = null;
  let timecodeValue = null;
  let itemIdValue = null;

  if (parent_id !== undefined && parent_id !== null) {
    parentIdValue = Number(parent_id);
    if (!Number.isInteger(parentIdValue)) {
      return res.status(400).json({ error: 'Ungültige parent_id' });
    }
    const parent = db
      .prepare('SELECT id FROM comments WHERE id = ? AND stream_id = ?')
      .get(parentIdValue, req.params.id);
    if (!parent) {
      return res.status(400).json({ error: 'Übergeordneter Kommentar nicht gefunden' });
    }
    // Antworten haben keinen eigenen Timecode/Item – sie hängen am
    // Top-Level-Kommentar, der beides bereits trägt.
  } else {
    // Jede Session ist playlist-basiert (siehe migrateLegacyArdStreamsToPlaylistItems) –
    // ein Top-Level-Kommentar hängt deshalb immer an einem Playlist-Item,
    // unabhängig von dessen Provider.
    itemIdValue = Number(item_id);
    if (!Number.isInteger(itemIdValue)) {
      return res.status(400).json({ error: 'item_id fehlt für Top-Level-Kommentar' });
    }
    const item = db
      .prepare('SELECT id, provider FROM playlist_items WHERE id = ? AND stream_id = ?')
      .get(itemIdValue, req.params.id);
    if (!item) {
      return res.status(400).json({ error: 'Playlist-Item nicht gefunden' });
    }
    if (item.provider === 'instagram') {
      // Instagrams embed.js liefert keine Positions-/Ende-Rückmeldung (siehe
      // instagramResolver.js) – Kommentare zu Instagram-Items sind deshalb
      // reine Item-Kommentare ohne Zeitbezug, timecode_sec bleibt NULL statt
      // einer Pflichtangabe.
      timecodeValue = null;
    } else {
      if (timecode_sec === undefined || timecode_sec === null || Number.isNaN(Number(timecode_sec))) {
        return res.status(400).json({ error: 'timecode_sec fehlt für Top-Level-Kommentar' });
      }
      timecodeValue = Math.max(0, Number(timecode_sec));
    }
  }

  const createdAt = Date.now();
  const info = db
    .prepare(
      'INSERT INTO comments (stream_id, parent_id, timecode_sec, item_id, author_name, author_color, body, image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      req.params.id,
      parentIdValue,
      timecodeValue,
      itemIdValue,
      author_name.trim(),
      authorColorValue,
      body.trim(),
      imageValue,
      createdAt
    );

  const created = db
    .prepare(
      'SELECT id, stream_id, parent_id, timecode_sec, item_id, author_name, author_color, body, image, created_at, updated_at FROM comments WHERE id = ?'
    )
    .get(info.lastInsertRowid);

  res.status(201).json(created);
});

// Kommentar bearbeiten (kein Login, keine Tokens: Bearbeitungsrecht wird
// allein am mitgeschickten Anzeigenamen festgemacht – wer denselben Namen
// wie der/die ursprüngliche Verfasser:in eines Kommentars angibt, gilt als
// berechtigt. Bewusste Design-Entscheidung: identifiziert wird ausschließlich
// über den frei gewählten Namen, nicht über ein geheimes Token im Browser
// (Kehrseite: kein Schutz vor Namensgleichheit/Trittbrettfahrern, siehe
// README).
app.patch('/api/comments/:cid', writeLimiter, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.cid);
  if (!comment) {
    return res.status(404).json({ error: 'Kommentar nicht gefunden' });
  }

  const authorName = typeof req.body?.author_name === 'string' ? req.body.author_name.trim() : '';
  if (!authorName || authorName !== comment.author_name) {
    return res.status(403).json({ error: 'Kein Bearbeitungsrecht für diesen Kommentar' });
  }

  const { body, image } = req.body || {};

  // image === undefined -> Bild unverändert lassen (Client hat es nicht
  // mitgeschickt, z. B. reine Textbearbeitung). image === null/'' -> Bild
  // explizit entfernen. Sonst -> neues/ersetztes Bild validieren.
  let imageProvided = image !== undefined;
  let imageValue = comment.image;
  if (imageProvided) {
    if (image === null || image === '') {
      imageValue = null;
    } else {
      try {
        imageValue = validateImageDataUrl(image);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
  }

  const hasImage = !!imageValue;
  if (typeof body !== 'string' || body.length > MAX_BODY_LEN || (!body.trim() && !hasImage)) {
    return res.status(400).json({ error: `Kommentartext fehlt oder zu lang (max ${MAX_BODY_LEN} Zeichen)` });
  }

  const updatedAt = Date.now();
  db.prepare('UPDATE comments SET body = ?, image = ?, updated_at = ? WHERE id = ?').run(
    body.trim(),
    imageValue,
    updatedAt,
    req.params.cid
  );

  const updated = db
    .prepare(
      'SELECT id, stream_id, parent_id, timecode_sec, item_id, author_name, author_color, body, image, created_at, updated_at FROM comments WHERE id = ?'
    )
    .get(req.params.cid);

  res.json(updated);
});

// Kommentar löschen (Admin ODER Person, deren mitgeschickter Anzeigename
// zum Kommentar passt – siehe Kommentar bei PATCH oben zur namensbasierten
// Identifikation statt Edit-Token)
app.delete('/api/comments/:cid', writeLimiter, (req, res) => {
  const comment = db
    .prepare('SELECT id, stream_id, author_name FROM comments WHERE id = ?')
    .get(req.params.cid);
  if (!comment) {
    return res.status(404).json({ error: 'Kommentar nicht gefunden' });
  }

  const authorName = typeof req.body?.author_name === 'string' ? req.body.author_name.trim() : '';
  const isOwner = !!authorName && authorName === comment.author_name;

  if (!isOwner) {
    if (!requireAdmin(req, res, comment.stream_id)) return;
  }

  // FK-Constraints sind hier nicht als ON-Konflikt-Cascade aktiv (kein PRAGMA
  // foreign_keys), daher Reaktionen des Kommentars explizit mit aufräumen.
  db.prepare('DELETE FROM comment_reactions WHERE comment_id = ?').run(comment.id);
  db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
  res.json({ ok: true });
});

// Reaction-Emoji auf einen Kommentar setzen/entfernen (Toggle). Wie bei
// PATCH/DELETE oben identifiziert allein der mitgeschickte Anzeigename die
// reagierende Person – kein Login, kein Token (siehe README). Jede Person
// kann pro Kommentar mehrere unterschiedliche Emojis setzen, aber pro Emoji
// nur einmal (UNIQUE-Constraint in comment_reactions).
app.post('/api/comments/:cid/reactions', writeLimiter, (req, res) => {
  const comment = db.prepare('SELECT id, stream_id FROM comments WHERE id = ?').get(req.params.cid);
  if (!comment) {
    return res.status(404).json({ error: 'Kommentar nicht gefunden' });
  }

  const authorName = typeof req.body?.author_name === 'string' ? req.body.author_name.trim() : '';
  if (!authorName || authorName.length > MAX_NAME_LEN) {
    return res.status(400).json({ error: `Name fehlt oder zu lang (max ${MAX_NAME_LEN} Zeichen)` });
  }

  const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji : '';
  if (!REACTION_EMOJI_SET.has(emoji)) {
    return res.status(400).json({ error: 'Ungültiges Reaction-Emoji' });
  }

  const existing = db
    .prepare('SELECT id FROM comment_reactions WHERE comment_id = ? AND emoji = ? AND author_name = ?')
    .get(comment.id, emoji, authorName);

  if (existing) {
    db.prepare('DELETE FROM comment_reactions WHERE id = ?').run(existing.id);
  } else {
    db.prepare(
      'INSERT INTO comment_reactions (comment_id, emoji, author_name, created_at) VALUES (?, ?, ?, ?)'
    ).run(comment.id, emoji, authorName, Date.now());
  }

  const reactions = db
    .prepare('SELECT emoji, author_name FROM comment_reactions WHERE comment_id = ?')
    .all(comment.id);

  res.json({ reactions });
});

// Gelesen-Status eines einzelnen Kommentars setzen/entfernen. Anders als bei
// den Reactions (Toggle) kennt die UI hier einen expliziten Zielzustand
// (Checkbox/Button "als gelesen markieren" bzw. wieder entfernen), deshalb
// kein Toggle, sondern read=true/false im Body.
app.post('/api/comments/:cid/read', writeLimiter, (req, res) => {
  const comment = db.prepare('SELECT id, stream_id FROM comments WHERE id = ?').get(req.params.cid);
  if (!comment) {
    return res.status(404).json({ error: 'Kommentar nicht gefunden' });
  }

  const authorName = typeof req.body?.author_name === 'string' ? req.body.author_name.trim() : '';
  if (!authorName || authorName.length > MAX_NAME_LEN) {
    return res.status(400).json({ error: `Name fehlt oder zu lang (max ${MAX_NAME_LEN} Zeichen)` });
  }

  const read = req.body?.read !== false;

  if (read) {
    db.prepare(
      'INSERT OR IGNORE INTO comment_read_status (comment_id, author_name, created_at) VALUES (?, ?, ?)'
    ).run(comment.id, authorName, Date.now());
  } else {
    db.prepare('DELETE FROM comment_read_status WHERE comment_id = ? AND author_name = ?').run(
      comment.id,
      authorName
    );
  }

  res.json({ ok: true, read });
});

// Gelesen-Status für mehrere Kommentare auf einmal setzen – wird
// ausschließlich für die einmalige Migration bestehender, bisher nur im
// localStorage des Browsers gespeicherter Gelesen-Markierungen auf den
// Server verwendet (siehe app.js, migrateLegacyLocalReadStatus).
app.post('/api/streams/:id/comments/read-bulk', writeLimiter, (req, res) => {
  const stream = db.prepare('SELECT id FROM streams WHERE id = ?').get(req.params.id);
  if (!stream) {
    return res.status(404).json({ error: 'Stream nicht gefunden' });
  }

  const authorName = typeof req.body?.author_name === 'string' ? req.body.author_name.trim() : '';
  if (!authorName || authorName.length > MAX_NAME_LEN) {
    return res.status(400).json({ error: `Name fehlt oder zu lang (max ${MAX_NAME_LEN} Zeichen)` });
  }

  const commentIds = Array.isArray(req.body?.comment_ids) ? req.body.comment_ids : [];
  const validIds = commentIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id));

  if (validIds.length === 0) {
    return res.json({ ok: true, count: 0 });
  }
  if (validIds.length > 1000) {
    return res.status(400).json({ error: 'Zu viele Kommentar-IDs (max 1000)' });
  }

  const placeholders = validIds.map(() => '?').join(',');
  // Nur IDs übernehmen, die auch tatsächlich zu dieser Session gehören.
  const ownIds = db
    .prepare(`SELECT id FROM comments WHERE stream_id = ? AND id IN (${placeholders})`)
    .all(req.params.id, ...validIds)
    .map((r) => r.id);

  const insert = db.prepare(
    'INSERT OR IGNORE INTO comment_read_status (comment_id, author_name, created_at) VALUES (?, ?, ?)'
  );
  const now = Date.now();
  const insertMany = db.transaction((ids) => {
    for (const id of ids) insert.run(id, authorName, now);
  });
  insertMany(ownIds);

  res.json({ ok: true, count: ownIds.length });
});

// Stream löschen (nur Admin)
app.delete('/api/streams/:id', writeLimiter, (req, res) => {
  const stream = db.prepare('SELECT id FROM streams WHERE id = ?').get(req.params.id);
  if (!stream) {
    return res.status(404).json({ error: 'Stream nicht gefunden' });
  }
  if (!requireAdmin(req, res, req.params.id)) return;

  db.prepare('DELETE FROM comments WHERE stream_id = ?').run(req.params.id);
  db.prepare('DELETE FROM playlist_items WHERE stream_id = ?').run(req.params.id);
  db.prepare('DELETE FROM streams WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// 404 für unbekannte API-Routen
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Nicht gefunden' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Duett läuft auf http://localhost:${PORT} (BASE_PATH="${BASE_PATH}")`);
});
