const express = require('express');
const { execFile } = require('child_process');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const YT_DLP_BIN = path.join(__dirname, 'yt-dlp-bin');

app.use(express.json());
app.use(express.static(__dirname));

// Formats autorisés (whitelist) — on ne laisse jamais l'utilisateur injecter
// une valeur libre dans la commande yt-dlp, seulement choisir une clé connue.
const QUALITY_FORMATS = {
  best: 'best[ext=mp4]/best',
  hd: 'best[height<=720][ext=mp4]/best[height<=720]/best',
  sd: 'best[height<=480][ext=mp4]/best[height<=480]/best',
};

// Extrait les infos d'une seule vidéo Facebook via yt-dlp
// Utilise execFile (arguments passés en tableau, pas via un shell) pour éviter
// tout risque d'injection de commande a partir d'un lien fourni par l'utilisateur.
function extractVideo(url, quality) {
  return new Promise((resolve) => {
    const formatString = QUALITY_FORMATS[quality] || QUALITY_FORMATS.best;
    const args = ['-j', '-f', formatString, '--no-playlist', '--', url];

    execFile(YT_DLP_BIN, args, { timeout: 30000, maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
      if (error) {
        const reason = error.code === 'ENOENT'
          ? 'yt-dlp n’est pas installé sur le serveur.'
          : 'Impossible de récupérer cette vidéo. Vérifie que le lien est public et valide.';
        resolve({ url, success: false, error: reason });
        return;
      }
      try {
        const info = JSON.parse(stdout);
        // info.url est fiable quand -f a resolu un seul format fusionne.
        // Sinon on cherche dans requested_downloads, puis en dernier recours
        // le meilleur format contenant a la fois video et audio.
        let directUrl = info.url || null;
        if (!directUrl && Array.isArray(info.requested_downloads) && info.requested_downloads.length) {
          directUrl = info.requested_downloads[0].url || null;
        }
        if (!directUrl && Array.isArray(info.formats)) {
          const withAudioVideo = info.formats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none');
          const pick = withAudioVideo.length ? withAudioVideo[withAudioVideo.length - 1] : info.formats[info.formats.length - 1];
          directUrl = pick ? pick.url : null;
        }

        if (!directUrl) {
          resolve({ url, success: false, error: 'Aucune source vidéo exploitable trouvée pour ce lien.' });
          return;
        }

        resolve({
          url,
          success: true,
          title: info.title || 'Vidéo Facebook',
          uploader: info.uploader || info.channel || info.uploader_id || null,
          thumbnail: info.thumbnail || null,
          duration: info.duration || null,
          directUrl,
        });
      } catch (e) {
        resolve({ url, success: false, error: 'Réponse invalide lors de l’extraction.' });
      }
    });
  });
}

app.post('/api/extract', async (req, res) => {
  const { links, quality } = req.body;

  if (!links || !Array.isArray(links) || links.length === 0) {
    return res.status(400).json({ error: 'Aucun lien fourni.' });
  }

  // Nettoie et limite à 10 liens par requête pour éviter les abus
  const cleanLinks = links
    .map((l) => (typeof l === 'string' ? l.trim() : ''))
    .filter((l) => l.length > 0 && l.includes('facebook.com'))
    .slice(0, 10);

  if (cleanLinks.length === 0) {
    return res.status(400).json({ error: 'Aucun lien Facebook valide trouvé.' });
  }

  const safeQuality = QUALITY_FORMATS[quality] ? quality : 'best';
  const results = await Promise.all(cleanLinks.map((l) => extractVideo(l, safeQuality)));
  res.json({ results });
});

// Proxy de téléchargement : force le téléchargement (Content-Disposition)
// et évite le probleme des liens cross-origin ou l'attribut "download" HTML
// est ignore par le navigateur. Necessaire aussi pour le telechargement groupe.
app.get('/api/download', async (req, res) => {
  const { url, filename } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).send('Lien manquant.');
  }

  try {
    const upstream = await fetch(url);
    if (!upstream.ok || !upstream.body) {
      return res.status(502).send('Impossible de récupérer le fichier depuis la source.');
    }

    const safeName = (typeof filename === 'string' ? filename : 'video.mp4')
      .replace(/[/\\?%*:|"<>]/g, '')
      .slice(0, 150) || 'video.mp4';

    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    // Expose Content-Length au JS cote navigateur (le fetch API ne l'expose
    // pas automatiquement sur les requetes cross-origin, ici c'est same-origin
    // mais on le declare explicitement pour rester robuste).
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition');

    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    res.status(500).send('Erreur lors du téléchargement.');
  }
});

app.get('/health', (req, res) => res.send('OK'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
