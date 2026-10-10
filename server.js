require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { COUNTRIES, NETWORKS } = require("./networks");

const API_BASE = "https://api-v2.feexpay.me/api";
const PORT = process.env.PORT || 3000;

const MIN_AMOUNT = 100;
const MAX_AMOUNT = 2000000;

// ---------------------------------------------------------------------------
// Réglages (modifiables depuis la page Paramètres, protégée par un PIN)
// Priorité : data/settings.json > variables d'environnement (.env)
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const ADMIN_PIN = String(process.env.ADMIN_PIN || "0291");

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch (_) { /* aucun réglage enregistré */ }
  return {
    apiKey: saved.apiKey || process.env.FEEXPAY_API_KEY || "",
    shopId: saved.shopId || process.env.FEEXPAY_SHOP_ID || "",
    baseUrl: (saved.baseUrl || process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, ""),
    // --- Crypto (MakaPay) ---
    mkApiKey: saved.mkApiKey || process.env.MAKAPAY_API_KEY || "",
    mkWallet: saved.mkWallet || process.env.MAKAPAY_WALLET || "",
    mkChainId: String(saved.mkChainId || process.env.MAKAPAY_CHAIN_ID || "56"),
    // Par défaut : USDT (BEP-20) sur BNB Smart Chain — à vérifier dans votre dashboard MakaPay / sur BscScan
    mkToken: saved.mkToken || process.env.MAKAPAY_TOKEN || "0x55d398326f99059fF775485246999027B3197955",
    mkWebhookKey: saved.mkWebhookKey || process.env.MAKAPAY_WEBHOOK_KEY || "",
    xofPerUsd: Number(saved.xofPerUsd || process.env.XOF_PER_USD || 600),
  };
}

function saveSettings(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function maskKey(k) {
  if (!k) return "";
  return k.length <= 8 ? "••••" : k.slice(0, 5) + "••••••••" + k.slice(-4);
}

const app = express();
app.set("trust proxy", 1);
// rawBody conservé : nécessaire pour vérifier la signature des webhooks MakaPay
app.use(express.json({ limit: "20kb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, "public")));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
app.use("/api/", limiter);

async function feexpay(method, urlPath, body) {
  const { apiKey } = loadSettings();
  const res = await fetch(API_BASE + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* réponse non JSON */ }
  return { ok: res.ok, status: res.status, data };
}

// Vérifie que la clé API et l'ID boutique fonctionnent réellement (lecture du solde).
async function verifySettings(s) {
  if (!s.apiKey || !s.shopId) {
    return { ok: false, message: "Clé API ou ID boutique manquant." };
  }
  try {
    const res = await fetch(`${API_BASE}/balance/public/getByShop/${encodeURIComponent(s.shopId)}`, {
      headers: { Authorization: `Bearer ${s.apiKey}` },
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* non JSON */ }
    if (res.ok) {
      const shopName = data?.data?.data?.shop_name || data?.data?.shop_name || null;
      return { ok: true, message: "Connexion à FeexPay réussie : clé API et boutique valides.", shopName };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "Clé API refusée par FeexPay. Vérifiez la clé." };
    }
    if (res.status === 404) {
      return { ok: false, message: "Boutique introuvable. Vérifiez l'ID de la boutique." };
    }
    return { ok: false, message: `FeexPay a répondu avec le code ${res.status}.` };
  } catch (e) {
    return { ok: false, message: "Impossible de joindre FeexPay depuis le serveur." };
  }
}

// Vérifie la clé API MakaPay (lecture de la liste des paiements, sans rien créer).
async function verifyCrypto(s) {
  if (!s.mkApiKey || !s.mkWallet) {
    return { ok: false, message: "Crypto non configuré (clé API MakaPay ou adresse du portefeuille manquante)." };
  }
  try {
    // GET /balance (documenté) : valide la clé et renvoie le solde du Gas Tank en USDT
    const res = await fetch("https://app.makapay.io/api/balance", {
      headers: { "x-api-key": s.mkApiKey },
    });
    if (res.ok) {
      let bal = null;
      try { bal = Number((await res.json())?.balance); } catch (_) { /* non JSON */ }
      if (Number.isFinite(bal)) {
        const low = bal < 5;
        return {
          ok: true,
          message: `Connexion à MakaPay réussie : clé API valide. Gas Tank : ${bal.toFixed(2)} USDT.` +
            (low ? " ⚠ Solde bas : les paiements risquent de rester en « Awaiting Gas » (rechargez en USDT)." : ""),
        };
      }
      return { ok: true, message: "Connexion à MakaPay réussie : clé API valide." };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Clé API MakaPay refusée. Vérifiez la clé." };
    return { ok: false, message: `MakaPay a répondu avec le code ${res.status}.` };
  } catch (e) {
    return { ok: false, message: "Impossible de joindre MakaPay depuis le serveur." };
  }
}

// ---------------------------------------------------------------------------
// Authentification admin par PIN (vérifié côté serveur, avec blocage anti-devinette)
// ---------------------------------------------------------------------------
const sessions = new Map();   // token -> expiration
const attempts = new Map();   // ip -> { count, lockedUntil }
const SESSION_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAdmin(req, res, next) {
  const token = (req.get("Authorization") || "").replace(/^Bearer /, "");
  const exp = sessions.get(token);
  if (!token || !exp || exp < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: "Session expirée. Saisissez à nouveau le PIN." });
  }
  sessions.set(token, Date.now() + SESSION_MS);
  next();
}

app.post("/api/admin/login", (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (a.lockedUntil > Date.now()) {
    const min = Math.ceil((a.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${min} min.` });
  }
  const pin = String(req.body?.pin || "");
  if (!safeEqual(pin, ADMIN_PIN)) {
    a.count += 1;
    if (a.count >= MAX_ATTEMPTS) { a.lockedUntil = Date.now() + LOCK_MS; a.count = 0; }
    attempts.set(ip, a);
    return res.status(401).json({ error: "PIN incorrect." });
  }
  attempts.delete(ip);
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, Date.now() + SESSION_MS);
  res.json({ token });
});

app.get("/api/admin/settings", requireAdmin, (_req, res) => {
  const s = loadSettings();
  res.json({
    apiKeyMasked: maskKey(s.apiKey), hasApiKey: !!s.apiKey, shopId: s.shopId, baseUrl: s.baseUrl,
    mkApiKeyMasked: maskKey(s.mkApiKey), hasMkApiKey: !!s.mkApiKey,
    mkWallet: s.mkWallet, mkChainId: s.mkChainId, mkToken: s.mkToken,
    mkWebhookKeyMasked: maskKey(s.mkWebhookKey), hasMkWebhookKey: !!s.mkWebhookKey,
    xofPerUsd: s.xofPerUsd,
  });
});

app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  const current = loadSettings();
  const { apiKey, shopId, baseUrl, mkApiKey, mkWallet, mkChainId, mkToken, mkWebhookKey, xofPerUsd } = req.body || {};
  const keep = (v, old) => (v && String(v).trim() ? String(v).trim() : old); // champ vide = garder l'actuel

  const next = {
    apiKey: keep(apiKey, current.apiKey),
    shopId: String(shopId || "").trim(),
    baseUrl: String(baseUrl || "").trim().replace(/\/$/, ""),
    mkApiKey: keep(mkApiKey, current.mkApiKey),
    mkWallet: String(mkWallet || "").trim(),
    mkChainId: String(mkChainId || "").trim() || "56",
    mkToken: String(mkToken || "").trim() || current.mkToken,
    mkWebhookKey: keep(mkWebhookKey, current.mkWebhookKey),
    xofPerUsd: Number(xofPerUsd) || current.xofPerUsd,
  };

  if (!/^fp_[A-Za-z0-9]{10,}$/.test(next.apiKey)) {
    return res.status(400).json({ error: "La clé API doit commencer par fp_ (menu Développeurs de FeexPay)." });
  }
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(next.shopId)) {
    return res.status(400).json({ error: "ID de boutique invalide." });
  }
  if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(next.baseUrl)) {
    return res.status(400).json({ error: "L'URL du site doit commencer par http:// ou https://." });
  }

  // Crypto : facultatif, mais s'il est renseigné il doit être valide
  if (next.mkApiKey || next.mkWallet) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(next.mkWallet)) {
      return res.status(400).json({ error: "Adresse du portefeuille crypto invalide (format 0x… de 42 caractères)." });
    }
    if (!next.mkApiKey) return res.status(400).json({ error: "Clé API MakaPay manquante." });
    if (!/^\d{1,10}$/.test(next.mkChainId)) return res.status(400).json({ error: "Chain ID invalide (56 pour BNB Smart Chain)." });
    if (!/^0x[a-fA-F0-9]{40}$/.test(next.mkToken)) return res.status(400).json({ error: "Adresse du token invalide (format 0x…)." });
    if (!(next.xofPerUsd >= 100 && next.xofPerUsd <= 5000)) return res.status(400).json({ error: "Taux XOF par USD invalide (entre 100 et 5000)." });
  }

  saveSettings(next);
  // Relecture du fichier puis test réel auprès de FeexPay et MakaPay
  const saved = loadSettings();
  const verification = await verifySettings(saved);
  const cryptoVerification = (saved.mkApiKey || saved.mkWallet) ? await verifyCrypto(saved) : null;
  res.json({
    saved: true,
    verification,
    cryptoVerification,
    settings: { apiKeyMasked: maskKey(saved.apiKey), shopId: saved.shopId, baseUrl: saved.baseUrl, mkApiKeyMasked: maskKey(saved.mkApiKey), mkWebhookKeyMasked: maskKey(saved.mkWebhookKey) },
  });
});

app.post("/api/admin/verify", requireAdmin, async (_req, res) => {
  const s = loadSettings();
  res.json({
    verification: await verifySettings(s),
    cryptoVerification: (s.mkApiKey || s.mkWallet) ? await verifyCrypto(s) : null,
  });
});

// ---------------------------------------------------------------------------
// Paiement
// ---------------------------------------------------------------------------

// Normalise le numéro : chiffres uniquement, avec indicatif pays, sans le signe +.
function normalizePhone(raw, countryCode) {
  const prefix = COUNTRIES[countryCode].prefix;
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!digits.startsWith(prefix)) digits = prefix + digits;
  // Bénin : format à 10 chiffres avec le préfixe 01 (ex : 2290166000000)
  if (countryCode === "BJ") {
    const local = digits.slice(prefix.length);
    if (local.length === 8) digits = prefix + "01" + local;
  }
  return digits;
}

// Liste des pays/réseaux pour le frontend
app.get("/api/config", (_req, res) => {
  const s = loadSettings();
  res.json({
    min: MIN_AMOUNT,
    max: MAX_AMOUNT,
    configured: !!(s.apiKey && s.shopId),
    cryptoEnabled: !!(s.mkApiKey && s.mkWallet),
    xofPerUsd: s.xofPerUsd,
    countries: Object.entries(COUNTRIES).map(([code, c]) => ({
      code,
      name: c.name,
      prefix: c.prefix,
      networks: Object.entries(NETWORKS)
        .filter(([, n]) => n.country === code)
        .map(([key, n]) => ({ key, label: n.label, flow: n.flow })),
    })),
  });
});

// Initier un paiement (payin)
app.post("/api/pay", async (req, res) => {
  try {
    const settings = loadSettings();
    if (!settings.apiKey || !settings.shopId) {
      return res.status(503).json({ error: "Le site n'est pas encore configuré (Paramètres)." });
    }

    const { network, phone, amount, first_name, last_name, otp, description } = req.body || {};
    const net = NETWORKS[network];
    if (!net) return res.status(400).json({ error: "Réseau non supporté." });

    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt < MIN_AMOUNT || amt > MAX_AMOUNT) {
      return res.status(400).json({
        error: `Le montant doit être un entier entre ${MIN_AMOUNT} et ${MAX_AMOUNT.toLocaleString("fr-FR")} XOF.`,
      });
    }

    const phoneNumber = normalizePhone(phone, net.country);
    if (phoneNumber.length < 11 || phoneNumber.length > 18) {
      return res.status(400).json({ error: "Numéro de téléphone invalide." });
    }

    if (net.flow === "otp" && !/^\d{4,8}$/.test(String(otp || ""))) {
      return res.status(400).json({ error: "Le code OTP est obligatoire pour ce réseau." });
    }

    const clean = (s, n) => String(s || "").replace(/[^\p{L}\p{N} .'-]/gu, "").slice(0, n);
    const orderId = "ORD_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

    const payload = {
      shop: settings.shopId,
      amount: amt,
      phoneNumber,
      first_name: clean(first_name, 50),
      last_name: clean(last_name, 50),
      description: clean(description, 80) || "Paiement",
      callback_info: orderId,
    };
    if (net.flow === "redirect") {
      payload.return_url = `${settings.baseUrl}/?done=1`;
      payload.cancel_url = `${settings.baseUrl}/?cancel=1`;
    }
    if (net.flow === "otp" || net.flow === "otp-2step") {
      payload.otp = otp ? String(otp) : "";
    }

    const r = await feexpay("POST", `/transactions/public/requesttopay/${net.endpoint}`, payload);
    if (!r.ok) {
      console.error("Payin refusé", r.status, JSON.stringify(r.data));
      const msg = Array.isArray(r.data?.message) ? r.data.message.join(", ") : r.data?.message;
      return res.status(r.status >= 500 ? 502 : 400).json({ error: msg || "Le paiement a été refusé." });
    }

    const d = r.data || {};
    res.json({
      reference: d.reference || d.order_id || null,
      status: d.status || "PENDING",
      payment_url: d.payment_url || null,
      needsOtp: net.flow === "otp-2step" && !otp,
      orderId,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Statut d'une transaction (le frontend interroge cette route)
app.get("/api/status/:reference", async (req, res) => {
  const ref = req.params.reference;
  if (!/^[\w-]{6,80}$/.test(ref)) return res.status(400).json({ error: "Référence invalide." });
  try {
    const r = await feexpay("GET", `/transactions/public/single/status/${ref}`);
    if (!r.ok) return res.status(r.status === 404 ? 404 : 502).json({ error: "Statut indisponible." });
    const d = r.data || {};
    res.json({ status: d.status, amount: d.amount, reason: d.reason || "", reference: d.reference });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Webhook FeexPay : ne jamais faire confiance au payload, on revérifie via l'API statut.
app.post("/api/webhook", async (req, res) => {
  res.sendStatus(200); // répondre vite
  try {
    const ref = req.body?.reference;
    if (!ref) return;
    const r = await feexpay("GET", `/transactions/public/single/status/${ref}`);
    const status = r.data?.status;
    console.log(`[webhook] ${ref} -> ${status} (callback_info=${r.data?.callback_info})`);
    // TODO : si status === "SUCCESSFUL", marquer la commande comme payée dans votre base de données.
  } catch (e) {
    console.error("[webhook] erreur", e.message);
  }
});

// ---------------------------------------------------------------------------
// Paiement crypto (MakaPay)
// ---------------------------------------------------------------------------
const MK_API = "https://app.makapay.io/api";

app.post("/api/crypto/pay", async (req, res) => {
  try {
    const s = loadSettings();
    if (!s.mkApiKey || !s.mkWallet) {
      return res.status(503).json({ error: "Le paiement crypto n'est pas configuré (Paramètres)." });
    }
    const xof = Number(req.body?.amount);
    if (!Number.isInteger(xof) || xof < MIN_AMOUNT || xof > MAX_AMOUNT) {
      return res.status(400).json({ error: `Le montant doit être un entier entre ${MIN_AMOUNT} et ${MAX_AMOUNT.toLocaleString("fr-FR")} XOF.` });
    }
    // Montant en token (stablecoin ≈ 1 USD) calculé côté serveur avec le taux des Paramètres
    const usd = xof / s.xofPerUsd;
    if (usd < 1) {
      return res.status(400).json({ error: `Montant trop faible pour un paiement crypto (minimum ${Math.ceil(s.xofPerUsd)} XOF, soit environ 1 USD).` });
    }
    const orderId = "CRY_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const payload = {
      merchant: s.mkWallet,
      chainId: s.mkChainId,
      token: s.mkToken,
      amount: usd.toFixed(2),
      orderId,
      description: `Paiement ${xof} XOF`,
      redirectUrl: `${s.baseUrl}/`,
    };
    const r = await fetch(`${MK_API}/payments`, {
      method: "POST",
      headers: { "x-api-key": s.mkApiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let d = null;
    try { d = await r.json(); } catch (_) { /* non JSON */ }
    if (!r.ok || !d?.url) {
      console.error("MakaPay refusé", r.status, JSON.stringify(d));
      return res.status(r.status >= 500 ? 502 : 400).json({ error: (typeof d?.error === "string" && d.error) || d?.message || "Le paiement crypto a été refusé." });
    }
    res.json({ url: d.url, paymentId: d.paymentId, orderId, amountToken: payload.amount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Statut d'un paiement crypto (recherche par orderId via l'API MakaPay)
app.get("/api/crypto/status/:orderId", async (req, res) => {
  const orderId = req.params.orderId;
  if (!/^CRY_[\w-]{6,60}$/.test(orderId)) return res.status(400).json({ error: "Référence invalide." });
  try {
    const s = loadSettings();
    const r = await fetch(`${MK_API}/v1/payments?orderId=${encodeURIComponent(orderId)}`, { headers: { "x-api-key": s.mkApiKey } });
    if (!r.ok) return res.status(502).json({ error: "Statut indisponible." });
    const d = await r.json();
    const p = Array.isArray(d?.data) ? d.data[0] : null;
    if (!p) return res.status(404).json({ error: "Paiement introuvable." });
    res.json({ status: p.status });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Webhook MakaPay : signature = SHA-256 hex de (corps brut + clé de signature), en-tête X-Signature.
app.post("/api/webhook/makapay", (req, res) => {
  const s = loadSettings();
  const key = s.mkWebhookKey || s.mkApiKey; // webhooks créés dans le dashboard : la clé API sert de clé
  const sig = String(req.get("X-Signature") || "");
  if (!key || !req.rawBody) return res.sendStatus(401);
  const expected = crypto.createHash("sha256").update(Buffer.concat([req.rawBody, Buffer.from(key)])).digest("hex");
  const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return res.sendStatus(401);
  res.sendStatus(200);
  const { event, paymentId, orderId, status } = req.body || {};
  console.log(`[makapay] ${event} paymentId=${paymentId} orderId=${orderId} status=${status}`);
  // TODO : si event === "payment.completed", marquer la commande comme payée (dédoublonner avec paymentId).
});

app.listen(PORT, () => {
  console.log(`Site de paiement sur http://localhost:${PORT}`);
  const s = loadSettings();
  if (!s.apiKey || !s.shopId) console.warn("⚠ Non configuré : ouvrez le site puis Paramètres (PIN) pour renseigner la clé API et l'ID boutique.");
});
