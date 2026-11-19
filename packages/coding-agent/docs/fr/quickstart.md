# Démarrage rapide

Prism fonctionne dans votre terminal et peut utiliser les fichiers de votre ordinateur. Pour vous en servir, vous devez accéder à un modèle par l’intermédiaire d’un fournisseur pris en charge. Il peut s’agir d’un abonnement, d’une clé API ou d’un modèle local.

Pour installer Prism sous Windows, consultez [Installation sous Windows](windows.md). Pour Android, consultez [Installation de Termux](termux.md).

## 1. Installer Prism

Installez Prism sur Linux x64 :

```bash
curl -fsSL https://prism.odelserver.space/install.sh | sh
```

Vérifiez l’installation :

```bash
prism --version
```

## 2. Démarrer Prism

Placez-vous dans le dossier sur lequel vous voulez travailler, puis démarrez Prism :

```bash
cd /path/to/folder
prism
```

Le dossier de travail aide Prism à trouver les fichiers, consignes et réglages utiles. Prism s’en sert aussi pour regrouper les sessions enregistrées.

<p align="center"><img src="../images/interactive-mode.png" alt="Prism dans un terminal avec une conversation, un éditeur de saisie et une barre d’état en bas" width="750"></p>

L’interface affiche votre conversation, un éditeur pour les prompts et les commandes, ainsi qu’une barre en bas avec le dossier actuel, le modèle et l’état de la session. Consultez [Utiliser Prism dans le terminal](usage.md) pour apprendre à ajouter des fichiers, exécuter des commandes, guider le travail en cours et gérer les résultats.

## 3. Choisir un modèle

Un **modèle** produit les réponses de Prism. Un **fournisseur** est le service ou le compte utilisé par Prism pour accéder à ce modèle.

Dans Prism, exécutez :

```text
/login
```

Choisissez un fournisseur, puis suivez les instructions pour utiliser un abonnement ou enregistrer une clé API. Exécutez ensuite `/model` si vous voulez choisir un autre modèle disponible.

Consultez [Choisir un modèle et un fournisseur](models.md) pour connaître les fournisseurs pris en charge, l’authentification par variable d’environnement, les modèles locaux et les points de terminaison personnalisés.

## 4. Confier une tâche à Prism

Prism affiche chaque fichier lu, chaque recherche, commande et modification effectuée. Dans le mode de permission par défaut, `broad` (« large » dans l’interface), il travaille dans le projet sans demander, et demande avant de sortir du projet, avant `sudo` et avant les appels qu’il juge dangereux. Appuyez sur `Alt+M` ou exécutez `/perm` pour choisir un mode plus strict. Consultez [Permissions](permissions.md#modes).

Saisissez une tâche adaptée à votre travail, par exemple :

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Dans l’éditeur, saisissez `@` pour rechercher un fichier au lieu d’entrer son chemin complet. Quand Prism a terminé, examinez sa réponse et les fichiers modifiés. Utilisez un système de gestion de versions ou des sauvegardes pour les travaux importants. Pour les tâches sans surveillance ou avec du contenu auquel vous ne faites pas confiance, utilisez un conteneur ou un autre environnement isolé. Consultez [Sécurité](security.md).

## Continuer plus tard

Prism enregistre automatiquement les sessions. Quittez Prism, puis reprenez la session la plus récente du même dossier de travail avec :

```bash
prism --continue
```

Utilisez `/resume` pour choisir une autre session enregistrée. Consultez [Reprendre ou créer une branche de session](sessions.md) pour en savoir plus sur le nom des sessions, les branches, le compactage, l’exportation et le partage.

## Étapes suivantes

- [Utiliser Prism en mode interactif](usage.md) pour découvrir la saisie, les commandes, les raccourcis et les messages mis en attente.
- [Ajouter des consignes](configuration.md#fichiers-de-contexte) que Prism suivra dans un dossier.
- [Choisir un modèle et un fournisseur](models.md).

### Choisir comment personnaliser Prism

Commencez par le mécanisme le moins puissant qui répond à votre besoin :

| Besoin | Commencez par |
|---|---|
| Donner à Prism des consignes durables pour un dossier | [`AGENTS.md`](configuration.md#fichiers-de-contexte) |
| Réutiliser un prompt depuis le menu `/` | [Modèle de prompt](prompt-templates.md) |
| Ajouter des consignes et fichiers utiles à une tâche précise | [Skill](skills.md) |
| Ajouter des outils, commandes ou gestionnaires d’événements exécutables | [Extension](../extensions.md) |
| Créer un composant de terminal personnalisé | [Interface du terminal](../tui.md) |
| Connecter un service de modèles non pris en charge | [Fournisseur personnalisé](../custom-provider.md) |
| Installer ou distribuer plusieurs ressources | [Package Prism](packages.md) |

## Désinstaller Prism

Exécutez le programme d’installation avec `--uninstall` :

```bash
curl -fsSL https://prism.odelserver.space/install.sh | sh -s -- --uninstall
```

La désinstallation de Prism ne supprime pas les réglages, identifiants, sessions ou packages Prism installés dans `~/.prism/agent/`.
