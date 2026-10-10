// Configuration des pays et réseaux FeexPay (payin), d'après la documentation v2.
// flow: "push"     -> le client confirme sur son téléphone (USSD / notification)
//       "redirect" -> le client est redirigé vers payment_url
//       "otp"      -> un code OTP est nécessaire
const COUNTRIES = {
  BJ: { name: "Bénin", prefix: "229" },
  CI: { name: "Côte d'Ivoire", prefix: "225" },
  TG: { name: "Togo", prefix: "228" },
  SN: { name: "Sénégal", prefix: "221" },
  BF: { name: "Burkina Faso", prefix: "226" },
  ML: { name: "Mali", prefix: "223" },
  CG: { name: "Congo Brazzaville", prefix: "242" },
};

const NETWORKS = {
  "MTN BJ":      { country: "BJ", label: "MTN Mobile Money",  endpoint: "mtn",          flow: "push" },
  "MOOV BJ":     { country: "BJ", label: "Moov Money",        endpoint: "moov",         flow: "push" },
  "CELTIIS BJ":  { country: "BJ", label: "Celtiis",           endpoint: "celtiis_bj",   flow: "push" },
  "CORIS BJ":    { country: "BJ", label: "Coris Money",       endpoint: "coris",        flow: "otp-2step" },
  "MTN CI":      { country: "CI", label: "MTN Mobile Money",  endpoint: "mtn_ci",       flow: "push" },
  "MOOV CI":     { country: "CI", label: "Moov Money",        endpoint: "moov_ci",      flow: "redirect" },
  "WAVE CI":     { country: "CI", label: "Wave",              endpoint: "wave_ci",      flow: "redirect" },
  "ORANGE CI":   { country: "CI", label: "Orange Money",      endpoint: "orange_ci",    flow: "redirect" },
  "TOGOCOM TG":  { country: "TG", label: "Togocom (T-Money)", endpoint: "togocom_tg",   flow: "push" },
  "MOOV TG":     { country: "TG", label: "Moov Money",        endpoint: "moov_tg",      flow: "push" },
  "ORANGE SN":   { country: "SN", label: "Orange Money",      endpoint: "orange_sn",    flow: "redirect" },
  "WAVE SN":     { country: "SN", label: "Wave",              endpoint: "wave_sn",      flow: "redirect" },
  "FREE SN":     { country: "SN", label: "Free Money",        endpoint: "free_sn",      flow: "push" },
  "MOOV BF":     { country: "BF", label: "Moov Money",        endpoint: "moov_bf",      flow: "push" },
  "ORANGE BF":   { country: "BF", label: "Orange Money",      endpoint: "orange_bf",    flow: "otp" },
  "WAVE BF":     { country: "BF", label: "Wave",              endpoint: "wave_bf",      flow: "redirect" },
  "ORANGE ML":   { country: "ML", label: "Orange Money",      endpoint: "orange_ml",    flow: "push" },
  "MOBICASH ML": { country: "ML", label: "Mobicash",          endpoint: "mobicash_ml",  flow: "push" },
  "MTN CG":      { country: "CG", label: "MTN Mobile Money",  endpoint: "mtn_cg",       flow: "push" },
};

module.exports = { COUNTRIES, NETWORKS };
