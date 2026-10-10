# Site de paiement FeexPay

Page de paiement Mobile Money (Bénin, Côte d'Ivoire, Togo, Sénégal, Burkina Faso, Mali, Congo) basée sur l'API FeexPay v2.

## Démarrage

```bash
npm install
cp .env.example .env     # puis renseignez FEEXPAY_API_KEY et FEEXPAY_SHOP_ID
npm start                # http://localhost:3000
```

## Mise en ligne

1. Hébergez sur un serveur Node.js 18+ avec HTTPS (Render, Railway, VPS...).
2. Dans le dashboard FeexPay → **Webhooks**, ajoutez `https://votre-domaine.com/api/webhook`.
3. Mettez `BASE_URL=https://votre-domaine.com` dans `.env`.
4. La clé API reste uniquement côté serveur (jamais dans le HTML).

## Fichiers

- `server.js` : API (paiement, statut, webhook), clé API secrète, validation du montant
- `networks.js` : liste des pays/réseaux et type de flux (push, redirection, OTP)
- `public/index.html` : page de paiement

## Notes

- Cameroun : non listé dans la documentation FeexPay v2, donc non inclus.
- Payout (envoi d'argent) : non inclus ici ; il exige une IP serveur autorisée dans le dashboard.
- Dans `/api/webhook`, ajoutez votre logique pour marquer la commande payée quand le statut est `SUCCESSFUL`.

## Déploiement sur Render

1. Mettez ce dossier sur GitHub (Render déploie depuis un dépôt Git).
2. Render → New → Web Service → choisissez le dépôt.
   Build Command : `npm install` · Start Command : `npm start`
3. Dans Environment, ajoutez uniquement les variables FeexPay :
   - `FEEXPAY_API_KEY` : votre clé `fp_...`
   - `FEEXPAY_SHOP_ID` : l'ID de votre boutique
   - `BASE_URL` : l'URL Render (ex : https://mon-site.onrender.com)
   - `ADMIN_PIN` : le PIN de la page Paramètres (par défaut 0291)
4. Dans le dashboard FeexPay → Webhooks : `https://mon-site.onrender.com/api/webhook`.

Le crypto (MakaPay) reste facultatif : sans ses variables, le choix « Cryptomonnaie » n'apparaît pas.
Pour l'activer plus tard, ajoutez les variables MAKAPAY_* (voir ci-dessous) ou saisissez-les dans Paramètres.
Sur l'offre gratuite de Render le disque est effacé à chaque redémarrage : les réglages saisis dans Paramètres peuvent disparaître, les variables d'environnement restent.

## Paiement crypto (MakaPay)

Le client choisit « Mobile Money » ou « Cryptomonnaie » sur la page. En mode crypto, il est redirigé vers la page de paiement MakaPay (stablecoin, USDT BEP-20 sur BNB Smart Chain par défaut).

Réglages (page Paramètres ou variables d'environnement) : `MAKAPAY_API_KEY`, `MAKAPAY_WALLET` (adresse 0x… qui reçoit l'argent), `MAKAPAY_CHAIN_ID` (56 = BNB Smart Chain), `XOF_PER_USD` (taux de conversion XOF → USD, à ajuster), `MAKAPAY_WEBHOOK_KEY` (facultatif).
Webhook à déclarer dans MakaPay (HTTPS) : `https://votre-domaine/api/webhook/makapay`.
Pour que les paiements soient réglés, le Gas Tank MakaPay doit être alimenté en USDT (ou activer le mode gasless).
