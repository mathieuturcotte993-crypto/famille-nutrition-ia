# Famille Nutrition IA

Application web familiale de gestion alimentaire assistée par l'IA (Claude). Projet indépendant, sans dépendance ni étape de compilation : un seul fichier `index.html` et une fonction serverless `api/ai.js`.

## Les 4 pages

**1. Famille et macros** — Une fiche par personne : prénom, âge, sexe, poids, taille, niveau d'activité, objectif, calories quotidiennes et répartition des macronutriments en pourcentage (protéines / glucides / lipides), convertie automatiquement en grammes. Restrictions alimentaires par cases (sans gluten, sans lactose, végétarien, halal, keto, etc.), allergies précises, aliments aimés et aliments à éviter. Le bouton *Calculer* estime les besoins caloriques (Mifflin-St Jeor pour les adultes, formules pédiatriques pour les enfants) selon l'activité et l'objectif.

**2. Rabais de la semaine** — Sélection de la ville actuelle, de la province, du code postal et des magasins à analyser. L'IA consulte les circulaires de la semaine (recherche web) et retourne les meilleures aubaines : produit, catégorie, magasin, prix, format, prix régulier et pourcentage d'économie. Chaque ligne est modifiable, peut être décochée ou supprimée, et il est possible d'ajouter des items à la main ou de coller le texte d'une circulaire pour extraction automatique.

**3. Recettes IA** — Génération de recettes qui combinent les rabais retenus à la page 2 et les profils de la page 1 : quantités ajustées au nombre de personnes, calories et macros par portion, respect strict des restrictions et des allergies, temps de préparation maximal, budget cible et style de cuisine. Chaque recette affiche son coût par portion, le pourcentage d'ingrédients en rabais, les ingrédients avec magasin, les étapes et la répartition par personne. On choisit les recettes à conserver et le nombre de portions à préparer.

**4. Liste d'épicerie** — Générée automatiquement à partir des recettes choisies : fusion des ingrédients en double, conversion des unités, regroupement par épicerie accessible puis par rayon, coût estimé par magasin et total. Sélection des épiceries accessibles (liste modifiable), ajout d'articles manuels, cases à cocher pendant les courses, optimisation facultative par l'IA, copie, export en `.txt` et impression.

## Configuration

1. Ouvrir l'application, cliquer sur **Réglages**.
2. Coller votre clé API Anthropic (elle reste dans le navigateur, dans `localStorage`, et n'est jamais partagée ailleurs).
3. Laisser **Autoriser la recherche web** activé pour que les rabais proviennent de circulaires réelles.

Le modèle utilisé est configurable dans les réglages, ainsi que :

- **Vitesse de génération** — *Prudent* (2 recettes par lot, 2 lots en parallèle), *Équilibré* (3 et 4, recommandé) ou *Rapide* (4 et 6).
- **Modèle rapide** — un modèle plus léger (`claude-haiku-4-5` par défaut) pour les tâches très structurées : extraction d'une circulaire collée, optimisation de la liste d'épicerie.

## Grosses demandes et performance

Une demande de 14 jours × 4 repas ne tient pas dans une seule réponse du modèle : l'ancienne version se faisait tronquer et renvoyait une erreur JSON. Le fonctionnement actuel :

- **Découpage en lots parallèles.** Chaque repas demandé devient un créneau (jour + repas). Les créneaux sont regroupés en petits lots envoyés simultanément. Aucune réponse n'est assez longue pour être tronquée, et le temps total correspond au lot le plus lent, pas à la somme des lots.
- **Affichage progressif.** Les recettes apparaissent lot par lot, avec le nombre de caractères déjà reçus.
- **Rattrapage automatique.** Un lot en échec est repris une fois ; les créneaux toujours manquants sont ensuite régénérés un par un, deux fois au maximum. Un lot raté ne fait plus perdre les autres.
- **Contexte mis en cache.** Les profils, les rabais et le contenu du frigo sont envoyés comme bloc `system` avec `cache_control`, donc réutilisés d'un lot à l'autre.
- **Streaming de bout en bout.** `api/ai.js` diffuse la réponse en NDJSON : la connexion n'est jamais silencieuse, ce qui supprime les coupures de passerelle (504) et les pages HTML renvoyées à la place du JSON.
- **Auto-continuation.** Si le modèle atteint quand même `max_tokens`, le serveur relance la génération là où elle s'est arrêtée et recolle le texte (jusqu'à 8 fois). `pause_turn` (recherche web longue) est traité de la même façon.
- **Reprises réseau.** Les erreurs 429 / 5xx / 529 sont réessayées avec temporisation croissante. Les erreurs sont toujours renvoyées en JSON, jamais en HTML.
- **Analyse JSON tolérante.** Un JSON tronqué est refermé automatiquement (chaînes, objets, tableaux) : les recettes complètes sont conservées au lieu de tout perdre.

## Déploiement

Déploiement sur Vercel sans configuration : importer le dépôt, aucun *build command*, le dossier racine contient `index.html` et `api/ai.js` est détecté automatiquement comme fonction Node. Le fichier `vercel.json` fixe `maxDuration` à 300 s pour `api/ai.js` (le maximum du plan Hobby).

Variable d'environnement optionnelle :

- `ANTHROPIC_API_KEY` — permet d'utiliser l'application sans saisir de clé dans le navigateur.

L'application fonctionne aussi en hébergement statique : si `/api/ai` n'existe pas, elle appelle l'API Anthropic directement depuis le navigateur avec la clé saisie dans les réglages.

## Données

Tout est conservé localement dans le navigateur (`localStorage`). Les réglages permettent d'exporter et d'importer un fichier JSON (sans la clé API) pour sauvegarder ou transférer les données.

## Avertissement

Les prix des circulaires produits par l'IA sont des estimations : ils doivent toujours être vérifiés en magasin. Les valeurs nutritionnelles et les calories estimées ne remplacent pas l'avis d'une nutritionniste ou d'un médecin, en particulier pour les enfants, les femmes enceintes ou toute condition de santé particulière.
