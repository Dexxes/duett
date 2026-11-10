// ---------- Instagram-Resolver ----------
//
// Löst Instagram-Reel-/Post-Links zu Metadaten auf, per öffentlichem
// oEmbed-Endpoint (https://graph.facebook.com/v.../instagram_oembed).
//
// Bis Juni 2026 brauchte dieser Endpoint zwingend eine registrierte
// Meta-App mit Access-Token (App-ID + Client-Token, siehe PLAN.md,
// ursprüngliche Fassung). Seit 15.06.2026 hat Meta das rückgängig gemacht:
// der Endpoint funktioniert jetzt ganz ohne Access-Token und ohne
// App-Review – verifiziert per Live-Abruf (curl gegen das offizielle
// Doku-Beispiel, sowohl über /p/... als auch /reel/... derselben ID, kein
// Token im Request). Genau wie bei tiktokResolver.js also kein API-Key
// nötig.
//
// Einschränkungen laut offizieller Doku (developers.facebook.com/docs/
// instagram-platform/oembed): nur öffentliche, nicht altersbeschränkte
// Accounts mit aktivierten Embeds; Stories werden nicht unterstützt;
// Rate-Limit 1000 Requests/Stunde (für den tokenlosen Zugriff laut Meta
// evtl. niedriger, aber nicht separat beziffert).
//
// Wichtigster Unterschied zu TikTok: Instagrams offizielles embed.js bietet
// keine dokumentierte JS-Steuerung von außen (kein Play/Pause/Seek, kein
// Ende-Event) – anders als TikToks Embed Player. Duett zeigt Instagram-Items
// deshalb als offizielles Blockquote+embed.js (siehe loadInstagramItem in
// app.js) ohne Timeline-Funktionen; Kommentare dazu haben keinen Zeitbezug.
//
// Zweiter Unterschied zu TikTok, per Live-Abruf verifiziert: Die tokenlose
// Antwort enthält NUR die Felder version/provider_name/provider_url/type/
// width/html – kein title, kein thumbnail_url, kein author_name (anders als
// TikToks oEmbed). Der `html`-Wert ist zudem nur ein generisches Lade-
// Skelett (graue Platzhalter-Boxen, kein Bild/Text) – Titel/Vorschaubild
// werden erst clientseitig von Instagrams embed.js nachgeladen, wenn das
// Blockquote im Browser gerendert wird. Explizites Anfordern weiterer Felder
// per `&fields=...` schlägt tokenlos mit "(#200) Provide valid app ID" fehl
// – diese Metadaten sind also grundsätzlich nur mit Access-Token verfügbar.
// Playlist-Items bekommen deshalb bewusst nur einen generischen Titel inkl.
// Shortcode statt eines echten Post-Titels/Vorschaubilds.

const GRAPH_API_VERSION = 'v25.0';

// Erkennt sowohl /reel/<shortcode>/ als auch /p/<shortcode>/ (Fotos,
// Karussells und als Feed-Post geteilte Videos), optional mit vorangestelltem
// Nutzernamen (instagram.com/<user>/reel/<shortcode>/ – so verlinken u. a.
// Business-Accounts).
const URL_RE = /instagram\.com\/(?:[^/?#]+\/)?(reel|p)\/([A-Za-z0-9_-]+)/i;

function looksLikeInstagramUrl(input) {
  return URL_RE.test((input || '').trim());
}

function parseInstagramUrl(input) {
  const m = (input || '').trim().match(URL_RE);
  if (!m) return null;
  return { type: m[1].toLowerCase(), shortcode: m[2] };
}

async function fetchOEmbed(canonicalUrl) {
  const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/instagram_oembed?url=${encodeURIComponent(
    canonicalUrl
  )}`;
  let res;
  try {
    res = await fetch(endpoint, { headers: { Accept: 'application/json' } });
  } catch {
    throw new Error('Instagram war nicht erreichbar');
  }

  if (!res.ok) {
    // Meta liefert bei bekannten Fehlern (privat/gelöscht/Embeds deaktiviert)
    // einen sprechenden error_user_msg mit – den bevorzugt an die Nutzenden
    // durchreichen statt eines generischen Statuscodes.
    let message = `Instagram antwortete mit ${res.status}`;
    try {
      const errBody = await res.json();
      if (errBody?.error?.error_user_msg) message = errBody.error.error_user_msg;
    } catch {
      // kein JSON-Body -> generische Meldung behalten
    }
    throw new Error(message);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Instagram-oEmbed-Antwort war kein gültiges JSON');
  }
  return data;
}

// Öffentliche Resolver-Funktion (Pendant zu resolveTikTok): nimmt einen
// Instagram-Reel-/Post-Link entgegen und liefert ein Array mit genau einem
// Playlist-Item – Instagram kennt wie TikTok kein "Playlist"-Konzept, jede
// URL ist genau ein Medium.
async function resolveInstagram(input) {
  const parsed = parseInstagramUrl(input);
  if (!parsed) {
    throw new Error('Das ist kein erkennbarer Instagram-Reel- oder Post-Link');
  }

  // Kanonische URL ohne Nutzername-Präfix/Query-Parameter fürs oEmbed und
  // später fürs Rendern des Embed-Blockquotes (siehe loadInstagramItem in
  // app.js) – so ist provider_uri unabhängig davon eindeutig, über welchen
  // Link (mit/ohne @nutzername, mit Tracking-Parametern) ein Item
  // hinzugefügt wurde.
  const canonicalUrl = `https://www.instagram.com/${parsed.type}/${parsed.shortcode}/`;
  const data = await fetchOEmbed(canonicalUrl);

  return [
    {
      provider: 'instagram',
      // Format "<type>:<shortcode>" (z. B. "reel:C1qJ9fzI3Zx"), damit
      // app.js beim Rendern die korrekte Permalink-Form (/reel/ vs. /p/)
      // rekonstruieren kann – wichtig, da Instagram embed.js beim Aufbau
      // des Embeds selbst noch einmal auf den Permalink zugreift.
      provider_uri: `${parsed.type}:${parsed.shortcode}`,
      // data.title existiert im tokenlosen Response nicht (siehe Kommentar
      // oben) – Fallback enthält deshalb den Shortcode, damit mehrere
      // Instagram-Items in derselben Playlist unterscheidbar bleiben statt
      // alle identisch "Instagram-Reel" zu heißen.
      title:
        data.title ||
        `${parsed.type === 'reel' ? 'Instagram-Reel' : 'Instagram-Post'} · ${parsed.shortcode}`,
      artist_or_channel: data.author_name ? `@${data.author_name}` : '',
      // Weder oEmbed noch embed.js liefern eine Videolänge, und es gibt kein
      // Ende-Event, über das sie sich nachträglich ermitteln ließe (siehe
      // Kommentar oben) – Dauer bleibt dauerhaft unbekannt.
      duration_ms: null,
      // Bleibt im tokenlosen Modus praktisch immer null (siehe Kommentar
      // oben) – Playlist-Leiste zeigt für Instagram-Items deshalb den
      // Platzhalter (siehe playlistItemIcon/renderPlaylist in app.js) statt
      // eines echten Vorschaubilds.
      thumbnail_url: data.thumbnail_url || null,
    },
  ];
}

module.exports = { resolveInstagram, looksLikeInstagramUrl };
