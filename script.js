const linksInput = document.getElementById('linksInput');
const submitBtn = document.getElementById('submitBtn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

function setStatus(text) {
  if (!text) {
    statusEl.classList.add('hidden');
    statusEl.textContent = '';
    return;
  }
  statusEl.classList.remove('hidden');
  statusEl.textContent = text;
}

function renderResults(results) {
  resultsEl.innerHTML = '';

  results.forEach((r) => {
    const card = document.createElement('div');
    card.className = 'card' + (r.success ? '' : ' error');

    if (r.success && r.directUrl) {
      card.innerHTML = `
        <h3>${escapeHtml(r.title)}</h3>
        <video controls preload="metadata" src="${r.directUrl}"></video>
        <a class="download-btn" href="${r.directUrl}" download target="_blank" rel="noopener">⬇️ Télécharger</a>
      `;
    } else {
      card.innerHTML = `
        <h3>Lien : ${escapeHtml(r.url)}</h3>
        <p>${escapeHtml(r.error || 'Échec de la récupération de cette vidéo.')}</p>
      `;
    }

    resultsEl.appendChild(card);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

submitBtn.addEventListener('click', async () => {
  const raw = linksInput.value.trim();
  if (!raw) {
    setStatus('Colle au moins un lien de vidéo Facebook.');
    return;
  }

  const links = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  submitBtn.disabled = true;
  setStatus('Récupération des vidéos en cours...');
  resultsEl.innerHTML = '';

  try {
    const res = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links }),
    });

    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || 'Une erreur est survenue.');
      return;
    }

    setStatus('');
    renderResults(data.results);
  } catch (err) {
    setStatus('Erreur réseau, réessaie.');
  } finally {
    submitBtn.disabled = false;
  }
});
