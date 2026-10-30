# Naboo — prise de rendez-vous

Site de réservation de **Naboo, coiffure afro à Poitiers** : https://mama2703.github.io/prise_de_rdv/

La cliente choisit une prestation, un créneau du week-end et le lieu (chez Naboo ou à domicile), puis envoie l'acompte
de 10 € par Wero. Quand Naboo **valide** la demande, l'événement est créé instantanément dans son **agenda iCloud**
(iPhone, Mac, iPad) et la cliente reçoit sa confirmation par email.

```
Cliente ──▶ site (GitHub Pages) ──▶ Apps Script (Google, gratuit) ──▶ Google Sheet (historique)
                                         │
       email « Examiner la demande » ◀───┤
   Naboo : acompte reçu sur Wero ? « Valider » ──▶ iCloud CalDAV ──▶ agenda Apple
                                         └──▶ email de confirmation + fichier .ics à la cliente
```

| Fichier | Rôle |
|---|---|
| `index.html` | Le site (une seule page). Sans backend branché, il tourne en **mode démo**. |
| `backend/Code.gs` | Le backend à coller dans Google Apps Script (un seul fichier) |
| `outils/trouver_calendrier_icloud.py` | Trouve l'URL CalDAV de ton calendrier iCloud (à lancer une fois) |
| `tests/backend.test.js` | Tests automatisés des créneaux et du fichier agenda : `node tests/backend.test.js` |

## Règles en place

- Prestations : Braids 40 €, Crochet Locks 45 €, Twist 45 €, Nattes Collées 30 €, Tissage Ouvert 50 € — durées indicatives dans `CONFIG.PRESTATIONS`.
- Samedi et dimanche, **début entre 9 h et 16 h**, un créneau par heure.
- Réservation **au moins 48 h** à l'avance, jusqu'à 45 jours.
- **Acompte de 10 € par Wero** au 07 52 34 16 52, déduit du prix, non remboursable si annulation à moins de 24 h.
- Une demande **sans acompte depuis 24 h** libère automatiquement son créneau.
- Au maximum **2 demandes en attente** par adresse email (anti-abus).
- **À domicile dans Poitiers : +15 €** (l'adresse de la cliente devient le lieu de l'événement).
- **Mèches non fournies** : liste de boutiques dans `index.html` (`BOUTIQUES`).

Tout se règle dans le bloc `CONFIG` en haut de `backend/Code.gs` (et pour l'affichage, dans `index.html`).

---

## Mise en route du backend (≈ 15 min, plutôt sur ordinateur)

### 1. Apple : mot de passe pour app + URL du calendrier

1. Sur <https://account.apple.com> → **Connexion et sécurité** → **Mots de passe pour app** → crée-en un
   (« RDV Naboo »). Il ne donne accès qu'à iCloud et peut être révoqué à tout moment.
2. *(Conseillé)* Dans l'app Calendrier, crée un calendrier iCloud **« Naboo »**.
3. Sur l'ordinateur : `python3 outils/trouver_calendrier_icloud.py` et copie l'URL du calendrier voulu.

### 2. Google : le backend

1. Crée une Google Sheet vide (« RDV Naboo »), puis **Extensions → Apps Script**.
2. Remplace le contenu de `Code.gs` par celui de `backend/Code.gs` (un seul fichier à coller). Faisable sur iPhone dans Safari en « version pour ordinateur ».
3. *(Facultatif)* Renseigne `ADRESSE_SALON` dans `CONFIG` : elle n'est envoyée que dans l'email de confirmation.
4. **⚙ Paramètres du projet → Propriétés du script** :

   | Propriété | Valeur |
   |---|---|
   | `ICLOUD_IDENTIFIANT` | ton identifiant Apple (email) |
   | `ICLOUD_MOT_DE_PASSE_APP` | le mot de passe pour app |
   | `ICLOUD_URL_CALENDRIER` | l'URL trouvée à l'étape 1 |
   | `EMAIL_PROPRIETAIRE` | l'email où tu reçois les demandes |

5. Exécute **`testerIcloud`** depuis l'éditeur et accepte les autorisations. Attendu : « Connexion iCloud OK ✅ ».
6. **Déployer → Nouveau déploiement → Application Web** : exécuter en tant que **Moi**, accès **Tout le monde**.
   Copie l'URL `…/exec` et ajoute-la aussi en propriété `URL_WEBAPP`.
7. Donne l'URL `…/exec` à Claude (ou remplace `COLLER_ICI_URL_APPS_SCRIPT` dans `index.html`) : le mode démo disparaît.

> Après chaque modification de `Code.gs` : **Déployer → Gérer les déploiements → ✏️ → Nouvelle version**.

## Au quotidien

- Nouvelle demande → email → vérifie l'acompte dans Wero (message « Acompte Prénom Nom JJ/MM ») → **Examiner** → **Valider** ou **Refuser**.
- **Annuler un RDV validé** : dans la Sheet, sélectionne la ligne → menu **Rendez-vous → Annuler le RDV…**
  (supprime l'événement iCloud et prévient la cliente).
- **Congés** : ajoute les dates dans `JOURS_FERMES`, puis redéploie une nouvelle version.

## Limites connues

- Les créneaux tiennent compte des rendez-vous du site, **pas** des autres événements de ton agenda iCloud.
- Pas de temps de trajet ajouté automatiquement pour les rendez-vous à domicile.
- Quota Google gratuit : ~100 emails/jour (2 par demande, 1 par validation).
- Mentions légales : pas de SIRET pour l'instant ; à ajouter dans la rubrique « Mentions légales » de `index.html` si l'activité est déclarée un jour.
