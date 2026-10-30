/**
 * Prise de rendez-vous -> Agenda iCloud
 * Backend Google Apps Script (lié à une Google Sheet).
 *
 * Flux :
 *  1. Le site (GitHub Pages) demande les créneaux libres  -> doGet ?action=slots
 *  2. Le client envoie sa demande                          -> doPost (statut "en_attente")
 *  3. Tu reçois un email avec un lien "Examiner la demande"
 *  4. Tu cliques sur "Valider" -> l'événement est créé dans ton agenda iCloud (CalDAV)
 *     + le client reçoit une confirmation avec un fichier .ics
 */

// ============================== CONFIGURATION ==============================

const CONFIG = {
  NOM_ACTIVITE: 'Naboo',
  FUSEAU: 'Europe/Paris',

  // Prestations proposées (durée en minutes) — DURÉES À AJUSTER
  PRESTATIONS: [
    { id: 'braids', nom: 'Braids', duree: 300, prix: '40 €' },
    { id: 'crochet-locks', nom: 'Crochet Locks', duree: 180, prix: '45 €' },
    { id: 'twist', nom: 'Twist', duree: 240, prix: '45 €' },
    { id: 'nattes-collees', nom: 'Nattes Collées', duree: 120, prix: '30 €' },
    { id: 'tissage-ouvert', nom: 'Tissage Ouvert', duree: 180, prix: '50 €' },
  ],

  // Horaires d'ouverture : 1 = lundi ... 7 = dimanche (week-ends uniquement)
  // Ici : heures de DÉBUT possibles (10h à 16h). Mettre DEBUT_SEULEMENT à false
  // si la prestation doit aussi être terminée avant l'heure de fin.
  HORAIRES: {
    1: [], 2: [], 3: [], 4: [], 5: [],
    6: [['10:00', '16:00']],
    7: [['10:00', '16:00']],
  },
  DEBUT_SEULEMENT: true,

  ACOMPTE: '10 €',           // acompte demandé pour confirmer le RDV

  JOURS_FERMES: [],          // ex. ['2026-12-26', '2026-12-27'] (congés)
  PAS_CRENEAUX: 60,          // un créneau toutes les heures
  DELAI_MIN_HEURES: 48,      // réservation au moins 48 h à l'avance
  JOURS_MAX_A_L_AVANCE: 45,
  RAPPEL_MINUTES: 60,        // alerte dans ton agenda 60 min avant (0 = aucune)
  LIEU: 'Poitiers (86000)',  // adresse affichée dans l'événement
};

const FEUILLE = 'Rendez-vous';
const COLONNES = ['id', 'token', 'creeLe', 'statut', 'prestationId', 'prestation',
  'debut', 'fin', 'nom', 'email', 'telephone', 'message', 'uidAgenda'];

const STATUT = { ATTENTE: 'en_attente', VALIDE: 'valide', REFUSE: 'refuse', ANNULE: 'annule' };

// ============================== POINTS D'ENTRÉE ==============================

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    switch (p.action) {
      case 'config':
        return json_({ ok: true, config: configPublique_() });
      case 'slots':
        return json_({ ok: true, creneaux: creneauxLibres_(p.date, p.prestation) });
      case 'examiner':
        return pageExamen_(p.id, p.token);
      default:
        return json_({ ok: false, erreur: 'Action inconnue' });
    }
  } catch (err) {
    console.error(err);
    return json_({ ok: false, erreur: String(err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const d = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // Anti-spam : champ caché rempli = robot
    if (d.siteweb) return json_({ ok: true });

    const presta = CONFIG.PRESTATIONS.find(x => x.id === d.prestation);
    if (!presta) throw new Error('Prestation inconnue.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '') || !/^\d{2}:\d{2}$/.test(d.heure || '')) {
      throw new Error('Date ou heure invalide.');
    }
    const nom = nettoie_(d.nom, 80);
    const email = nettoie_(d.email, 120);
    const tel = nettoie_(d.telephone, 30);
    const message = nettoie_(d.message, 1000);
    if (!nom) throw new Error('Le nom est obligatoire.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Email invalide.');
    if (d.conditions !== true) throw new Error('Merci d\'accepter les conditions de réservation.');

    lock.waitLock(20000);
    // Revérifie que le créneau est toujours libre (deux clients en même temps)
    if (creneauxLibres_(d.date, presta.id).indexOf(d.heure) === -1) {
      throw new Error('Ce créneau vient d\'être pris. Merci d\'en choisir un autre.');
    }

    const debut = dateParis_(d.date, d.heure);
    const fin = new Date(debut.getTime() + presta.duree * 60000);
    const id = Utilities.getUuid().slice(0, 8);
    const token = Utilities.getUuid().replace(/-/g, '');

    feuille_().appendRow([id, token, new Date(), STATUT.ATTENTE, presta.id, presta.nom,
      debut.toISOString(), fin.toISOString(), nom, email, tel, message, '']);
    SpreadsheetApp.flush();
    lock.releaseLock();

    const quand = formatQuand_(debut);
    const lien = urlWebApp_() + '?action=examiner&id=' + id + '&token=' + token;

    MailApp.sendEmail({
      to: prop_('EMAIL_PROPRIETAIRE'),
      subject: 'Nouvelle demande de RDV — ' + nom + ' — ' + quand,
      htmlBody:
        '<p><b>' + esc_(nom) + '</b> demande un rendez-vous :</p>' +
        '<ul><li>' + esc_(presta.nom) + ' (' + presta.duree + ' min)</li>' +
        '<li>' + esc_(quand) + '</li>' +
        '<li>' + esc_(email) + (tel ? ' — ' + esc_(tel) : '') + '</li></ul>' +
        (message ? '<p>Message : ' + esc_(message) + '</p>' : '') +
        '<p>Pense à demander l\'acompte de ' + CONFIG.ACOMPTE + ' avant de valider.</p>' +
        '<p><a href="' + lien + '" style="background:#1f6f5c;color:#fff;padding:10px 16px;' +
        'border-radius:8px;text-decoration:none">Examiner la demande</a></p>',
    });

    MailApp.sendEmail({
      to: email,
      name: CONFIG.NOM_ACTIVITE,
      replyTo: prop_('EMAIL_PROPRIETAIRE'),
      subject: 'Demande de rendez-vous reçue — ' + CONFIG.NOM_ACTIVITE,
      htmlBody:
        '<p>Bonjour ' + esc_(nom) + ',</p>' +
        '<p>Votre demande pour <b>' + esc_(presta.nom) + '</b> le <b>' + esc_(quand) +
        '</b> a bien été reçue.</p>' +
        '<p>Pour confirmer votre rendez-vous, un <b>acompte de ' + CONFIG.ACOMPTE + '</b> vous sera demandé. ' +
        'Il est déduit du prix de la prestation et n\'est pas remboursable en cas d\'annulation moins de 24 h avant. ' +
        'Vous recevrez un email de confirmation dès réception.</p>' +
        '<p>' + esc_(CONFIG.NOM_ACTIVITE) + '</p>',
    });

    return json_({ ok: true, id: id });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, erreur: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// ============================== VALIDATION (appelée depuis la page d'examen) ==============================

/** Appelée par le bouton Valider / Refuser via google.script.run */
function decider(id, token, decision) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { ligne, rdv } = trouveRdv_(id);
    if (!rdv || rdv.token !== token) throw new Error('Lien invalide.');
    if (rdv.statut !== STATUT.ATTENTE) return 'Cette demande a déjà été traitée (' + rdv.statut + ').';

    const debut = new Date(rdv.debut);
    const fin = new Date(rdv.fin);
    const quand = formatQuand_(debut);

    if (decision === 'valider') {
      const uid = rdv.id + '-' + Date.now() + '@rdv';
      const ics = construireIcs_(uid, debut, fin, rdv, true);
      icloudPut_(uid, ics);                       // <- mise à jour de l'agenda en temps réel
      majLigne_(ligne, { statut: STATUT.VALIDE, uidAgenda: uid });

      MailApp.sendEmail({
        to: rdv.email,
        name: CONFIG.NOM_ACTIVITE,
        replyTo: prop_('EMAIL_PROPRIETAIRE'),
        subject: 'Rendez-vous confirmé — ' + quand,
        htmlBody:
          '<p>Bonjour ' + esc_(rdv.nom) + ',</p>' +
          '<p>Votre rendez-vous <b>' + esc_(rdv.prestation) + '</b> est confirmé pour le <b>' +
          esc_(quand) + '</b>.' + (CONFIG.LIEU ? '<br>Lieu : ' + esc_(CONFIG.LIEU) : '') + '</p>' +
          '<p>Merci de venir avec les cheveux propres, démêlés et sans produit. ' +
          'Rappel : l\'acompte n\'est pas remboursable en cas d\'annulation moins de 24 h avant le rendez-vous.</p>' +
          '<p>Vous pouvez l\'ajouter à votre agenda avec le fichier joint.</p>' +
          '<p>' + esc_(CONFIG.NOM_ACTIVITE) + '</p>',
        attachments: [Utilities.newBlob(construireIcs_(uid, debut, fin, rdv, false),
          'text/calendar', 'rendez-vous.ics')],
      });
      return 'Rendez-vous validé ✅ Il est maintenant dans ton agenda iCloud et le client est prévenu.';
    }

    if (decision === 'refuser') {
      majLigne_(ligne, { statut: STATUT.REFUSE });
      MailApp.sendEmail({
        to: rdv.email,
        name: CONFIG.NOM_ACTIVITE,
        replyTo: prop_('EMAIL_PROPRIETAIRE'),
        subject: 'Votre demande de rendez-vous — ' + CONFIG.NOM_ACTIVITE,
        htmlBody:
          '<p>Bonjour ' + esc_(rdv.nom) + ',</p>' +
          '<p>Malheureusement, le créneau du <b>' + esc_(quand) + '</b> n\'est pas disponible. ' +
          'N\'hésitez pas à faire une nouvelle demande sur le site.</p>' +
          '<p>' + esc_(CONFIG.NOM_ACTIVITE) + '</p>',
      });
      return 'Demande refusée. Le client a été prévenu par email.';
    }
    throw new Error('Décision inconnue.');
  } finally {
    lock.releaseLock();
  }
}

// ============================== MENU DE LA FEUILLE ==============================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Rendez-vous')
    .addItem('Annuler le RDV de la ligne sélectionnée', 'annulerSelection')
    .addItem('Tester la connexion iCloud', 'testerIcloud')
    .addToUi();
}

function annulerSelection() {
  const ui = SpreadsheetApp.getUi();
  const ligne = SpreadsheetApp.getActiveRange().getRow();
  if (ligne < 2) return ui.alert('Sélectionne la ligne d\'un rendez-vous.');
  const rdv = lireLigne_(ligne);
  if (rdv.statut !== STATUT.VALIDE && rdv.statut !== STATUT.ATTENTE) {
    return ui.alert('Ce rendez-vous est déjà ' + rdv.statut + '.');
  }
  const quand = formatQuand_(new Date(rdv.debut));
  if (ui.alert('Annuler le RDV de ' + rdv.nom + ' le ' + quand + ' ?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

  if (rdv.uidAgenda) icloudDelete_(rdv.uidAgenda);
  majLigne_(ligne, { statut: STATUT.ANNULE });
  MailApp.sendEmail({
    to: rdv.email,
    name: CONFIG.NOM_ACTIVITE,
    replyTo: prop_('EMAIL_PROPRIETAIRE'),
    subject: 'Rendez-vous annulé — ' + quand,
    htmlBody: '<p>Bonjour ' + esc_(rdv.nom) + ',</p><p>Votre rendez-vous du <b>' + esc_(quand) +
      '</b> a été annulé. Répondez à cet email pour en convenir d\'un autre.</p><p>' +
      esc_(CONFIG.NOM_ACTIVITE) + '</p>',
  });
  ui.alert('Rendez-vous annulé, retiré de l\'agenda, client prévenu.');
}

/** Crée puis supprime un événement de test dans iCloud. */
function testerIcloud() {
  const uid = 'test-' + Date.now() + '@rdv';
  const debut = new Date(Date.now() + 3600000);
  const ics = construireIcs_(uid, debut, new Date(debut.getTime() + 1800000),
    { prestation: 'TEST connexion', nom: 'Test', email: '', telephone: '', message: '' }, false);
  icloudPut_(uid, ics);
  icloudDelete_(uid);
  const msg = 'Connexion iCloud OK ✅ (événement de test créé puis supprimé)';
  try { SpreadsheetApp.getUi().alert(msg); } catch (_) { console.log(msg); }
}

// ============================== CRÉNEAUX ==============================

function creneauxLibres_(dateStr, prestationId) {
  const presta = CONFIG.PRESTATIONS.find(x => x.id === prestationId);
  if (!presta || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return [];
  if (CONFIG.JOURS_FERMES.indexOf(dateStr) !== -1) return [];

  const jourSemaine = Number(Utilities.formatDate(dateParis_(dateStr, '12:00'), CONFIG.FUSEAU, 'u'));
  const plages = CONFIG.HORAIRES[jourSemaine] || [];
  const maintenant = Date.now();
  const minDebut = maintenant + CONFIG.DELAI_MIN_HEURES * 3600000;
  const maxDebut = maintenant + CONFIG.JOURS_MAX_A_L_AVANCE * 86400000;
  const occupes = rdvOccupes_();
  const duree = presta.duree * 60000;
  const res = [];

  plages.forEach(([ouv, ferm]) => {
    const finPlage = dateParis_(dateStr, ferm).getTime();
    const dernierDebut = CONFIG.DEBUT_SEULEMENT ? finPlage : finPlage - duree;
    for (let t = dateParis_(dateStr, ouv).getTime(); t <= dernierDebut; t += CONFIG.PAS_CRENEAUX * 60000) {
      if (t < minDebut || t > maxDebut) continue;
      const chevauche = occupes.some(o => t < o.fin && t + duree > o.debut);
      if (!chevauche) res.push(Utilities.formatDate(new Date(t), CONFIG.FUSEAU, 'HH:mm'));
    }
  });
  return res;
}

function rdvOccupes_() {
  const sh = feuille_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, COLONNES.length).getValues()
    .filter(r => r[3] === STATUT.ATTENTE || r[3] === STATUT.VALIDE)
    .map(r => ({ debut: new Date(r[6]).getTime(), fin: new Date(r[7]).getTime() }));
}

function configPublique_() {
  const jours = Object.keys(CONFIG.HORAIRES).filter(k => CONFIG.HORAIRES[k].length).map(Number);
  return {
    nom: CONFIG.NOM_ACTIVITE,
    lieu: CONFIG.LIEU,
    prestations: CONFIG.PRESTATIONS,
    joursOuverts: jours,
    joursFermes: CONFIG.JOURS_FERMES,
    joursMax: CONFIG.JOURS_MAX_A_L_AVANCE,
    acompte: CONFIG.ACOMPTE,
    delaiHeures: CONFIG.DELAI_MIN_HEURES,
    // heure de début la plus tardive possible, tous jours confondus (sert à griser les jours trop proches)
    dernierDebut: Object.keys(CONFIG.HORAIRES).reduce((m, k) => CONFIG.HORAIRES[k].reduce((mm, r) => r[1] > mm ? r[1] : mm, m), '00:00'),
  };
}

// ============================== iCLOUD (CalDAV) ==============================

function icloudPut_(uid, ics) {
  const url = urlEvenement_(uid);
  const r = UrlFetchApp.fetch(url, {
    method: 'put',
    contentType: 'text/calendar; charset=utf-8',
    payload: ics,
    headers: { Authorization: authIcloud_(), 'If-None-Match': '*' },
    muteHttpExceptions: true,
    followRedirects: true,
  });
  const code = r.getResponseCode();
  if (code !== 201 && code !== 204) {
    throw new Error('iCloud a refusé la création (' + code + ') : ' + r.getContentText().slice(0, 300));
  }
}

function icloudDelete_(uid) {
  const r = UrlFetchApp.fetch(urlEvenement_(uid), {
    method: 'delete',
    headers: { Authorization: authIcloud_() },
    muteHttpExceptions: true,
  });
  const code = r.getResponseCode();
  if (code !== 204 && code !== 200 && code !== 404) {
    throw new Error('iCloud a refusé la suppression (' + code + ')');
  }
}

function urlEvenement_(uid) {
  let base = prop_('ICLOUD_URL_CALENDRIER');
  if (!base.endsWith('/')) base += '/';
  return base + encodeURIComponent(uid.replace(/[^A-Za-z0-9-]/g, '_')) + '.ics';
}

function authIcloud_() {
  return 'Basic ' + Utilities.base64Encode(
    prop_('ICLOUD_IDENTIFIANT') + ':' + prop_('ICLOUD_MOT_DE_PASSE_APP'), Utilities.Charset.UTF_8);
}

/** @param pourMoi true = événement de ton agenda (avec infos client), false = pour le client */
function construireIcs_(uid, debut, fin, rdv, pourMoi) {
  const utc = d => Utilities.formatDate(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'");
  const titre = pourMoi ? rdv.prestation + ' — ' + rdv.nom : rdv.prestation + ' — ' + CONFIG.NOM_ACTIVITE;
  const desc = pourMoi
    ? ['Client : ' + rdv.nom, 'Email : ' + rdv.email, rdv.telephone ? 'Tél : ' + rdv.telephone : '',
       rdv.message ? 'Message : ' + rdv.message : ''].filter(Boolean).join('\n')
    : 'Rendez-vous confirmé.';

  const lignes = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//rdv//Prise de rendez-vous//FR', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + utc(new Date()),
    'DTSTART:' + utc(debut),
    'DTEND:' + utc(fin),
    'SUMMARY:' + icsTexte_(titre),
    'DESCRIPTION:' + icsTexte_(desc),
  ];
  if (CONFIG.LIEU) lignes.push('LOCATION:' + icsTexte_(CONFIG.LIEU));
  if (pourMoi && CONFIG.RAPPEL_MINUTES > 0) {
    lignes.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsTexte_(titre),
      'TRIGGER:-PT' + CONFIG.RAPPEL_MINUTES + 'M', 'END:VALARM');
  }
  lignes.push('END:VEVENT', 'END:VCALENDAR');
  return lignes.map(plieLigne_).join('\r\n') + '\r\n';
}

function icsTexte_(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Plie les lignes à 75 caractères (RFC 5545) */
function plieLigne_(l) {
  const out = [];
  while (l.length > 74) { out.push(l.slice(0, 74)); l = ' ' + l.slice(74); }
  out.push(l);
  return out.join('\r\n');
}

// ============================== PAGE D'EXAMEN ==============================

function pageExamen_(id, token) {
  const { rdv } = trouveRdv_(id);
  const t = HtmlService.createTemplateFromFile('Examen');
  t.valide = !!(rdv && rdv.token === token);
  t.rdv = t.valide ? {
    id: rdv.id, token: rdv.token, statut: rdv.statut, nom: rdv.nom, email: rdv.email,
    telephone: rdv.telephone, message: rdv.message, prestation: rdv.prestation,
    quand: formatQuand_(new Date(rdv.debut)),
  } : null;
  return t.evaluate().setTitle('Demande de rendez-vous')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ============================== OUTILS ==============================

function feuille_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(FEUILLE);
  if (!sh) {
    sh = ss.insertSheet(FEUILLE);
    sh.appendRow(COLONNES);
    sh.setFrozenRows(1);
    sh.hideColumns(2); // token
  }
  return sh;
}

function trouveRdv_(id) {
  const sh = feuille_();
  if (!id || sh.getLastRow() < 2) return { ligne: -1, rdv: null };
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return { ligne: i + 2, rdv: lireLigne_(i + 2) };
  }
  return { ligne: -1, rdv: null };
}

function lireLigne_(ligne) {
  const v = feuille_().getRange(ligne, 1, 1, COLONNES.length).getValues()[0];
  const o = {};
  COLONNES.forEach((c, i) => { o[c] = v[i] instanceof Date ? v[i].toISOString() : String(v[i]); });
  return o;
}

function majLigne_(ligne, champs) {
  const sh = feuille_();
  Object.keys(champs).forEach(k => sh.getRange(ligne, COLONNES.indexOf(k) + 1).setValue(champs[k]));
  SpreadsheetApp.flush();
}

function dateParis_(dateStr, heure) {
  return Utilities.parseDate(dateStr + ' ' + heure, CONFIG.FUSEAU, 'yyyy-MM-dd HH:mm');
}

function formatQuand_(d) {
  const jours = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  const mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
    'septembre', 'octobre', 'novembre', 'décembre'];
  const f = x => Utilities.formatDate(d, CONFIG.FUSEAU, x);
  return jours[Number(f('u'))] + ' ' + Number(f('d')) + ' ' + mois[Number(f('M')) - 1] + ' à ' + f('HH:mm');
}

function prop_(k) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error('Propriété du script manquante : ' + k);
  return v;
}

function urlWebApp_() {
  return PropertiesService.getScriptProperties().getProperty('URL_WEBAPP') || ScriptApp.getService().getUrl();
}

function nettoie_(s, max) { return String(s || '').trim().slice(0, max); }

function esc_(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
