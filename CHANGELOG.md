# Journal des versions — RefBoard

Format : une section par version, la plus recente en haut.
Version = celle de l extension (extension/manifest.json) ; le site suit le depot (git log).

## Site — en cours (non publié)

- Lecture des vidéos sur la planche : une fine ligne de lecture apparaît au survol (jamais cliquable).
  Un clic sur une vidéo la sélectionne et la met en pause, un reclic relance ou remet en pause.
  Glisser dans une vidéo déjà sélectionnée déplace la tête de lecture (droite avance, gauche recule) ;
  glisser une vidéo non sélectionnée la déplace comme avant.
- Flèches ← → : image par image sur la vidéo sélectionnée, Maj + flèches : 10 images.
  La cadence est mesurée pendant la lecture (30 i/s en attendant). En pause, le badge affiche le numéro d'image.
- Une vidéo mise en pause le reste, à la même image, quand elle est rechargée (zoom, défilement).

## 2.4.1 — 2026-11-17

- Icônes harmonisées sur l'icône officielle (`_Commun\icones_apps\RefBoard.svg`) : barre d'outils
  et fiche de l'extension (l'ancien dossier bleu disparaît), bouton posé sur les posts et popup.
- Le bouton des posts garde les couleurs du logo ; envoi, réussite et échec se lisent sur son fond.

## En cours (non publie)

- `build.bat` : publie le site (push de main, servi par GitHub Pages), apres confirmation ;
  refuse s il reste des changements non commites.
- `lancer.bat` : sert le site en local (http://localhost:8791).
- VERSION et CHANGELOG ajoutes.

## Historique avant ce journal (git log)

- 2026-11-10 : RefBoard installable sur téléphone : manifeste et icônes propres
- 2026-11-10 : RefBoard sur téléphone : barre réduite avec menu ☰, navigation au doigt
- 2026-11-09 : Extension 2.4.0 : icône Instagram sur l'image du post, clic droit sur le fil
- 2026-10-31 : Cadres : plus de coupure onglet/cadre à fort zoom. Extension : le clic sur l'icône ouvre RefBoard
- 2026-10-31 : Cadres : taille limitée au dézoom, poignée en arc, contour plus clair, palette de 12 couleurs
- 2026-10-31 : Extension : icône de RefBoard
- 2026-10-31 : Cadres : nouvel aspect, palette de 50 couleurs, icône de RefBoard
- 2026-10-31 : Page de confidentialité (demandée par Google pour publier l'app)
- 2026-10-31 : Cadres dynamiques, connexion Drive durable et images protégées par Cloudflare
- 2026-10-29 : Miro : bouton pour retrouver les images en échec
- 2026-10-29 : Reconnaît les fichiers sans type (images venues de Miro) et évite les vieilles versions en cache
- 2026-10-29 : Import depuis Miro (mini-app) et reprise des vidéos d'origine
- 2026-10-29 : Médias dans l'espace privé de l'app sur Drive, cache plafonné, export
- 2026-10-29 : Extension : recharge un onglet RefBoard qui ne répond pas
- 2026-10-29 : Extension « Vers RefBoard » et cartes YouTube
- 2026-10-29 : Ajoute l'identifiant client Google (projet refboard-513115)
- 2026-10-29 : RefBoard : canevas infini, rangement et synchronisation Google Drive
