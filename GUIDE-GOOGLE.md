# Brancher RefBoard sur Google Drive

À faire une seule fois (environ 10 minutes). Il en ressort un **identifiant client** à coller dans `js/config.js`.

## 1. Créer le projet

1. Va sur <https://console.cloud.google.com/> avec le compte Google dont tu veux utiliser le Drive.
2. En haut à gauche, clique sur le sélecteur de projet, puis **Nouveau projet**.
3. Nom : `RefBoard`. Clique sur **Créer**, puis sélectionne ce projet (vérifie qu'il est bien affiché en haut).

## 2. Activer l'API Google Drive

1. Menu ☰ → **API et services** → **Bibliothèque**.
2. Cherche **Google Drive API**, ouvre-la et clique sur **Activer**.

## 3. Configurer l'écran de connexion

1. Menu ☰ → **API et services** → **Écran de consentement OAuth** (la page peut s'appeler **Google Auth Platform**). Clique sur **Commencer**.
2. **Informations sur l'application** : nom `RefBoard`, adresse e-mail d'assistance = ton adresse.
3. **Audience** : **Externe**.
4. **Coordonnées** : ton adresse. Accepte les conditions, puis **Créer**.
5. Dans le menu de gauche, **Accès aux données** → **Ajouter ou supprimer des niveaux d'accès**. Coche
   `.../auth/drive.appdata` (l'espace privé de l'app) et `.../auth/drive.file`, puis **Mettre à jour** et **Enregistrer**.
6. Dans le menu de gauche, **Audience** → **Publier l'application** → **Confirmer**.
   `drive.file` est un niveau d'accès « non sensible » : aucune validation par Google n'est nécessaire.
   Si tu laisses l'app en mode « Test », il faut t'ajouter dans **Utilisateurs tests**, et Google peut redemander ton accord chaque semaine.

## 4. Créer l'identifiant client

1. Dans le menu de gauche, **Clients** (ou **Identifiants** → **Créer des identifiants** → **ID client OAuth**).
2. Type d'application : **Application Web**. Nom : `RefBoard web`.
3. **Origines JavaScript autorisées** : ajoute ces deux lignes.
   - `https://arkogelul.github.io` (la future adresse GitHub Pages, sans `/refboard` à la fin)
   - `http://localhost:8791` (pour tester sur ton PC)
4. **URI de redirection autorisés** : laisse vide.
5. Clique sur **Créer**, puis copie l'**ID client**. Il ressemble à `123456789-abc….apps.googleusercontent.com`.
   Le « code secret du client » ne sert pas : RefBoard n'en a pas besoin.

> Les nouvelles origines peuvent mettre quelques minutes à être prises en compte.

## 5. Coller l'identifiant dans RefBoard

Ouvre `js/config.js` et colle l'ID entre les guillemets :

```js
const CONFIG = {
  googleClientId: '123456789-abc….apps.googleusercontent.com',
};
```

Cet identifiant n'est pas un secret : il peut être publié sur GitHub sans risque.

## 6. Essayer

La connexion Google ne fonctionne pas avec une page ouverte d'un double-clic (`file://`). Il faut une vraie adresse :

- **soit sur GitHub Pages** (étape suivante) ;
- **soit en local** : dans un terminal ouvert dans le dossier `RefBoard`, lance `python -m http.server 8791`, puis ouvre <http://localhost:8791>.

Clique sur **Se connecter à Drive** en haut à droite, choisis ton compte et coche les deux autorisations.

RefBoard range tout dans son **espace privé** sur ton Drive : `board.json` (toutes les planches), les fichiers d'origine et les vignettes.
Cet espace compte dans ton stockage Drive, mais **Google Drive pour ordinateur ne le recopie jamais sur ton PC**.
Il n'apparaît pas dans « Mon Drive » : sa taille se voit dans Drive → ⚙ Paramètres → **Gérer les applications** → RefBoard.
Pour récupérer tous tes fichiers dans un dossier normal : bouton **Drive ✓** → **Tout exporter dans un dossier…**.

## Bon à savoir

- **Ce que RefBoard voit** : son espace privé, et les fichiers qu'il a créés lui-même. Le reste de ton Drive lui est invisible.
- **Ancien dossier « RefBoard »** (versions précédentes) : à la connexion, ses médias sont déplacés dans l'espace privé, puis le dossier part à la corbeille du Drive.
- **Cache du navigateur** : RefBoard garde toutes les vignettes, mais au plus 2 Go d'originaux sur ce PC. Les autres se retéléchargent quand tu zoomes dessus.
- **Session** : la connexion dure une heure. Ensuite, le bouton passe à « Reconnecter Drive », et ton premier clic dans la page rouvre la session (une petite fenêtre Google s'ouvre et se referme).
- **Médias supprimés d'une planche** : leurs fichiers restent 30 jours dans l'espace privé (le temps de changer d'avis), puis sont effacés.
- **Deux PC en même temps** : si tu modifies la même planche sur deux PC à la fois, c'est la dernière modification qui gagne pour cette planche.
