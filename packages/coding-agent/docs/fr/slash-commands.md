# Commandes slash

Saisissez `/` dans l’éditeur de terminal de Prism pour rechercher les commandes disponibles dans la session actuelle. Cette page répertorie les commandes intégrées à la version actuelle de Prism.

Les extensions, modèles de prompt et skills peuvent ajouter des commandes. Le menu de commandes de Prism indique donc exactement quelles ressources sont chargées dans votre session.

## Modèles et réglages

| Commande | Description |
|---|---|
| `/settings` | Ouvrir les réglages |
| `/model [provider/model]` | Choisir un modèle |
| `/budget` | Afficher limites et consommation ; `/budget time 30`, `/budget tools 50`, `/budget tokens 200000`, `/budget cost 2`, `/budget off [time|tools|tokens|cost]` définissent ou suppriment les limites |
| `/init [plan ou chemin]` | Avec l'extension `project-continuity` activée : mettre en place les documents de continuité du projet (`AGENTS.md`, `project/`) à partir d'un plan ou du dépôt existant, après avoir montré ce qui sera créé et demandé |
| `/handoff [note]` | Avec l'extension `project-continuity` activée : faire mettre à jour `project/handoff.md` par le modèle, avec la branche, le commit, les fichiers non commités et les tâches de fond relevés par Prism. Prism y inscrit ensuite le commit ; au démarrage, une passation qui ne correspond plus au dépôt est signalée |
| `/thinking [level]` | Définir le niveau de réflexion |
| `/scoped-models` | Configurer les modèles du parcours interactif |
| `/login [provider]` | Ajouter l’authentification d’un fournisseur |
| `/logout` | Supprimer l’authentification d’un fournisseur |
| `/llama` | Gérer les modèles du routeur llama.cpp configuré |
| `/web-key [exa\|brave\|tavily\|firecrawl\|searxng] [remove]` | Enregistrer ou supprimer une clé API de recherche web ou une URL SearXNG ; le fournisseur sélectionné est utilisé par défaut. Choisissez-le dans `/settings` > Web search ; consultez [Réglages de la recherche web](settings.md#recherche-web) |

## Sessions et contexte

| Commande | Description |
|---|---|
| `/new` | Démarrer une session |
| `/resume` | Passer à une autre session enregistrée |
| `/name [name]` | Définir le nom affiché de la session ou afficher son nom actuel si aucun nom n’est indiqué |
| `/session` | Afficher les informations et statistiques de la session actuelle |
| `/tree` | Parcourir l’arbre de session |
| `/fork` | Créer une session à partir d’un ancien message utilisateur |
| `/clone` | Dupliquer la session actuelle à sa position actuelle |
| `/compact [instructions]` | Compacter le contexte actuel, avec éventuellement des consignes personnalisées |
| `/import <path>` | Importer et reprendre une session JSONL |

## Export et partage

| Commande | Description |
|---|---|
| `/copy` | Copier le dernier message de l’assistant |
| `/export [path]` | Exporter la session au format HTML ou JSONL |
| `/share` | Téléverser la session et obtenir un lien de consultation |
| `/bug [description]` | Préparer un signalement privé à l’équipe Prism |

Examinez une session avant de l’exporter ou de la partager. Elle peut contenir des prompts, des arguments d’outils, des résultats de commandes, le contenu de fichiers et des identifiants révélés pendant la conversation.

## Exécution et projet

| Commande | Description |
|---|---|
| `/trust` | Enregistrer une décision de confiance pour les prochains processus Prism |
| `/files` | Parcourir les fichiers du projet et les ajouter au prompt (`Alt+E`) |
| `/lsp-setup [all]` | Afficher les serveurs de langage pour les langages du projet ou tous les serveurs pris en charge, et proposer leur installation |
| `/reload` | Recharger les raccourcis clavier, extensions, skills, modèles, thèmes et fichiers de contexte |
| `/changelog` | Afficher les notes de version de Prism |
| `/tutorial` | Apprendre Prism en neuf modules courts, chacun avec un exercice que Prism vérifie sans appeler le modèle ; la progression est gardée. Aussi proposé à la fin de l'onboarding et dans le menu « plus… » |
| `/quit` | Quitter Prism |

## Commandes ajoutées par des ressources

- Les extensions peuvent enregistrer des commandes avec leurs propres arguments et règles d’autocomplétion.
- Chaque modèle de prompt est disponible sous son nom.
- Les skills sont disponibles avec `/skill:name` si les commandes de skills sont activées.

Exécutez `/reload` après avoir ajouté ou modifié une ressource de commande détectée. Consultez [Extensions](../extensions.md), [Modèles de prompt](prompt-templates.md) et [Skills](skills.md) pour connaître leurs règles de chargement et de nommage.
