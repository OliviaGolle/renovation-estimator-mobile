# Estimateur de rénovation — version mobile (PWA)

Application web installable sur téléphone (Android et iOS), avec les mêmes
fonctionnalités que l'application de bureau : icône sur l'écran d'accueil,
fonctionne hors-ligne une fois installée, aucune boutique d'application requise.

## Tester rapidement depuis votre PC (même réseau Wi-Fi)

1. Double-cliquez sur `Lancer_Serveur_Mobile.bat` (Python doit être installé sur le PC).
2. Notez l'adresse IP affichée (ex: `192.168.1.23`).
3. Sur votre téléphone connecté au **même Wi-Fi**, ouvrez `http://192.168.1.23:8000`
   dans le navigateur.
4. Menu du navigateur → **"Ajouter à l'écran d'accueil"** (Chrome/Android) ou
   **"Sur l'écran d'accueil"** (Safari/iOS) → une icône de l'appli apparaît sur votre téléphone.

⚠️ En HTTP simple (pas HTTPS), le mode hors-ligne complet (service worker) peut être limité
selon le navigateur. Pour une expérience 100% "vraie appli installable" avec cache
hors-ligne, hébergez le dossier `mobile/` sur un service gratuit en HTTPS (voir ci-dessous).

## Héberger en HTTPS pour une vraie installation PWA (recommandé)

**Option simple : GitHub Pages**
1. Créez un dépôt GitHub et poussez le contenu du dossier `mobile/` à la racine.
2. Dans les paramètres du dépôt → Pages → activez la publication depuis la branche principale.
3. Ouvrez l'URL fournie (`https://votre-compte.github.io/votre-repo/`) sur votre téléphone.
4. "Ajouter à l'écran d'accueil" → l'appli s'installe avec icône + fonctionnement hors-ligne.

**Option glisser-déposer : Netlify Drop**
1. Allez sur https://app.netlify.com/drop
2. Glissez-déposez le dossier `mobile/` entier.
3. Ouvrez l'URL générée sur votre téléphone et installez-la comme ci-dessus.

## Modifier le catalogue produits

`mobile/data/products.json` est une copie du catalogue de l'appli de bureau
(`data/products.json`). Les prix/produits sont des **estimations indicatives**
inspirées des marques Leroy Merlin (Luxens, Artens, Sensa, Sensea, LMDESIGN,
Legrand Dooxie...) et non des données scrapées en temps réel — vérifiez les tarifs
réels avant tout engagement. Modifiez ce fichier pour les ajuster (gardez la même
structure que le fichier du dossier `data/`).

## Structure

```
mobile/
  index.html            page principale (onglets, formulaires, galeries)
  style.css              mise en page mobile
  app.js                  toute la logique (calculs, galeries, devis)
  manifest.json            métadonnées PWA (icône, nom, mode standalone)
  service-worker.js        mise en cache pour le mode hors-ligne
  data/products.json       catalogue produits (copie de l'appli de bureau)
  icons/                   icônes 192x192 et 512x512
  Lancer_Serveur_Mobile.bat  lance un serveur local pour tester depuis le téléphone
```
