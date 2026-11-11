// ---------- TikTok-Resolver ----------
//
// Löst TikTok-Video-Links zu Metadaten auf, per öffentlichem, dokumentiertem
// oEmbed-Endpoint (https://www.tiktok.com/oembed) – kein API-Key nötig
// (verifiziert per Live-Abruf). Anders als bei Spotify/YouTube gibt es kein
// "Playlist"-Konzept: jede TikTok-URL ist genau ein Video, daher liefert
// resolveTikTok() immer genau ein Item.
//
// Kurzlinks (vm.tiktok.com/…, vt.tiktok.com/…, pro.tiktok.com/t/…, aber auch
// www.tiktok.com/t/…), wie sie beim Teilen aus der TikTok-App bzw. TikTok
// Pro/Business-Konten entstehen, akzeptiert der oEmbed-Endpoint NICHT direkt
// (verifiziert: liefert `{"message":"Something went wrong","code":400}`) –
// sie werden hier zuerst per HTTP-Redirect (302, verifiziert per Live-Abruf)
// auf die kanonische www.tiktok.com/@user/video/<id>-URL aufgelöst. Erkannt
// wird ein Kurzlink entweder an einer der bekannten Kurzlink-Subdomains
// (vm./vt./pro.) oder generisch am "/t/<code>"-Pfad, den TikTok für
// Kurzlinks unabhängig von der Subdomain verwendet.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const SHORT_LINK_SUBDOMAINS = new Set(['vm.tiktok.com', 'vt.tiktok.com', 'pro.tiktok.com']);
const VIDEO_ID_RE = /\/video\/(\d+)/;
const MAX_REDIRECTS = 5;

// Parst die Eingabe als http(s)-URL und prüft, dass der Host wirklich
// tiktok.com (oder eine Subdomain davon) ist. Ein bloßer Teilstring-Test auf
// "tiktok.com/" würde z. B. auch "http://127.0.0.1/?x=tiktok.com/t/a"
// akzeptieren – der Server würde dann beim Kurzlink-Auflösen beliebige
// (auch interne) Adressen abrufen (SSRF).
function parseTikTokUrl(input) {
  let raw = (input || '').trim();
  // Ohne Schema eingefügte Links ("www.tiktok.com/…", "vm.tiktok.com/…")
  // wie bisher akzeptieren.
  if (raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) return null;
  return parsed;
}

function looksLikeTikTokUrl(input) {
  return !!parseTikTokUrl(input);
}

function isShortTikTokLink(input) {
  const parsed = parseTikTokUrl(input);
  if (!parsed) return false;
  return SHORT_LINK_SUBDOMAINS.has(parsed.hostname.toLowerCase()) || /^\/t\//i.test(parsed.pathname);
}

// Folgt Kurzlink-Redirects manuell (statt automatisch), um die Kette auf
// MAX_REDIRECTS zu begrenzen und früh abzubrechen, sobald eine Video-ID im
// Ziel-Link auftaucht.
async function resolveShortLink(startUrl) {
  let current = startUrl;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    let res;
    try {
      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': UA },
      });
    } catch {
      throw new Error('TikTok-Kurzlink war nicht erreichbar');
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      // Redirects nur innerhalb von tiktok.com folgen (siehe parseTikTokUrl).
      if (!parseTikTokUrl(current)) {
        throw new Error('TikTok-Kurzlink leitet auf eine fremde Adresse weiter');
      }
      if (VIDEO_ID_RE.test(current)) return current;
      continue;
    }
    break;
  }
  if (!VIDEO_ID_RE.test(current)) {
    throw new Error('TikTok-Kurzlink konnte nicht zu einem Video aufgelöst werden');
  }
  return current;
}

async function fetchOEmbed(canonicalUrl) {
  const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(canonicalUrl)}`;
  let res;
  try {
    res = await fetch(endpoint, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  } catch {
    throw new Error('TikTok war nicht erreichbar');
  }
  if (res.status === 404) {
    throw new Error('TikTok-Video nicht gefunden (falscher Link, gelöscht oder privat)');
  }
  if (!res.ok) {
    throw new Error(`TikTok antwortete mit ${res.status} (Link falsch oder Video nicht öffentlich verfügbar)`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('TikTok-oEmbed-Antwort war kein gültiges JSON');
  }
  return data;
}

// Öffentliche Resolver-Funktion (Pendant zu resolveSpotify): nimmt einen
// TikTok-Link entgegen und liefert ein Array mit genau einem Playlist-Item.
async function resolveTikTok(input) {
  input = (input || '').trim();
  if (!input || !looksLikeTikTokUrl(input)) {
    throw new Error('Das ist kein erkennbarer TikTok-Link');
  }

  const normalized = parseTikTokUrl(input).toString();
  const canonicalUrl = isShortTikTokLink(normalized) ? await resolveShortLink(normalized) : normalized;
  const data = await fetchOEmbed(canonicalUrl);

  // Video-ID bevorzugt aus der oEmbed-Antwort (embed_product_id, verifiziert
  // per Live-Abruf), Fallback: aus der (ggf. aufgelösten) URL bzw. dem
  // eingebetteten Blockquote-HTML.
  let videoId = data.embed_product_id || null;
  if (!videoId) {
    const m = canonicalUrl.match(VIDEO_ID_RE) || (data.html || '').match(/data-video-id="(\d+)"/);
    videoId = m ? m[1] : null;
  }
  if (!videoId) {
    throw new Error('Konnte keine TikTok-Video-ID ermitteln');
  }

  // Link zum Original (für das verlinkte Anbieter-Icon in der Playlist):
  // die aufgelöste Video-URL ohne Tracking-Parameter.
  let sourceUrl = null;
  try {
    const u = new URL(canonicalUrl);
    if (VIDEO_ID_RE.test(u.pathname)) {
      u.search = '';
      u.hash = '';
      sourceUrl = u.toString();
    }
  } catch {
    // ignore
  }

  return [
    {
      provider: 'tiktok',
      provider_uri: videoId,
      source_url: sourceUrl,
      title: data.title || 'TikTok-Video',
      artist_or_channel: data.author_name || (data.author_unique_id ? `@${data.author_unique_id}` : ''),
      // oEmbed liefert keine Videolänge – Dauer bleibt unbekannt, bis der
      // Embed Player sie über die onCurrentTime-Nachricht meldet.
      duration_ms: null,
      thumbnail_url: data.thumbnail_url || null,
    },
  ];
}

module.exports = { resolveTikTok, looksLikeTikTokUrl };
