# Commandes slash

Saisissez `/` dans l’éditeur de Prism pour rechercher les commandes disponibles dans la session actuelle ; `/help` liste les commandes et raccourcis actifs, les plus utilisés d’abord. Cette page répertorie les commandes de la version actuelle de Prism.

Certaines commandes appartiennent à un module intégré : elles n’existent que lorsque ce module est activé (**/settings › Modules**). Les modules désactivés par défaut sont signalés *(désactivé par défaut)*. Les extensions, modèles de prompt et skills peuvent ajouter des commandes : le menu de commandes indique donc exactement ce qui est disponible dans votre session.

## Modèles et réglages

| Commande | Description |
|---|---|
| `/settings` | Ouvrir les réglages |
| `/model [provider/model]` | Choisir un modèle |
| `/thinking [level]` | Définir le niveau de réflexion |
| `/scoped-models` | Choisir les modèles que `Ctrl+P` fait défiler |
| `/model-settings` | Voir et corriger le nom, le contexte, la limite de sortie, l’échantillonnage et les autres paramètres de requête du modèle actuel, à côté des valeurs du serveur |
| `/login [provider]` | Ajouter l’authentification d’un fournisseur |
| `/logout` | Supprimer l’authentification d’un fournisseur |
| `/llama` | Gérer les modèles du routeur llama.cpp configuré |
| `/web-key [exa\|brave\|tavily\|firecrawl\|searxng] [remove]` | Enregistrer ou supprimer une clé API de recherche web ou une URL SearXNG ; le fournisseur sélectionné est utilisé par défaut. Choisissez-le dans `/settings` > Web search ; consultez [Réglages de la recherche web](settings.md#recherche-web) |
| `/budget` | Afficher limites et consommation ; `/budget time 30`, `/budget tools 50`, `/budget tokens 200000`, `/budget cost 2`, `/budget off [time\|tools\|tokens\|cost]` définissent ou suppriment les limites |
| `/onboarding` | Refaire les choix du premier lancement : langue, thème, permissions, modules, confidentialité, modèle |
| `/tutorial` | Apprendre Prism en neuf courts modules, chacun avec un exercice que Prism vérifie sans appeler le modèle ; la progression est conservée |

## Permissions et sécurité

| Commande | Description |
|---|---|
| `/perm` | Permissions : mode, mode par défaut, règles et accords en vigueur ; consultez [Permissions](permissions.md#commandes). `Alt+M` change de mode |
| `/sandbox` | La [sandbox](sandbox.md) : son état, les chemins inscriptibles et masqués, les hôtes autorisés |
| `/trust` | Enregistrer une décision de confiance pour les prochains processus Prism |
| `/doctor [details\|export <fichier>]` | Vérifier la configuration locale et les chemins ; consultez [Diagnostic](doctor.md) |
| `/sent [export <chemin>]` | Examiner la dernière requête envoyée au modèle : destination, consignes, outils et messages |
| `/trace` | La trace des opérations de la session, quand les traces sont activées (`traceEnabled`) |

## Sessions et contexte

| Commande | Description |
|---|---|
| `/new` | Démarrer une nouvelle session |
| `/resume` | Passer à une autre session enregistrée |
| `/name [name]` | Définir le nom affiché de la session, ou afficher le nom actuel s’il est omis |
| `/session` | Afficher les informations et statistiques de la session actuelle |
| `/state` | Ce que faisait la session quand elle s’est arrêtée, et quoi faire d’un outil resté inachevé |
| `/tree` | Parcourir l’arbre de la session |
| `/fork` | Créer une nouvelle session à partir d’un message utilisateur précédent |
| `/clone` | Dupliquer la session actuelle à sa position actuelle |
| `/compact [instructions]` | Compacter le contexte actuel, éventuellement avec des consignes personnalisées |
| `/context` | Voir ce qui remplit le contexte du modèle : prompt système, outils, messages |
| `/import <path>` | Importer et reprendre une session JSONL |
| `/expand` | Déplier ensemble la réflexion et la sortie des outils ; une seconde fois : replier les deux |
| `/sessions [all] <mots-clés>` | Chercher dans vos sessions passées *(module `session-search`, désactivé par défaut)* |
| `/memory [consigne]`, `/memory-project [consigne]`, `/memory-edit` | Voir ou mettre à jour la mémoire gardée d’une session à l’autre, pour tous les projets ou pour celui-ci *(module `memory`, désactivé par défaut)* |

## Annuler et travail de fond

| Commande | Description |
|---|---|
| `/undo` | Annuler les modifications de fichiers du dernier tour du modèle. Les modifications faites par une commande shell ne sont pas suivies |
| `/checkpoints` | Lister les points de restauration des fichiers et revenir à l’un d’eux |
| `/bg` | Voir et gérer les tâches de fond (`Alt+J`) |
| `/bg-clear` | Oublier les tâches de fond terminées |
| `/agents` | Créer et gérer des agents personnalisés, que le modèle lance avec l’outil `agent` ; voir les agents lancés dans la session, en arrêter un, envoyer un message à un agent fini (il garde son contexte), en lancer un vous-même ; activer le mode avancé des agents. `/agents fork <tâche>` (mode avancé) lance un agent sur une copie de cette conversation |
| `/plan` | Entrer dans le mode Plan ou le gérer : le modèle planifie et ne fait que lire des fichiers jusqu’à votre accord (`Alt+P`) |
| `/goal [--tokens 100k] <objectif>` | Donner au modèle un objectif qu’il poursuit d’un tour à l’autre |
| `/schedule` | Créer, mettre en pause ou supprimer des [tâches planifiées](scheduled-tasks.md) |

## Exporter et partager

| Commande | Description |
|---|---|
| `/copy` | Copier le dernier message de l’assistant |
| `/export [path]` | Exporter la session en HTML ou JSONL |
| `/export-zip` | Exporter des sessions et fichiers choisis dans une archive ZIP portable, avec les secrets connus masqués |
| `/share` | Envoyer la session dans un gist GitHub secret et afficher un lien vers le lecteur de sessions de Prism |

Relisez une session avant de l’exporter ou de la partager. Les sessions peuvent contenir des prompts, des arguments d’outils, la sortie de commandes, le contenu de fichiers et des identifiants exposés pendant la conversation.

## Projet et fichiers

| Commande | Description |
|---|---|
| `/files` | Parcourir les fichiers du projet et les ajouter à votre prompt (`Alt+E`) |
| `/init [plan ou chemin]` | Mettre en place les documents de continuité du projet (`AGENTS.md`, `project/`) à partir d’un plan ou du dépôt existant, après avoir montré ce qui sera créé et demandé |
| `/handoff [note]` | Faire mettre à jour `project/handoff.md` par le modèle, avec la branche, le commit, les fichiers non commités et les tâches de fond relevés par Prism. Prism y inscrit ensuite le commit ; au démarrage, une passation qui ne correspond plus au dépôt est signalée |
| `/lsp-setup [all]` | Afficher les serveurs de langage des langages du projet, ou tous les serveurs pris en charge, les activer ou les désactiver, et proposer leurs commandes d’installation |
| `/lsp` | Afficher la configuration des serveurs de langage |
| `/mcp` | Gérer les serveurs MCP : connexion, reconnexion, activation et exposition ; consultez [MCP](mcp.md) |
| `/skills` | Installer, activer ou désactiver, mettre à jour et supprimer des skills |

## Prism, la fenêtre et les appareils

| Commande | Description |
|---|---|
| `/docs [sujet]` | Lire cette documentation dans Prism |
| `/help` | Raccourcis et actions courantes, les plus fréquents d’abord |
| `/changelog` | Afficher les notes de version de Prism |
| `/update` | Chercher une mise à jour de Prism, changer de canal ou revenir à la version précédente ; consultez [Mises à jour](updates.md) |
| `/phone` | Lier l’[app Android](phone.md) à cet ordinateur, lister et révoquer les téléphones liés |
| `/browser [setup\|resume\|firefox]` | Lier Prism à votre [navigateur](browser.md) *(module `browser`, désactivé par défaut)* |
| `/desktop [stop]` | Le bureau propre à l’agent : vue en direct ou état *(module `desktop`, désactivé par défaut)* |
| `/reload` | Recharger les raccourcis clavier, extensions, skills, modèles, thèmes et fichiers de contexte |
| `/debug` | Écrire l’écran et les messages de la session dans `~/.prism/agent/prism-debug.log`, pour un problème d’affichage |
| `/quit` | Quitter Prism |

## Commandes ajoutées par des ressources

- Les extensions peuvent enregistrer des commandes avec leurs propres arguments et leur propre complétion.
- Chaque modèle de prompt est disponible sous son nom de modèle.
- Les skills sont disponibles sous la forme `/skill:name` lorsque les commandes de skills sont activées.

Utilisez `/reload` après avoir ajouté ou modifié une ressource de commande découverte. Consultez [Extensions](../extensions.md), [Modèles de prompt](prompt-templates.md) et [Skills](skills.md) pour leurs règles de chargement et de nommage.
