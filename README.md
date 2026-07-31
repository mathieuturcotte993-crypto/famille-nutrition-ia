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

Le modèle utilisé est configurable dans les réglages.

## Déploiement

Déploiement sur Vercel sans configuration : importer le dépôt, aucun *build command*, le dossier racine contient `index.html` et `api/ai.js` est détecté automatiquement comme fonction Node.

Variable d'environnement optionnelle :

- `ANTHROPIC_API_KEY` — permet d'utiliser l'application sans saisir de clé dans le navigateur.

L'application fonctionne aussi en hébergement statique : si `/api/ai` n'existe pas, elle appelle l'API Anthropic directement depuis le navigateur avec la clé saisie dans les réglages.

## Données

Tout est conservé localement dans le navigateur (`localStorage`). Les réglages permettent d'exporter et d'importer un fichier JSON (sans la clé API) pour sauvegarder ou transférer les données.

## Avertissement

Les prix des circulaires produits par l'IA sont des estimations : ils doivent toujours être vérifiés en magasin. Les valeurs nutritionnelles et les calories estimées ne remplacent pas l'avis d'une nutritionniste ou d'un médecin, en particulier pour les enfants, les femmes enceintes ou toute condition de santé particulière.
