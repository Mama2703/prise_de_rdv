/**
 * Tests du backend (Code.gs) sans Google : les services Apps Script sont simulés.
 * Lancer :  node tests/backend.test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ---------- Horloge figée : vendredi 30 octobre 2026, 21 h (Paris) ----------
const MAINTENANT = Date.parse('2026-10-30T20:00:00Z');
Date.now = () => MAINTENANT;

// ---------- Simulations minimales des services Apps Script ----------
function partiesTZ(d, tz) {
  const o = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(d).forEach(p => { o[p.type] = p.value; });
  return o;
}
const JS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
global.Utilities = {
  formatDate(d, tz, f) {
    const p = partiesTZ(d, tz);
    return f.split(/('[^']*')/).map(seg => seg.startsWith("'") ? seg.slice(1, -1) : seg
      .replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour)
      .replace('mm', p.minute).replace('ss', p.second).replace(/\bu\b/, JS[p.weekday])
      .replace(/\bd\b/, Number(p.day)).replace(/\bM\b/, Number(p.month))).join('');
  },
  parseDate(s, tz) {
    const [D, T] = s.split(' ');
    const [y, mo, da] = D.split('-').map(Number);
    const [h, mi] = T.split(':').map(Number);
    const voulu = Date.UTC(y, mo - 1, da, h, mi);
    let g = voulu;
    for (let k = 0; k < 2; k++) {
      const p = partiesTZ(new Date(g), tz);
      g += voulu - Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute);
    }
    return new Date(g);
  },
};
let LIGNES = [];
global.SpreadsheetApp = {
  getActiveSpreadsheet: () => ({
    getSheetByName: () => ({
      getLastRow: () => LIGNES.length + 1,
      getRange: (r, c, n) => ({ getValues: () => LIGNES.slice(r - 2, r - 2 + n) }),
    }),
  }),
};

// ---------- Chargement du code ----------
const code = fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8');
const B = new Function(code + '; return { creneauxLibres_, construireIcs_, plieLigne_, formatQuand_, dateParis_, CONFIG, STATUT };')();

// Ligne de la feuille : [id, token, creeLe, statut, prestationId, prestation, debut, fin, ...]
function ligne(id, statut, debutParis, dureeH, creeIlYaH = 1) {
  const [d, h] = debutParis.split(' ');
  const debut = B.dateParis_(d, h);
  return [id, 't', new Date(MAINTENANT - creeIlYaH * 3600000), statut, 'x', 'x',
    debut, new Date(debut.getTime() + dureeH * 3600000), 'Nom', 'a@b.fr', '0700000000', '', '', 'salon', ''];
}

// ---------- Tests ----------
let ok = 0, ko = 0;
function test(nom, f) {
  LIGNES = [];
  try { f(); ok++; console.log('  ✓ ' + nom); }
  catch (e) { ko++; console.log('  ✗ ' + nom + '\n      ' + e.message); }
}

console.log('Créneaux');
test('samedi : créneaux de 9 h à 16 h, toutes les heures', () => {
  assert.deepStrictEqual(B.creneauxLibres_('2026-11-07', 'braids'),
    ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
});
test('en semaine : aucun créneau', () => {
  assert.deepStrictEqual(B.creneauxLibres_('2026-11-10', 'braids'), []);
});
test('moins de 48 h avant : aucun créneau (dimanche 1er novembre)', () => {
  assert.deepStrictEqual(B.creneauxLibres_('2026-11-01', 'twist'), []);
});
test('au-delà de 45 jours : aucun créneau', () => {
  assert.deepStrictEqual(B.creneauxLibres_('2027-01-16', 'twist'), []);
});
test('prestation ou date invalide : aucun créneau', () => {
  assert.deepStrictEqual(B.creneauxLibres_('2026-11-07', 'inconnue'), []);
  assert.deepStrictEqual(B.creneauxLibres_('7/11/2026', 'twist'), []);
});
test('un RDV validé de 10 h à 15 h bloque les créneaux qui chevauchent', () => {
  LIGNES = [ligne('R1', 'valide', '2026-11-07 10:00', 5)];
  // nattes collées = 2 h : 9 h finirait à 11 h (chevauche), 15 h et 16 h sont libres
  assert.deepStrictEqual(B.creneauxLibres_('2026-11-07', 'nattes-collees'), ['15:00', '16:00']);
});
test('une demande en attente récente bloque aussi le créneau', () => {
  LIGNES = [ligne('R1', 'en_attente', '2026-11-07 09:00', 2, 3)];
  assert.ok(!B.creneauxLibres_('2026-11-07', 'nattes-collees').includes('10:00'));
});
test('une demande en attente depuis plus de 24 h (sans acompte) libère le créneau', () => {
  LIGNES = [ligne('R1', 'en_attente', '2026-11-07 09:00', 2, 30)];
  assert.ok(B.creneauxLibres_('2026-11-07', 'nattes-collees').includes('09:00'));
});
test('un RDV refusé ou annulé ne bloque rien', () => {
  LIGNES = [ligne('R1', 'refuse', '2026-11-07 09:00', 8), ligne('R2', 'annule', '2026-11-07 09:00', 8)];
  assert.strictEqual(B.creneauxLibres_('2026-11-07', 'braids').length, 8);
});
test('jour fermé (congés) : aucun créneau', () => {
  B.CONFIG.JOURS_FERMES.push('2026-11-14');
  try { assert.deepStrictEqual(B.creneauxLibres_('2026-11-14', 'twist'), []); }
  finally { B.CONFIG.JOURS_FERMES.pop(); }
});

console.log('Dates et fichier agenda');
test('10 h à Paris = 9 h UTC en novembre (heure d\'hiver)', () => {
  assert.strictEqual(B.dateParis_('2026-11-07', '10:00').toISOString(), '2026-11-07T09:00:00.000Z');
});
test('date lisible en français', () => {
  assert.strictEqual(B.formatQuand_(B.dateParis_('2026-11-07', '10:00')), 'samedi 7 novembre à 10h00');
});
test('événement .ics : heures en UTC, adresse à domicile en lieu', () => {
  const d = B.dateParis_('2026-11-07', '10:00');
  const ics = B.construireIcs_('u@rdv', d, new Date(d.getTime() + 4 * 3600000),
    { prestation: 'Twist', nom: 'Awa', email: 'a@b.fr', telephone: '07', message: '', lieu: 'domicile', adresse: '3 rue X, Poitiers' }, true);
  assert.ok(ics.includes('DTSTART:20261107T090000Z'));
  assert.ok(ics.includes('DTEND:20261107T130000Z'));
  assert.ok(ics.includes('LOCATION:3 rue X\\, Poitiers'));
  assert.ok(ics.includes('TRIGGER:-PT60M'));
});
test('lignes .ics pliées à 75 octets maximum, accents compris', () => {
  const longue = 'DESCRIPTION:' + 'é'.repeat(100);
  B.plieLigne_(longue).split('\r\n').forEach(l => assert.ok(Buffer.byteLength(l, 'utf8') <= 75));
  assert.strictEqual(B.plieLigne_(longue).split('\r\n').map((l, i) => i ? l.slice(1) : l).join(''), longue);
});

console.log(`\n${ok} réussi(s), ${ko} échoué(s)`);
process.exit(ko ? 1 : 0);
