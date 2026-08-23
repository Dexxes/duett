// ---------- Spotify-Resolver ----------
//
// Löst Spotify-Links (Track/Album/Playlist) zu Metadaten auf, ganz ohne
// API-Key/Login: genutzt wird derselbe öffentliche, unauthentifizierte
// Embed-Endpoint (https://open.spotify.com/embed/...), den Spotify auch für
// eingebettete Player auf fremden Websites bereitstellt. Die Seite liefert
// serverseitig gerendertes HTML mit einem eingebetteten JSON-Datenblock
// (<script id="__NEXT_DATA__">), aus dem sich Titel, Interpret, Dauer, Cover
// und – bei Album/Playlist – die vollständige, geordnete Tracklist inkl.
// einzelner Track-URIs extrahieren lassen (verifiziert per Live-Abruf,
// Stand der Umsetzung).
//
// Risiko: Das ist eine öffentliche, aber undokumentierte HTML-Seite ohne
// API-Versionierungs-Garantie. Spotify kann das Markup jederzeit ohne
// Ankündigung ändern und diesen Parser brechen. Der Parser wirft in solchen
// Fällen einen sprechenden Fehler statt stillschweigend falsche Daten zu
// liefern.

const NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

const SUPPORTED_TYPES = new Set(['track', 'album', 'playlist']);

function parseSpotifyInput(input) {
  input = (input || '').trim();
  if (!input) return null;

  let m = input.match(/^spotify:(track|album|playlist):([a-zA-Z0-9]+)$/);
  if (m) return { type: m[1], id: m[2] };

  m = input.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([a-zA-Z0-9]+)/);
  if (m) return { type: m[1], id: m[2] };

  return null;
}

// Bevorzugt ein ca. 300px-Cover aus der visualIdentity.image-Liste (Track-,
// Album- oder Playlist-Entity); fällt sonst auf das größte verfügbare Bild
// zurück.
function pickCoverUrl(entity) {
  const images = entity?.visualIdentity?.image;
  if (!Array.isArray(images) || images.length === 0) return null;
  const preferred = images.find((img) => img.maxWidth === 300);
  if (preferred) return preferred.url;
  const largest = images.reduce((best, img) =>
    !best || (img.maxWidth || 0) > (best.maxWidth || 0) ? img : best, null);
  return largest?.url || images[0]?.url || null;
}

async function fetchEmbedEntity(type, id) {
  const url = `https://open.spotify.com/embed/${type}/${id}`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        // Ohne einen "echten" User-Agent liefert die Embed-Seite gelegentlich
        // eine reduzierte/andere Variante aus.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html',
      },
    });
  } catch {
    throw new Error('Spotify war nicht erreichbar');
  }
  if (res.status === 404) {
    throw new Error('Spotify-Inhalt nicht gefunden (falscher Link oder nicht öffentlich verfügbar)');
  }
  if (!res.ok) {
    throw new Error(`Spotify antwortete mit ${res.status}`);
  }

  const html = await res.text();
  const match = html.match(NEXT_DATA_RE);
  if (!match) {
    throw new Error(
      'Konnte Spotify-Daten nicht extrahieren (Seitenstruktur hat sich vermutlich geändert)'
    );
  }

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error('Spotify-Datenblock war kein gültiges JSON');
  }

  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (!entity) {
    throw new Error('Spotify-Antwort enthielt keine verwertbaren Daten (evtl. privater/gelöschter Inhalt)');
  }
  return entity;
}

// Öffentliche Resolver-Funktion: nimmt einen Spotify-Link oder eine URI
// entgegen und liefert ein Array von Playlist-Items (bei Track: genau eins,
// bei Album/Playlist: alle enthaltenen Tracks in Original-Reihenfolge).
async function resolveSpotify(input) {
  const parsed = parseSpotifyInput(input);
  if (!parsed) {
    throw new Error('Das ist kein erkennbarer Spotify-Track-, Album- oder Playlist-Link');
  }
  if (!SUPPORTED_TYPES.has(parsed.type)) {
    throw new Error(`Spotify-Inhaltstyp "${parsed.type}" wird nicht unterstützt`);
  }

  const entity = await fetchEmbedEntity(parsed.type, parsed.id);

  if (entity.type === 'track') {
    return [
      {
        provider: 'spotify',
        provider_uri: entity.uri,
        title: entity.name || entity.title || 'Unbekannter Track',
        artist_or_channel: Array.isArray(entity.artists)
          ? entity.artists.map((a) => a.name).filter(Boolean).join(', ')
          : '',
        duration_ms: typeof entity.duration === 'number' ? entity.duration : null,
        thumbnail_url: pickCoverUrl(entity),
      },
    ];
  }

  if (entity.type === 'album' || entity.type === 'playlist') {
    const cover = pickCoverUrl(entity);
    const trackList = Array.isArray(entity.trackList) ? entity.trackList : [];
    const items = trackList
      .filter((t) => t && t.entityType === 'track' && typeof t.uri === 'string')
      .map((t) => ({
        provider: 'spotify',
        provider_uri: t.uri,
        title: t.title || 'Unbekannter Track',
        artist_or_channel: t.subtitle || '',
        duration_ms: typeof t.duration === 'number' ? t.duration : null,
        thumbnail_url: cover,
      }));
    if (items.length === 0) {
      throw new Error('Diese Spotify-Playlist/Album enthält keine abspielbaren Tracks');
    }
    return items;
  }

  throw new Error(`Unerwarteter Spotify-Entity-Typ: ${entity.type}`);
}

module.exports = { resolveSpotify, parseSpotifyInput };
