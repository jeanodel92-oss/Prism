# Utiliser Prism dans le terminal

Lancez `prism` depuis le dossier dans lequel vous voulez travailler. Prism utilise ce dossier pour trouver les fichiers, consignes et réglages, et pour regrouper les sessions enregistrées. Si Prism n’est pas encore installé ou si vous n’avez pas choisi de modèle, suivez le [guide de démarrage rapide](quickstart.md).

Prism peut vous demander si vous faites confiance au dossier de travail avant de charger ses ressources de projet. Consultez [Confiance accordée à un projet](security.md#comprendre-la-confiance-accordée-au-projet).

<p align="center"><img src="../images/interactive-mode.png" alt="Mode interactif de Prism avec une conversation, un éditeur et des informations d’état" width="750"></p>

La transcription affiche vos prompts, les réponses de Prism, les appels d’outils, leurs résultats et les erreurs. Vous saisissez les prompts et commandes dans l’éditeur. La barre du bas indique le dossier actuel, la session, le modèle, l’utilisation du contexte et le cumul de l’utilisation et du coût.

## Saisir un prompt

Saisissez une demande et appuyez sur `Enter` pour l’envoyer. Utilisez `Shift+Enter` pour ajouter une ligne, ou appuyez sur `Ctrl+G` pour écrire un prompt plus long dans l’éditeur externe configuré.

Pour ajouter des fichiers ou des images :

- Saisissez `@` pour rechercher un fichier et l’ajouter à votre prompt.
- Exécutez `/files` ou appuyez sur `Alt+E` pour parcourir les fichiers du projet. Appuyez sur `Tab` pour marquer des fichiers, puis sur `Enter` pour les ajouter à votre prompt.
- Appuyez sur `Tab` pour compléter un chemin.
- Collez une image ou faites-la glisser dans un terminal compatible. Une image copiée, comme une capture d’écran, apparaît sous la forme `[Image #1]` dans l’éditeur et part au modèle comme image avec le message ; supprimez le repère pour ne pas l’envoyer. Des fichiers copiés dans le gestionnaire de fichiers se collent comme chemins ; un fichier hors du projet est d’abord copié dans le `/tmp` privé de la session, où l’agent le lit sans question d’autorisation, et le chemin est celui de cette copie.

## Suivre le travail de Prism

Prism affiche chaque appel d’outil et son résultat pendant le travail. Appuyez sur `Ctrl+O` pour ouvrir ou fermer tous les blocs dépliables, y compris ceux de réflexion. Cela réinitialise les choix faits en cliquant sur chaque bloc. Appuyez sur `Ctrl+T` pour afficher ou masquer les blocs de réflexion jusqu’au prochain `Ctrl+O`.

L’en-tête de démarrage indique les consignes et ressources chargées par Prism. La bordure de l’éditeur indique le niveau de réflexion actuel. La barre du bas se met à jour à mesure que le modèle utilise le contexte et indique l’utilisation.

Le mode de permission décide si Prism demande votre accord avant un appel d’outil. Dans le mode par défaut, `broad` (« large » dans l’interface), Prism travaille dans le projet sans demander, et demande avant de sortir du projet, avant `sudo` et avant les appels qu’il juge dangereux. Le mode `ask` (« demander ») demande aussi avant de modifier un fichier ou de lancer une commande qui n’est pas reconnue comme sûre, `safe` (« prudent ») limite l’agent à la lecture et aux commandes sûres, et `unrestricted` (« sans limite ») saute les questions ordinaires une fois que vous l’avez accepté. Appuyez sur `Alt+M` pour passer d’un mode à l’autre, ou utilisez `/perm mode <mode>` pour la session et `/perm default <mode>` pour les nouvelles sessions. Consultez [Permissions](permissions.md#modes).

Ce contrôle des permissions n’est pas un environnement isolé. Examinez les commandes et les fichiers modifiés, et utilisez un environnement isolé pour les tâches sans surveillance ou avec du contenu auquel vous ne faites pas confiance. Consultez [Sécurité](security.md).

## Réorienter le travail

Vous pouvez envoyer d’autres informations pendant que Prism travaille :

| Ce que vous voulez faire | Action |
|---|---|
| Ajuster la tâche en cours | Saisissez un message et appuyez sur `Enter` |
| Ajouter du travail après la tâche en cours | Saisissez un message et appuyez sur `Alt+Enter` |
| Renvoyer les messages mis en attente dans l’éditeur | Appuyez sur `Alt+Up` |
| Arrêter la tâche en cours | Appuyez sur `Escape` |

Un message envoyé avec `Enter` attend la fin de la réponse et des appels d’outils actuels avant de guider la réponse suivante. Un message de suivi envoyé avec `Alt+Enter` attend que Prism termine la tâche en cours. L’interruption renvoie les messages mis en attente dans l’éditeur.

Windows Terminal réserve certains raccourcis avec Alt. Consultez [Configurer votre terminal](terminal-setup.md) pour connaître les solutions sous Windows.

## Changer de modèle ou de réglages

Saisissez `/` pour rechercher les commandes disponibles. Voici les plus utiles :

- `/model` sélectionne un modèle. Appuyez sur `Ctrl+L` pour ouvrir le même sélecteur.
- `/thinking` choisit la quantité de réflexion utilisée par le modèle actuel. Appuyez sur `Shift+Tab` pour parcourir les niveaux pris en charge.
- `/login` et `/logout` gèrent l’accès au fournisseur.
- `/settings` modifie les préférences courantes.

Les modèles de prompt, skills et extensions peuvent ajouter des commandes au même menu. Consultez [Choisir un modèle](models.md), [Configurer Prism](configuration.md) ou la [référence complète des commandes slash](slash-commands.md).

## Continuer ou recommencer

Prism enregistre automatiquement les sessions, sauf si la persistance des sessions est désactivée.

- `/new` démarre une session.
- `/resume` ouvre une autre session enregistrée.
- `/name` donne un nom facile à reconnaître à la session actuelle.
- `/session` affiche son fichier, son identifiant, le nombre de messages, l’utilisation de tokens et le coût.

Utilisez `/tree`, `/fork` ou `/clone` pour essayer une autre approche sans perdre le travail existant. Utilisez `/compact` pour réduire l’historique envoyé au modèle. Consultez [Sessions et contexte](sessions.md) pour en savoir plus.

Après avoir quitté Prism, exécutez `prism --continue` depuis le même dossier pour reprendre la session la plus récente.

## Exécuter une commande de terminal

Faites précéder une commande de `!` pour l’exécuter et ajouter son résultat à la conversation :

```text
!git status
```

Utilisez `!!` pour exécuter une commande sans envoyer son résultat au modèle.

## Copier, exporter ou partager des résultats

Appuyez sur `Ctrl+X` ou exécutez `/copy` pour copier la dernière réponse de l’assistant. Utilisez `/export` pour enregistrer la session au format HTML ou JSONL.

Utilisez `/share` pour téléverser la session et obtenir un lien de consultation. Avec l’authentification Radius, l’élément partagé est visible par votre organisation Radius. Sinon, Prism crée un gist GitHub privé au moyen de l’interface en ligne de commande GitHub. Examinez la session avant de la partager : elle peut contenir vos prompts, les résultats des outils, le contenu des fichiers et les identifiants révélés pendant la conversation.

## Régler le terminal

Le mode plein écran, activé par défaut, garde l’éditeur et la zone d’état fixes pendant que la transcription défile dans la fenêtre du terminal. Le mode normal utilise le défilement habituel du terminal. Choisissez un mode avec `/settings` ou `--tui-mode`.

La prise en charge de la souris, des raccourcis clavier et des images intégrées varie selon le terminal. Consultez [Configurer votre terminal](terminal-setup.md) pour les réglages par plateforme et [Raccourcis clavier](keybindings.md) pour tous les raccourcis configurables. Exécutez `/help` pour voir ceux qui sont actifs dans votre session.

## Recueillir des informations de diagnostic

Si vous cherchez la cause d’un problème d’affichage ou d’état de conversation dans le terminal, exécutez `/debug`. Prism écrit les lignes affichées dans le terminal et les messages de la session actuelle dans `prism-debug.log`, dans votre [dossier agent](configuration.md#dossier-agent).

Examinez ce fichier avant de le partager. Il peut contenir des prompts, des réponses de modèles, des résultats d’outils, le contenu de fichiers et des données du terminal.
