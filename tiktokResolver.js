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

const SHORT_LINK_SUBDOMAIN_RE = /^https?:\/\/(vm|vt|pro)\.tiktok\.com\//i;
const SHORT_LINK_PATH_RE = /tiktok\.com\/t\//i;
const VIDEO_ID_RE = /\/video\/(\d+)/;
const MAX_REDIRECTS = 5;

function looksLikeTikTokUrl(input) {
  return /tiktok\.com\//i.test((input || '').trim());
}

function isShortTikTokLink(input) {
  return SHORT_LINK_SUBDOMAIN_RE.test(input) || SHORT_LINK_PATH_RE.test(input);
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

  const canonicalUrl = isShortTikTokLink(input) ? await resolveShortLink(input) : input;
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

  return [
    {
      provider: 'tiktok',
      provider_uri: videoId,
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
