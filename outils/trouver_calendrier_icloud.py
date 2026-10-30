#!/usr/bin/env python3
"""
Trouve l'URL CalDAV de tes calendriers iCloud (à lancer une seule fois sur ton ordinateur).

Usage :  python3 trouver_calendrier_icloud.py
Il te demande ton identifiant Apple et un mot de passe pour app
(à créer sur https://account.apple.com > Connexion et sécurité > Mots de passe pour app).
Rien n'est enregistré : le script affiche juste la liste des calendriers et leur URL.
"""
import base64
import getpass
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from urllib.parse import urljoin

NS = {"d": "DAV:", "c": "urn:ietf:params:xml:ns:caldav"}
RACINE = "https://caldav.icloud.com/"


def propfind(url, corps, auth, depth="0", sauts=0):
    req = urllib.request.Request(
        url, data=corps.encode("utf-8"), method="PROPFIND",
        headers={"Authorization": auth, "Depth": depth,
                 "Content-Type": "application/xml; charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.geturl(), ET.fromstring(r.read())
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 307, 308) and e.headers.get("Location") and sauts < 5:
            return propfind(urljoin(url, e.headers["Location"]), corps, auth, depth, sauts + 1)
        if e.code == 401:
            sys.exit("Identifiants refusés (401). Vérifie l'identifiant Apple et le mot de passe pour app.")
        sys.exit(f"Erreur HTTP {e.code} sur {url}")


def href(arbre, chemin):
    el = arbre.find(chemin, NS)
    if el is None or not (el.text or "").strip():
        sys.exit("Réponse iCloud inattendue : " + chemin)
    return el.text.strip()


def main():
    ident = input("Identifiant Apple (email) : ").strip()
    mdp = getpass.getpass("Mot de passe pour app (xxxx-xxxx-xxxx-xxxx) : ").strip()
    auth = "Basic " + base64.b64encode(f"{ident}:{mdp}".encode()).decode()

    # 1. Principal de l'utilisateur
    url, a = propfind(RACINE, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
                      '<d:current-user-principal/></d:prop></d:propfind>', auth)
    principal = urljoin(url, href(a, ".//d:current-user-principal/d:href"))

    # 2. Dossier des calendriers
    url, a = propfind(principal, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
                      'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/>'
                      '</d:prop></d:propfind>', auth)
    maison = urljoin(url, href(a, ".//c:calendar-home-set/d:href"))

    # 3. Liste des calendriers
    url, a = propfind(maison, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
                      'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/>'
                      '<d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>',
                      auth, depth="1")

    trouves = []
    for rep in a.findall("d:response", NS):
        if rep.find(".//d:resourcetype/c:calendar", NS) is None:
            continue
        comps = [c.get("name") for c in rep.findall(".//c:supported-calendar-component-set/c:comp", NS)]
        if comps and "VEVENT" not in comps:
            continue  # liste de rappels, pas un agenda
        nom = (rep.findtext(".//d:displayname", default="", namespaces=NS) or "(sans nom)").strip()
        trouves.append((nom, urljoin(url, rep.findtext("d:href", namespaces=NS).strip())))

    if not trouves:
        sys.exit("Aucun calendrier trouvé.")
    print("\nTes calendriers iCloud :\n")
    for nom, u in trouves:
        print(f"  • {nom}\n    {u}\n")
    print("Copie l'URL du calendrier voulu dans la propriété ICLOUD_URL_CALENDRIER du script Apps Script.")


if __name__ == "__main__":
    main()
