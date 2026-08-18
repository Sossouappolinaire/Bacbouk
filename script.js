const linksInput = document.getElementById('linksInput');
const qualitySelect = document.getElementById('qualitySelect');
const submitBtn = document.getElementById('submitBtn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const emptyState = document.getElementById('emptyState');
const topProgress = document.getElementById('topProgress');

let lastResults = [];

// Compteur de "J'aime" local à l'appareil, persisté dans le navigateur.
// Clé = URL de la vidéo Facebook. Pas de backend, pas de partage entre utilisateurs.
const LIKES_KEY = 'flux-likes-v1';

function loadLikes() {
  try {
    return JSON.parse(localStorage.getItem(LIKES_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveLikes(likes) {
  try {
    localStorage.setItem(LIKES_KEY, JSON.stringify(likes));
  } catch (e) {
    // stockage indisponible (navigation privée, quota atteint...) : on ignore silencieusement
  }
}

function getLike(url) {
  const likes = loadLikes();
  return likes[url] || { liked: false, count: 0 };
}

function toggleLike(url) {
  const likes = loadLikes();
  const current = likes[url] || { liked: false, count: 0 };
  const next = current.liked
    ? { liked: false, count: Math.max(0, current.count - 1) }
    : { liked: true, count: current.count + 1 };
  likes[url] = next;
  saveLikes(likes);
  return next;
}

function setStatus(text, isError) {
  if (!text) {
    statusEl.classList.add('hidden');
    statusEl.textContent = '';
    return;
  }
  statusEl.classList.remove('hidden');
  statusEl.classList.toggle('status--error', !!isError);
  statusEl.textContent = text;
}

function showTopProgress(indeterminate) {
  topProgress.classList.add('active');
  topProgress.classList.toggle('indeterminate', !!indeterminate);
}

function hideTopProgress() {
  topProgress.classList.remove('active', 'indeterminate');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatDuration(seconds) {
  if (!seconds || Number.isNaN(seconds)) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} Mo` : `${(bytes / 1024).toFixed(0)} Ko`;
}

function buildFilename(r) {
  return (r.title || 'video').replace(/[/\\?%*:|"<>]/g, '').slice(0, 100) + '.mp4';
}

function buildDownloadUrl(r) {
  return `/api/download?url=${encodeURIComponent(r.directUrl)}&filename=${encodeURIComponent(buildFilename(r))}`;
}

function renderResults(results) {
  resultsEl.innerHTML = '';
  lastResults = results;

  const successCount = results.filter((r) => r.success && r.directUrl).length;
  emptyState.classList.toggle('hidden', results.length > 0);
  downloadAllBtn.classList.toggle('hidden', successCount < 2);
  downloadAllBtn.textContent = `⬇ Tout télécharger (${successCount})`;

  results.forEach((r, index) => {
    const card = document.createElement('div');
    card.className = 'card' + (r.success ? '' : ' card--error');

    if (r.success && r.directUrl) {
      const metaParts = [];
      if (r.uploader) metaParts.push(`Publié par ${r.uploader}`);
      const dur = formatDuration(r.duration);
      if (dur) metaParts.push(dur);
      const metaLine = metaParts.length
        ? `<p class="card__meta">${escapeHtml(metaParts.join(' · '))}</p>`
        : `<p class="card__meta card__meta--unknown">Auteur non identifié</p>`;

      const like = getLike(r.url);

      card.innerHTML = `
        <h3 class="card__title">${escapeHtml(r.title)}</h3>
        ${metaLine}
        <video controls preload="metadata" src="${r.directUrl}"></video>
        <div class="card__actions">
          <button class="download-btn" data-index="${index}">⬇ Télécharger</button>
          <button class="like-btn${like.liked ? ' like-btn--active' : ''}" data-like-url="${escapeHtml(r.url)}" aria-pressed="${like.liked}">
            <svg class="like-btn__heart" viewBox="0 0 24 24" width="16" height="16"><path d="M12 20.5s-7.5-4.6-10-9.3C.5 7.8 2.3 4.5 5.8 4.1c2-.2 3.7.8 4.9 2.6C11.9 4.9 13.6 3.9 15.6 4.1c3.5.4 5.3 3.7 3.8 7.1-2.5 4.7-10 9.3-10 9.3z"/></svg>
            <span class="like-btn__count">${like.count}</span>
          </button>
        </div>
        <div class="dl-progress hidden" data-progress-for="${index}">
          <div class="dl-progress__track"><div class="dl-progress__fill"></div></div>
          <div class="dl-progress__label"><span class="dl-progress__pct">0 %</span><span class="dl-progress__size"></span></div>
        </div>
      `;
    } else {
      card.innerHTML = `
        <h3 class="card__title">Lien : ${escapeHtml(r.url)}</h3>
        <p class="card__error">${escapeHtml(r.error || 'Échec de la récupération de cette vidéo.')}</p>
      `;
    }

    resultsEl.appendChild(card);
  });

  resultsEl.querySelectorAll('.download-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = lastResults[Number(btn.dataset.index)];
      downloadWithProgress(r, btn);
    });
  });

  resultsEl.querySelectorAll('.like-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.likeUrl;
      const next = toggleLike(url);
      btn.classList.toggle('like-btn--active', next.liked);
      btn.setAttribute('aria-pressed', String(next.liked));
      btn.querySelector('.like-btn__count').textContent = next.count;
    });
  });
}

// Telecharge le fichier en suivant la vraie progression (Content-Length),
// affiche la barre de telemetrie sous la carte, puis declenche la
// sauvegarde via une URL blob locale (fonctionne pour un fichier "same-origin").
async function downloadWithProgress(r, triggerBtn) {
  const progressWrap = resultsEl.querySelector(`[data-progress-for="${triggerBtn.dataset.index}"]`);
  const fill = progressWrap.querySelector('.dl-progress__fill');
  const pctLabel = progressWrap.querySelector('.dl-progress__pct');
  const sizeLabel = progressWrap.querySelector('.dl-progress__size');

  progressWrap.classList.remove('hidden');
  if (triggerBtn) triggerBtn.disabled = true;

  try {
    const res = await fetch(buildDownloadUrl(r));
    if (!res.ok || !res.body) throw new Error('download failed');

    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;

      if (total) {
        const pct = Math.min(100, Math.round((received / total) * 100));
        fill.style.width = pct + '%';
        pctLabel.textContent = pct + ' %';
        sizeLabel.textContent = `${formatBytes(received)} / ${formatBytes(total)}`;
      } else {
        pctLabel.textContent = formatBytes(received);
      }
    }

    fill.style.width = '100%';
    pctLabel.textContent = '100 %';

    const blob = new Blob(chunks);
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = buildFilename(r);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
  } catch (err) {
    pctLabel.textContent = 'Échec du téléchargement';
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
    setTimeout(() => progressWrap.classList.add('hidden'), 2500);
  }
}

submitBtn.addEventListener('click', async () => {
  const raw = linksInput.value.trim();
  if (!raw) {
    setStatus('Colle au moins un lien de vidéo Facebook.', true);
    return;
  }

  const links = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  submitBtn.disabled = true;
  downloadAllBtn.classList.add('hidden');
  setStatus('Récupération des vidéos en cours…');
  showTopProgress(true);
  resultsEl.innerHTML = '';
  emptyState.classList.add('hidden');

  try {
    const res = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links, quality: qualitySelect.value }),
    });

    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || 'Une erreur est survenue.', true);
      emptyState.classList.remove('hidden');
      return;
    }

    setStatus('');
    renderResults(data.results);
  } catch (err) {
    setStatus('Erreur réseau, réessaie.', true);
    emptyState.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    hideTopProgress();
  }
});

downloadAllBtn.addEventListener('click', async () => {
  const items = lastResults
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.success && r.directUrl);

  if (items.length === 0) return;

  downloadAllBtn.disabled = true;

  for (const { r, i } of items) {
    const btn = resultsEl.querySelector(`.download-btn[data-index="${i}"]`);
    await downloadWithProgress(r, btn);
  }

  downloadAllBtn.disabled = false;
});
