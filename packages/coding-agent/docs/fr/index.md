# Prism

Prism est un agent de code libre, gratuit et open source pour Linux, pour les modèles locaux ou distants. Il fonctionne dans votre terminal, dans une fenêtre qui lui est propre et depuis l’app Prism de votre téléphone Android. Donnez-lui un objectif et un dossier de travail : il peut examiner des fichiers, exécuter des commandes, modifier du contenu et mener des tâches en plusieurs étapes, dans les limites des permissions et de la sandbox (environnement isolé des commandes) que vous contrôlez.

Prism fonctionne sous Linux x64. Il n’existe pas de version pour macOS, Windows ou les ordinateurs ARM ; l’app pour téléphone n’existe que sur Android.

Utilisez Prism pour développer des logiciels, prendre des notes de recherche, écrire, travailler sur des fichiers de données ou réaliser des projets personnels. Vous pouvez l’utiliser tel quel, lui demander de s’adapter à votre façon de travailler ou créer d’autres applications avec le SDK.

## Commencer avec Prism

Vous découvrez Prism ? Suivez le [guide de démarrage rapide](quickstart.md) pour installer Prism, connecter un modèle et accomplir votre première tâche.

Si Prism est déjà installé, choisissez ce que vous voulez faire :

- [Utiliser Prism en mode interactif](usage.md) pour ajouter des fichiers, exécuter des commandes, guider le travail en cours et exporter les résultats.
- [Choisir un modèle](models.md) ou connecter un abonnement, une clé API, un modèle local ou un point de terminaison compatible.
- [Reprendre ou créer une branche de session](sessions.md) pour continuer un travail ou explorer une autre approche sans perdre l’historique.
- [Configurer Prism](configuration.md) selon vos préférences, vos dossiers de travail, vos consignes et vos ressources réutilisables.
- [Comprendre le fonctionnement de Prism](how-pi-works.md), notamment ses outils, son contexte, ses sessions et sa boucle d’agent.
- Ouvrir la [fenêtre de Prism](window.md), lier l’[app Android](phone.md) ou laisser l’agent utiliser [votre navigateur](browser.md).
- [Planifier des tâches](scheduled-tasks.md) qui s’exécutent seules, et garder Prism [à jour](updates.md).
- Vérifier votre installation avec [/doctor](doctor.md) quand quelque chose ne va pas.

## Personnaliser Prism

Prism peut réutiliser des prompts, charger des consignes spécialisées, ajouter des intégrations exécutables, modifier son interface de terminal, se connecter à des services de modèles et distribuer ces ressources sous forme de packages.
Utilisez le [choix des options de personnalisation du guide de démarrage rapide](quickstart.md#choisir-comment-personnaliser-prism) pour retenir le mécanisme le plus simple qui répond à votre besoin.

## Automatiser Prism ou l’intégrer

- Utilisez l’[automatisation sans interface](automation.md) pour les modes d’affichage, JSON et RPC, le SDK et le comportement des permissions.
- Utilisez le [mode d’affichage](cli.md#lancer-prism-et-afficher-les-résultats) pour des tâches ponctuelles ou des scripts.
- Utilisez le [mode flux d’événements JSON](../json.md) pour recevoir des événements structurés d’une exécution.
- Utilisez le [mode RPC](../rpc.md) pour contrôler un processus Prism distinct.
- Utilisez le [SDK TypeScript](../sdk.md) pour exécuter Prism dans une application.

## Référence et configuration

Consultez les pages de référence pour trouver les [options CLI](cli.md), les [réglages](settings.md), les [fournisseurs](providers.md), les [commandes slash](slash-commands.md), les [raccourcis clavier](keybindings.md) et les [variables d’environnement](environment-variables.md).

Les pages destinées aux développeurs (extensions, SDK, RPC, flux JSON, formats de session et de messages, compaction, API des scripts codemode, composants d’interface, fournisseurs et modèles virtuels personnalisés, intégration à la CLI) restent en anglais ; les liens de ces pages mènent à la version anglaise.

Pour une aide propre à votre système, consultez [Configurer votre terminal](terminal-setup.md), [tmux](tmux.md) ou [Conteneuriser Prism](containerization.md). [Windows](windows.md) et [Termux sur Android](termux.md) décrivent pi, l’agent sur lequel Prism est construit : Prism ne publie pas de version pour eux.

## Travailler en toute sécurité

Chaque appel d’outil passe par l’[étape de permissions](permissions.md), et dans les modes `safe`, `ask` et `broad`, les commandes shell de l’agent s’exécutent dans la [sandbox](sandbox.md) : elles ne peuvent modifier que le projet, ne lisent pas vos identifiants et ne joignent que les hôtes que vous autorisez. Les extensions, les serveurs MCP et les outils de fichiers gardent les permissions de votre compte, et la confiance accordée à un projet détermine seulement quelles ressources du projet se chargent. Lisez la page [Sécurité](security.md) avant d’utiliser des fichiers, dépôts, extensions ou automatisations sans surveillance auxquels vous ne faites pas confiance.
