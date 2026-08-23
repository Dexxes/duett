(function () {
  'use strict';

  const NAME_KEY = 'duett_author_name';
  const COLOR_KEY = 'duett_author_color';
  const SORT_ORDER_KEY = 'duett_comment_sort';
  const READ_FILTER_KEY = 'duett_read_filter';
  const STREAM_ACCESS_KEY = 'duett_stream_access';
  const READ_COMMENTS_KEY = 'duett_read_comments';
  const SPOTIFY_HINT_DISMISSED_KEY = 'duett_spotify_hint_dismissed';
  const OVERVIEW_ACCESS_KEY = 'duett_overview_access';

  // ---------- Helpers ----------

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Wandelt URLs in bereits escapetem HTML-Text in klickbare Links um.
  // Läuft NACH escapeHtml, sodass kein rohes HTML aus Nutzereingaben
  // eingeschleust werden kann – es werden nur <a>-Tags um URL-Treffer gelegt.
  function linkify(safeHtml) {
    const urlRegex = /((https?:\/\/|www\.)[^\s<]+)/gi;
    return safeHtml.replace(urlRegex, (match) => {
      let core = match;
      let trailing = '';
      const trailingChars = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '"', "'"]);
      while (core.length > 0 && trailingChars.has(core[core.length - 1])) {
        trailing = core[core.length - 1] + trailing;
        core = core.slice(0, -1);
      }
      if (!core) return match;
      let href = core;
      if (!/^https?:\/\//i.test(href)) href = 'https://' + href;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow ugc">${core}</a>${trailing}`;
    });
  }

  // Zeichenlimit für Sprechblasen im Vollbild: alles darüber hinaus wird
  // gekappt und mit "[...]" markiert, damit lange Kommentare den Player
  // nicht zupflastern.
  const BUBBLE_CHAR_LIMIT = 200;
  function truncateForBubble(text) {
    if (text.length <= BUBBLE_CHAR_LIMIT) return text;
    return text.slice(0, BUBBLE_CHAR_LIMIT) + ' [...]';
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // Für Listen: volles Datum + Uhrzeit.
  function formatDate(ts) {
    return new Date(ts).toLocaleString('de-DE');
  }

  // Für Kommentar-Zeitstempel: bewusst nur Stunde:Minute (kein Datum),
  // da Kommentare i. d. R. am selben Tag entstehen und die Liste sonst
  // unnötig unruhig wirkt.
  function formatCommentTime(ts) {
    return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  // Für den Hover-Tooltip auf .date: volles Datum als TT.MM.JJJJ, da der
  // sichtbare Zeitstempel selbst bewusst nur die Uhrzeit zeigt (s.o.).
  function formatDateOnly(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  // Erlaubt Eingaben wie "90", "1:30" oder "1:02:05" als Sekunden.
  function parseTimecode(str) {
    str = (str || '').trim();
    if (!str) return null;
    if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
    const parts = str.split(':');
    if (parts.length < 2 || parts.some((p) => !/^\d+$/.test(p))) return null;
    let seconds = 0;
    for (const p of parts) seconds = seconds * 60 + parseInt(p, 10);
    return seconds;
  }

  // Strg+Enter (bzw. Cmd+Enter auf dem Mac) sendet ein Formular ab, ohne
  // dass man erst ins Leere klicken/tabben muss. Normales Enter fügt in
  // <textarea>-Feldern weiterhin einen Zeilenumbruch ein.
  function submitOnCtrlEnter(textarea, form) {
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }

  // ---------- Kommentar-Bilder: Auswahl, Verkleinerung, Vorschau, Lightbox ----------
  //
  // Bilder werden bereits im Browser auf eine vernünftige Kantenlänge
  // verkleinert und (außer GIF, wegen Animation) zu JPEG neukomprimiert,
  // bevor sie als data:-URL im Kommentar-Payload landen (siehe server.js,
  // MAX_IMAGE_BYTES dort ist die harte serverseitige Obergrenze). Das hält
  // die SQLite-DB klein und vermeidet, dass ein 12-MP-Handyfoto 1:1 base64-
  // kodiert die 6-MB-JSON-Body-Grenze sprengt.

  const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
  const MAX_IMAGE_DIM = 1600;
  const IMAGE_JPEG_QUALITY = 0.82;
  const MAX_IMAGE_DATA_URL_LEN = Math.ceil((4 * 1024 * 1024 * 4) / 3) + 100; // ~ MAX_IMAGE_BYTES server-seitig
  const MAX_GIF_BYTES = 4 * 1024 * 1024;

  function readImageFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
        reject(new Error('Nur PNG, JPEG, GIF oder WebP erlaubt'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
      reader.onload = () => {
        // GIFs unverändert übernehmen – eine Canvas-Neukodierung würde eine
        // eventuelle Animation auf ein Standbild reduzieren.
        if (file.type === 'image/gif') {
          if (file.size > MAX_GIF_BYTES) {
            reject(new Error(`GIF ist zu groß (max. ${Math.floor(MAX_GIF_BYTES / (1024 * 1024))} MB)`));
            return;
          }
          resolve(reader.result);
          return;
        }
        const img = new Image();
        img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
        img.onload = () => {
          let width = img.naturalWidth;
          let height = img.naturalHeight;
          if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
            const scale = MAX_IMAGE_DIM / Math.max(width, height);
            width = Math.max(1, Math.round(width * scale));
            height = Math.max(1, Math.round(height * scale));
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          const preferPng = file.type === 'image/png';
          let dataUrl = canvas.toDataURL(preferPng ? 'image/png' : 'image/jpeg', IMAGE_JPEG_QUALITY);
          // PNG mit viel Detail (z. B. Screenshots) kann trotz Verkleinerung
          // noch groß bleiben – dann auf JPEG ausweichen (Transparenz geht
          // dabei verloren, ist bei Kommentarbildern aber ein akzeptabler
          // Kompromiss gegenüber einer Ablehnung).
          if (dataUrl.length > MAX_IMAGE_DATA_URL_LEN && preferPng) {
            dataUrl = canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);
          }
          if (dataUrl.length > MAX_IMAGE_DATA_URL_LEN) {
            reject(new Error('Bild ist auch nach Verkleinerung noch zu groß'));
            return;
          }
          resolve(dataUrl);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Klick-vergrößerte Ansicht eines Kommentarbilds. src stammt entweder von
  // einer soeben lokal gewählten Datei oder wurde vom Server mitgeliefert
  // (dort strikt gegen ein data:image/...;base64,-Muster validiert) – in
  // beiden Fällen wird der Wert per DOM-Property statt HTML-String gesetzt,
  // um jegliches Injection-Risiko von vornherein auszuschließen.
  function openImageLightbox(src) {
    const overlay = document.createElement('div');
    overlay.className = 'image-lightbox-overlay';
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    overlay.appendChild(img);
    // Explizites Schließen-Kreuz: auf Touch-Geräten gibt es keinen Hover-
    // Cursor (zoom-out), der "Tippen schließt" andeutet – gerade nach dem
    // Reinzoomen per Pinch (Browser-natives Pinch-Zoom funktioniert hier
    // bereits, da die Viewport-Meta kein user-scalable=no setzt) tippt man
    // sonst leicht daneben. Das Kreuz bleibt zusätzlich zum Klick auf den
    // Hintergrund als klarer, großzügig bemessener Ausstieg.
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'image-lightbox-close';
    closeBtn.setAttribute('aria-label', 'Schließen');
    closeBtn.textContent = '×';
    overlay.appendChild(closeBtn);
    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === img) return;
      close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  }

  // Wiederverwendbares Bild-Anhang-Widget für Kommentar-/Antwort-/Edit-
  // Formulare: Auswahl-Button, Vorschau, Entfernen-Button, Fehlermeldung.
  // getValue() liefert die aktuelle data:-URL oder null (kein Bild).
  function buildImageAttach(initialDataUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'image-attach';
    wrap.innerHTML = `
      <label class="link-btn image-attach-label">📷 Bild anhängen (oder mit Strg+V einfügen)
        <input type="file" class="image-attach-input hidden" accept="image/png,image/jpeg,image/gif,image/webp">
      </label>
      <button type="button" class="link-btn danger image-attach-remove hidden">Bild entfernen</button>
      <p class="image-attach-error error hidden"></p>
      <div class="image-attach-preview-wrap hidden">
        <img class="image-attach-preview" alt="Bildvorschau">
      </div>
    `;
    const fileInput = wrap.querySelector('.image-attach-input');
    const removeBtn = wrap.querySelector('.image-attach-remove');
    const errorEl = wrap.querySelector('.image-attach-error');
    const previewWrap = wrap.querySelector('.image-attach-preview-wrap');
    const previewImg = wrap.querySelector('.image-attach-preview');

    let value = initialDataUrl || null;

    function refresh() {
      if (value) {
        previewImg.src = value;
        previewWrap.classList.remove('hidden');
        removeBtn.classList.remove('hidden');
      } else {
        previewImg.removeAttribute('src');
        previewWrap.classList.add('hidden');
        removeBtn.classList.add('hidden');
      }
    }
    refresh();

    // Gemeinsamer Pfad für Datei-Auswahl UND Zwischenablage-Einfügen (siehe
    // wirePasteImage) – beide liefern ein File-Objekt.
    async function attachFile(file) {
      errorEl.classList.add('hidden');
      try {
        value = await readImageFileAsDataUrl(file);
        refresh();
      } catch (err) {
        errorEl.textContent = err.message || 'Bild konnte nicht geladen werden';
        errorEl.classList.remove('hidden');
      }
    }

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (file) attachFile(file);
    });

    removeBtn.addEventListener('click', () => {
      value = null;
      errorEl.classList.add('hidden');
      refresh();
    });

    return {
      element: wrap,
      getValue: () => value,
      reset: (newValue) => {
        value = newValue || null;
        errorEl.classList.add('hidden');
        refresh();
      },
      attachFile,
    };
  }

  // Erlaubt STRG+V (bzw. Cmd+V) eines Bilds aus der Zwischenablage direkt in
  // ein Text-/Kommentarfeld – landet im übergebenen Bild-Anhang-Widget statt
  // als (ohnehin nicht darstellbarer) Text. Enthält die Zwischenablage sowohl
  // ein Bild als auch Text (selten), gewinnt bewusst das Bild: wer ein Bild
  // einfügt, will es normalerweise auch anhängen, nicht nur den Alt-Text.
  function wirePasteImage(textarea, imageAttach) {
    if (!textarea) return;
    textarea.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            imageAttach.attachFile(file);
          }
          break;
        }
      }
    });
  }

  function getFullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      null
    );
  }

  // Deterministische Farbe pro Anzeigename, damit jede Person im Thread
  // visuell wiedererkennbar ist (gleicher Name -> gleiche Farbe). Dient als
  // Fallback für Kommentare ohne selbst gewählte Farbe (siehe
  // resolveAuthorColor) – z. B. ältere Kommentare oder Personen, die noch
  // keine Farbe ausgewählt haben.
  function authorColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    const hue = hash % 360;
    return `hsl(${hue}, 62%, 58%)`;
  }

  // Feste Farbpalette zur Selbst-Kennzeichnung (name-modal). Muss mit
  // AUTHOR_COLOR_PALETTE in server.js synchron gehalten werden – der Server
  // akzeptiert nur Werte aus dieser Liste. Bewusst ohne Blautöne: --accent
  // (die UI-eigene Akzentfarbe, siehe style.css) ist bereits blau.
  const AUTHOR_COLOR_PALETTE = [
    '#db5762', '#db8357', '#dbaf57', '#d0db57', '#99db57',
    '#57db99', '#57dbd0', '#8e57db', '#db57d0', '#db5799',
  ];

  // Farbe, die tatsächlich für einen Kommentar angezeigt wird: die vom
  // Autor/der Autorin selbst gewählte Farbe (falls vorhanden, vom Server
  // mitgeliefert), sonst der Namens-Hash-Fallback wie bisher.
  function resolveAuthorColor(comment) {
    return (comment && comment.author_color) || authorColor((comment && comment.author_name) || '');
  }

  // Wie resolveAuthorColor, aber für Notizzeilen (siehe createNotesController)
  // gedacht: die gibt es auch ganz ohne Autor (z. B. altes Freitext-Format
  // von vor der Zeilen-Autor-Erweiterung, oder leere Zeilen) – dafür liefert
  // diese Variante null statt einer Zufallsfarbe, damit die Zeile im
  // normalen Textfarbton statt in einer irreführenden Farbe erscheint.
  function resolveNoteLineColor(line) {
    if (!line) return null;
    if (line.author_color) return line.author_color;
    if (line.author_name) return authorColor(line.author_name);
    return null;
  }

  // Rendert die Farb-Auswahl im Name-Modal als Reihe klickbarer Swatches.
  // `selected` ist der aktuell gewählte Hex-Wert (oder '' für "keine
  // Auswahl" -> Namens-Hash-Fallback). onSelect wird mit dem neuen Wert
  // aufgerufen (per Klick nochmal auf die bereits gewählte Farbe -> Auswahl
  // aufheben, zurück zum Fallback).
  function renderColorSwatches(container, selected, onSelect) {
    if (!container) return;
    container.innerHTML = '';
    AUTHOR_COLOR_PALETTE.forEach((color) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch';
      btn.style.setProperty('--swatch-color', color);
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(color === selected));
      btn.setAttribute('aria-label', `Farbe ${color}`);
      btn.classList.toggle('selected', color === selected);
      btn.addEventListener('click', () => {
        onSelect(color === selected ? '' : color);
      });
      container.appendChild(btn);
    });
  }

  // ---------- Kommentar-"Besitz" (rein namensbasiert, kein Token) ----------
  //
  // Bewusste Design-Entscheidung: Bearbeiten/Löschen-Recht für einen
  // Kommentar hängt allein daran, ob der aktuell im Browser eingestellte
  // Anzeigename exakt zum author_name des Kommentars passt (siehe auch
  // server.js, PATCH/DELETE /api/comments/:cid) – kein Login, aber auch kein
  // geheimes, gerätegebundenes Token mehr. Vorteil: funktioniert
  // geräteübergreifend, sobald man denselben Namen verwendet. Kehrseite:
  // kein Schutz vor Namensgleichheit – wer denselben Namen wie jemand
  // anderes wählt, kann dessen Kommentare bearbeiten/löschen.
  function isOwnComment(comment, authorName) {
    return !!authorName && !!comment && comment.author_name === authorName;
  }

  // ---------- Gelesen-Status pro Kommentar (serverseitig, pro Anzeigename) ----------
  //
  // Der Status wird nicht mehr im localStorage des Browsers gehalten, sondern
  // vom Server pro (Kommentar, Anzeigename) verwaltet (siehe server.js,
  // comment_read_status). GET .../comments liefert bei mitgegebenem
  // author_name-Query-Param ein `read`-Feld pro Kommentar mit; dieses Feld
  // wird hier direkt am jeweiligen Kommentar-Objekt gelesen/optimistisch
  // aktualisiert, ein zusätzlicher lokaler Cache ist dafür nicht nötig, da
  // die Kommentar-Objekte im Speicher (comments-Array) wiederverwendet werden.

  // Eigene Kommentare (erkennbar an isOwnComment, siehe oben) gelten immer
  // als gelesen – wer selbst etwas geschrieben hat, muss es nicht erst
  // manuell als gesichtet markieren.
  function isCommentRead(comment, authorName) {
    return isOwnComment(comment, authorName) || !!comment.read;
  }

  async function setCommentRead(comment, read, authorName) {
    const previous = comment.read;
    comment.read = read; // optimistisches Update, damit die UI sofort reagiert
    try {
      await apiFetch(`api/comments/${comment.id}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author_name: authorName, read }),
      });
    } catch (err) {
      comment.read = previous; // Rollback bei Fehler
      throw err;
    }
  }

  function buildReadToggleButton(comment, el, authorName, onToggle) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'link-btn read-toggle';

    const isOwn = isOwnComment(comment, authorName);

    function refresh() {
      const read = isCommentRead(comment, authorName);
      btn.textContent = read ? '✓ gelesen' : 'als gelesen markieren';
      el.classList.toggle('is-read', read);
    }

    if (isOwn) {
      btn.disabled = true;
      btn.title = 'Eigene Kommentare gelten automatisch als gelesen';
    } else {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await setCommentRead(comment, !isCommentRead(comment, authorName), authorName);
        } catch (err) {
          console.error('Gelesen-Status konnte nicht gespeichert werden:', err);
        }
        btn.disabled = false;
        refresh();
        onToggle?.();
      });
    }

    refresh();
    return btn;
  }

  // ---------- Gelesen/Ungelesen-Filter (Kommentarliste) ----------

  function matchesReadFilter(comment, authorName, filter) {
    if (filter === 'unread') return !isCommentRead(comment, authorName);
    if (filter === 'read') return isCommentRead(comment, authorName);
    return true;
  }

  function loadReadFilter() {
    const value = localStorage.getItem(READ_FILTER_KEY);
    return value === 'unread' || value === 'read' ? value : 'all';
  }

  function buildReadFilterControl(container, initialValue, onChange) {
    if (!container) return;
    const buttons = container.querySelectorAll('.read-filter-option');
    function setActive(value) {
      buttons.forEach((btn) => btn.classList.toggle('active', btn.dataset.value === value));
    }
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.value;
        setActive(value);
        onChange(value);
      });
    });
    setActive(initialValue);
  }

  // ---------- Notizen-Feld (server-seitig, für alle mit Zugriff sichtbar) ----------

  function createNotesController(streamId, accessHeadersFn, getAuthorFn) {
    const textarea = document.getElementById('notes-textarea');
    const viewEl = document.getElementById('notes-view');
    if (!textarea) {
      return { applyServerValue() {}, refresh() {} };
    }

    let saveTimer = null;
    let lines = []; // [{ text, author_name, author_color }]
    let lastKnownText = '';

    function linesToText(ls) {
      return ls.map((l) => l.text).join('\n');
    }

    function renderView() {
      if (!viewEl) return;
      viewEl.innerHTML = '';
      const isEmpty = lines.length === 0 || (lines.length === 1 && lines[0].text === '');
      viewEl.classList.toggle('notes-view-empty', isEmpty);
      if (isEmpty) {
        viewEl.textContent = textarea.placeholder;
        return;
      }
      lines.forEach((line) => {
        const row = document.createElement('div');
        row.className = 'notes-line';
        const color = resolveNoteLineColor(line);
        if (color) row.style.setProperty('--note-color', color);
        row.textContent = line.text === '' ? ' ' : line.text;
        viewEl.appendChild(row);
      });
    }

    function showView() {
      if (!viewEl) return;
      renderView();
      viewEl.classList.remove('hidden');
      textarea.classList.add('hidden');
    }

    function showEditor() {
      if (!viewEl) return;
      viewEl.classList.add('hidden');
      textarea.classList.remove('hidden');
    }

    function applyServerValue(serverLines) {
      lines = Array.isArray(serverLines) ? serverLines : [];
      lastKnownText = linesToText(lines);
      if (document.activeElement !== textarea) {
        textarea.value = lastKnownText;
        showView();
      }
    }

    async function refresh() {
      try {
        const data = await apiFetch(`api/streams/${streamId}/notes`, { headers: accessHeadersFn() });
        applyServerValue(data.lines);
      } catch {
        // stiller Fehlschlag beim Polling, analog zu den Kommentaren
      }
    }

    function computeNewLines(newTexts) {
      const author = (getAuthorFn && getAuthorFn()) || {};
      return newTexts.map((text, i) => {
        const prev = lines[i];
        if (prev && prev.text === text) return prev;
        return { text, author_name: author.name || null, author_color: author.color || null };
      });
    }

    async function save() {
      const value = textarea.value;
      if (value === lastKnownText) return;
      const newLines = computeNewLines(value.split('\n'));
      try {
        const data = await apiFetch(`api/streams/${streamId}/notes`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...accessHeadersFn() },
          body: JSON.stringify({ lines: newLines }),
        });
        lines = data.lines || newLines;
        lastKnownText = linesToText(lines);
      } catch (err) {
        console.error('Notizen konnten nicht gespeichert werden:', err);
      }
    }

    textarea.addEventListener('focus', showEditor);
    textarea.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 800);
    });
    textarea.addEventListener('blur', () => {
      clearTimeout(saveTimer);
      save().then(showView);
    });
    viewEl?.addEventListener('click', () => {
      showEditor();
      textarea.focus();
    });

    showView();

    return { applyServerValue, refresh };
  }

  // ---------- Stream-Access-Tokens (Passwortschutz pro Session) ----------

  function getStreamAccessTokens() {
    try {
      return JSON.parse(localStorage.getItem(STREAM_ACCESS_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function getStreamAccessToken(streamId) {
    return getStreamAccessTokens()[streamId] || null;
  }

  function setStreamAccessToken(streamId, token) {
    const tokens = getStreamAccessTokens();
    tokens[streamId] = token;
    localStorage.setItem(STREAM_ACCESS_KEY, JSON.stringify(tokens));
  }

  // Alle relativen Pfade unten (ohne führenden "/") werden gegen den
  // <base href> der Seite aufgelöst. Das macht die App unabhängig davon,
  // ob sie unter "/" oder z. B. hinter einem Reverse-Proxy unter "/duett/"
  // läuft, solange der Proxy das Präfix vor der Weiterleitung entfernt.

  async function apiFetch(url, options) {
    const res = await fetch(url, options);
    let data = null;
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Fehler (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // =========================================================
  // Provider-Erkennung + Resolver-Helper (gemeinsam genutzt von Startseite
  // und Session-Seite). ARD-Mediathek/m3u8 ist seit der Vereinigung von
  // ARD-Mediathek und Content-Mix ein Provider unter mehreren, kein
  // struktureller Sonderfall mehr (siehe PLAN.md).
  // =========================================================

  function isSpotifyInput(input) {
    return /open\.spotify\.com\/|^spotify:/i.test((input || '').trim());
  }

  // Erkennt iOS (inkl. iPadOS, das sich seit iPadOS 13 als "MacIntel" mit
  // Touch-Support ausgibt). Relevant fürs Premium-Banner: Safari/WebKit
  // partitioniert Third-Party-Cookies, daher sieht das eingebettete
  // Spotify-iframe einen Login aus einem anderen Tab nie – auf iOS macht der
  // "Bei Spotify einloggen"-Button also keinen Sinn.
  function isIOS() {
    return (
      /iP(hone|od|ad)/.test(navigator.userAgent || '') ||
      (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1)
    );
  }

  // Extrahiert die Track-ID aus provider_uri ("spotify:track:ID") und liefert
  // einen open.spotify.com-Link, der auf iOS/iPadOS per Universal Link direkt
  // in der Spotify-App öffnet (falls installiert), sonst im Browser.
  function spotifyOpenUrl(item) {
    const m = /^spotify:track:([a-zA-Z0-9]+)$/.exec(item?.provider_uri || '');
    return m ? `https://open.spotify.com/track/${m[1]}` : 'https://open.spotify.com/';
  }

  function isYouTubeInput(input) {
    return /(youtube\.com|youtu\.be)/i.test((input || '').trim());
  }

  // TikTok wird (wie Spotify) serverseitig aufgelöst (siehe
  // tiktokResolver.js) – hier nur die Erkennung, ob der Server überhaupt
  // gefragt werden soll.
  function isTikTokInput(input) {
    return /tiktok\.com\//i.test((input || '').trim());
  }

  // Instagram wird (wie TikTok) serverseitig aufgelöst (siehe
  // instagramResolver.js) – hier nur die Erkennung. Deckt sowohl /reel/ als
  // auch /p/ ab (siehe instagramResolver.js für den Grund).
  function isInstagramInput(input) {
    return /instagram\.com\/(?:[^/?#]+\/)?(?:reel|p)\//i.test((input || '').trim());
  }

  // ARD-Mediathek-Seiten-Links werden serverseitig zu einem m3u8-Link
  // aufgelöst (siehe resolveArdMediathek in server.js); ein roher m3u8-/
  // Video-Link ohne erkannten Anbieter wird dort ebenfalls als 'ard'-Item
  // behandelt (Fallback, kein eigener Client-Check nötig).
  function isArdMediathekInput(input) {
    return /ardmediathek\.de\//i.test((input || '').trim());
  }

  // ZDF-Mediathek-/Play-Seiten-Links werden serverseitig zu einem m3u8-Link
  // aufgelöst (siehe resolveZdfMediathek in server.js) und landen dabei –
  // genau wie ARD-Mediathek-Links – als 'ard'-Item (generischer Video-/
  // m3u8-Provider, siehe playlistItemIcon).
  function isZdfInput(input) {
    return /(^|\/\/)(www\.)?zdf\.de\/(video|play)\//i.test((input || '').trim());
  }

  // Extrahiert "<type>:<shortcode>" aus einem Instagram-Link, im selben
  // Format wie provider_uri in instagramResolver.js – zum Abgleich, ob ein
  // in einem Kommentar geposteter Link schon in der Playlist steckt (siehe
  // findPlaylistItemForLink), ohne einen eigenen Server-Roundtrip zu
  // brauchen.
  function extractInstagramProviderUri(url) {
    const m = (url || '').match(/instagram\.com\/(?:[^/?#]+\/)?(reel|p)\/([A-Za-z0-9_-]+)/i);
    return m ? `${m[1].toLowerCase()}:${m[2]}` : null;
  }

  // Zentrale Icon-Zuordnung für Playlist-Items (Playlist-Leiste + In-App-
  // Kommentar-Links, siehe linkifyWithPlaylistRefs) statt derselben Ternary-
  // Kette an mehreren Stellen.
  function playlistItemIcon(provider) {
    if (provider === 'ard') return '📺';
    if (provider === 'spotify') return '🎵';
    if (provider === 'tiktok') return '🎬';
    if (provider === 'instagram') return '📸';
    return '▶️';
  }

  // Erkennt sowohl eine Video-ID (v=, youtu.be/, /shorts/, /embed/) als auch
  // eine list=-Playlist-ID im selben Link und liefert beide, falls vorhanden
  // (typisch z. B. bei .../watch?v=X&list=RD… für die Autoplay-"Mix"-
  // Playlist neben dem Video, oder list=WL für "Später ansehen"). Ist eine
  // Video-ID vorhanden, gilt der Link primär als 'video' – die optionale
  // playlistId hängt zusätzlich dran, damit resolveYouTubeToItems bei Bedarf
  // nachfragen kann, ob statt nur des Videos gleich die ganze Playlist
  // importiert werden soll (siehe dort). Nur ein Link OHNE erkennbare
  // Video-ID (z. B. .../playlist?list=PL…) gilt als reiner Playlist-Link.
  function parseYouTubeInput(input) {
    input = (input || '').trim();
    if (!input) return null;
    let videoId = null;
    let m = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (m) videoId = m[1];
    if (!videoId) {
      m = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
      if (m) videoId = m[1];
    }
    if (!videoId) {
      m = input.match(/youtube\.com\/(?:shorts|embed)\/([a-zA-Z0-9_-]{11})/);
      if (m) videoId = m[1];
    }
    const listMatch = input.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    const playlistId = listMatch ? listMatch[1] : null;

    if (videoId) return { kind: 'video', id: videoId, playlistId };
    if (playlistId) return { kind: 'playlist', id: playlistId };
    return null;
  }

  // oEmbed ist ein öffentlicher, dokumentierter YouTube-Endpoint ohne
  // API-Key – liefert Titel/Kanal/Thumbnail, aber keine Dauer.
  async function fetchYouTubeOEmbed(videoId) {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      'https://www.youtube.com/watch?v=' + videoId
    )}&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('YouTube-Metadaten konnten nicht geladen werden für ' + videoId);
    const data = await res.json();
    return {
      provider: 'youtube',
      provider_uri: videoId,
      title: data.title || videoId,
      artist_or_channel: data.author_name || '',
      duration_ms: null,
      thumbnail_url: data.thumbnail_url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    };
  }

  // Lädt die YouTube-IFrame-Player-API dynamisch nach (einmalig, gecacht).
  let ytApiReadyPromise = null;
  function loadYouTubeIframeApi() {
    if (ytApiReadyPromise) return ytApiReadyPromise;
    ytApiReadyPromise = new Promise((resolve) => {
      if (window.YT && window.YT.Player) {
        resolve(window.YT);
        return;
      }
      const prevCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prevCallback?.();
        resolve(window.YT);
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(script);
    });
    return ytApiReadyPromise;
  }

  // Löst eine YouTube-Playlist-ID zur vollständigen, geordneten Liste von
  // Video-IDs auf. getPlaylist() ist echter Teil der IFrame-Player-API (kein
  // Scraping), braucht aber einen echten Browser-Player-Kontext – deshalb
  // hier clientseitig statt in einem serverResolver (siehe PLAN.md).
  function resolvePlaylistVideoIds(playlistId) {
    return loadYouTubeIframeApi().then(
      (YT) =>
        new Promise((resolve, reject) => {
          const hiddenHost = document.createElement('div');
          hiddenHost.style.cssText =
            'position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
          document.body.appendChild(hiddenHost);
          let settled = false;
          let player;

          function cleanup() {
            clearTimeout(timeoutId);
            try {
              player?.destroy();
            } catch {
              // ignore
            }
            hiddenHost.remove();
          }

          const timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('YouTube-Playlist konnte nicht geladen werden (Zeitüberschreitung)'));
          }, 15000);

          player = new YT.Player(hiddenHost, {
            height: '1',
            width: '1',
            playerVars: { listType: 'playlist', list: playlistId, autoplay: 0, controls: 0 },
            events: {
              onReady: () => {
                if (settled) return;
                try {
                  const ids = player.getPlaylist();
                  settled = true;
                  cleanup();
                  if (Array.isArray(ids) && ids.length > 0) resolve(ids);
                  else reject(new Error('Playlist enthält keine Videos oder ist nicht öffentlich einsehbar'));
                } catch {
                  settled = true;
                  cleanup();
                  reject(new Error('Playlist konnte nicht gelesen werden'));
                }
              },
              onError: () => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error('YouTube meldete einen Fehler beim Laden der Playlist'));
              },
            },
          });
        })
    );
  }

  // Öffentliche Resolver-Funktion (Pendant zu spotifyResolver.js, aber
  // clientseitig): löst einen YouTube-Video- oder Playlist-Link zu einem
  // Array fertiger Playlist-Items auf. Bevor tatsächlich eine ganze Playlist
  // aufgelöst wird (viele Items auf einmal, dauert entsprechend und ist ein
  // größerer Eingriff in die Session), wird per confirm() nachgefragt – bei
  // "Nein"/Abbruch wird, falls der Link zusätzlich eine Video-ID enthält
  // (z. B. .../watch?v=X&list=RD…), stattdessen nur dieses eine Video
  // aufgelöst. Ein reiner Playlist-Link ohne Video-ID (z. B.
  // .../playlist?list=PL…) hat bei "Nein" keine Einzelvideo-Alternative –
  // der Vorgang wird dann abgebrochen.
  async function resolveYouTubeToItems(input) {
    const parsed = parseYouTubeInput(input);
    if (!parsed) throw new Error('Das ist kein erkennbarer YouTube-Video- oder Playlist-Link');

    let videoIds;
    if (parsed.kind === 'playlist') {
      const wantsPlaylist = confirm(
        'Dieser Link ist eine YouTube-Playlist. Alle Videos der Playlist zur Session hinzufügen?'
      );
      if (!wantsPlaylist) {
        throw new Error('Playlist-Import abgebrochen.');
      }
      videoIds = await resolvePlaylistVideoIds(parsed.id);
    } else if (parsed.playlistId) {
      const wantsPlaylist = confirm(
        'Dieser Link gehört zu einer YouTube-Playlist. Statt nur diesem Video gleich die ganze Playlist zur Session hinzufügen?'
      );
      videoIds = wantsPlaylist ? await resolvePlaylistVideoIds(parsed.playlistId) : [parsed.id];
    } else {
      videoIds = [parsed.id];
    }

    const items = [];
    for (const id of videoIds) {
      try {
        items.push(await fetchYouTubeOEmbed(id));
      } catch (err) {
        console.warn('YouTube-oEmbed fehlgeschlagen, Video übersprungen:', id, err);
      }
    }
    if (items.length === 0) {
      throw new Error('Keine der YouTube-Quellen konnte aufgelöst werden');
    }
    return items;
  }

  // Lädt die Spotify-IFrame-Player-API dynamisch nach (einmalig, gecacht).
  let spotifyApiReadyPromise = null;
  function loadSpotifyIframeApi() {
    if (spotifyApiReadyPromise) return spotifyApiReadyPromise;
    spotifyApiReadyPromise = new Promise((resolve) => {
      if (window.spotifyIframeApi) {
        resolve(window.spotifyIframeApi);
        return;
      }
      window.onSpotifyIframeApiReady = (IFrameAPI) => {
        window.spotifyIframeApi = IFrameAPI;
        resolve(IFrameAPI);
      };
      const script = document.createElement('script');
      script.src = 'https://open.spotify.com/embed/iframe-api/v1';
      script.async = true;
      document.head.appendChild(script);
    });
    return spotifyApiReadyPromise;
  }

  // =========================================================
  // Medien-Links in Kommentaren erkennen
  //
  // Enthält ein Kommentar einen Spotify-/YouTube-/TikTok-/Instagram-/ARD-
  // Mediathek-Link, wird das entsprechende Item beim Absenden automatisch
  // der Playlist hinzugefügt (siehe ensureLinkAddedToPlaylist); beim
  // Rendern wird der Link – sofern er sich einem bekannten Playlist-Item
  // zuordnen lässt – durch eine In-App-Verlinkung zu diesem Item ersetzt
  // (siehe linkifyWithPlaylistRefs). Bewusst NICHT jeder beliebige Link wird
  // so behandelt (nur die erkannten Anbieter oben) – sonst würde jeder
  // zufällige Link in einem Kommentar ungefragt als Video-Item importiert.
  // =========================================================

  function extractSpotifyRef(url) {
    let m = url.match(/^spotify:(track|album|playlist):([a-zA-Z0-9]+)$/);
    if (m) return { type: m[1], id: m[2] };
    m = url.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([a-zA-Z0-9]+)/);
    if (m) return { type: m[1], id: m[2] };
    return null;
  }

  function extractTikTokVideoId(url) {
    const m = url.match(/\/video\/(\d+)/);
    return m ? m[1] : null;
  }

  const MEDIA_URL_SCAN_RE = /((https?:\/\/|www\.)[^\s<]+|spotify:(?:track|album|playlist):[a-zA-Z0-9]+)/gi;

  function findMediaLinksInText(text) {
    const matches = (text || '').match(MEDIA_URL_SCAN_RE) || [];
    const trailingChars = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '"', "'"]);
    const seen = new Set();
    const links = [];
    for (const raw of matches) {
      let url = raw;
      while (url.length > 0 && trailingChars.has(url[url.length - 1])) {
        url = url.slice(0, -1);
      }
      if (!url) continue;
      let href = url;
      if (!/^https?:\/\//i.test(href) && !/^spotify:/i.test(href)) href = 'https://' + href;
      let link = null;
      if (isSpotifyInput(href)) link = { url: href, provider: 'spotify' };
      else if (isTikTokInput(href)) link = { url: href, provider: 'tiktok' };
      else if (isInstagramInput(href)) link = { url: href, provider: 'instagram' };
      else if (isArdMediathekInput(href)) link = { url: href, provider: 'ard' };
      else if (isZdfInput(href)) link = { url: href, provider: 'ard' };
      else if (isYouTubeInput(href)) link = { url: href, provider: 'youtube' };
      if (!link) continue;
      const key = `${link.provider}:${href.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(link);
    }
    return links;
  }

  // Sucht in einer bereits geladenen Playlist nach dem Item, das zu einem
  // erkannten Medien-Link gehört. Für ARD-Links nicht möglich (provider_uri
  // ist der aufgelöste m3u8-Link, nicht der ursprüngliche Seiten-Link) –
  // liefert dafür bewusst immer null, der Link bleibt dann ein normaler
  // externer Link statt eines Playlist-Sprungs.
  function findPlaylistItemForLink(link, playlistArr) {
    if (!link || !Array.isArray(playlistArr)) return null;
    if (link.provider === 'youtube') {
      const parsed = parseYouTubeInput(link.url);
      if (!parsed || parsed.kind !== 'video') return null;
      return playlistArr.find((it) => it.provider === 'youtube' && it.provider_uri === parsed.id) || null;
    }
    if (link.provider === 'spotify') {
      const ref = extractSpotifyRef(link.url);
      if (!ref || ref.type !== 'track') return null;
      const candidate = `spotify:track:${ref.id}`;
      return playlistArr.find((it) => it.provider === 'spotify' && it.provider_uri === candidate) || null;
    }
    if (link.provider === 'tiktok') {
      const videoId = extractTikTokVideoId(link.url);
      if (!videoId) return null;
      return playlistArr.find((it) => it.provider === 'tiktok' && it.provider_uri === videoId) || null;
    }
    if (link.provider === 'instagram') {
      const providerUri = extractInstagramProviderUri(link.url);
      if (!providerUri) return null;
      return playlistArr.find((it) => it.provider === 'instagram' && it.provider_uri === providerUri) || null;
    }
    return null;
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ---------- @-Mentions: Playlist-Titel im Kommentartext verlinken ----------
  //
  // "@Titel" wird – analog zu Erwähnungen bei Twitter/Instagram, aber ohne
  // eigenes Nutzerkonzept, sondern gegen die Titel der aktuellen Playlist –
  // zu einem In-App-Sprung zum jeweiligen Item. Eingefügt wird der Mention-
  // Text bereits beim Tippen über wireMentionAutocomplete() weiter unten;
  // hier geht es nur um die Erkennung beim Rendern. Läuft VOR dem
  // URL-Linkify in linkifyWithPlaylistRefs.
  //
  // Abgleich erfolgt auf dem bereits escapeHtml()-escapten Kommentartext,
  // daher werden auch die Playlist-Titel vor dem Vergleich escaped. Bei
  // mehreren Items mit (Teil-)identischem Titel gewinnt der längere Titel
  // (Sortierung nach Länge absteigend), damit kein Präfix eines längeren
  // Titels fälschlich zuerst matcht. "@" muss am Zeilenanfang oder nach
  // Leerzeichen/"(" stehen (kein Treffer z. B. bei "name@Titel"), danach muss
  // der Titel vollständig folgen und mit Zeilenende/Leerzeichen/Satzzeichen
  // abschließen.
  function linkifyMentions(safeHtml, playlistArr) {
    if (!Array.isArray(playlistArr) || playlistArr.length === 0) return safeHtml;
    const items = playlistArr
      .filter((it) => it && it.title)
      .slice()
      .sort((a, b) => b.title.length - a.title.length);
    if (items.length === 0) return safeHtml;

    const titleToItem = new Map();
    const alternatives = [];
    items.forEach((it) => {
      const escapedTitle = escapeHtml(it.title);
      if (titleToItem.has(escapedTitle)) return; // identischer Titel: erstes (längstes) Item gewinnt
      titleToItem.set(escapedTitle, it);
      alternatives.push(escapeRegExp(escapedTitle));
    });

    const mentionRegex = new RegExp(`(^|[\\s(])@(${alternatives.join('|')})(?=$|[\\s).,;:!?])`, 'g');
    return safeHtml.replace(mentionRegex, (match, prefix, titleMatch) => {
      const item = titleToItem.get(titleMatch);
      if (!item) return match;
      const icon = playlistItemIcon(item.provider);
      return `${prefix}<a href="#" class="playlist-item-link" data-item-id="${item.id}">${icon} ${titleMatch}</a>`;
    });
  }

  // Wie linkify(), aber Spotify-/YouTube-/TikTok-/Instagram-Links, die sich
  // einem bereits bekannten Playlist-Item zuordnen lassen, werden statt als
  // externer Link als In-App-Sprung zum Playlist-Item gerendert. Andere URLs
  // (inkl. ARD-Mediathek-Links, siehe findPlaylistItemForLink) verhalten
  // sich wie bei linkify() gewohnt. @-Mentions (siehe linkifyMentions) werden
  // zuerst aufgelöst.
  function linkifyWithPlaylistRefs(safeHtml, playlistArr) {
    const withMentions = linkifyMentions(safeHtml, playlistArr);
    const urlRegex = /((https?:\/\/|www\.)[^\s<]+)/gi;
    return withMentions.replace(urlRegex, (match) => {
      let core = match;
      let trailing = '';
      const trailingChars = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '"', "'"]);
      while (core.length > 0 && trailingChars.has(core[core.length - 1])) {
        trailing = core[core.length - 1] + trailing;
        core = core.slice(0, -1);
      }
      if (!core) return match;
      let href = core;
      if (!/^https?:\/\//i.test(href)) href = 'https://' + href;

      let link = null;
      if (isSpotifyInput(href)) link = { url: href, provider: 'spotify' };
      else if (isTikTokInput(href)) link = { url: href, provider: 'tiktok' };
      else if (isInstagramInput(href)) link = { url: href, provider: 'instagram' };
      else if (isYouTubeInput(href)) link = { url: href, provider: 'youtube' };

      const item = link ? findPlaylistItemForLink(link, playlistArr) : null;
      if (item) {
        const icon = playlistItemIcon(item.provider);
        const label = escapeHtml(`${icon} ${item.title}`);
        return `<a href="#" class="playlist-item-link" data-item-id="${item.id}">${label}</a>${trailing}`;
      }
      return `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow ugc">${core}</a>${trailing}`;
    });
  }

  // ---------- @-Mentions: Autocomplete-Dropdown beim Tippen ----------
  //
  // Ein einziges, wiederverwendetes Dropdown-Element reicht aus, da immer
  // höchstens eine Kommentar-Textarea gleichzeitig fokussiert sein kann
  // (Haupt-, Vollbild-, Antwort- und Bearbeiten-Formular teilen sich dieses
  // eine Element, siehe wireMentionAutocomplete-Aufrufe weiter unten).
  let mentionDropdownEl = null;
  let mentionDropdownState = null; // { textarea, atIndex, items, activeIndex }
  let mentionScrollListenerAdded = false;

  function ensureMentionDropdown() {
    if (mentionDropdownEl) return mentionDropdownEl;
    mentionDropdownEl = document.createElement('div');
    mentionDropdownEl.className = 'mention-autocomplete hidden';
    mentionDropdownEl.setAttribute('role', 'listbox');
    document.body.appendChild(mentionDropdownEl);
    return mentionDropdownEl;
  }

  function closeMentionDropdown() {
    if (mentionDropdownEl) mentionDropdownEl.classList.add('hidden');
    mentionDropdownState = null;
  }

  // Bei Scroll/Resize wird das Dropdown einfach geschlossen statt neu
  // positioniert – es ist ohnehin nur während des Tippens sichtbar, ein
  // erneutes "@" öffnet es an der dann aktuellen Position wieder.
  function ensureMentionScrollListener() {
    if (mentionScrollListenerAdded) return;
    mentionScrollListenerAdded = true;
    window.addEventListener('scroll', () => closeMentionDropdown(), true);
    window.addEventListener('resize', () => closeMentionDropdown());
  }

  function updateMentionActiveOption() {
    if (!mentionDropdownEl || !mentionDropdownState) return;
    const options = mentionDropdownEl.querySelectorAll('.mention-autocomplete-option');
    options.forEach((opt, idx) => {
      opt.classList.toggle('active', idx === mentionDropdownState.activeIndex);
    });
  }

  function selectMentionItem(item) {
    const state = mentionDropdownState;
    if (!state || !item) return;
    const { textarea, atIndex } = state;
    const caret = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, atIndex);
    const after = textarea.value.slice(caret);
    const insertion = `@${item.title} `;
    textarea.value = before + insertion + after;
    const newPos = before.length + insertion.length;
    textarea.setSelectionRange(newPos, newPos);
    closeMentionDropdown();
    textarea.focus();
  }

  function renderMentionDropdown(textarea, atIndex, items) {
    const el = ensureMentionDropdown();
    el.innerHTML = '';
    items.forEach((item) => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'mention-autocomplete-option';
      opt.setAttribute('role', 'option');
      opt.textContent = `${playlistItemIcon(item.provider)} ${item.title}`;
      opt.addEventListener('mousedown', (e) => {
        // mousedown statt click: verhindert, dass der blur-Handler der
        // Textarea (siehe wireMentionAutocomplete) das Dropdown schon vor
        // der Auswahl schließt.
        e.preventDefault();
        selectMentionItem(item);
      });
      el.appendChild(opt);
    });
    const rect = textarea.getBoundingClientRect();
    el.style.left = `${Math.round(rect.left)}px`;
    el.style.top = `${Math.round(rect.bottom + 4)}px`;
    el.style.width = `${Math.round(Math.min(Math.max(rect.width, 220), 360))}px`;
    el.classList.remove('hidden');
    mentionDropdownState = { textarea, atIndex, items, activeIndex: 0 };
    updateMentionActiveOption();
  }

  // Sucht rückwärts vom Cursor aus das zuletzt getippte "@" – gültig nur am
  // Zeilenanfang oder nach Leerzeichen/"(" davor (siehe linkifyMentions) und
  // nur, solange danach noch kein Leerzeichen folgt (das beendet die
  // Eingabe des Suchbegriffs).
  function findMentionQuery(textarea) {
    const caret = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, caret);
    const atIndex = before.lastIndexOf('@');
    if (atIndex === -1) return null;
    const precedingChar = atIndex > 0 ? before[atIndex - 1] : '';
    if (precedingChar && !/[\s(]/.test(precedingChar)) return null;
    const query = before.slice(atIndex + 1);
    if (/\s/.test(query)) return null;
    return { atIndex, query };
  }

  // Hängt die @-Mention-Autocomplete an eine Kommentar-Textarea an.
  // getPlaylistArr wird bei jedem Tastendruck neu aufgerufen (statt einmalig
  // die Playlist zu übergeben), damit auch nachträglich hinzugefügte Items
  // sofort vorschlagbar sind.
  function wireMentionAutocomplete(textarea, getPlaylistArr) {
    if (!textarea) return;
    ensureMentionScrollListener();

    function handleInput() {
      const match = findMentionQuery(textarea);
      if (!match) {
        closeMentionDropdown();
        return;
      }
      const playlistArr = getPlaylistArr() || [];
      const q = match.query.toLowerCase();
      const items = playlistArr
        .filter((it) => it && it.title && it.title.toLowerCase().includes(q))
        .slice(0, 8);
      if (items.length === 0) {
        closeMentionDropdown();
        return;
      }
      renderMentionDropdown(textarea, match.atIndex, items);
    }

    textarea.addEventListener('input', handleInput);
    textarea.addEventListener('click', handleInput);
    textarea.addEventListener('blur', () => {
      // Kurzer Timeout, damit ein mousedown auf eine Dropdown-Option noch vor
      // dem Schließen verarbeitet wird (siehe renderMentionDropdown).
      setTimeout(() => {
        if (mentionDropdownState?.textarea === textarea) closeMentionDropdown();
      }, 150);
    });

    // Capture-Phase, damit dies vor anderen keydown-Handlern läuft (z. B.
    // Enter = Formular absenden im Vollbild-Kommentarfeld) – bei offenem
    // Dropdown sollen Pfeiltasten/Enter/Tab/Escape ausschließlich die
    // Auswahl steuern, nicht gleichzeitig das Formular auslösen.
    textarea.addEventListener(
      'keydown',
      (e) => {
        if (!mentionDropdownState || mentionDropdownState.textarea !== textarea) return;
        const { items } = mentionDropdownState;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopImmediatePropagation();
          mentionDropdownState.activeIndex = (mentionDropdownState.activeIndex + 1) % items.length;
          updateMentionActiveOption();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopImmediatePropagation();
          mentionDropdownState.activeIndex =
            (mentionDropdownState.activeIndex - 1 + items.length) % items.length;
          updateMentionActiveOption();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          e.stopImmediatePropagation();
          selectMentionItem(items[mentionDropdownState.activeIndex]);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          closeMentionDropdown();
        }
      },
      true
    );
  }

  // =========================================================
  // Startseite: Session anlegen (Schritt-für-Schritt-Assistent)
  // =========================================================

  function initHomePage() {
    const form = document.getElementById('create-form');
    if (!form) return;

    const errorEl = document.getElementById('create-error');
    const resultEl = document.getElementById('result');
    const titleInput = document.getElementById('title');
    const slugInput = document.getElementById('slug');
    const mixSourceInput = document.getElementById('mix_source_url');
    const mixResolveStatus = document.getElementById('mix-resolve-status');
    const sessionPasswordInput = document.getElementById('session_password');
    const wizardProgress = document.getElementById('wizard-progress');
    const steps = document.querySelectorAll('.wizard-step');
    const progressSteps = document.querySelectorAll('.wizard-progress-step');
    const createAnotherBtn = document.getElementById('create-another-btn');
    const resultItemNote = document.getElementById('result-item-note');
    const submitBtn = document.getElementById('create-submit-btn');

    let currentStep = 1;

    function showStep(n) {
      currentStep = n;
      steps.forEach((el) => el.classList.toggle('active', Number(el.dataset.step) === n));
      progressSteps.forEach((el) => {
        const stepNum = Number(el.dataset.step);
        el.classList.toggle('active', stepNum === n);
        el.classList.toggle('done', stepNum < n);
      });
      const focusEl = document.querySelector(`.wizard-step[data-step="${n}"] input`);
      if (focusEl) setTimeout(() => focusEl.focus(), 0);
    }

    document.querySelectorAll('.wizard-next').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (currentStep === 1 && !titleInput.value.trim()) {
          titleInput.focus();
          return;
        }
        showStep(Number(btn.dataset.goto));
      });
    });
    document.querySelectorAll('.wizard-back').forEach((btn) => {
      btn.addEventListener('click', () => showStep(Number(btn.dataset.goto)));
    });

    // Enter in einem Schritt-1/2-Feld soll zum nächsten Schritt springen statt
    // (über den eigentlich unsichtbaren, aber weiterhin im DOM stehenden
    // Submit-Button von Schritt 3) das ganze Formular vorzeitig abzusenden.
    [titleInput, mixSourceInput].forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        document.querySelector(`.wizard-step[data-step="${currentStep}"] .wizard-next`)?.click();
      });
    });

    function showMixStatus(text, isError) {
      mixResolveStatus.textContent = text;
      mixResolveStatus.classList.remove('hidden');
      mixResolveStatus.classList.toggle('error-text', !!isError);
    }
    function hideMixStatus() {
      mixResolveStatus.classList.add('hidden');
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.classList.add('hidden');
      hideMixStatus();

      const title = titleInput.value;
      const slug = slugInput.value;
      const password = sessionPasswordInput.value;
      const sourceInput = mixSourceInput.value.trim();

      submitBtn.disabled = true;
      try {
        const payload = { title, slug, password };
        if (sourceInput) {
          if (isYouTubeInput(sourceInput)) {
            showMixStatus('Löse YouTube-Quelle auf …', false);
            payload.items = await resolveYouTubeToItems(sourceInput);
          } else {
            // Spotify/TikTok/Instagram/ARD-Mediathek/roher Video-Link – der
            // Server erkennt den Provider selbst (siehe resolveSourceToItems
            // in server.js) und liefert bei einem wirklich unbekannten Link
            // einen sprechenden Fehler zurück.
            payload.url = sourceInput;
          }
        }

        const stream = await apiFetch('api/streams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        // share_url/admin_url kommen bereits mit korrektem Präfix vom Server
        const shareUrl = `${location.origin}${stream.share_url}`;
        const adminUrl = `${location.origin}${stream.admin_url}`;

        document.getElementById('share-link').value = shareUrl;
        document.getElementById('admin-link').value = adminUrl;
        document.getElementById('open-link').href = stream.admin_url;

        if (Array.isArray(stream.items) && stream.items.length > 0) {
          const names = stream.items.map((it) => `${playlistItemIcon(it.provider)} ${it.title}`).join(', ');
          resultItemNote.textContent = `Hinzugefügt: ${names}`;
          resultItemNote.classList.remove('hidden');
        } else {
          resultItemNote.classList.add('hidden');
        }

        form.classList.add('hidden');
        wizardProgress.classList.add('hidden');
        resultEl.classList.remove('hidden');
        hideMixStatus();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.classList.remove('hidden');
        hideMixStatus();
        if (sourceInput) showStep(2);
      } finally {
        submitBtn.disabled = false;
      }
    });

    createAnotherBtn?.addEventListener('click', () => {
      form.reset();
      form.classList.remove('hidden');
      wizardProgress.classList.remove('hidden');
      resultEl.classList.add('hidden');
      showStep(1);
    });

    document.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = document.querySelector(btn.getAttribute('data-copy'));
        target.select();
        navigator.clipboard?.writeText(target.value).catch(() => {});
        document.execCommand?.('copy');
        const original = btn.textContent;
        btn.textContent = 'Kopiert!';
        setTimeout(() => (btn.textContent = original), 1500);
      });
    });

    showStep(1);
  }

  // =========================================================
  // Session-Seite: Playlist + Dual-/Multi-Player + Kommentare
  //
  // Vereinigt die früher getrennten ARD-Stream- und Content-Mix-Seiten zu
  // einer einzigen Ansicht (siehe PLAN.md/ToDo.md) – ARD/m3u8 ist hier ein
  // Provider unter mehreren (spotify/youtube/tiktok/instagram/ard), keine
  // Sonderseite mehr. Marker-Leiste, Sprung-zu-Timecode und Theater-/
  // Vollbildmodus gelten jetzt für alle Provider außer Instagram (das liefert
  // keine Positions-/Ende-Rückmeldung).
  // =========================================================

  function initSessionPage() {
    const spotifyEmbedEl = document.getElementById('spotify-embed');
    if (!spotifyEmbedEl) return;
    const spotifyEmbedTargetEl = document.getElementById('spotify-embed-target');
    const ardEmbedEl = document.getElementById('ard-embed');
    const video = document.getElementById('video');

    const streamId = location.pathname.split('/').filter(Boolean).pop();
    const params = new URLSearchParams(location.search);
    const adminToken = params.get('admin');

    const POLL_MS = 10000;

    let authorName = localStorage.getItem(NAME_KEY) || '';
    let authorColorChoice = localStorage.getItem(COLOR_KEY) || '';
    let accessToken = getStreamAccessToken(streamId);
    let pollTimer = null;

    let playlist = [];
    let comments = [];
    let currentIndex = -1;
    let spotifyController = null;
    let spotifyHasLoadedTrack = false;
    let youtubePlayer = null;
    let youtubePlayerReady = false;
    let ytPollTimer = null;
    let tiktokIframe = null;
    let tiktokPlayerReady = false;
    let tiktokPendingSeek = 0;
    let tiktokPendingAutoplay = false;
    let hls = null;
    let currentPositionSec = 0;
    let currentDurationSec = 0;
    let currentPlaybackRate = 1;
    let isPlaying = false;
    let lastCheckedPos = -0.001;
    let lastMarkerDuration = -1;
    // Timecode des Kommentars, zu dem der "Nächster Kommentar"-Button zuletzt
    // hingesprungen ist, solange dieser Punkt noch nicht erreicht ist (siehe
    // jumpToNextComment/checkCommentTriggers) – null, wenn kein Sprung
    // aussteht. Verhindert, dass der Button direkt nach dem Sprung erneut
    // klickbar wirkt, obwohl er (weil man ja erst 5s davor landet) nichts
    // Sichtbares mehr täte, bis die Stelle tatsächlich erreicht ist.
    let nextCommentPendingTarget = null;

    const titleEl = document.getElementById('stream-title');
    const loadErrorEl = document.getElementById('load-error');
    const premiumBanner = document.getElementById('premium-banner');
    const premiumBannerText = document.getElementById('premium-banner-text');
    const premiumBannerClose = document.getElementById('premium-banner-close');
    const spotifyLoginBtn = document.getElementById('spotify-login-btn');
    const nowPlayingEl = document.querySelector('.mix-now-playing');
    const youtubeEmbedEl = document.getElementById('youtube-embed');
    const tiktokEmbedEl = document.getElementById('tiktok-embed');
    const instagramEmbedEl = document.getElementById('instagram-embed');
    const nowPlayingThumb = document.getElementById('now-playing-thumb');
    const nowPlayingTitle = document.getElementById('now-playing-title');
    const nowPlayingArtist = document.getElementById('now-playing-artist');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const prevItemBtn = document.getElementById('prev-item-btn');
    const nextItemBtn = document.getElementById('next-item-btn');
    const posDisplay = document.getElementById('mix-pos-display');
    const restartBtn = document.getElementById('restart-btn');
    const advancedToggle = document.getElementById('advanced-toggle');
    const advancedPanel = document.getElementById('advanced-panel');
    const mobileCommentBtn = document.getElementById('mobile-comment-btn');
    const commentHereBtn = document.getElementById('comment-here-btn');
    const commentForm = document.getElementById('comment-form');
    const commentTimecodeField = document.getElementById('comment-timecode-field');
    const commentTimecodeInput = document.getElementById('comment-timecode');
    const commentBodyInput = document.getElementById('comment-body');
    const commentErrorEl = document.getElementById('comment-error');
    const commentCancelBtn = document.getElementById('comment-cancel-btn');
    const commentImageAttachHost = document.getElementById('comment-image-attach');
    const commentImageAttach = buildImageAttach(null);
    commentImageAttachHost?.appendChild(commentImageAttach.element);
    const emojiBtn = document.getElementById('emoji-btn');
    const emojiFlyout = document.getElementById('emoji-flyout');
    wirePasteImage(commentBodyInput, commentImageAttach);
    wireMentionAutocomplete(commentBodyInput, () => playlist);
    const commentList = document.getElementById('comment-list');
    const playlistListEl = document.getElementById('playlist-list');
    const addItemForm = document.getElementById('add-item-form');
    const addItemInput = document.getElementById('add-item-input');
    const addItemStatus = document.getElementById('add-item-status');
    const adminBanner = document.getElementById('admin-banner');
    const deleteStreamBtn = document.getElementById('delete-stream-btn');
    const currentNameDisplay = document.getElementById('current-name-display');
    const changeNameBtn = document.getElementById('change-name-btn');
    const nameModal = document.getElementById('name-modal');
    const nameModalForm = document.getElementById('name-modal-form');
    const nameModalInput = document.getElementById('name-modal-input');
    const nameModalSkip = document.getElementById('name-modal-skip');
    const nameModalStepName = document.getElementById('name-modal-step-name');
    const nameModalStepColor = document.getElementById('name-modal-step-color');
    const nameModalNextBtn = document.getElementById('name-modal-next-btn');
    const nameModalBackBtn = document.getElementById('name-modal-back-btn');
    const colorSwatchesEl = document.getElementById('color-swatches');
    const adminPasswordCard = document.getElementById('admin-password-card');
    const adminPasswordStatus = document.getElementById('admin-password-status');
    const adminPasswordForm = document.getElementById('admin-password-form');
    const adminPasswordInput = document.getElementById('admin-password-input');
    const adminPasswordError = document.getElementById('admin-password-error');
    const passwordModal = document.getElementById('password-modal');
    const passwordModalForm = document.getElementById('password-modal-form');
    const passwordModalInput = document.getElementById('password-modal-input');
    const passwordModalError = document.getElementById('password-modal-error');

    const playerWrap = document.querySelector('.player-wrap');
    const bubbleOverlay = document.getElementById('bubble-overlay');
    const markerBar = document.getElementById('marker-bar');
    const mobileScrubber = document.getElementById('mobile-scrubber');
    const mobileScrubberFill = document.getElementById('mobile-scrubber-fill');
    const mobileScrubberThumb = document.getElementById('mobile-scrubber-thumb');
    const jumpToEl = document.querySelector('.jump-to');
    const jumpInput = document.getElementById('jump-input');
    const jumpBtn = document.getElementById('jump-btn');
    const nextCommentBtn = document.getElementById('next-comment-btn');
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const speedSelect = document.getElementById('speed-select');
    const fsCommentInput = document.getElementById('fs-comment-input');
    wireMentionAutocomplete(fsCommentInput, () => playlist);
    const fsCommentSubmitBtn = document.getElementById('fs-comment-submit');
    const fsReplyBadge = document.getElementById('fs-reply-badge');
    const fsReplyAuthorEl = document.getElementById('fs-reply-author');
    const fsReplyCancelBtn = document.getElementById('fs-reply-cancel');
    const sortToggle = document.getElementById('sort-toggle');
    const sortOptions = document.querySelectorAll('.sort-switch-option');

    // ---------- Kommentar-Sortierung innerhalb eines Playlist-Items ----------
    //
    // Die Playlist-Position bestimmt weiterhin die Grundreihenfolge der
    // Kommentar-Gruppen (siehe renderComments) – dieser Umschalter regelt nur
    // die Reihenfolge INNERHALB der Kommentare zum selben Item ("früh/spät
    // im Titel zuerst"), analog zum früheren ARD-only-Umschalter.

    let sortOrder = localStorage.getItem(SORT_ORDER_KEY) === 'desc' ? 'desc' : 'asc';

    function updateSortUI() {
      sortToggle.checked = sortOrder === 'desc';
      sortOptions.forEach((opt) => opt.classList.toggle('active', opt.dataset.value === sortOrder));
    }
    updateSortUI();

    function setSortOrder(order) {
      if (order !== 'asc' && order !== 'desc') return;
      sortOrder = order;
      localStorage.setItem(SORT_ORDER_KEY, sortOrder);
      updateSortUI();
      renderComments();
    }

    sortToggle.addEventListener('change', () => setSortOrder(sortToggle.checked ? 'desc' : 'asc'));
    sortOptions.forEach((opt) => opt.addEventListener('click', () => setSortOrder(opt.dataset.value)));

    // ---------- Kommentarfilter (Alle/Ungelesen/Gelesen) ----------

    let readFilter = loadReadFilter();
    const readFilterEl = document.getElementById('read-filter');
    buildReadFilterControl(readFilterEl, readFilter, (value) => {
      readFilter = value;
      localStorage.setItem(READ_FILTER_KEY, value);
      renderComments();
    });

    function onReadToggled() {
      if (readFilter !== 'all') renderComments();
    }

    // ---------- Anzeigename: einmalig per Modal abfragen ----------

    function updateNameDisplay() {
      currentNameDisplay.textContent = authorName || '–';
    }
    updateNameDisplay();

    function onColorSwatchSelect(color) {
      authorColorChoice = color;
      renderColorSwatches(colorSwatchesEl, authorColorChoice, onColorSwatchSelect);
    }

    // Zweistufiger Ablauf, damit die Farbe nicht bei jedem Namenswechsel neu
    // abgefragt werden muss: Schritt 1 fragt nur den Namen ab. Erst wenn
    // dieser Name in DIESER Session noch mit keiner Farbe aufgetaucht ist
    // (siehe findKnownColorForName), folgt Schritt 2 zur Farbauswahl – ist
    // der Name schon bekannt (z. B. weil sich mehrere Personen ein Gerät
    // teilen und jede ihren eigenen Namen einträgt), wird dessen zuletzt
    // benutzte Farbe direkt übernommen und der Farbschritt übersprungen.
    function showNameModalStep(step) {
      nameModalStepName?.classList.toggle('hidden', step !== 'name');
      nameModalStepColor?.classList.toggle('hidden', step !== 'color');
    }

    function openNameModal() {
      nameModalInput.value = authorName;
      showNameModalStep('name');
      nameModal.classList.remove('hidden');
      setTimeout(() => nameModalInput.focus(), 0);
    }
    function closeNameModal() {
      nameModal.classList.add('hidden');
    }
    if (!authorName) openNameModal();

    // Sucht in den Kommentaren dieser Session nach dem zuletzt benutzten
    // author_color-Wert für exakt diesen Namen. Nutzt den bereits geladenen
    // comments-Cache, falls vorhanden – das Name-Modal kann aber schon vor
    // dem ersten Laden der Kommentare erscheinen (siehe loadStream), daher
    // wird bei leerem Cache einmalig frisch nachgeladen.
    async function findKnownColorForName(name) {
      let list = comments;
      if (!Array.isArray(list) || list.length === 0) {
        try {
          list = await apiFetch(
            `api/streams/${streamId}/comments${authorName ? `?author_name=${encodeURIComponent(authorName)}` : ''}`,
            { headers: accessHeaders() }
          );
          comments = list;
        } catch {
          list = comments;
        }
      }
      const match = (list || []).find((c) => c.author_name === name && c.author_color);
      return match ? match.author_color : null;
    }

    function finalizeNameModal() {
      const value = nameModalInput.value.trim();
      if (!value) return;
      authorName = value;
      localStorage.setItem(NAME_KEY, authorName);
      localStorage.setItem(COLOR_KEY, authorColorChoice);
      updateNameDisplay();
      closeNameModal();
      renderComments();
      // Gelesen-Status hängt am Anzeigenamen (siehe setCommentRead/isCommentRead) –
      // nach einem Namenswechsel/-erstwahl daher neu vom Server laden, außerdem
      // Chance für eine einmalige Migration alter localStorage-Markierungen.
      loadComments();
      migrateLegacyLocalReadStatus();
    }

    async function advanceFromNameStep() {
      const value = nameModalInput.value.trim();
      if (!value) {
        nameModalInput.focus();
        return;
      }
      nameModalNextBtn.disabled = true;
      try {
        const knownColor = await findKnownColorForName(value);
        if (knownColor) {
          authorColorChoice = knownColor;
          finalizeNameModal();
        } else {
          renderColorSwatches(colorSwatchesEl, authorColorChoice, onColorSwatchSelect);
          showNameModalStep('color');
        }
      } finally {
        nameModalNextBtn.disabled = false;
      }
    }

    nameModalNextBtn?.addEventListener('click', advanceFromNameStep);
    nameModalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !nameModalStepName?.classList.contains('hidden')) {
        e.preventDefault();
        advanceFromNameStep();
      }
    });
    nameModalBackBtn?.addEventListener('click', () => {
      showNameModalStep('name');
      setTimeout(() => nameModalInput.focus(), 0);
    });

    nameModalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      finalizeNameModal();
    });
    nameModalSkip.addEventListener('click', closeNameModal);
    changeNameBtn.addEventListener('click', openNameModal);

    if (adminToken) {
      adminBanner.classList.remove('hidden');
      adminPasswordCard?.classList.remove('hidden');
    }

    function adminHeaders() {
      return adminToken ? { 'X-Admin-Token': adminToken } : {};
    }
    function accessHeaders() {
      return accessToken ? { 'X-Stream-Access': accessToken } : {};
    }

    const notesController = createNotesController(streamId, accessHeaders, () => ({
      name: authorName,
      color: authorColorChoice,
    }));

    // ---------- Passwort-Gate ----------

    function showPasswordGate() {
      passwordModal?.classList.remove('hidden');
      setTimeout(() => passwordModalInput?.focus(), 0);
    }
    function hidePasswordGate() {
      passwordModal?.classList.add('hidden');
    }

    passwordModalForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      passwordModalError.classList.add('hidden');
      const password = passwordModalInput.value;
      try {
        const result = await apiFetch(`api/streams/${streamId}/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        accessToken = result.access_token;
        setStreamAccessToken(streamId, accessToken);
        passwordModalInput.value = '';
        hidePasswordGate();
        await loadStream();
      } catch (err) {
        passwordModalError.textContent = err.message;
        passwordModalError.classList.remove('hidden');
      }
    });

    function updateAdminPasswordStatus(isProtected) {
      if (!adminPasswordStatus) return;
      adminPasswordStatus.textContent = isProtected
        ? 'Diese Session ist aktuell mit einem Passwort geschützt.'
        : 'Diese Session ist aktuell nicht passwortgeschützt.';
    }

    adminPasswordForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      adminPasswordError.classList.add('hidden');
      const password = adminPasswordInput.value;
      try {
        const result = await apiFetch(`api/streams/${streamId}/password`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...adminHeaders() },
          body: JSON.stringify({ password }),
        });
        updateAdminPasswordStatus(result.password_protected);
        adminPasswordInput.value = '';
      } catch (err) {
        adminPasswordError.textContent = err.message;
        adminPasswordError.classList.remove('hidden');
      }
    });

    deleteStreamBtn?.addEventListener('click', async () => {
      if (!confirm('Diese komplette Session inkl. Playlist und Kommentare löschen?')) return;
      try {
        await apiFetch(`api/streams/${streamId}`, { method: 'DELETE', headers: adminHeaders() });
        location.href = '.';
      } catch (err) {
        alert('Löschen fehlgeschlagen: ' + err.message);
      }
    });

    // ---------- Session + Playlist + Kommentare laden ----------

    async function loadStream() {
      try {
        const stream = await apiFetch(`api/streams/${streamId}`, { headers: accessHeaders() });
        titleEl.textContent = stream.title;
        document.title = `${stream.title} – Duett`;
        notesController.applyServerValue(stream.notes);
        if (adminToken) updateAdminPasswordStatus(stream.password_protected);
        hidePasswordGate();
        await loadItems();
        loadComments();
        if (!pollTimer) {
          pollTimer = setInterval(() => {
            loadItems();
            loadComments();
            notesController.refresh();
          }, POLL_MS);
        }
      } catch (err) {
        if (err.status === 401) {
          showPasswordGate();
          return;
        }
        loadErrorEl.textContent = 'Session konnte nicht geladen werden: ' + err.message;
        loadErrorEl.classList.remove('hidden');
        titleEl.textContent = 'Session nicht gefunden';
      }
    }

    // ---------- Spotify-Hinweis-Banner: wegklickbar (localStorage-Merker) ----------

    function updatePremiumBannerVisibility() {
      const hasSpotify = playlist.some((it) => it.provider === 'spotify');
      const dismissed = localStorage.getItem(SPOTIFY_HINT_DISMISSED_KEY) === '1';
      premiumBanner.classList.toggle('hidden', !hasSpotify || dismissed);
    }

    premiumBannerClose?.addEventListener('click', () => {
      localStorage.setItem(SPOTIFY_HINT_DISMISSED_KEY, '1');
      premiumBanner.classList.add('hidden');
    });

    // Auf iOS bringt der Login-Popup-Button nichts (siehe isIOS()-Kommentar):
    // eigener Hinweistext ohne den Button, stattdessen Verweis aufs Icon.
    if (isIOS() && premiumBannerText) {
      premiumBannerText.textContent =
        '🎧 Diese Playlist enthält Spotify-Inhalte: auf iPhone/iPad blockiert Safari den Spotify-Login im eingebetteten Player technisch, daher gibt es hier nur eine kurze Vorschau. Für den ganzen Song auf das 🎵-Icon neben dem Titel tippen – öffnet den Track in der Spotify-App.';
      spotifyLoginBtn?.remove();
    }

    spotifyLoginBtn?.addEventListener('click', () => {
      const w = 480;
      const h = 640;
      const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
      const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
      window.open(
        'https://accounts.spotify.com/login',
        'spotify-login',
        `width=${w},height=${h},left=${left},top=${top},noopener,noreferrer`
      );
    });

    async function loadItems() {
      try {
        const data = await apiFetch(`api/streams/${streamId}/items`, { headers: accessHeaders() });
        const hadNoItemsYet = playlist.length === 0;
        playlist = data;
        renderPlaylist();
        updatePremiumBannerVisibility();
        commentHereBtn.disabled = playlist.length === 0;
        if (hadNoItemsYet && playlist.length > 0) {
          loadItemIntoPlayer(0, false);
        } else if (playlist.length === 0) {
          updateNowPlaying(null);
          updatePosDisplayVisibility(null);
          updateSeekControlsVisibility(null);
          updateTimelineControlsVisibility(null);
          updateSpeedControlVisibility(null);
        } else {
          renderMarkers();
        }
      } catch (err) {
        console.error('Playlist konnte nicht geladen werden:', err);
      }
    }

    // ---------- Anzeige: aktueller Titel, Position, Play/Pause-Icon ----------

    function formatPos(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    }

    function updatePosDisplay() {
      posDisplay.textContent = `${formatPos(currentPositionSec)} / ${formatPos(currentDurationSec)}`;
      if (currentDurationSec && isFinite(currentDurationSec) && currentDurationSec > 0) {
        const pct = (currentPositionSec / currentDurationSec) * 100;
        markerBar.style.setProperty('--playhead', pct + '%');
        if (mobileScrubberFill) mobileScrubberFill.style.width = pct + '%';
        if (mobileScrubberThumb) mobileScrubberThumb.style.left = pct + '%';
      }
      if (currentDurationSec !== lastMarkerDuration) {
        lastMarkerDuration = currentDurationSec;
        renderMarkers();
      }
    }

    // ---------- Mobiler Scrubber: Tippen/Ziehen zum Springen ----------
    // Eigenständiges Pill-Element unterhalb der Marker-Leiste (siehe
    // "Spotify embed Buttons"-Handoff) – auf Desktop per CSS ausgeblendet.
    // Rechnet die Klick-/Touch-Position in Prozent der Breite um und springt
    // per seekCurrentTo() zur entsprechenden Stelle im aktuellen Titel.
    function scrubToClientX(clientX) {
      if (!currentDurationSec || !isFinite(currentDurationSec) || currentDurationSec <= 0) return;
      const rect = mobileScrubber.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      seekCurrentTo(pct * currentDurationSec, false);
    }

    if (mobileScrubber) {
      let scrubbing = false;
      mobileScrubber.addEventListener('pointerdown', (e) => {
        scrubbing = true;
        mobileScrubber.setPointerCapture(e.pointerId);
        scrubToClientX(e.clientX);
      });
      mobileScrubber.addEventListener('pointermove', (e) => {
        if (scrubbing) scrubToClientX(e.clientX);
      });
      const stopScrub = () => { scrubbing = false; };
      mobileScrubber.addEventListener('pointerup', stopScrub);
      mobileScrubber.addEventListener('pointercancel', stopScrub);
    }

    // Bei Spotify-Items ausgeblendet: ohne Premium+Login liefert das Embed
    // nur eine kurze Vorschau, mit sehr unzuverlässigen/unpassenden
    // Positions-/Dauer-Werten. Bei Instagram ausgeblendet, da es dafür gar
    // keine Positions-/Dauer-Daten gibt.
    function updatePosDisplayVisibility(item) {
      const hide = !!item && (item.provider === 'spotify' || item.provider === 'instagram');
      posDisplay.classList.toggle('hidden', hide);
    }

    // Blendet die ±Sek-Sprung-Buttons und den Play/Pause-Button bei
    // Instagram-Items aus: Instagrams embed.js bietet keine dokumentierte
    // JS-Steuerung von außen. "Vorheriges"/"Nächstes" bleiben sichtbar, da
    // sie providerunabhängig nur die Playlist weiterschalten.
    function updateSeekControlsVisibility(item) {
      const hide = !!item && item.provider === 'instagram';
      document.querySelectorAll('[data-seek]').forEach((btn) => {
        btn.classList.toggle('hidden', hide);
      });
      playPauseBtn.classList.toggle('hidden', hide);
    }

    // Marker-Leiste, Sprung-zu-Timecode und Vollbild-/Theater-Modus gelten
    // für JEDEN Provider außer Instagram (siehe ToDo.md/Merge-Entscheidung) –
    // ausgeblendet, solange kein Item aktiv ist oder Instagram spielt.
    function updateTimelineControlsVisibility(item) {
      const supportsTimeline = !!item && item.provider !== 'instagram';
      markerBar.classList.toggle('hidden', !supportsTimeline);
      jumpToEl?.classList.toggle('hidden', !supportsTimeline);
      nextCommentBtn?.classList.toggle('hidden', !supportsTimeline);
      // Fullscreen-Button ausblenden, wenn weder die Fullscreen API für
      // .player-wrap noch (bei ARD/Video) der iOS-Safari-Fallback über
      // video.webkitEnterFullscreen() zur Verfügung steht – sonst hätten
      // z. B. iPhone-Nutzer:innen bei Spotify/YouTube/TikTok/Instagram
      // einen Button, der beim Antippen nichts tut.
      const canFullscreen = supportsTimeline && (elementFullscreenSupported() || iosVideoFullscreenSupported());
      fullscreenBtn?.classList.toggle('hidden', !canFullscreen);
    }

    // Wiedergabegeschwindigkeit: nur ARD/m3u8 (natives <video>) und YouTube
    // (IFrame-API kennt setPlaybackRate) unterstützen sie. Bei Spotify,
    // TikTok und Instagram gibt es keine dokumentierte Steuerung dafür.
    function providerSupportsPlaybackRate(provider) {
      return provider === 'ard' || provider === 'youtube';
    }

    function updateSpeedControlVisibility(item) {
      const supported = !!item && providerSupportsPlaybackRate(item.provider);
      speedSelect?.classList.toggle('hidden', !supported);
    }

    function applyPlaybackRate(item) {
      if (!item) return;
      if (item.provider === 'ard') {
        video.playbackRate = currentPlaybackRate;
      } else if (item.provider === 'youtube' && youtubePlayer && youtubePlayerReady) {
        try {
          youtubePlayer.setPlaybackRate(currentPlaybackRate);
        } catch {
          // ignore
        }
      }
    }

    speedSelect?.addEventListener('change', () => {
      currentPlaybackRate = parseFloat(speedSelect.value) || 1;
      applyPlaybackRate(playlist[currentIndex]);
    });

    function updatePlayPauseIcon() {
      playPauseBtn.textContent = isPlaying ? '⏸' : '▶';
      playPauseBtn.setAttribute('aria-label', isPlaying ? 'Pausieren' : 'Abspielen');
    }

    function updateNowPlaying(item) {
      const isSpotify = !!item && item.provider === 'spotify';
      nowPlayingEl?.classList.toggle('hidden', isSpotify);
      if (isSpotify) return;

      nowPlayingTitle.textContent = item ? item.title : 'Noch keine Playlist-Einträge';
      nowPlayingArtist.textContent = item ? item.artist_or_channel || '' : '';
      if (item && item.thumbnail_url) {
        nowPlayingThumb.src = item.thumbnail_url;
        nowPlayingThumb.classList.remove('hidden');
      } else {
        nowPlayingThumb.classList.add('hidden');
      }
    }

    // ---------- Embed-Sichtbarkeit ----------

    function showEmbedFor(provider) {
      ardEmbedEl.classList.toggle('hidden', provider !== 'ard');
      spotifyEmbedEl.classList.toggle('hidden', provider !== 'spotify');
      youtubeEmbedEl.classList.toggle('hidden', provider !== 'youtube');
      tiktokEmbedEl.classList.toggle('hidden', provider !== 'tiktok');
      instagramEmbedEl.classList.toggle('hidden', provider !== 'instagram');
      // Am .player-wrap gespiegelt, damit CSS im Vollbildmodus providerspezifisch
      // reagieren kann (siehe .player-wrap:fullscreen[data-provider="ard"] in
      // style.css – blendet dort .mix-now-playing aus).
      if (playerWrap) playerWrap.dataset.provider = provider || '';
    }

    function stopPlaybackForProvider(provider) {
      if (provider === 'ard') {
        video.pause();
      } else if (provider === 'spotify' && spotifyController && spotifyHasLoadedTrack) {
        try {
          spotifyController.pause();
        } catch {
          // ignore
        }
      } else if (provider === 'youtube' && youtubePlayer && youtubePlayerReady) {
        try {
          youtubePlayer.pauseVideo();
        } catch {
          // ignore
        }
        stopYouTubePositionPolling();
      } else if (provider === 'tiktok') {
        postToTikTok('pause');
      } else if (provider === 'instagram') {
        instagramEmbedEl.innerHTML = '';
      }
    }

    // ---------- ARD/m3u8-Engine ----------

    function loadArdItem(item, startAtSec, autoplay) {
      showEmbedFor('ard');
      if (hls) {
        try {
          hls.destroy();
        } catch {
          // ignore
        }
        hls = null;
      }
      const applyStart = () => {
        if (startAtSec) video.currentTime = startAtSec;
        video.playbackRate = currentPlaybackRate;
        if (autoplay) video.play().catch(() => {});
      };
      if (window.Hls && window.Hls.isSupported()) {
        hls = new Hls();
        hls.loadSource(item.provider_uri);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            loadErrorEl.textContent = 'Fehler beim Laden des Videos. Prüfe die m3u8-URL und CORS-Header des Hosts.';
            loadErrorEl.classList.remove('hidden');
          }
        });
        hls.on(Hls.Events.MANIFEST_PARSED, applyStart);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = item.provider_uri; // Safari native HLS
        video.addEventListener('loadedmetadata', applyStart, { once: true });
      } else {
        loadErrorEl.textContent = 'HLS wird von diesem Browser nicht unterstützt.';
        loadErrorEl.classList.remove('hidden');
      }
    }

    function ardIsActive() {
      return playlist[currentIndex]?.provider === 'ard';
    }

    // Providerspezifische Aktiv-Checks: verhindern, dass Positions-/Dauer-
    // Updates eines Providers (z.B. ein weiterlaufender YouTube-Poll-Timer
    // oder eine noch eintrudelnde Spotify-playback_update-Nachricht) die
    // Timecode-Anzeige überschreiben, nachdem längst zu einem anderen
    // Playlist-Item/Provider gewechselt wurde ("Timecode spinnt" nach
    // mehreren angespielten Items).
    function spotifyIsActive() {
      return playlist[currentIndex]?.provider === 'spotify';
    }

    function youtubeIsActive() {
      return playlist[currentIndex]?.provider === 'youtube';
    }

    function tiktokIsActive() {
      return playlist[currentIndex]?.provider === 'tiktok';
    }

    video.addEventListener('timeupdate', () => {
      if (!ardIsActive()) return;
      currentPositionSec = video.currentTime || 0;
      updatePosDisplay();
      checkCommentTriggers();
    });
    video.addEventListener('durationchange', () => {
      if (!ardIsActive()) return;
      currentDurationSec = isFinite(video.duration) ? video.duration : 0;
      updatePosDisplay();
    });
    video.addEventListener('play', () => {
      if (!ardIsActive()) return;
      isPlaying = true;
      updatePlayPauseIcon();
    });
    video.addEventListener('pause', () => {
      if (!ardIsActive()) return;
      isPlaying = false;
      updatePlayPauseIcon();
    });
    video.addEventListener('ended', () => {
      if (ardIsActive()) handleItemEnded();
    });
    video.addEventListener('click', () => {
      if (!ardIsActive()) return;
      if (video.paused) video.play();
      else video.pause();
    });

    // ---------- Spotify-Engine ----------

    function ensureSpotifyEncryptedMedia() {
      const iframeEl = spotifyEmbedEl.querySelector('iframe');
      if (!iframeEl) return;
      const desired = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
      if (iframeEl.getAttribute('allow') !== desired) iframeEl.setAttribute('allow', desired);
    }

    function ensureSpotifyController() {
      if (spotifyController) return Promise.resolve(spotifyController);
      return loadSpotifyIframeApi().then(
        (IFrameAPI) =>
          new Promise((resolve) => {
            IFrameAPI.createController(spotifyEmbedTargetEl, { uri: '', width: '100%', height: 152 }, (controller) => {
              spotifyController = controller;
              controller.addListener('ready', ensureSpotifyEncryptedMedia);
              controller.addListener('playback_update', (e) => {
                spotifyHasLoadedTrack = true;
                if (!spotifyIsActive()) return;
                currentPositionSec = (e.data.position || 0) / 1000;
                currentDurationSec = (e.data.duration || 0) / 1000;
                isPlaying = !e.data.isPaused;
                updatePosDisplay();
                updatePlayPauseIcon();
                checkCommentTriggers();
                if (
                  currentDurationSec > 0 &&
                  currentPositionSec >= currentDurationSec - 0.4 &&
                  e.data.isPaused
                ) {
                  handleItemEnded();
                }
              });
              resolve(controller);
            });
          })
      );
    }

    async function loadSpotifyItem(item, startAtSec, autoplay) {
      showEmbedFor('spotify');
      const controller = await ensureSpotifyController();
      try {
        controller.loadUri(item.provider_uri, false, Math.max(0, Math.floor(startAtSec || 0)));
      } catch {
        controller.loadUri(item.provider_uri);
      }
      ensureSpotifyEncryptedMedia();
      if (startAtSec) {
        setTimeout(() => {
          try {
            controller.seek(startAtSec);
          } catch {
            // ignore
          }
        }, 600);
      }
      if (autoplay) {
        setTimeout(() => {
          try {
            controller.resume();
          } catch {
            // ignore
          }
        }, 300);
      }
    }

    // ---------- YouTube-Engine ----------

    function ensureYouTubePlayer() {
      if (youtubePlayer) return Promise.resolve(youtubePlayer);
      return loadYouTubeIframeApi().then(
        (YT) =>
          new Promise((resolve) => {
            youtubePlayer = new YT.Player('youtube-embed-target', {
              height: '100%',
              width: '100%',
              playerVars: { playsinline: 1, fs: 0 },
              events: {
                onReady: () => {
                  youtubePlayerReady = true;
                  resolve(youtubePlayer);
                },
                onStateChange: (e) => {
                  if (e.data === YT.PlayerState.ENDED) handleItemEnded();
                  isPlaying = e.data === YT.PlayerState.PLAYING;
                  updatePlayPauseIcon();
                },
              },
            });
          })
      );
    }

    function stopYouTubePositionPolling() {
      if (ytPollTimer) {
        clearInterval(ytPollTimer);
        ytPollTimer = null;
      }
    }

    function startYouTubePositionPolling() {
      if (ytPollTimer) return;
      ytPollTimer = setInterval(() => {
        if (!youtubeIsActive()) {
          stopYouTubePositionPolling();
          return;
        }
        if (!youtubePlayer || !youtubePlayerReady) return;
        try {
          currentPositionSec = youtubePlayer.getCurrentTime() || 0;
          currentDurationSec = youtubePlayer.getDuration() || 0;
          updatePosDisplay();
          checkCommentTriggers();
        } catch {
          // ignore
        }
      }, 500);
    }

    async function loadYouTubeItem(item, startAtSec, autoplay) {
      showEmbedFor('youtube');
      const player = await ensureYouTubePlayer();
      player.loadVideoById({ videoId: item.provider_uri, startSeconds: startAtSec || 0 });
      try {
        player.setPlaybackRate(currentPlaybackRate);
      } catch {
        // ignore
      }
      if (!autoplay) {
        setTimeout(() => {
          try {
            player.pauseVideo();
          } catch {
            // ignore
          }
        }, 400);
      }
      startYouTubePositionPolling();
    }

    // ---------- TikTok-Engine ----------

    function postToTikTok(type, value) {
      if (!tiktokIframe || !tiktokIframe.contentWindow) return;
      try {
        tiktokIframe.contentWindow.postMessage({ type, value, 'x-tiktok-player': true }, '*');
      } catch {
        // ignore
      }
    }

    function playTikTokUnmuted() {
      postToTikTok('unMute');
      postToTikTok('play');
    }

    window.addEventListener('message', (event) => {
      if (!tiktokIframe || event.source !== tiktokIframe.contentWindow) return;
      const data = event.data;
      if (!data || !data['x-tiktok-player']) return;

      switch (data.type) {
        case 'onPlayerReady':
          tiktokPlayerReady = true;
          postToTikTok('unMute');
          if (tiktokPendingSeek > 0) postToTikTok('seekTo', tiktokPendingSeek);
          if (tiktokPendingAutoplay) postToTikTok('play');
          break;
        case 'onStateChange':
          if (data.value === 0) {
            handleItemEnded();
          } else {
            isPlaying = data.value === 1;
            updatePlayPauseIcon();
          }
          break;
        case 'onCurrentTime':
          if (!tiktokIsActive()) break;
          if (data.value && typeof data.value === 'object') {
            currentPositionSec = data.value.currentTime || 0;
            if (data.value.duration) currentDurationSec = data.value.duration;
          }
          updatePosDisplay();
          checkCommentTriggers();
          break;
        default:
          break;
      }
    });

    function loadTikTokItem(item, startAtSec, autoplay) {
      showEmbedFor('tiktok');

      tiktokPlayerReady = false;
      tiktokPendingSeek = Math.max(0, Math.floor(startAtSec || 0));
      tiktokPendingAutoplay = !!autoplay;

      const params = new URLSearchParams({
        music_info: '1',
        description: '1',
        muted: '0',
        autoplay: autoplay && !tiktokPendingSeek ? '1' : '0',
      });
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.tiktok.com/player/v1/${item.provider_uri}?${params.toString()}`;
      iframe.allow = 'fullscreen; autoplay';
      iframe.title = item.title || 'TikTok-Video';
      tiktokEmbedEl.innerHTML = '';
      tiktokEmbedEl.appendChild(iframe);
      tiktokIframe = iframe;
    }

    // ---------- Instagram-Engine ----------

    let instagramScriptPromise = null;
    function ensureInstagramEmbedScript() {
      if (instagramScriptPromise) return instagramScriptPromise;
      instagramScriptPromise = new Promise((resolve) => {
        if (window.instgrm) {
          resolve(window.instgrm);
          return;
        }
        const script = document.createElement('script');
        script.src = 'https://www.instagram.com/embed.js';
        script.async = true;
        script.onload = () => resolve(window.instgrm);
        document.body.appendChild(script);
      });
      return instagramScriptPromise;
    }

    function loadInstagramItem(item) {
      showEmbedFor('instagram');

      const [type, shortcode] = String(item.provider_uri || '').split(':');
      const permalink = `https://www.instagram.com/${type || 'reel'}/${shortcode || ''}/`;

      instagramEmbedEl.innerHTML = `<blockquote class="instagram-media" data-instgrm-permalink="${permalink}" data-instgrm-version="14"></blockquote>`;

      ensureInstagramEmbedScript().then((instgrm) => {
        try {
          instgrm?.Embeds?.process();
        } catch {
          // ignore
        }
      });
    }

    // ---------- Gemeinsame Steuerung ----------

    function loadItemIntoPlayer(index, autoplay, startAtSec) {
      if (index < 0 || index >= playlist.length) return;
      const previousItem = playlist[currentIndex];
      currentIndex = index;
      const item = playlist[index];
      if (previousItem && previousItem.provider !== item.provider) {
        stopPlaybackForProvider(previousItem.provider);
      }
      updateNowPlaying(item);
      updatePosDisplayVisibility(item);
      updateSeekControlsVisibility(item);
      updateTimelineControlsVisibility(item);
      updateSpeedControlVisibility(item);
      lastCheckedPos = -0.001;
      currentPositionSec = startAtSec || 0;
      currentDurationSec = (item.duration_ms || 0) / 1000;
      lastMarkerDuration = -1;
      nextCommentPendingTarget = null;
      updateNextCommentBtnDisabled();
      updatePosDisplay();
      highlightCurrentPlaylistItem();
      highlightActiveItemComments();
      if (item.provider === 'spotify') {
        loadSpotifyItem(item, startAtSec, autoplay);
      } else if (item.provider === 'tiktok') {
        loadTikTokItem(item, startAtSec, autoplay);
      } else if (item.provider === 'instagram') {
        loadInstagramItem(item);
      } else if (item.provider === 'ard') {
        loadArdItem(item, startAtSec, autoplay);
      } else {
        loadYouTubeItem(item, startAtSec, autoplay);
      }
    }

    function handleItemEnded() {
      if (currentIndex + 1 < playlist.length) {
        loadItemIntoPlayer(currentIndex + 1, true);
      } else {
        isPlaying = false;
        updatePlayPauseIcon();
      }
    }

    function pauseCurrent() {
      const item = playlist[currentIndex];
      if (!item) return;
      if (item.provider === 'ard') video.pause();
      else if (item.provider === 'spotify' && spotifyController && spotifyHasLoadedTrack) spotifyController.pause();
      else if (item.provider === 'youtube' && youtubePlayer) youtubePlayer.pauseVideo();
      else if (item.provider === 'tiktok') postToTikTok('pause');
    }

    function togglePlayPause() {
      const item = playlist[currentIndex];
      if (!item) return;
      if (item.provider === 'ard') {
        if (video.paused) video.play();
        else video.pause();
      } else if (item.provider === 'spotify' && spotifyController) {
        try {
          if (isPlaying) spotifyController.pause();
          else spotifyController.resume();
        } catch {
          // ignore - siehe Kommentar bei spotifyHasLoadedTrack im Original
        }
      } else if (item.provider === 'youtube' && youtubePlayer) {
        if (isPlaying) youtubePlayer.pauseVideo();
        else youtubePlayer.playVideo();
      } else if (item.provider === 'tiktok') {
        if (isPlaying) postToTikTok('pause');
        else playTikTokUnmuted();
      }
    }

    function seekCurrentTo(sec, forcePlay = true) {
      const item = playlist[currentIndex];
      if (!item) return;
      const target = Math.max(0, sec);
      if (item.provider === 'ard') {
        video.currentTime = target;
        if (forcePlay) video.play().catch(() => {});
      } else if (item.provider === 'spotify' && spotifyController && spotifyHasLoadedTrack) {
        spotifyController.seek(target);
        if (forcePlay) spotifyController.resume();
      } else if (item.provider === 'youtube' && youtubePlayer) {
        youtubePlayer.seekTo(target, true);
        if (forcePlay) youtubePlayer.playVideo();
      } else if (item.provider === 'tiktok') {
        if (tiktokPlayerReady) {
          postToTikTok('seekTo', Math.floor(target));
          if (forcePlay) playTikTokUnmuted();
        } else {
          tiktokPendingSeek = Math.floor(target);
          if (forcePlay) tiktokPendingAutoplay = true;
        }
      }
      currentPositionSec = target;
      updatePosDisplay();
    }

    function seekRelative(deltaSec) {
      if (!playlist[currentIndex]) return;
      let target = (currentPositionSec || 0) + deltaSec;
      if (target < 0) target = 0;
      if (currentDurationSec && isFinite(currentDurationSec) && currentDurationSec > 0 && target > currentDurationSec) {
        target = currentDurationSec;
      }
      seekCurrentTo(target, false);
    }

    document.querySelectorAll('[data-seek]').forEach((btn) => {
      btn.addEventListener('click', () => seekRelative(parseFloat(btn.getAttribute('data-seek'))));
    });

    restartBtn?.addEventListener('click', () => seekCurrentTo(0));

    // ---------- "Mehr"-Aufklapper (mobiles Transport-Panel) ----------
    // Nur auf schmalen Screens sichtbar (siehe .more-toggle/.advanced-panel
    // in style.css) – auf Desktop bleibt der erweiterte Bereich immer offen
    // dargestellt, daher kein Zustand dort nötig.
    advancedToggle?.addEventListener('click', () => {
      const open = advancedPanel.classList.toggle('open');
      advancedToggle.setAttribute('aria-expanded', String(open));
    });

    // Kompaktes 💬-Icon im mobilen Transport-Panel: löst denselben "Kommentar
    // an aktueller Stelle"-Flow wie der vollständige Button darunter aus,
    // statt eigene Logik zu duplizieren.
    mobileCommentBtn?.addEventListener('click', () => commentHereBtn?.click());

    playPauseBtn.addEventListener('click', togglePlayPause);

    // Leertaste togglet Play/Pause, außer es wird gerade in ein Text-/
    // Eingabefeld getippt (z. B. das Fullscreen-Kommentarfeld).
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const active = document.activeElement;
      const isTypingField =
        active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (isTypingField) return;

      const nothingFocused = !active || active === document.body;
      const isFullscreen = !!getFullscreenElement();
      if (!nothingFocused && !isFullscreen) return;

      e.preventDefault();
      if (active instanceof HTMLElement && active !== document.body) active.blur();
      togglePlayPause();
    });

    prevItemBtn.addEventListener('click', () => {
      if (currentIndex > 0) loadItemIntoPlayer(currentIndex - 1, true);
    });
    nextItemBtn.addEventListener('click', () => {
      if (currentIndex + 1 < playlist.length) loadItemIntoPlayer(currentIndex + 1, true);
    });

    // ---------- Vollbild-/Theater-Modus ----------

    // iOS Safari (iPhone) kennt die Fullscreen API nur für <video>-Elemente
    // selbst (video.webkitEnterFullscreen()), NICHT für beliebige Container
    // wie .player-wrap – dort liefen playerWrap.requestFullscreen/
    // webkitRequestFullscreen bislang beide undefined, der Button tat also
    // schlicht nichts. Fallback: bei ARD/Video-Items native Video-
    // Vollbildsteuerung von iOS nutzen (degradiert, ohne Sprechblasen-
    // Overlay/Theater-Layout, aber immerhin funktional). Für Provider ohne
    // eigenes <video>-Element (Spotify/YouTube/TikTok/Instagram-Iframes)
    // gibt es dort keinen sinnvollen Fallback.
    function elementFullscreenSupported() {
      return !!(playerWrap.requestFullscreen || playerWrap.webkitRequestFullscreen || playerWrap.mozRequestFullScreen);
    }
    function iosVideoFullscreenSupported() {
      return ardIsActive() && typeof video?.webkitEnterFullscreen === 'function';
    }
    function requestPlayerFullscreen() {
      const req = playerWrap.requestFullscreen || playerWrap.webkitRequestFullscreen || playerWrap.mozRequestFullScreen;
      if (req) {
        req.call(playerWrap);
        return;
      }
      if (iosVideoFullscreenSupported()) {
        video.webkitEnterFullscreen();
      }
    }
    function exitFullscreen() {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
      exit?.call(document);
    }
    fullscreenBtn?.addEventListener('click', () => {
      if (getFullscreenElement()) exitFullscreen();
      else requestPlayerFullscreen();
    });

    // ---------- Jump-to-Timecode + Nächster Kommentar ----------

    function jumpToTimecode() {
      const seconds = parseTimecode(jumpInput.value);
      if (seconds === null || Number.isNaN(seconds)) return;
      seekCurrentTo(Math.max(0, seconds));
    }
    jumpBtn?.addEventListener('click', jumpToTimecode);
    jumpInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        jumpToTimecode();
      }
    });

    // Deaktiviert den Button, solange ein Sprungziel aussteht (siehe
    // nextCommentPendingTarget) – reflektiert damit, dass ein erneuter Klick
    // gerade nichts Sichtbares bewirken würde.
    function updateNextCommentBtnDisabled() {
      if (nextCommentBtn) nextCommentBtn.disabled = nextCommentPendingTarget !== null;
    }

    function jumpToNextComment() {
      const currentItem = playlist[currentIndex];
      if (!currentItem) return;
      const current = currentPositionSec;
      const next = comments
        .filter((c) => c.parent_id === null && c.item_id === currentItem.id && c.timecode_sec != null && c.timecode_sec > current + 0.05)
        .sort((a, b) => a.timecode_sec - b.timecode_sec)[0];
      if (!next) return;
      nextCommentPendingTarget = next.timecode_sec;
      updateNextCommentBtnDisabled();
      seekCurrentTo(Math.max(0, next.timecode_sec - 5));
    }
    nextCommentBtn?.addEventListener('click', jumpToNextComment);

    // ---------- Kommentar-Trigger (Sprechblase im Vollbild, sonst Scroll+Highlight) ----------

    function checkCommentTriggers() {
      const currentItem = playlist[currentIndex];
      if (!currentItem || currentItem.provider === 'instagram') return;
      const current = currentPositionSec;
      // Sobald die Zielstelle des letzten "Nächster Kommentar"-Sprungs
      // erreicht ist, den Button wieder freigeben (siehe jumpToNextComment).
      if (nextCommentPendingTarget !== null && current >= nextCommentPendingTarget - 0.05) {
        nextCommentPendingTarget = null;
        updateNextCommentBtnDisabled();
      }
      if (current < lastCheckedPos) {
        lastCheckedPos = Math.max(-0.001, current - 0.25);
        return;
      }
      const windowStart = Math.max(lastCheckedPos, current - 1.5);
      comments
        .filter(
          (c) =>
            c.parent_id === null &&
            c.item_id === currentItem.id &&
            c.timecode_sec != null &&
            c.timecode_sec > windowStart &&
            c.timecode_sec <= current
        )
        .forEach((c) => triggerTimecodeComment(c));
      lastCheckedPos = current;
    }

    function triggerTimecodeComment(c) {
      if (getFullscreenElement()) showCommentBubble(c);
      else scrollAndHighlightComment(c);
    }

    function showCommentBubble(c) {
      if (!bubbleOverlay) return;
      const color = resolveAuthorColor(c);
      const bubble = document.createElement('div');
      bubble.className = 'comment-bubble';
      bubble.style.setProperty('--bubble-color', color);
      bubble.innerHTML = `
        <span class="comment-bubble-author" style="color: ${color}"></span>
        <span class="comment-bubble-body"></span>
        <button type="button" class="link-btn comment-bubble-reply-btn">Antworten</button>
      `;
      bubble.querySelector('.comment-bubble-author').textContent = c.author_name;
      bubble.querySelector('.comment-bubble-body').textContent = truncateForBubble(c.body);
      bubble.querySelector('.comment-bubble-reply-btn').addEventListener('click', () => startFsReply(c));
      bubbleOverlay.appendChild(bubble);

      requestAnimationFrame(() => bubble.classList.add('show'));
      setTimeout(() => {
        bubble.classList.remove('show');
        bubble.classList.add('hide');
        setTimeout(() => bubble.remove(), 400);
      }, 6000);
    }

    function scrollAndHighlightComment(c) {
      const el = commentList.querySelector(`.comment[data-id="${c.id}"]`);
      if (!el) return;
      const replyForm = el.querySelector(':scope > .reply-form');
      const editForm = el.querySelector(':scope > .edit-form');
      const busy =
        (replyForm && !replyForm.classList.contains('hidden')) || (editForm && !editForm.classList.contains('hidden'));
      if (busy) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.setProperty('--highlight-color', resolveAuthorColor(c));
      el.classList.add('timecode-highlight');
      setTimeout(() => el.classList.remove('timecode-highlight'), 6000);
    }

    // ---------- Marker-Leiste ----------

    function renderMarkers() {
      markerBar.innerHTML = '';
      const currentItem = playlist[currentIndex];
      if (!currentItem || currentItem.provider === 'instagram') return;
      const duration = currentDurationSec;
      if (!duration || !isFinite(duration) || duration <= 0) return;

      comments
        .filter((c) => c.parent_id === null && c.item_id === currentItem.id && c.timecode_sec != null)
        .forEach((c) => {
          const marker = document.createElement('button');
          marker.type = 'button';
          marker.className = 'marker';
          marker.style.left = (c.timecode_sec / duration) * 100 + '%';
          marker.style.background = resolveAuthorColor(c);
          marker.title = `${formatTime(c.timecode_sec)} – ${c.author_name}: ${c.body}`;
          marker.addEventListener('click', () => seekCurrentTo(c.timecode_sec));
          markerBar.appendChild(marker);
        });
    }

    // ---------- Playlist rendern ----------

    function highlightCurrentPlaylistItem() {
      playlistListEl.querySelectorAll('.playlist-item').forEach((el) => {
        el.classList.toggle('active', Number(el.dataset.index) === currentIndex);
      });
    }

    function highlightActiveItemComments() {
      const currentItem = playlist[currentIndex];
      const activeItemId = currentItem ? currentItem.id : null;
      // Die Umrandung soll erst ab drei Playlist-Items greifen – bei ein oder
      // zwei Items ist ohnehin klar, welche Kommentare zum aktiven Item
      // gehören (bzw. gibt es noch keine wirkliche Gruppierung), da wirkt der
      // Rahmen nur wie unnötiges Rauschen.
      const enoughItems = playlist.length >= 3;
      commentList.querySelectorAll('.comment[data-id]').forEach((el) => {
        const c = comments.find((cm) => String(cm.id) === el.dataset.id);
        const isActive = enoughItems && activeItemId != null && !!c && c.item_id === activeItemId;
        el.classList.toggle('active-item-comment', isActive);
      });
    }

    function renderPlaylist() {
      playlistListEl.innerHTML = '';
      if (playlist.length === 0) {
        playlistListEl.innerHTML = '<p class="empty-state">Noch keine Playlist-Einträge – füge oben eine Quelle hinzu.</p>';
        return;
      }
      // Zuletzt hinzugefügte Items zuerst anzeigen (neue Items landen am Ende
      // von `playlist`, siehe insertPlaylistItems in server.js) – daher hier
      // rückwärts iterieren. currentIndex/Wiedergabereihenfolge bleiben davon
      // unberührt, da row.dataset.index weiterhin den echten Array-Index trägt.
      for (let index = playlist.length - 1; index >= 0; index--) {
        const item = playlist[index];
        const row = document.createElement('div');
        row.className = 'playlist-item' + (index === currentIndex ? ' active' : '');
        row.dataset.index = String(index);
        row.innerHTML = `
          ${
            item.thumbnail_url
              ? `<img class="playlist-item-thumb" src="${item.thumbnail_url}" alt="">`
              : '<span class="playlist-item-thumb playlist-item-thumb-placeholder"></span>'
          }
          <span class="playlist-item-meta">
            <span class="playlist-item-title"></span>
            <span class="playlist-item-artist"></span>
          </span>
          ${
            item.provider === 'spotify'
              ? `<a class="playlist-item-provider playlist-item-provider-link" href="${spotifyOpenUrl(item)}" target="_blank" rel="noopener noreferrer" title="In Spotify öffnen" aria-label="In Spotify öffnen">${playlistItemIcon(item.provider)}</a>`
              : `<span class="playlist-item-provider">${playlistItemIcon(item.provider)}</span>`
          }
          <button type="button" class="playlist-item-remove" aria-label="Entfernen" title="Entfernen">×</button>
        `;
        row.querySelector('.playlist-item-title').textContent = item.title;
        row.querySelector('.playlist-item-artist').textContent = item.artist_or_channel || '';
        row.addEventListener('click', (e) => {
          if (e.target.closest('.playlist-item-remove') || e.target.closest('.playlist-item-provider-link')) return;
          loadItemIntoPlayer(index, true);
        });
        row.querySelector('.playlist-item-remove')?.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('Dieses Item aus der Playlist entfernen?')) return;
          try {
            await apiFetch(`api/items/${item.id}`, { method: 'DELETE', headers: accessHeaders() });
            await loadItems();
          } catch (err) {
            alert('Entfernen fehlgeschlagen: ' + err.message);
          }
        });
        playlistListEl.appendChild(row);
      }
    }

    // ---------- Item hinzufügen ----------

    addItemForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = addItemInput.value.trim();
      if (!value) return;
      addItemStatus.classList.remove('hidden');
      addItemStatus.classList.remove('error-text');
      addItemStatus.textContent = 'Löse Quelle auf …';
      try {
        let payload;
        if (isYouTubeInput(value)) {
          const items = await resolveYouTubeToItems(value);
          payload = { items };
        } else {
          payload = { url: value };
        }
        await apiFetch(`api/streams/${streamId}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...accessHeaders() },
          body: JSON.stringify(payload),
        });
        addItemInput.value = '';
        addItemStatus.textContent = 'Hinzugefügt ✓';
        await loadItems();
        setTimeout(() => addItemStatus.classList.add('hidden'), 2000);
      } catch (err) {
        addItemStatus.textContent = err.message;
        addItemStatus.classList.add('error-text');
      }
    });

    // ---------- Medien-Links in einem Kommentar -> automatisch zur Playlist ----------

    async function ensureLinkAddedToPlaylist(body) {
      const links = findMediaLinksInText(body);
      if (!links.length) return;
      let added = false;
      for (const link of links) {
        if (findPlaylistItemForLink(link, playlist)) continue;
        try {
          let payload;
          if (link.provider === 'youtube') {
            const items = await resolveYouTubeToItems(link.url);
            payload = { items };
          } else {
            payload = { url: link.url };
          }
          await apiFetch(`api/streams/${streamId}/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...accessHeaders() },
            body: JSON.stringify(payload),
          });
          added = true;
        } catch (err) {
          console.warn('Automatisches Hinzufügen zur Playlist fehlgeschlagen:', err);
        }
      }
      if (added) await loadItems();
    }

    function playPlaylistItemById(itemId) {
      const idx = playlist.findIndex((it) => it.id === itemId);
      if (idx === -1) return;
      loadItemIntoPlayer(idx, true);
    }

    commentList.addEventListener('click', (e) => {
      const link = e.target.closest('.playlist-item-link');
      if (!link) return;
      e.preventDefault();
      playPlaylistItemById(Number(link.dataset.itemId));
    });

    // ---------- Kommentar an aktueller Stelle ----------

    async function postComment(payload) {
      return await apiFetch(`api/streams/${streamId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...accessHeaders() },
        body: JSON.stringify(payload),
      });
    }

    // ---------- Optimistic UI für neue Kommentare/Antworten ----------
    //
    // Statt auf die Server-Antwort (+ vollen Reload der Kommentarliste) zu
    // warten, wird der Kommentar sofort mit einer negativen Temp-ID lokal
    // eingefügt und gerendert – bei langsamer Verbindung fühlt sich das
    // Absenden dadurch sofort an. Antwortet der Server, wird der Platzhalter
    // durch die echte Zeile ersetzt (reconcileOptimisticComment); schlägt der
    // Request fehl, wird er wieder entfernt (discardOptimisticComment) und
    // der Fehler an die aufrufende Stelle weitergereicht (dort landet er im
    // bereits vorhandenen Fehler-UI, z. B. commentErrorEl).
    let nextTempCommentId = -1;

    function createOptimisticComment(payload) {
      const tempId = nextTempCommentId--;
      comments.push({
        id: tempId,
        stream_id: streamId,
        parent_id: payload.parent_id ?? null,
        timecode_sec: payload.timecode_sec ?? null,
        item_id: payload.item_id ?? null,
        author_name: payload.author_name,
        author_color: payload.author_color ?? null,
        body: payload.body,
        image: payload.image ?? null,
        created_at: Date.now(),
        updated_at: null,
        reactions: [],
        pending: true,
      });
      renderComments();
      renderMarkers();
      return tempId;
    }

    function reconcileOptimisticComment(tempId, serverComment) {
      const idx = comments.findIndex((c) => c.id === tempId);
      const merged = { ...serverComment, reactions: serverComment.reactions || [] };
      if (idx !== -1) comments.splice(idx, 1, merged);
      else comments.push(merged);
      renderComments();
      renderMarkers();
    }

    function discardOptimisticComment(tempId) {
      const idx = comments.findIndex((c) => c.id === tempId);
      if (idx !== -1) comments.splice(idx, 1);
      renderComments();
      renderMarkers();
    }

    async function createTopLevelComment(timecodeSec, body, image) {
      const item = playlist[currentIndex];
      if (!item) throw new Error('Bitte zuerst eine Quelle zur Playlist hinzufügen');
      await ensureLinkAddedToPlaylist(body);
      const timecode = item.provider === 'instagram' ? null : timecodeSec;
      const payload = {
        author_name: authorName,
        author_color: authorColorChoice || null,
        body,
        image: image || null,
        timecode_sec: timecode,
        item_id: item.id,
      };
      const tempId = createOptimisticComment(payload);
      try {
        const created = await postComment(payload);
        reconcileOptimisticComment(tempId, created);
        if (timecode != null) {
          lastCheckedPos = Math.min(lastCheckedPos, Math.max(0, timecode - 0.05));
        }
      } catch (err) {
        discardOptimisticComment(tempId);
        throw err;
      }
    }

    commentHereBtn.addEventListener('click', () => {
      if (!authorName) {
        openNameModal();
        return;
      }
      const item = playlist[currentIndex];
      if (!item) {
        commentErrorEl.textContent = 'Bitte zuerst eine Quelle zur Playlist hinzufügen.';
        commentErrorEl.classList.remove('hidden');
        return;
      }
      pauseCurrent();
      const isInstagram = item.provider === 'instagram';
      commentTimecodeField.classList.toggle('hidden', isInstagram);
      commentTimecodeInput.required = !isInstagram;
      commentTimecodeInput.value = isInstagram ? '' : currentPositionSec.toFixed(1);
      commentForm.classList.remove('hidden');
      commentBodyInput.focus();
    });

    submitOnCtrlEnter(commentBodyInput, commentForm);

    // ---------- Emoji-Button + Flyout im Kommentarfeld ----------

    const EMOJI_LIST = [
      '😀', '😂', '🥲', '😅', '😊', '😍', '🤔', '😮',
      '😢', '😭', '😡', '🥳', '😴', '🙄', '😱', '🤯',
      '👍', '👎', '👏', '🙌', '🙏', '💪', '👀', '✌️',
      '❤️', '🔥', '✨', '🎉', '💯', '⭐', '✅', '❌',
    ];

    let emojiFlyoutBuilt = false;

    function buildEmojiFlyout() {
      if (emojiFlyoutBuilt || !emojiFlyout) return;
      emojiFlyoutBuilt = true;
      EMOJI_LIST.forEach((emoji) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'emoji-flyout-option';
        btn.textContent = emoji;
        btn.setAttribute('role', 'menuitem');
        btn.addEventListener('click', () => {
          insertAtCursor(commentBodyInput, emoji);
          closeEmojiFlyout();
          commentBodyInput.focus();
        });
        emojiFlyout.appendChild(btn);
      });
    }

    function insertAtCursor(textarea, text) {
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;
      textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
      const newPos = start + text.length;
      textarea.setSelectionRange(newPos, newPos);
    }

    // Klappt ein rechts-verankertes Popover (Emoji-Flyout, Reaction-Picker)
    // nach links um, falls es sonst über den rechten Viewport-Rand
    // hinausragen würde – v. a. relevant auf schmalen Mobile-Screens, wenn
    // der auslösende Button nah am rechten Rand einer umgebrochenen Zeile
    // sitzt. Muss NACH dem Sichtbarmachen aufgerufen werden (unsichtbare
    // Elemente haben keine sinnvolle Bounding-Box).
    function keepPopoverInViewport(el) {
      el.classList.remove('align-right');
      const rect = el.getBoundingClientRect();
      if (rect.right > window.innerWidth - 4) {
        el.classList.add('align-right');
      }
    }

    function openEmojiFlyout() {
      buildEmojiFlyout();
      emojiFlyout.classList.remove('hidden');
      emojiBtn.setAttribute('aria-expanded', 'true');
    }

    function closeEmojiFlyout() {
      emojiFlyout?.classList.add('hidden');
      emojiBtn?.setAttribute('aria-expanded', 'false');
    }

    emojiBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (emojiFlyout.classList.contains('hidden')) openEmojiFlyout();
      else closeEmojiFlyout();
    });

    document.addEventListener('click', (e) => {
      if (!emojiFlyout || emojiFlyout.classList.contains('hidden')) return;
      if (e.target === emojiBtn || emojiFlyout.contains(e.target)) return;
      closeEmojiFlyout();
    });

    // Einmaliger, delegierter Listener statt eines neuen document-Listeners
    // pro Kommentar/Reaction-Picker (siehe buildReactionsRow) – verhindert,
    // dass sich bei jedem Re-Render (Polling alle 10s) Listener anhäufen.
    document.addEventListener('click', (e) => {
      document.querySelectorAll('.reaction-picker:not(.hidden)').forEach((picker) => {
        const wrap = picker.closest('.reaction-add-wrap');
        if (wrap && wrap.contains(e.target)) return;
        picker.classList.add('hidden');
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeEmojiFlyout();
    });

    commentCancelBtn.addEventListener('click', () => {
      commentForm.classList.add('hidden');
      commentForm.reset();
      commentImageAttach.reset(null);
      commentErrorEl.classList.add('hidden');
      closeEmojiFlyout();
    });

    commentForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      commentErrorEl.classList.add('hidden');
      if (!authorName) {
        openNameModal();
        return;
      }
      const item = playlist[currentIndex];
      if (!item) return;
      const body = commentBodyInput.value.trim();
      const image = commentImageAttach.getValue();
      if (!body && !image) {
        commentErrorEl.textContent = 'Bitte Text eingeben oder ein Bild anhängen.';
        commentErrorEl.classList.remove('hidden');
        return;
      }
      const timecode_sec = item.provider === 'instagram' ? null : parseFloat(commentTimecodeInput.value);
      try {
        await createTopLevelComment(timecode_sec, body, image);
        commentForm.classList.add('hidden');
        commentForm.reset();
        commentImageAttach.reset(null);
        closeEmojiFlyout();
      } catch (err) {
        commentErrorEl.textContent = err.message;
        commentErrorEl.classList.remove('hidden');
      }
    });

    // ---------- Fullscreen-Kommentarleiste ----------

    let fsPendingTimecode = null;
    let fsReplyTarget = null;

    fsCommentInput?.addEventListener('focus', () => {
      if (!authorName) {
        openNameModal();
        return;
      }
      fsPendingTimecode = currentPositionSec;
    });

    function startFsReply(c) {
      if (!authorName) {
        openNameModal();
        return;
      }
      fsReplyTarget = { id: c.id, authorName: c.author_name };
      if (fsReplyAuthorEl) fsReplyAuthorEl.textContent = c.author_name;
      fsReplyBadge?.classList.remove('hidden');
      if (fsCommentInput) fsCommentInput.placeholder = 'Antwort schreiben …';
      fsCommentInput?.focus();
    }

    function cancelFsReply() {
      fsReplyTarget = null;
      fsReplyBadge?.classList.add('hidden');
      if (fsCommentInput) fsCommentInput.placeholder = 'Kommentar an aktueller Stelle …';
    }
    fsReplyCancelBtn?.addEventListener('click', cancelFsReply);

    async function submitFsComment() {
      if (!fsCommentInput) return;
      if (!authorName) {
        openNameModal();
        return;
      }
      const body = fsCommentInput.value.trim();
      if (!body) return;
      try {
        if (fsReplyTarget) {
          await ensureLinkAddedToPlaylist(body);
          const payload = { parent_id: fsReplyTarget.id, author_name: authorName, author_color: authorColorChoice || null, body };
          cancelFsReply();
          const tempId = createOptimisticComment(payload);
          try {
            const created = await postComment(payload);
            reconcileOptimisticComment(tempId, created);
          } catch (err) {
            discardOptimisticComment(tempId);
            throw err;
          }
        } else {
          const timecodeSec = fsPendingTimecode !== null ? fsPendingTimecode : currentPositionSec;
          await createTopLevelComment(timecodeSec, body);
        }
        fsCommentInput.value = '';
        fsPendingTimecode = null;
      } catch (err) {
        alert('Kommentar konnte nicht gesendet werden: ' + err.message);
      }
    }
    fsCommentSubmitBtn?.addEventListener('click', submitFsComment);
    fsCommentInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitFsComment();
      }
    });

    // ---------- Kommentare laden/rendern ----------

    async function loadComments() {
      try {
        const data = await apiFetch(
          `api/streams/${streamId}/comments${authorName ? `?author_name=${encodeURIComponent(authorName)}` : ''}`,
          { headers: accessHeaders() }
        );
        comments = data;
        renderComments();
        renderMarkers();
      } catch (err) {
        console.error('Kommentare konnten nicht geladen werden:', err);
      }
    }

    // ---------- Einmalige Migration: alte, lokal (localStorage) gespeicherte
    // Gelesen-Markierungen an den Server übertragen ----------
    //
    // Bis zu diesem Update lag der Gelesen-Status rein im Browser
    // (READ_COMMENTS_KEY). Damit dieser Stand nicht verloren geht, wird er
    // beim ersten Aufruf mit gesetztem Anzeigenamen einmalig an den Server
    // übertragen (POST .../comments/read-bulk) und der localStorage-Eintrag
    // danach gelöscht. Ohne Anzeigenamen ist keine Zuordnung möglich, daher
    // in dem Fall kein Vorgang.
    async function migrateLegacyLocalReadStatus() {
      if (!authorName) return;
      let map;
      try {
        map = JSON.parse(localStorage.getItem(READ_COMMENTS_KEY) || '{}');
      } catch {
        map = {};
      }
      const commentIds = Object.keys(map)
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id));
      if (commentIds.length === 0) {
        localStorage.removeItem(READ_COMMENTS_KEY);
        return;
      }
      try {
        await apiFetch(`api/streams/${streamId}/comments/read-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...accessHeaders() },
          body: JSON.stringify({ author_name: authorName, comment_ids: commentIds }),
        });
        localStorage.removeItem(READ_COMMENTS_KEY);
        await loadComments();
      } catch (err) {
        // Bei Fehlschlag bleibt der localStorage-Eintrag erhalten, damit der
        // nächste Aufruf es erneut versuchen kann.
        console.error('Migration alter Gelesen-Markierungen fehlgeschlagen:', err);
      }
    }

    function itemLabel(itemId) {
      const item = playlist.find((it) => it.id === itemId);
      return item ? item.title : '(gelöschtes Item)';
    }

    async function submitMixReply(parentId, body, formEl, image) {
      await ensureLinkAddedToPlaylist(body);
      const payload = {
        parent_id: parentId,
        author_name: authorName,
        author_color: authorColorChoice || null,
        body,
        image: image || null,
      };
      // Formular VOR dem optimistischen Rendern schließen: renderComments()
      // überspringt sich selbst, solange irgendein Antwort-/Bearbeiten-
      // Formular offen ist (siehe dortiger Kommentar), sonst bliebe die neue
      // Antwort erst nach dem Schließen sichtbar.
      formEl.reset();
      formEl.classList.add('hidden');
      const tempId = createOptimisticComment(payload);
      try {
        const created = await postComment(payload);
        reconcileOptimisticComment(tempId, created);
      } catch (err) {
        discardOptimisticComment(tempId);
        throw err;
      }
    }

    async function submitMixEdit(commentId, body, image, onSaved) {
      await ensureLinkAddedToPlaylist(body);
      const comment = comments.find((c) => c.id === commentId);
      const previous = comment ? { body: comment.body, image: comment.image, updated_at: comment.updated_at } : null;
      // Formular VOR dem optimistischen Rendern schließen (siehe submitMixReply).
      onSaved?.();
      if (comment) {
        comment.body = body;
        comment.image = image || null;
        comment.updated_at = Date.now();
        renderComments();
      }
      try {
        const updated = await apiFetch(`api/comments/${commentId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body, image: image || null, author_name: authorName }),
        });
        if (comment) {
          Object.assign(comment, updated);
          renderComments();
        }
      } catch (err) {
        if (comment && previous) {
          comment.body = previous.body;
          comment.image = previous.image;
          comment.updated_at = previous.updated_at;
          renderComments();
        }
        throw err;
      }
    }

    // ---------- Reaction-Emojis auf Kommentare/Antworten ----------
    // Feste Auswahl analog zu server.js REACTION_EMOJI_LIST – bewusst kein
    // freier Emoji-Picker, um die Liste klein und synchron mit dem Server zu
    // halten (der Server lehnt alles außerhalb dieser Liste ab).
    const REACTION_EMOJI_LIST = [
      '👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '👎',
      '😭', '😥', '💪', '🔥', '🙈', '😅', '🤷‍♂️', '👷', '😍', '🙄', '💯',
    ];

    // Ersetzt nur die Reactions-Zeile des betroffenen Kommentars/der Antwort
    // im DOM, statt die komplette Liste neu zu rendern (siehe toggleReaction)
    // – Reactions werden potenziell häufig/schnell hintereinander geklickt,
    // ein voller renderComments()-Durchlauf würde dabei u. a. offene
    // Reaction-Picker anderer Kommentare schließen und den Scroll-Zustand
    // stören.
    function refreshReactionsUI(comment) {
      const el = commentList.querySelector(`[data-id="${comment.id}"]`);
      if (!el) return;
      const oldRow = el.querySelector(':scope > .reactions-row');
      const newRow = buildReactionsRow(comment);
      if (oldRow) oldRow.replaceWith(newRow);
      else el.appendChild(newRow);
    }

    async function toggleReaction(commentId, emoji) {
      if (!authorName) {
        openNameModal();
        return;
      }
      const comment = comments.find((c) => c.id === commentId);
      if (!comment) return;
      comment.reactions = comment.reactions || [];
      const existingIdx = comment.reactions.findIndex((r) => r.emoji === emoji && r.author_name === authorName);
      const hadReaction = existingIdx !== -1;
      // Optimistisches Update: sofort lokal umschalten und rendern, danach
      // erst den Server-Request abschicken.
      if (hadReaction) comment.reactions.splice(existingIdx, 1);
      else comment.reactions.push({ emoji, author_name: authorName });
      refreshReactionsUI(comment);
      try {
        const res = await apiFetch(`api/comments/${commentId}/reactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji, author_name: authorName }),
        });
        comment.reactions = res.reactions || comment.reactions;
        refreshReactionsUI(comment);
      } catch (err) {
        // Rollback bei Fehlschlag
        if (hadReaction) comment.reactions.push({ emoji, author_name: authorName });
        else {
          const idx = comment.reactions.findIndex((r) => r.emoji === emoji && r.author_name === authorName);
          if (idx !== -1) comment.reactions.splice(idx, 1);
        }
        refreshReactionsUI(comment);
        alert('Reaction konnte nicht gesetzt werden: ' + err.message);
      }
    }

    // Baut die Reaction-Zeile (bestehende Pills + "+"-Button zum Hinzufügen)
    // für einen Kommentar/eine Antwort. `comment.reactions` ist eine flache
    // Liste { emoji, author_name } vom Server – Zählung und "habe ich selbst
    // reagiert" werden hier clientseitig aggregiert.
    function buildReactionsRow(comment) {
      const row = document.createElement('div');
      row.className = 'reactions-row';

      const byEmoji = new Map();
      (comment.reactions || []).forEach((r) => {
        if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
        byEmoji.get(r.emoji).push(r.author_name);
      });

      byEmoji.forEach((authors, emoji) => {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'reaction-pill';
        const mine = !!authorName && authors.includes(authorName);
        if (mine) pill.classList.add('mine');
        pill.title = authors.join(', ');
        pill.innerHTML = `<span class="reaction-emoji"></span><span class="reaction-count"></span>`;
        pill.querySelector('.reaction-emoji').textContent = emoji;
        pill.querySelector('.reaction-count').textContent = String(authors.length);
        pill.addEventListener('click', () => toggleReaction(comment.id, emoji));
        row.appendChild(pill);
      });

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'reaction-add-btn';
      addBtn.title = 'Reaction hinzufügen';
      addBtn.textContent = '😊+';
      const picker = document.createElement('div');
      picker.className = 'reaction-picker hidden';
      REACTION_EMOJI_LIST.forEach((emoji) => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'reaction-picker-option';
        opt.textContent = emoji;
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          picker.classList.add('hidden');
          toggleReaction(comment.id, emoji);
        });
        picker.appendChild(opt);
      });
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.reaction-picker').forEach((p) => {
          if (p !== picker) p.classList.add('hidden');
        });
        const wasHidden = picker.classList.contains('hidden');
        picker.classList.toggle('hidden');
        if (wasHidden) keepPopoverInViewport(picker);
      });

      const addWrap = document.createElement('div');
      addWrap.className = 'reaction-add-wrap';
      addWrap.appendChild(addBtn);
      addWrap.appendChild(picker);
      row.appendChild(addWrap);

      return row;
    }

    async function deleteMixComment(id) {
      if (!confirm('Diesen Kommentar wirklich löschen?')) return;
      // Antworten hängen serverseitig per ON DELETE CASCADE am Elternkommentar
      // (siehe server.js) – beim optimistischen Entfernen daher genauso
      // mitnehmen, damit der Client-Stand konsistent bleibt.
      const removed = comments.filter((c) => c.id === id || c.parent_id === id);
      if (removed.length > 0) {
        comments = comments.filter((c) => c.id !== id && c.parent_id !== id);
        renderComments();
        renderMarkers();
      }
      try {
        await apiFetch(`api/comments/${id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', ...adminHeaders() },
          body: JSON.stringify({ author_name: authorName }),
        });
      } catch (err) {
        comments.push(...removed);
        renderComments();
        renderMarkers();
        alert('Löschen fehlgeschlagen: ' + err.message);
      }
    }

    function buildMixEditForm(commentId, getBody, getImage, el) {
      const form = document.createElement('form');
      form.className = 'edit-form hidden';
      form.innerHTML = `
        <textarea class="edit-body" maxlength="2000" rows="3"></textarea>
        <div class="edit-image-attach"></div>
        <div class="form-actions">
          <button type="submit">Speichern</button>
          <button type="button" class="secondary edit-cancel-btn">Abbrechen</button>
        </div>
      `;
      const textarea = form.querySelector('.edit-body');
      const bodyEl = el.querySelector(':scope > .comment-body');
      const imageAttach = buildImageAttach(null);
      form.querySelector('.edit-image-attach').appendChild(imageAttach.element);
      wirePasteImage(textarea, imageAttach);
      submitOnCtrlEnter(textarea, form);
      wireMentionAutocomplete(textarea, () => playlist);

      function openEdit() {
        textarea.value = getBody();
        imageAttach.reset(getImage());
        bodyEl.classList.add('hidden');
        form.classList.remove('hidden');
        textarea.focus();
      }
      function closeEdit() {
        form.classList.add('hidden');
        bodyEl.classList.remove('hidden');
      }

      form.querySelector('.edit-cancel-btn').addEventListener('click', closeEdit);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newBody = textarea.value.trim();
        const newImage = imageAttach.getValue();
        if (!newBody && !newImage) return;
        try {
          await submitMixEdit(commentId, newBody, newImage, closeEdit);
        } catch (err) {
          if (err.status === 403) {
            closeEdit();
            el.querySelector(':scope > .comment-head > .edit-toggle')?.remove();
            el.querySelector(':scope > .comment-head > .delete-btn')?.remove();
            form.remove();
            alert(
              'Dieser Kommentar lässt sich mit dem aktuellen Anzeigenamen nicht mehr ' +
                'bearbeiten (Name stimmt nicht mehr mit dem des Kommentars überein).'
            );
          } else {
            alert('Bearbeiten fehlgeschlagen: ' + err.message);
          }
        }
      });

      return { form, openEdit };
    }

    function buildMixReplyElement(r) {
      const el = document.createElement('div');
      el.className = 'reply';
      el.dataset.id = String(r.id);
      // Optimistisch eingefügter, noch nicht vom Server bestätigter Platzhalter
      // (siehe createOptimisticComment) – abgeblendet, Aktionen gesperrt, bis
      // die echte ID da ist.
      if (r.pending) el.classList.add('is-pending');
      const canEdit = isOwnComment(r, authorName);
      const canDelete = !!adminToken || canEdit;
      const color = resolveAuthorColor(r);
      el.style.borderLeftColor = color;
      el.innerHTML = `
        <div class="comment-head">
          <span class="author" style="color: ${color}">${escapeHtml(r.author_name)}</span>
          <span class="date" title="${formatDateOnly(r.created_at)}">${formatCommentTime(r.created_at)}</span>
          ${canEdit ? '<button type="button" class="link-btn edit-toggle">bearbeiten</button>' : ''}
          ${canDelete ? '<button type="button" class="link-btn danger delete-btn">löschen</button>' : ''}
        </div>
        <div class="comment-body">${linkifyWithPlaylistRefs(escapeHtml(r.body), playlist)}</div>
        ${r.image ? '<div class="comment-image-wrap"><img class="comment-image" alt="Bild im Kommentar"></div>' : ''}
      `;
      if (r.image) {
        const imgEl = el.querySelector(':scope > .comment-image-wrap > .comment-image');
        imgEl.src = r.image;
        imgEl.addEventListener('click', () => openImageLightbox(r.image));
      }
      el.querySelector('.delete-btn')?.addEventListener('click', () => deleteMixComment(r.id));
      el.querySelector('.comment-head').appendChild(buildReadToggleButton(r, el, authorName, onReadToggled));
      el.appendChild(buildReactionsRow(r));
      if (canEdit) {
        const { form, openEdit } = buildMixEditForm(r.id, () => r.body, () => r.image, el);
        el.appendChild(form);
        el.querySelector('.edit-toggle').addEventListener('click', openEdit);
      }
      return el;
    }

    function buildMixCommentElement(c) {
      const item = document.createElement('div');
      item.className = 'comment';
      item.dataset.id = String(c.id);
      if (c.pending) item.classList.add('is-pending');
      const canEdit = isOwnComment(c, authorName);
      const canDelete = !!adminToken || canEdit;
      const color = resolveAuthorColor(c);
      item.style.borderLeftColor = color;
      item.innerHTML = `
        <div class="comment-head">
          <button type="button" class="timecode-link"></button>
          <span class="author" style="color: ${color}">${escapeHtml(c.author_name)}</span>
          <span class="date" title="${formatDateOnly(c.created_at)}">${formatCommentTime(c.created_at)}</span>
          ${canEdit ? '<button type="button" class="link-btn edit-toggle">bearbeiten</button>' : ''}
          ${canDelete ? '<button type="button" class="link-btn danger delete-btn">löschen</button>' : ''}
        </div>
        <div class="comment-body">${linkifyWithPlaylistRefs(escapeHtml(c.body), playlist)}</div>
        ${c.image ? '<div class="comment-image-wrap"><img class="comment-image" alt="Bild im Kommentar"></div>' : ''}
        <div class="replies"></div>
        <button type="button" class="link-btn reply-toggle">Antworten</button>
        <form class="reply-form hidden">
          <textarea class="reply-body" maxlength="2000" rows="2" placeholder="Antwort …"></textarea>
          <div class="reply-image-attach"></div>
          <button type="submit">Senden</button>
        </form>
      `;
      if (c.image) {
        const imgEl = item.querySelector(':scope > .comment-image-wrap > .comment-image');
        imgEl.src = c.image;
        imgEl.addEventListener('click', () => openImageLightbox(c.image));
      }
      item.querySelector('.replies').insertAdjacentElement('beforebegin', buildReactionsRow(c));

      // Der Item-Kontext steht bereits in der Gruppenüberschrift (siehe
      // renderComments) – hier deshalb nur noch der Zeitpunkt, wenn die
      // Playlist mehr als ein Item hat; bei genau einem Item (z. B. der
      // Regelfall bei einer reinen ARD-Session) zeigt der Badge weiterhin
      // Item + Zeit gemeinsam, da dort keine Gruppenüberschrift erscheint.
      const showItemLabel = playlist.length <= 1;
      item.querySelector('.timecode-link').textContent =
        c.timecode_sec == null
          ? showItemLabel
            ? itemLabel(c.item_id)
            : '💬'
          : showItemLabel
          ? `${itemLabel(c.item_id)} · ${formatPos(c.timecode_sec)}`
          : formatPos(c.timecode_sec);
      item.querySelector('.timecode-link').addEventListener('click', () => {
        const idx = playlist.findIndex((it) => it.id === c.item_id);
        if (idx === -1) return;
        if (c.timecode_sec == null) {
          if (idx !== currentIndex) loadItemIntoPlayer(idx, true);
          return;
        }
        if (idx === currentIndex) seekCurrentTo(c.timecode_sec);
        else loadItemIntoPlayer(idx, true, c.timecode_sec);
      });

      item.querySelector('.delete-btn')?.addEventListener('click', () => deleteMixComment(c.id));
      item.querySelector('.comment-head').appendChild(buildReadToggleButton(c, item, authorName, onReadToggled));

      if (canEdit) {
        const { form, openEdit } = buildMixEditForm(c.id, () => c.body, () => c.image, item);
        item.querySelector('.replies').insertAdjacentElement('beforebegin', form);
        item.querySelector('.edit-toggle').addEventListener('click', openEdit);
      }

      const replyToggle = item.querySelector('.reply-toggle');
      const replyForm = item.querySelector('.reply-form');
      const replyImageAttach = buildImageAttach(null);
      replyForm.querySelector('.reply-image-attach').appendChild(replyImageAttach.element);
      wirePasteImage(replyForm.querySelector('.reply-body'), replyImageAttach);
      submitOnCtrlEnter(replyForm.querySelector('.reply-body'), replyForm);
      wireMentionAutocomplete(replyForm.querySelector('.reply-body'), () => playlist);

      replyToggle.addEventListener('click', () => {
        if (!authorName) {
          openNameModal();
          return;
        }
        replyForm.classList.toggle('hidden');
        if (!replyForm.classList.contains('hidden')) replyForm.querySelector('.reply-body').focus();
      });

      replyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!authorName) {
          openNameModal();
          return;
        }
        const bodyField = replyForm.querySelector('.reply-body');
        const body = bodyField.value.trim();
        const image = replyImageAttach.getValue();
        if (!body && !image) return;
        try {
          await submitMixReply(c.id, body, replyForm, image);
          replyImageAttach.reset(null);
        } catch (err) {
          alert('Antwort konnte nicht gesendet werden: ' + err.message);
        }
      });

      return item;
    }

    // Gruppiert Kommentare nach Playlist-Item (Reihenfolge = Playlist-
    // Position), damit die Zugehörigkeit mehrerer Kommentare zum selben Item
    // visuell erkennbar ist (siehe ToDo.md/Merge-Entscheidung) – innerhalb
    // jeder Gruppe gilt der Früh/Spät-Umschalter (sortOrder).
    function renderComments() {
      const anyFormOpen =
        commentList.querySelector('.reply-form:not(.hidden)') || commentList.querySelector('.edit-form:not(.hidden)');
      if (anyFormOpen) return;

      const allTopLevel = comments.filter((c) => c.parent_id === null);
      const byParent = {};
      comments
        .filter((c) => c.parent_id !== null)
        .forEach((c) => {
          (byParent[c.parent_id] = byParent[c.parent_id] || []).push(c);
        });
      // Bei Filterung nach "ungelesen" soll der ganze Kommentarstrang sichtbar
      // bleiben, sobald mindestens eine Antwort (Child-Kommentar) ungelesen
      // ist – auch wenn der Top-Level-Kommentar selbst bereits gelesen wurde.
      const filtered = allTopLevel.filter((c) => {
        if (matchesReadFilter(c, authorName, readFilter)) return true;
        if (readFilter === 'unread') {
          const replies = byParent[c.id] || [];
          return replies.some((r) => !isCommentRead(r, authorName));
        }
        return false;
      });

      if (filtered.length === 0) {
        const message =
          allTopLevel.length === 0
            ? 'Noch keine Kommentare – sei der/die Erste!'
            : readFilter === 'unread'
            ? 'Keine ungelesenen Kommentare.'
            : 'Keine gelesenen Kommentare.';
        commentList.innerHTML = `<p class="empty-state">${message}</p>`;
        return;
      }

      const groups = new Map();
      filtered.forEach((c) => {
        if (!groups.has(c.item_id)) groups.set(c.item_id, []);
        groups.get(c.item_id).push(c);
      });
      const orderedItemIds = playlist.map((it) => it.id).filter((id) => groups.has(id));
      Array.from(groups.keys()).forEach((id) => {
        if (!orderedItemIds.includes(id)) orderedItemIds.push(id);
      });

      commentList.innerHTML = '';
      const showGroupHeaders = playlist.length > 1;
      orderedItemIds.forEach((itemId) => {
        const groupComments = groups.get(itemId).sort((a, b) => {
          const ta = a.timecode_sec ?? 0;
          const tb = b.timecode_sec ?? 0;
          const diff = sortOrder === 'asc' ? ta - tb : tb - ta;
          return diff !== 0 ? diff : a.created_at - b.created_at;
        });
        const item = playlist.find((it) => it.id === itemId);

        if (showGroupHeaders) {
          const header = document.createElement('button');
          header.type = 'button';
          header.className = 'comment-group-header';
          header.disabled = !item;
          header.innerHTML = `<span class="comment-group-icon"></span><span class="comment-group-title"></span>`;
          header.querySelector('.comment-group-icon').textContent = item ? playlistItemIcon(item.provider) : '❔';
          header.querySelector('.comment-group-title').textContent = item ? item.title : '(gelöschtes Item)';
          if (item) {
            header.addEventListener('click', () => {
              const idx = playlist.findIndex((it) => it.id === itemId);
              if (idx !== -1) loadItemIntoPlayer(idx, true);
            });
          }
          commentList.appendChild(header);
        }

        const groupEl = document.createElement('div');
        groupEl.className = 'comment-group';
        groupComments.forEach((c) => {
          const el = buildMixCommentElement(c);
          groupEl.appendChild(el);
          const repliesEl = el.querySelector('.replies');
          (byParent[c.id] || [])
            .sort((a, b) => a.created_at - b.created_at)
            .forEach((r) => repliesEl.appendChild(buildMixReplyElement(r)));
        });
        commentList.appendChild(groupEl);
      });
      highlightActiveItemComments();
    }

    // ---------- Init ----------

    updateTimelineControlsVisibility(null);
    loadStream();
    if (authorName) migrateLegacyLocalReadStatus();
  }

  // =========================================================
  // Übersichtsseite: passwortgeschützte Liste aller Sessions
  // =========================================================

  function initOverviewPage() {
    const gateCard = document.getElementById('overview-gate-card');
    if (!gateCard) return;

    const authForm = document.getElementById('overview-auth-form');
    const passwordInput = document.getElementById('overview-password-input');
    const authError = document.getElementById('overview-auth-error');
    const listCard = document.getElementById('overview-list-card');
    const listEl = document.getElementById('overview-list');

    let accessToken = localStorage.getItem(OVERVIEW_ACCESS_KEY) || '';

    async function loadList() {
      try {
        const rows = await apiFetch('api/overview/streams', { headers: { 'X-Overview-Access': accessToken } });
        gateCard.classList.add('hidden');
        listCard.classList.remove('hidden');
        if (rows.length === 0) {
          listEl.innerHTML = '<p class="empty-state">Noch keine Sessions angelegt.</p>';
          return;
        }
        listEl.innerHTML = '';
        rows.forEach((s) => {
          const row = document.createElement('a');
          row.className = 'stream-list-item';
          row.href = `s/${s.id}`;
          const lock = s.password_protected ? '🔒 ' : '';
          const providerIcons = (s.providers || []).map(playlistItemIcon).join(' ');
          row.innerHTML = `
            <span class="stream-list-title">${lock}${escapeHtml(s.title)}</span>
            <span class="stream-list-meta">${providerIcons} · ${s.item_count} Item(s)</span>
            <span class="stream-list-date">${formatDate(s.created_at)}</span>
          `;
          listEl.appendChild(row);
        });
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          accessToken = '';
          localStorage.removeItem(OVERVIEW_ACCESS_KEY);
          gateCard.classList.remove('hidden');
          listCard.classList.add('hidden');
          return;
        }
        listEl.innerHTML = `<p class="empty-state">Konnte nicht geladen werden: ${escapeHtml(err.message)}</p>`;
      }
    }

    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      authError.classList.add('hidden');
      try {
        const result = await apiFetch('api/overview/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: passwordInput.value }),
        });
        accessToken = result.access_token;
        localStorage.setItem(OVERVIEW_ACCESS_KEY, accessToken);
        passwordInput.value = '';
        await loadList();
      } catch (err) {
        authError.textContent = err.message;
        authError.classList.remove('hidden');
      }
    });

    if (accessToken) loadList();
  }

  // ---------- Bootstrap ----------

  document.addEventListener('DOMContentLoaded', () => {
    initHomePage();
    initSessionPage();
    initOverviewPage();
  });
})();
