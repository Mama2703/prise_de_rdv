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
// Valeurs PAR DÉFAUT. Tout ce qui suit se modifie ensuite depuis la page d'administration
// (https://mama2703.github.io/prise_de_rdv/admin.html) : ces valeurs ne servent qu'au premier lancement.
// Mot de passe admin : propriété du script ADMIN_MOT_DE_PASSE (au moins 10 caractères).

const CONFIG = {
  NOM_ACTIVITE: 'Naboo',
  FUSEAU: 'Europe/Paris',

  // Prestations proposées (durée en minutes) — DURÉES À AJUSTER
  PRESTATIONS: [
    { id: 'braids', nom: 'Braids', duree: 300, prix: '40 €', actif: true },
    { id: 'crochet-locks', nom: 'Crochet Locks', duree: 180, prix: '45 €', actif: true },
    { id: 'twist', nom: 'Twist', duree: 240, prix: '45 €', actif: true },
    { id: 'nattes-collees', nom: 'Nattes Collées', duree: 120, prix: '30 €', actif: true },
    { id: 'tissage-ouvert', nom: 'Tissage Ouvert', duree: 180, prix: '50 €', actif: true },
  ],

  // Horaires d'ouverture : 1 = lundi ... 7 = dimanche (week-ends uniquement)
  // Ici : heures de DÉBUT possibles (9 h à 16 h). Mettre DEBUT_SEULEMENT à false
  // si la prestation doit aussi être terminée avant l'heure de fin.
  HORAIRES: {
    1: [], 2: [], 3: [], 4: [], 5: [],
    6: [['09:00', '16:00']],
    7: [['09:00', '16:00']],
  },
  DEBUT_SEULEMENT: true,

  ACOMPTE: '10 €',           // acompte demandé pour confirmer le RDV
  SUPPLEMENT_DOMICILE: '15 €', // déplacement à domicile dans Poitiers
  WERO_NUMERO: '07 52 34 16 52', // numéro sur lequel recevoir l'acompte par Wero

  JOURS_FERMES: [],          // ex. ['2026-12-26', '2026-12-27'] (congés)
  CRENEAUX_BLOQUES: {},      // ex. { '2026-11-07': ['10:00', '11:00'] }
  OUVERTURES_EXCEPTION: {},  // jour ouvert exceptionnellement, ex. { '2026-11-11': [['09:00', '16:00']] }
  PAS_CRENEAUX: 60,          // un créneau toutes les heures
  DELAI_MIN_HEURES: 48,      // réservation au moins 48 h à l'avance
  JOURS_MAX_A_L_AVANCE: 45,
  RAPPEL_MINUTES: 60,        // alerte dans ton agenda 60 min avant (0 = aucune)
  LIEU: 'Poitiers (86000)',  // ville affichée dans l'événement si pas d'adresse
  ADRESSE_SALON: '',         // adresse exacte où tu reçois (envoyée seulement dans l'email de confirmation)

  EXPIRATION_ATTENTE_HEURES: 24, // une demande sans acompte libère son créneau après 24 h
  MAX_DEMANDES_PAR_EMAIL: 2,     // anti-abus : demandes en attente max par adresse email

  // Boutiques de mèches affichées sur le site
  BOUTIQUES: [
    { nom: "Bel'Ivoire", adresse: '11 place Jean de Berry, 86000 Poitiers', tel: '05 49 61 26 37' },
    { nom: 'Ekitrade', adresse: "5 boulevard Jeanne d'Arc, 86000 Poitiers", tel: '05 49 46 64 25' },
  ],
};

// Réglages modifiables depuis la page d'administration (enregistrés dans la propriété REGLAGES)
const CLES_REGLAGES = ['PRESTATIONS', 'HORAIRES', 'DEBUT_SEULEMENT', 'ACOMPTE', 'SUPPLEMENT_DOMICILE',
  'WERO_NUMERO', 'JOURS_FERMES', 'CRENEAUX_BLOQUES', 'OUVERTURES_EXCEPTION', 'PAS_CRENEAUX',
  'DELAI_MIN_HEURES', 'JOURS_MAX_A_L_AVANCE', 'RAPPEL_MINUTES', 'ADRESSE_SALON',
  'EXPIRATION_ATTENTE_HEURES', 'MAX_DEMANDES_PAR_EMAIL', 'BOUTIQUES'];

const FEUILLE = 'Rendez-vous';
const COLONNES = ['id', 'token', 'creeLe', 'statut', 'prestationId', 'prestation',
  'debut', 'fin', 'nom', 'email', 'telephone', 'message', 'uidAgenda', 'lieu', 'adresse'];

const STATUT = { ATTENTE: 'en_attente', VALIDE: 'valide', REFUSE: 'refuse', ANNULE: 'annule' };

// ============================== POINTS D'ENTRÉE ==============================

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    chargerReglages_();
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
    chargerReglages_();
    const d = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // Page d'administration
    if (d.action === 'admin') return json_(admin_(d));

    // Anti-spam : champ caché rempli = robot
    if (d.siteweb) return json_({ ok: true });

    const presta = prestaActive_(d.prestation);
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
    const domicile = d.lieu === 'domicile';
    const adresse = domicile ? nettoie_(d.adresse, 200) : '';
    if (domicile && adresse.length < 8) throw new Error('Merci d\'indiquer votre adresse complète à Poitiers.');
    const lieuTxt = domicile ? 'À domicile (+' + CONFIG.SUPPLEMENT_DOMICILE + ') : ' + adresse : 'Chez Naboo';

    lock.waitLock(20000);
    // Anti-abus : pas plus de N demandes en attente pour la même adresse
    const enAttente = lignesActives_().filter(r => r.statut === STATUT.ATTENTE && r.email.toLowerCase() === email.toLowerCase());
    if (enAttente.length >= CONFIG.MAX_DEMANDES_PAR_EMAIL) {
      throw new Error('Vous avez déjà ' + enAttente.length + ' demande(s) en attente. Merci d\'envoyer l\'acompte ou de nous contacter.');
    }
    // Revérifie que le créneau est toujours libre (deux clients en même temps)
    if (creneauxLibres_(d.date, presta.id).indexOf(d.heure) === -1) {
      throw new Error('Ce créneau vient d\'être pris. Merci d\'en choisir un autre.');
    }

    const debut = dateParis_(d.date, d.heure);
    const fin = new Date(debut.getTime() + presta.duree * 60000);
    const id = 'R' + Utilities.getUuid().replace(/-/g, '').slice(0, 9).toUpperCase();
    const token = Utilities.getUuid().replace(/-/g, '');

    // Les textes sont préfixés par ' pour que Sheets ne les transforme pas
    // (téléphone 07… → nombre, formules =…) ; les dates restent de vraies dates.
    feuille_().appendRow([t_(id), t_(token), new Date(), t_(STATUT.ATTENTE), t_(presta.id), t_(presta.nom),
      debut, fin, t_(nom), t_(email), t_(tel), t_(message), '',
      t_(domicile ? 'domicile' : 'salon'), t_(adresse)]);
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
        '<li>' + esc_(lieuTxt) + '</li>' +
        '<li>' + esc_(email) + (tel ? ' — ' + esc_(tel) : '') + '</li></ul>' +
        (message ? '<p>Message : ' + esc_(message) + '</p>' : '') +
        '<p>Vérifie que l\'acompte de ' + CONFIG.ACOMPTE + ' est bien arrivé sur Wero avant de valider ' +
        '(message attendu : « Acompte ' + esc_(nom) + ' ' + esc_(Utilities.formatDate(debut, CONFIG.FUSEAU, 'dd/MM')) + ' »).</p>' +
        '<p><a href="' + lien + '" style="background:#8a6440;color:#fff;padding:10px 16px;' +
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
        '</b> a bien été reçue.<br>Lieu : ' + esc_(lieuTxt) + '</p>' +
        '<p>Pensez à acheter vos mèches avant le rendez-vous : elles ne sont pas fournies.</p>' +
        '<p><b>Pour confirmer votre rendez-vous</b>, envoyez un <b>acompte de ' + CONFIG.ACOMPTE + '</b> par <b>Wero</b> ' +
        '(depuis l\'appli de votre banque) au <b>' + CONFIG.WERO_NUMERO + '</b>, avec en message : ' +
        '« Acompte ' + esc_(nom) + ' ' + esc_(Utilities.formatDate(debut, CONFIG.FUSEAU, 'dd/MM')) + ' ».</p>' +
        '<p>L\'acompte est déduit du prix de la prestation et n\'est pas remboursable en cas d\'annulation moins de 24 h avant. ' +
        'Vous recevrez un email de confirmation dès réception. Sans acompte sous ' + CONFIG.EXPIRATION_ATTENTE_HEURES +
        ' h, le créneau sera libéré.</p>' +
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
  chargerReglages_();
  const { ligne, rdv } = trouveRdv_(id);
  if (!rdv || rdv.token !== token) throw new Error('Lien invalide.');
  if (decision === 'valider') return actionRdv_(id, 'valider');
  if (decision === 'refuser') return actionRdv_(id, 'refuser');
  throw new Error('Décision inconnue.');
}

/**
 * Actions sur un rendez-vous, partagées par la page d'examen, la page d'administration et le menu de la feuille.
 * @return {string} message à afficher
 */
function actionRdv_(id, action) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { ligne, rdv } = trouveRdv_(id);
    if (!rdv) throw new Error('Rendez-vous introuvable.');
    const debut = new Date(rdv.debut);
    const fin = new Date(rdv.fin);
    const quand = formatQuand_(debut);

    if (action === 'valider') {
      if (rdv.statut !== STATUT.ATTENTE) return 'Cette demande a déjà été traitée (' + libelleStatut_(rdv.statut) + ').';
      // Une demande expirée a pu voir son créneau repris par quelqu'un d'autre entre-temps
      const conflit = rdvOccupes_().some(o => o.id !== rdv.id && debut.getTime() < o.fin && fin.getTime() > o.debut);
      if (conflit) throw new Error('Ce créneau est désormais occupé par un autre rendez-vous. Refuse la demande ou propose un autre horaire à la cliente.');
      const uid = rdv.id + '-' + Date.now() + '@rdv';
      icloudPut_(uid, construireIcs_(uid, debut, fin, rdv, true));   // <- mise à jour de l'agenda en temps réel
      majLigne_(ligne, { statut: STATUT.VALIDE, uidAgenda: uid });
      MailApp.sendEmail({
        to: rdv.email,
        name: CONFIG.NOM_ACTIVITE,
        replyTo: prop_('EMAIL_PROPRIETAIRE'),
        subject: 'Rendez-vous confirmé — ' + quand,
        htmlBody:
          '<p>Bonjour ' + esc_(rdv.nom) + ',</p>' +
          '<p>Votre rendez-vous <b>' + esc_(rdv.prestation) + '</b> est confirmé pour le <b>' +
          esc_(quand) + '</b>.<br>Lieu : ' + esc_(rdv.lieu === 'domicile' ? 'à domicile, ' + rdv.adresse +
          ' (supplément ' + CONFIG.SUPPLEMENT_DOMICILE + ')' : (CONFIG.ADRESSE_SALON ||
          CONFIG.LIEU + ' — l\'adresse exacte vous sera envoyée par message')) + '</p>' +
          '<p>N\'oubliez pas vos mèches (non fournies).</p>' +
          '<p>Merci de venir avec les cheveux propres, démêlés et sans produit. ' +
          'Rappel : l\'acompte n\'est pas remboursable en cas d\'annulation moins de 24 h avant le rendez-vous.</p>' +
          '<p>Vous pouvez l\'ajouter à votre agenda avec le fichier joint. Pour annuler ou déplacer, répondez simplement à cet email.</p>' +
          '<p>' + esc_(CONFIG.NOM_ACTIVITE) + '</p>',
        attachments: [Utilities.newBlob(construireIcs_(uid, debut, fin, rdv, false), 'text/calendar', 'rendez-vous.ics')],
      });
      return 'Rendez-vous validé ✅ Il est dans ton agenda iCloud et la cliente est prévenue.';
    }

    if (action === 'refuser') {
      if (rdv.statut !== STATUT.ATTENTE) return 'Cette demande a déjà été traitée (' + libelleStatut_(rdv.statut) + ').';
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
      return 'Demande refusée. La cliente a été prévenue par email.';
    }

    if (action === 'annuler') {
      if (rdv.statut !== STATUT.VALIDE && rdv.statut !== STATUT.ATTENTE) {
        return 'Ce rendez-vous est déjà ' + libelleStatut_(rdv.statut).toLowerCase() + '.';
      }
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
      return 'Rendez-vous annulé : retiré de ton agenda, cliente prévenue.';
    }

    if (action === 'supprimer') {
      // Suppression définitive (ex. rendez-vous de test) : aucun email envoyé
      if (rdv.uidAgenda && rdv.statut === STATUT.VALIDE) icloudDelete_(rdv.uidAgenda);
      feuille_().deleteRow(ligne);
      SpreadsheetApp.flush();
      return 'Rendez-vous supprimé définitivement (aucun email envoyé).';
    }

    throw new Error('Action inconnue.');
  } finally {
    lock.releaseLock();
  }
}

function libelleStatut_(s) {
  return ({ en_attente: 'En attente', valide: 'Validé', refuse: 'Refusé', annule: 'Annulé' })[s] || s;
}

// ============================== MENU DE LA FEUILLE ==============================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Rendez-vous')
    .addItem('Annuler le RDV de la ligne sélectionnée', 'annulerSelection')
    .addItem('Tester la connexion iCloud', 'testerIcloud')
    .addToUi();
}

function annulerSelection() {
  proprietaireSeulement_();
  chargerReglages_();
  const ui = SpreadsheetApp.getUi();
  const ligne = SpreadsheetApp.getActiveRange().getRow();
  if (ligne < 2) return ui.alert('Sélectionne la ligne d\'un rendez-vous.');
  const rdv = lireLigne_(ligne);
  if (ui.alert('Annuler le RDV de ' + rdv.nom + ' le ' + formatQuand_(new Date(rdv.debut)) + ' ?',
    ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  ui.alert(actionRdv_(rdv.id, 'annuler'));
}

/** Crée puis supprime un événement de test dans iCloud. */
function testerIcloud() {
  proprietaireSeulement_();
  chargerReglages_();
  const uid = 'test-' + Date.now() + '@rdv';
  const debut = new Date(Date.now() + 3600000);
  const ics = construireIcs_(uid, debut, new Date(debut.getTime() + 1800000),
    { prestation: 'TEST connexion', nom: 'Test', email: '', telephone: '', message: '' }, false);
  icloudPut_(uid, ics);
  icloudDelete_(uid);
  const msg = 'Connexion iCloud OK ✅ (événement de test créé puis supprimé)';
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (_) {}
}

// ============================== CRÉNEAUX ==============================

function creneauxLibres_(dateStr, prestationId) {
  const presta = prestaActive_(prestationId);
  if (!presta || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return [];
  if ((CONFIG.JOURS_FERMES || []).indexOf(dateStr) !== -1) return [];

  const jourSemaine = Number(Utilities.formatDate(dateParis_(dateStr, '12:00'), CONFIG.FUSEAU, 'u'));
  const exception = (CONFIG.OUVERTURES_EXCEPTION || {})[dateStr];
  const plages = exception || CONFIG.HORAIRES[jourSemaine] || [];
  const bloques = (CONFIG.CRENEAUX_BLOQUES || {})[dateStr] || [];
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
      const hhmm = Utilities.formatDate(new Date(t), CONFIG.FUSEAU, 'HH:mm');
      if (bloques.indexOf(hhmm) !== -1) continue;
      const chevauche = occupes.some(o => t < o.fin && t + duree > o.debut);
      if (!chevauche) res.push(hhmm);
    }
  });
  return res;
}

/** Rendez-vous qui bloquent un créneau : validés, ou en attente depuis moins de EXPIRATION_ATTENTE_HEURES. */
function rdvOccupes_() {
  const limite = Date.now() - CONFIG.EXPIRATION_ATTENTE_HEURES * 3600000;
  return lignesActives_()
    .filter(r => r.statut === STATUT.VALIDE || (r.statut === STATUT.ATTENTE && r.creeLe >= limite))
    .map(r => ({ id: r.id, debut: r.debut, fin: r.fin }));
}

/** Lignes en attente ou validées, avec dates en millisecondes. */
function lignesActives_() {
  const sh = feuille_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, COLONNES.length).getValues()
    .filter(r => r[3] === STATUT.ATTENTE || r[3] === STATUT.VALIDE)
    .map(r => ({ id: String(r[0]), statut: r[3], email: String(r[9]), creeLe: new Date(r[2]).getTime(),
      debut: new Date(r[6]).getTime(), fin: new Date(r[7]).getTime() }));
}

function prestaActive_(id) {
  return (CONFIG.PRESTATIONS || []).find(x => x.id === id && x.actif !== false) || null;
}

function configPublique_() {
  const jours = Object.keys(CONFIG.HORAIRES).filter(k => CONFIG.HORAIRES[k].length).map(Number);
  const toutes = [].concat(...Object.values(CONFIG.HORAIRES), ...Object.values(CONFIG.OUVERTURES_EXCEPTION || {}));
  return {
    nom: CONFIG.NOM_ACTIVITE,
    lieu: CONFIG.LIEU,
    prestations: CONFIG.PRESTATIONS.filter(p => p.actif !== false)
      .map(p => ({ id: p.id, nom: p.nom, duree: p.duree, prix: p.prix })),
    joursOuverts: jours,
    horaires: CONFIG.HORAIRES,
    joursFermes: CONFIG.JOURS_FERMES || [],
    joursExtra: Object.keys(CONFIG.OUVERTURES_EXCEPTION || {}),
    joursMax: CONFIG.JOURS_MAX_A_L_AVANCE,
    acompte: CONFIG.ACOMPTE,
    delaiHeures: CONFIG.DELAI_MIN_HEURES,
    supplementDomicile: CONFIG.SUPPLEMENT_DOMICILE,
    wero: CONFIG.WERO_NUMERO,
    boutiques: CONFIG.BOUTIQUES || [],
    // heure de début la plus tardive possible, tous jours confondus (sert à griser les jours trop proches)
    dernierDebut: toutes.reduce((m, r) => r[1] > m ? r[1] : m, '00:00'),
  };
}

// ============================== RÉGLAGES MODIFIABLES ==============================

/** Applique les réglages enregistrés depuis la page d'administration par-dessus les valeurs par défaut. */
function chargerReglages_() {
  const brut = PropertiesService.getScriptProperties().getProperty('REGLAGES');
  if (!brut) return;
  try {
    const r = JSON.parse(brut);
    CLES_REGLAGES.forEach(k => { if (r[k] !== undefined) CONFIG[k] = r[k]; });
  } catch (e) { console.error('REGLAGES illisibles', e); }
}

function reglagesActuels_() {
  const o = {};
  CLES_REGLAGES.forEach(k => { o[k] = CONFIG[k]; });
  return o;
}

/** Vérifie et nettoie les réglages envoyés par la page d'administration. Lève une erreur claire si invalide. */
function valideReglages_(r) {
  if (!r || typeof r !== 'object') throw new Error('Réglages invalides.');
  const HEURE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const aujourdhui = Utilities.formatDate(new Date(), CONFIG.FUSEAU, 'yyyy-MM-dd');
  const txt = (v, max, nom) => {
    const t = String(v == null ? '' : v).trim();
    if (t.length > max) throw new Error(nom + ' : ' + max + ' caractères maximum.');
    return t;
  };
  const nb = (v, min, max, nom) => {
    const n = Math.round(Number(v));
    if (!isFinite(n) || n < min || n > max) throw new Error(nom + ' : entre ' + min + ' et ' + max + '.');
    return n;
  };
  const plage = (p, nom) => {
    if (!Array.isArray(p) || p.length !== 2 || !HEURE.test(p[0]) || !HEURE.test(p[1]) || p[0] > p[1]) {
      throw new Error(nom + ' : horaires invalides (début avant fin, format HH:MM).');
    }
    return [p[0], p[1]];
  };
  const o = {};

  // Prestations
  if (!Array.isArray(r.PRESTATIONS) || !r.PRESTATIONS.length || r.PRESTATIONS.length > 30) {
    throw new Error('Il faut entre 1 et 30 prestations.');
  }
  const ids = {};
  o.PRESTATIONS = r.PRESTATIONS.map((p, i) => {
    const nom = txt(p.nom, 60, 'Nom de prestation');
    if (!nom) throw new Error('Chaque prestation doit avoir un nom.');
    let id = /^[a-z0-9-]{1,40}$/.test(p.id || '') ? p.id
      : (nom.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'presta');
    while (ids[id]) id = id.replace(/-\d+$/, '') + '-' + (i + 1);
    ids[id] = true;
    return { id, nom, duree: nb(p.duree, 15, 720, 'Durée de « ' + nom + ' » (minutes)'),
      prix: txt(p.prix, 20, 'Prix'), actif: p.actif !== false };
  });
  if (!o.PRESTATIONS.some(p => p.actif)) throw new Error('Au moins une prestation doit rester active.');

  // Horaires de la semaine
  o.HORAIRES = {};
  for (let j = 1; j <= 7; j++) {
    const h = (r.HORAIRES || {})[j] || [];
    if (!Array.isArray(h) || h.length > 3) throw new Error('Horaires invalides.');
    o.HORAIRES[j] = h.map(p => plage(p, 'Horaires'));
  }
  o.DEBUT_SEULEMENT = r.DEBUT_SEULEMENT !== false;

  // Fermetures, créneaux bloqués, ouvertures exceptionnelles (les dates passées sont retirées)
  o.JOURS_FERMES = [...new Set((r.JOURS_FERMES || []).filter(d => DATE.test(d) && d >= aujourdhui))].sort();
  if (o.JOURS_FERMES.length > 200) throw new Error('Trop de jours fermés.');
  o.CRENEAUX_BLOQUES = {};
  Object.keys(r.CRENEAUX_BLOQUES || {}).filter(d => DATE.test(d) && d >= aujourdhui).sort().forEach(d => {
    const hs = [...new Set((r.CRENEAUX_BLOQUES[d] || []).filter(h => HEURE.test(h)))].sort();
    if (hs.length) o.CRENEAUX_BLOQUES[d] = hs.slice(0, 48);
  });
  o.OUVERTURES_EXCEPTION = {};
  Object.keys(r.OUVERTURES_EXCEPTION || {}).filter(d => DATE.test(d) && d >= aujourdhui).sort().forEach(d => {
    const ps = (r.OUVERTURES_EXCEPTION[d] || []).map(p => plage(p, 'Ouverture du ' + d));
    if (ps.length) o.OUVERTURES_EXCEPTION[d] = ps.slice(0, 3);
  });

  // Règles
  o.PAS_CRENEAUX = nb(r.PAS_CRENEAUX, 15, 240, 'Intervalle entre créneaux (minutes)');
  o.DELAI_MIN_HEURES = nb(r.DELAI_MIN_HEURES, 0, 720, 'Délai minimum (heures)');
  o.JOURS_MAX_A_L_AVANCE = nb(r.JOURS_MAX_A_L_AVANCE, 1, 365, 'Réservation possible jusqu\'à (jours)');
  o.RAPPEL_MINUTES = nb(r.RAPPEL_MINUTES, 0, 2880, 'Rappel dans l\'agenda (minutes)');
  o.EXPIRATION_ATTENTE_HEURES = nb(r.EXPIRATION_ATTENTE_HEURES, 1, 336, 'Délai pour envoyer l\'acompte (heures)');
  o.MAX_DEMANDES_PAR_EMAIL = nb(r.MAX_DEMANDES_PAR_EMAIL, 1, 20, 'Demandes en attente par email');

  // Paiement, lieu
  o.ACOMPTE = txt(r.ACOMPTE, 20, 'Acompte');
  o.SUPPLEMENT_DOMICILE = txt(r.SUPPLEMENT_DOMICILE, 20, 'Supplément à domicile');
  o.WERO_NUMERO = txt(r.WERO_NUMERO, 30, 'Numéro Wero');
  o.ADRESSE_SALON = txt(r.ADRESSE_SALON, 200, 'Adresse');
  if (!o.ACOMPTE || !o.WERO_NUMERO) throw new Error('L\'acompte et le numéro Wero sont obligatoires.');

  // Boutiques
  if (!Array.isArray(r.BOUTIQUES) || r.BOUTIQUES.length > 15) throw new Error('15 boutiques maximum.');
  o.BOUTIQUES = r.BOUTIQUES.map(b => ({ nom: txt(b.nom, 60, 'Nom de boutique'),
    adresse: txt(b.adresse, 150, 'Adresse de boutique'), tel: txt(b.tel, 30, 'Téléphone de boutique') }))
    .filter(b => b.nom);

  if (JSON.stringify(o).length > 8500) throw new Error('Trop de réglages enregistrés : supprime d\'anciennes fermetures ou créneaux bloqués.');
  return o;
}

// ============================== ADMINISTRATION ==============================

const SESSION_SECONDES = 6 * 3600;   // une connexion reste valable 6 h
const ESSAIS_MAX = 8;                // au-delà, la connexion est bloquée 15 min

/** Point d'entrée de la page d'administration (POST { action: 'admin', op, ... }). */
function admin_(d) {
  const cache = CacheService.getScriptCache();

  if (d.op === 'connexion') {
    const echecs = Number(cache.get('adm_echecs') || 0);
    if (echecs >= ESSAIS_MAX) return { ok: false, erreur: 'Trop d\'essais. Réessaie dans 15 minutes.' };
    if (!motDePasseCorrect_(String(d.motDePasse || ''))) {
      cache.put('adm_echecs', String(echecs + 1), 900);
      Utilities.sleep(800);
      return { ok: false, erreur: 'Mot de passe incorrect.' };
    }
    cache.remove('adm_echecs');
    const jeton = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    cache.put('adm_' + jeton, '1', SESSION_SECONDES);
    return { ok: true, jeton };
  }

  // Toutes les autres opérations exigent une session valide
  const jeton = String(d.jeton || '');
  if (!/^[a-f0-9]{64}$/.test(jeton) || !cache.get('adm_' + jeton)) {
    return { ok: false, session: false, erreur: 'Session expirée, reconnecte-toi.' };
  }
  cache.put('adm_' + jeton, '1', SESSION_SECONDES); // prolonge la session

  switch (d.op) {
    case 'deconnexion':
      cache.remove('adm_' + jeton);
      return { ok: true };
    case 'etat':
      return { ok: true, reglages: reglagesActuels_(), rdv: listeRdvAdmin_(), urlFeuille: urlFeuille_() };
    case 'enregistrer': {
      const propre = valideReglages_(d.reglages);
      PropertiesService.getScriptProperties().setProperty('REGLAGES', JSON.stringify(propre));
      CLES_REGLAGES.forEach(k => { CONFIG[k] = propre[k]; });
      return { ok: true, reglages: propre, message: 'Réglages enregistrés ✅ Le site est déjà à jour.' };
    }
    case 'rdv':
      if (['valider', 'refuser', 'annuler', 'supprimer'].indexOf(d.quoi) === -1) throw new Error('Action inconnue.');
      return { ok: true, message: actionRdv_(String(d.id || ''), d.quoi), rdv: listeRdvAdmin_() };
    case 'motdepasse': {
      if (!motDePasseCorrect_(String(d.actuel || ''))) return { ok: false, erreur: 'Mot de passe actuel incorrect.' };
      const nouveau = String(d.nouveau || '');
      if (nouveau.length < 10) return { ok: false, erreur: 'Le nouveau mot de passe doit faire au moins 10 caractères.' };
      const props = PropertiesService.getScriptProperties();
      const sel = Utilities.getUuid();
      props.setProperty('ADMIN_HASH', sel + ':' + hash_(sel + nouveau));
      props.deleteProperty('ADMIN_MOT_DE_PASSE');
      return { ok: true, message: 'Mot de passe modifié ✅' };
    }
    default:
      throw new Error('Opération inconnue.');
  }
}

function motDePasseCorrect_(saisi) {
  const props = PropertiesService.getScriptProperties();
  const h = props.getProperty('ADMIN_HASH');
  if (h) {
    const [sel, attendu] = h.split(':');
    return egal_(hash_(sel + saisi), attendu);
  }
  const clair = props.getProperty('ADMIN_MOT_DE_PASSE');
  if (!clair || clair.length < 10) throw new Error('Mot de passe admin non configuré (propriété ADMIN_MOT_DE_PASSE, 10 caractères minimum).');
  return egal_(hash_(saisi), hash_(clair));
}

function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/** Comparaison en temps constant. */
function egal_(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Rendez-vous des 60 derniers jours et à venir, sans les jetons secrets. */
function listeRdvAdmin_() {
  const sh = feuille_();
  if (sh.getLastRow() < 2) return [];
  const limite = Date.now() - 60 * 86400000;
  const expiration = Date.now() - CONFIG.EXPIRATION_ATTENTE_HEURES * 3600000;
  return sh.getRange(2, 1, sh.getLastRow() - 1, COLONNES.length).getValues()
    .map(v => {
      const o = {};
      COLONNES.forEach((c, i) => { o[c] = v[i] instanceof Date ? v[i].toISOString() : String(v[i]); });
      return o;
    })
    .filter(o => o.id && new Date(o.debut).getTime() >= limite)
    .map(o => ({
      id: o.id, statut: o.statut, prestation: o.prestation, debut: o.debut, fin: o.fin,
      quand: formatQuand_(new Date(o.debut)), nom: o.nom, email: o.email, telephone: o.telephone,
      message: o.message, lieu: o.lieu, adresse: o.adresse, creeLe: o.creeLe,
      expire: o.statut === STATUT.ATTENTE && new Date(o.creeLe).getTime() < expiration,
      messageWero: 'Acompte ' + o.nom + ' ' + Utilities.formatDate(new Date(o.debut), CONFIG.FUSEAU, 'dd/MM'),
    }))
    .sort((a, b) => new Date(a.debut) - new Date(b.debut));
}

function urlFeuille_() {
  try { return SpreadsheetApp.getActiveSpreadsheet().getUrl(); } catch (e) { return ''; }
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
    ? [rdv.lieu === 'domicile' ? 'À DOMICILE (+' + CONFIG.SUPPLEMENT_DOMICILE + ') : ' + rdv.adresse : '',
       'Client : ' + rdv.nom, 'Email : ' + rdv.email, rdv.telephone ? 'Tél : ' + rdv.telephone : '',
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
  const lieuEvt = rdv.lieu === 'domicile' && rdv.adresse ? rdv.adresse : CONFIG.LIEU;
  if (lieuEvt) lignes.push('LOCATION:' + icsTexte_(lieuEvt));
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

/** Plie les lignes à 75 octets UTF-8 (RFC 5545), sans couper un caractère accentué. */
function plieLigne_(l) {
  const octets = c => { const n = c.codePointAt(0); return n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4; };
  const out = [];
  let cour = '', taille = 0;
  for (const c of l) {
    const t = octets(c);
    if (taille + t > 75) { out.push(cour); cour = ' '; taille = 1; }
    cour += c; taille += t;
  }
  out.push(cour);
  return out.join('\r\n');
}

// ============================== PAGE D'EXAMEN ==============================

function pageExamen_(id, token) {
  const { rdv } = trouveRdv_(id);
  const t = HtmlService.createTemplate(PAGE_EXAMEN);
  t.valide = !!(rdv && rdv.token === token);
  t.rdv = t.valide ? {
    id: rdv.id, token: rdv.token, statut: rdv.statut, nom: rdv.nom, email: rdv.email,
    statutTxt: ({ en_attente: 'En attente de l\'acompte', valide: 'Validé', refuse: 'Refusé', annule: 'Annulé' })[rdv.statut] || rdv.statut,
    messageWero: 'Acompte ' + rdv.nom + ' ' + Utilities.formatDate(new Date(rdv.debut), CONFIG.FUSEAU, 'dd/MM'),
    acompte: CONFIG.ACOMPTE,
    telephone: rdv.telephone, message: rdv.message, prestation: rdv.prestation,
    quand: formatQuand_(new Date(rdv.debut)),
    lieu: rdv.lieu === 'domicile' ? 'À domicile (+' + CONFIG.SUPPLEMENT_DOMICILE + ') : ' + rdv.adresse : 'Chez Naboo',
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
    ss.setSpreadsheetTimeZone(CONFIG.FUSEAU);
    [3, 7, 8].forEach(c => sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('dd/MM/yyyy HH:mm'));
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
  return jours[Number(f('u'))] + ' ' + Number(f('d')) + ' ' + mois[Number(f('M')) - 1] + ' à ' + f('HH') + 'h' + f('mm');
}

function prop_(k) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error('Propriété du script manquante : ' + k);
  return v;
}

function urlWebApp_() {
  return PropertiesService.getScriptProperties().getProperty('URL_WEBAPP') || ScriptApp.getService().getUrl();
}

/** Force Sheets à stocker la valeur comme texte brut. */
function t_(s) { return s === '' ? '' : "'" + String(s); }

/** Bloque l'appel d'une fonction d'administration depuis le web par un inconnu. */
function proprietaireSeulement_() {
  const moi = Session.getEffectiveUser().getEmail();
  const actif = Session.getActiveUser().getEmail();
  if (!actif || actif !== moi) throw new Error('Action réservée à la propriétaire.');
}

function nettoie_(s, max) { return String(s || '').trim().slice(0, max); }

function esc_(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ============================== PAGE D'EXAMEN (HTML) ==============================
// Page ouverte depuis le lien « Examiner la demande » de l'email.

const PAGE_EXAMEN = `<!DOCTYPE html>
<html lang="fr">
<head>
  <base target="_top">
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; background: #f6f3ee; color: #1d2b27; margin: 0; padding: 24px 16px; }
    .carte { max-width: 460px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,.06); }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .quand { color: #8a6440; font-weight: 600; margin-bottom: 16px; }
    dl { margin: 0 0 20px; } dt { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7a75; margin-top: 10px; } dd { margin: 2px 0 0; word-break: break-word; }
    .actions { display: flex; gap: 10px; }
    button { flex: 1; border: 0; border-radius: 10px; padding: 14px; font-size: 16px; font-weight: 600; cursor: pointer; }
    .ok { background: #8a6440; color: #fff; } .non { background: #f1e4e1; color: #8a2f22; }
    button:disabled { opacity: .5; cursor: wait; }
    .msg { margin-top: 16px; padding: 12px; border-radius: 10px; background: #eef6f3; display: none; }
    .msg.err { background: #fbeceb; color: #8a2f22; }
    .rappel { background: #f4ece2; border-radius: 10px; padding: 10px 12px; font-size: 14px; margin: 0 0 14px; }
    dd a { color: #8a6440; }
    .statut { display: inline-block; padding: 4px 10px; border-radius: 99px; background: #eee; font-size: 13px; }
  </style>
</head>
<body>
  <div class="carte">
  <? if (!valide) { ?>
    <h1>Lien invalide</h1>
    <p>Cette demande est introuvable ou le lien est incorrect.</p>
  <? } else { ?>
    <h1><?= rdv.prestation ?> — <?= rdv.nom ?></h1>
    <div class="quand"><?= rdv.quand ?></div>
    <dl>
      <dt>Lieu</dt><dd><?= rdv.lieu ?></dd>
      <dt>Email</dt><dd><?= rdv.email ?></dd>
      <? if (rdv.telephone) { ?><dt>Téléphone</dt><dd><a href="tel:<?= rdv.telephone ?>"><?= rdv.telephone ?></a></dd><? } ?>
      <? if (rdv.message) { ?><dt>Message</dt><dd><?= rdv.message ?></dd><? } ?>
      <dt>Statut</dt><dd><span class="statut"><?= rdv.statutTxt ?></span></dd>
    </dl>
    <? if (rdv.statut === 'en_attente') { ?>
      <p class="rappel">Avant de valider, vérifie dans Wero que l'acompte de <?= rdv.acompte ?> est arrivé, avec le message « <?= rdv.messageWero ?> ».</p>
      <div class="actions">
        <button class="ok" onclick="decide('valider')">Valider</button>
        <button class="non" onclick="decide('refuser')">Refuser</button>
      </div>
    <? } ?>
    <div class="msg" id="msg"></div>
    <script>
      var ID = <?!= JSON.stringify(rdv.id) ?>, TOKEN = <?!= JSON.stringify(rdv.token) ?>;
      function decide(d) {
        if (d === 'refuser' && !confirm('Refuser cette demande ?')) return;
        document.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
        google.script.run
          .withSuccessHandler(function (t) { afficher(t, false); var a = document.querySelector('.actions'); if (a) a.remove(); })
          .withFailureHandler(function (e) { afficher('Erreur : ' + e.message, true); document.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); })
          .decider(ID, TOKEN, d);
      }
      function afficher(t, err) { var m = document.getElementById('msg'); m.textContent = t; m.className = 'msg' + (err ? ' err' : ''); m.style.display = 'block'; }
    </script>
  <? } ?>
  </div>
</body>
</html>`;
