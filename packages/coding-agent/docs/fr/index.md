# Prism

Prism est un agent d’IA extensible qui fonctionne dans votre terminal. Donnez-lui un objectif et un dossier de travail : il peut examiner des fichiers, exécuter des commandes, modifier du contenu et mener des tâches en plusieurs étapes.

Utilisez Prism pour développer des logiciels, prendre des notes de recherche, écrire, travailler sur des fichiers de données ou réaliser des projets personnels. Vous pouvez l’utiliser tel quel, lui demander de s’adapter à votre façon de travailler ou créer d’autres applications avec le SDK.

## Commencer avec Prism

Vous découvrez Prism ? Suivez le [guide de démarrage rapide](quickstart.md) pour installer Prism, connecter un modèle et accomplir votre première tâche.

Si Prism est déjà installé, choisissez ce que vous voulez faire :

- [Utiliser Prism en mode interactif](usage.md) pour ajouter des fichiers, exécuter des commandes, guider le travail en cours et exporter les résultats.
- [Choisir un modèle](models.md) ou connecter un abonnement, une clé API, un modèle local ou un point de terminaison compatible.
- [Reprendre ou créer une branche de session](sessions.md) pour continuer un travail ou explorer une autre approche sans perdre l’historique.
- [Configurer Prism](configuration.md) selon vos préférences, vos dossiers de travail, vos consignes et vos ressources réutilisables.
- [Comprendre le fonctionnement de Prism](how-pi-works.md), notamment ses outils, son contexte, ses sessions et sa boucle d’agent.

## Personnaliser Prism

Prism peut réutiliser des prompts, charger des consignes spécialisées, ajouter des intégrations exécutables, modifier son interface de terminal, se connecter à des services de modèles et distribuer ces ressources sous forme de packages.
Utilisez le [choix des options de personnalisation du guide de démarrage rapide](quickstart.md#choisir-comment-personnaliser-prism) pour retenir le mécanisme le plus simple qui répond à votre besoin.

## Automatiser Prism ou l’intégrer

- Utilisez le [mode d’affichage](../cli.md#invocation-and-output) pour des tâches ponctuelles ou des scripts.
- Utilisez le [mode flux d’événements JSON](../json.md) pour recevoir des événements structurés d’une exécution.
- Utilisez le [mode RPC](../rpc.md) pour contrôler un processus Prism distinct.
- Utilisez le [SDK TypeScript](../sdk.md) pour exécuter Prism dans une application.

## Référence et configuration

Consultez les pages de référence pour trouver les [options CLI](../cli.md), les [réglages](settings.md), les [fournisseurs](../providers.md), les [raccourcis clavier](keybindings.md) et les [variables d’environnement](environment-variables.md).

Pour une aide propre à votre système, consultez [Configurer votre terminal](terminal-setup.md), [Windows](windows.md), [tmux](tmux.md), [Termux sur Android](termux.md) ou [Conteneuriser Prism](containerization.md).

## Travailler en toute sécurité

Les outils et extensions de Prism s’exécutent avec les permissions du processus Prism. La confiance accordée à un projet détermine quelles ressources du projet Prism charge, mais elle n’isole pas les appels d’outils. Lisez la page [Sécurité](security.md) avant d’utiliser des fichiers, dépôts, extensions ou automatisations sans surveillance auxquels vous ne faites pas confiance.
