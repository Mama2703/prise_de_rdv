# Prise de rendez-vous → Agenda iCloud

Site de réservation hébergé sur GitHub Pages. Quand tu **valides** une demande, l'événement est créé
instantanément dans ton agenda iCloud (iPhone, Mac, iPad synchronisés en quelques secondes).

```
Client ──▶ site (GitHub Pages) ──▶ Apps Script (Google, gratuit) ──▶ Google Sheet (historique)
                                         │
              email « Examiner » ◀───────┤
   Toi : « Valider » ────────────────────┴──▶ iCloud CalDAV (PUT .ics) ──▶ ton agenda Apple
                                         └──▶ email de confirmation + .ics au client
```

| Dossier | Contenu |
|---|---|
| `index.html` | Le site client, publié sur https://mama2703.github.io/prise_de_rdv/ |
| `backend/Code.gs`, `backend/Examen.html` | Le backend à coller dans Google Apps Script |
| `outils/trouver_calendrier_icloud.py` | Trouve l'URL CalDAV de ton calendrier (à lancer une fois) |

Il te faut : un compte Apple (iCloud), un compte Google (pour Apps Script, gratuit), un compte GitHub.

---

## 1. Côté Apple : mot de passe pour app + URL du calendrier

1. Sur <https://account.apple.com> → **Connexion et sécurité** → **Mots de passe pour app** → crée-en un
   (nom : « RDV site »). Note-le (`xxxx-xxxx-xxxx-xxxx`). Il ne donne accès qu'à iCloud (agenda, contacts…),
   pas à ton compte Apple, et tu peux le révoquer à tout moment.
2. *(Conseillé)* Dans l'app Calendrier, crée un calendrier iCloud dédié, ex. **« Rendez-vous clients »**.
3. Sur ton ordinateur :
   ```bash
   python3 outils/trouver_calendrier_icloud.py
   ```
   Copie l'URL du calendrier voulu (forme `https://pXX-caldav.icloud.com/123456789/calendars/XXXX/`).

## 2. Côté Google : le backend

1. Crée une Google Sheet vide (ex. « RDV clients »).
2. **Extensions → Apps Script**. Remplace le contenu de `Code.gs` par `backend/Code.gs`.
3. **+ → HTML**, nomme-le exactement `Examen`, colle `backend/Examen.html`.
4. Adapte le bloc `CONFIG` en haut de `Code.gs` : nom de l'activité, prestations, horaires, jours fermés, lieu.
5. **⚙ Paramètres du projet → Propriétés du script**, ajoute :

   | Propriété | Valeur |
   |---|---|
   | `ICLOUD_IDENTIFIANT` | ton identifiant Apple (email) |
   | `ICLOUD_MOT_DE_PASSE_APP` | le mot de passe pour app de l'étape 1 |
   | `ICLOUD_URL_CALENDRIER` | l'URL trouvée par le script Python |
   | `EMAIL_PROPRIETAIRE` | l'email où tu reçois les demandes |

   *(Les secrets restent côté Google, jamais dans le site public.)*
6. Dans l'éditeur, choisis la fonction **`testerIcloud`** → **Exécuter**. Accepte les autorisations
   (« Application non validée » → Paramètres avancés → Accéder au projet : normal, c'est ton propre script).
   Le journal doit afficher « Connexion iCloud OK ✅ ».
7. **Déployer → Nouveau déploiement** → type **Application Web** :
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde**

   Copie l'URL (`https://script.google.com/macros/s/…/exec`).
8. *(Recommandé)* Ajoute la propriété `URL_WEBAPP` = cette URL, pour que les liens des emails pointent
   toujours vers le déploiement actif.

> ⚠️ Après chaque modification de `Code.gs` : **Déployer → Gérer les déploiements → ✏️ → Version : Nouvelle version**,
> sinon le site continue d'utiliser l'ancienne version (l'URL ne change pas).

## 3. Côté GitHub : le site

1. Dans `index.html`, remplace `COLLER_ICI_URL_APPS_SCRIPT` par l'URL `/exec`.
2. Crée un dépôt (ex. `rendez-vous`), pousse `index.html` à la racine.
3. **Settings → Pages → Deploy from a branch → main / root**.
   Le site est en ligne sur `https://<ton-pseudo>.github.io/rendez-vous/`.

Tant que l'URL n'est pas renseignée, la page tourne en **mode démo** (données fictives), pratique pour
tester le design.

## 4. Au quotidien

- Une demande arrive → tu reçois un email → **Examiner la demande** → **Valider** ou **Refuser**.
- Valider : l'événement apparaît dans ton agenda Apple (avec nom, email, téléphone, message du client et
  une alerte 1 h avant), le client reçoit sa confirmation avec un fichier `.ics`.
- Le créneau est bloqué dès la **demande** (pour éviter deux demandes sur le même créneau) et libéré si tu refuses.
- **Annuler un RDV validé** : dans la Sheet, sélectionne sa ligne → menu **Rendez-vous → Annuler le RDV…**
  (supprime l'événement iCloud et prévient le client).
- Les congés : ajoute les dates dans `JOURS_FERMES`, puis redéploie une nouvelle version.

## Limites à connaître

- Les créneaux libres sont calculés à partir de tes horaires et des RDV de la Sheet, **pas** des autres
  événements de ton agenda iCloud (un rendez-vous perso n'est pas vu). Comme tu valides chaque demande
  à la main, tu gardes la main sur les conflits.
- Quotas Apps Script gratuits : ~100 emails/jour avec un compte Gmail perso (2 emails par demande + 1 par validation).
- **RGPD** : tu stockes les nom/email/téléphone de clients. Pour une activité pro, ajoute une courte mention
  (finalité : gestion des RDV ; durée de conservation ; contact pour suppression) et supprime les vieilles lignes
  de la Sheet régulièrement.
