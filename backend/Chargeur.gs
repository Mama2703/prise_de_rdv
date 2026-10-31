/**
 * NABOO — CHARGEUR AUTOMATIQUE (à coller UNE SEULE FOIS dans Apps Script, puis ne plus y toucher)
 *
 * Le vrai code du backend est sur GitHub (backend/Code.gs du dépôt Mama2703/prise_de_rdv).
 * Ce chargeur le télécharge et l'exécute : chaque amélioration publiée sur GitHub s'applique
 * toute seule en quelques minutes, sans copier-coller ni nouveau déploiement.
 *
 * Sécurité : seul ce dépôt GitHub est utilisé. Protège ton compte GitHub
 * (validation en deux étapes) : quiconque peut modifier le dépôt peut modifier ce code.
 * Une copie de secours du dernier code valide est gardée pour que le site continue
 * de fonctionner même si GitHub est momentanément indisponible.
 */

const SOURCE_CODE = 'https://raw.githubusercontent.com/Mama2703/prise_de_rdv/main/backend/Code.gs';
const RAFRAICHIR_SECONDES = 300; // vérifie les nouveautés au plus toutes les 5 minutes

let MODULE_;

// ---------- Points d'entrée (appelés par Google) ----------
function doGet(e) { return module_().doGet(e); }
function doPost(e) { return module_().doPost(e); }
function decider(id, token, decision) { return module_().decider(id, token, decision); }
function annulerSelection() { return module_().annulerSelection(); }
function testerIcloud() { return module_().testerIcloud(); }

/** Menu de la feuille (déclencheur simple : ne peut pas télécharger de code, donc défini ici). */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Rendez-vous')
    .addItem('Annuler le RDV de la ligne sélectionnée', 'annulerSelection')
    .addItem('Tester la connexion iCloud', 'testerIcloud')
    .addItem('Forcer la mise à jour du code', 'forcerMiseAJour')
    .addToUi();
}

/** Recharge immédiatement le code depuis GitHub (sans attendre 5 minutes). */
function forcerMiseAJour() {
  CacheService.getScriptCache().remove('code_source');
  MODULE_ = null;
  module_();
  const msg = 'Code à jour ✅ (' + (PropertiesService.getScriptProperties().getProperty('CODE_VERSION') || '?') + ')';
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
}

// ---------- Chargement ----------
function module_() {
  if (MODULE_) return MODULE_;
  const cache = CacheService.getScriptCache();
  let code = cache.get('code_source');
  if (!code) {
    code = telecharger_();
    if (code) {
      cache.put('code_source', code, RAFRAICHIR_SECONDES);
      sauverSecours_(code);
    } else {
      code = lireSecours_();
      if (!code) throw new Error('Le code du site est momentanément indisponible. Réessaie dans quelques minutes.');
      cache.put('code_source', code, 60);
    }
  }
  MODULE_ = new Function(code +
    '\n;return { doGet, doPost, decider, annulerSelection, testerIcloud };')();
  return MODULE_;
}

function telecharger_() {
  try {
    const r = UrlFetchApp.fetch(SOURCE_CODE + '?v=' + Math.floor(Date.now() / (RAFRAICHIR_SECONDES * 1000)),
      { muteHttpExceptions: true, followRedirects: true });
    const code = r.getContentText();
    // Contrôle minimal : c'est bien le backend Naboo, et il est syntaxiquement valide
    if (r.getResponseCode() !== 200 || code.indexOf('function doPost(') === -1) return null;
    new Function(code); // lève une erreur si le fichier est corrompu
    return code;
  } catch (e) {
    console.error('Téléchargement du code impossible', e);
    return null;
  }
}

/** Copie de secours découpée en morceaux (les propriétés sont limitées à 9 Ko chacune). */
function sauverSecours_(code) {
  const props = PropertiesService.getScriptProperties();
  const empreinte = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, code));
  if (props.getProperty('CODE_VERSION') === empreinte) return;
  const morceaux = code.match(/[\s\S]{1,4000}/g); // 4000 caractères ≤ 9 Ko même avec des accents
  const ecrit = { CODE_VERSION: empreinte, CODE_MORCEAUX: String(morceaux.length) };
  morceaux.forEach((m, i) => { ecrit['CODE_' + i] = m; });
  props.setProperties(ecrit);
}

function lireSecours_() {
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty('CODE_MORCEAUX') || 0);
  let code = '';
  for (let i = 0; i < n; i++) code += props.getProperty('CODE_' + i) || '';
  return code || null;
}

// ---------- Autorisations ----------
// Cette fonction n'est jamais appelée. Elle sert uniquement à indiquer à Google les services
// dont le code a besoin, pour que l'autorisation soit demandée une seule fois :
// feuille de calcul (rendez-vous), emails, iCloud (internet), Drive (photos des prestations).
function autorisations_() {
  SpreadsheetApp.getActiveSpreadsheet();
  MailApp.sendEmail('', '', '');
  UrlFetchApp.fetch('');
  DriveApp.getRootFolder();
  HtmlService.createHtmlOutput('');
  Session.getActiveUser();
}
