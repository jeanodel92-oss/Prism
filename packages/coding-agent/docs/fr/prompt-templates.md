# Modèles de prompt

Les modèles de prompt (consignes envoyées au modèle) transforment des fichiers Markdown en commandes réutilisables dans le menu `/`. Utilisez-en un si vous voulez réutiliser la même consigne sans ajouter de comportement exécutable ni un grand nombre de consignes complémentaires.

Un modèle peut accepter des arguments et apparaître dans l’autocomplétion des commandes. Prism peut charger des modèles depuis la configuration personnelle ou celle du projet, depuis un chemin explicite ou depuis un package Prism. La configuration du projet n’est chargée qu’après son approbation.

## Créer un modèle

Créez `~/.prism/agent/prompts/review.md` :

```markdown
---
description: Review staged git changes
argument-hint: "[focus]"
---
Review the staged changes. Focus on ${1:-correctness, security, and error handling}.
```

Le nom de fichier devient le nom de commande : ce modèle est donc disponible avec `/review`. La valeur de `description` apparaît dans l’autocomplétion. Si elle est absente, Prism utilise la première ligne non vide.

`argument-hint` est facultatif. Utilisez `<chevrons>` pour les arguments obligatoires et `[crochets]` pour les arguments facultatifs.

Exécutez `/reload` après avoir ajouté ou modifié un modèle pendant une session active.

<a id="invoke-a-template"></a>

## Utiliser un modèle

Saisissez la commande du modèle dans l’éditeur :

```text
/review
/review concurrency
```

Prism développe le modèle avant d’envoyer le texte obtenu à l’agent. Les extensions reçoivent d’abord la saisie brute par l’événement `input`, sauf si une commande d’extension du même nom la prend en charge.

Les modèles acceptent les substitutions suivantes :

| Syntaxe | Résultat |
|---|---|
| `$1`, `$2`, … | Un argument positionnel |
| `$@` ou `$ARGUMENTS` | Tous les arguments assemblés avec des espaces |
| `${1:-default}` | Premier argument ou valeur par défaut |
| `${@:-default}` | Tous les arguments ou valeur par défaut |
| `${@:N}` | Arguments à partir de la position `N` |
| `${@:N:L}` | `L` arguments à partir de la position `N` |

Les arguments suivent les règles de citation du shell. Ainsi, `/review "API compatibility"` fournit un seul argument contenant un espace.

<a id="choose-where-it-loads"></a>

## Ajouter un modèle à Prism

Placez le modèle dans le dossier de prompts utilisateur ou du projet. Les dossiers de prompts habituels ne chargent que les fichiers `.md` placés directement dedans.

Les réglages et les packages peuvent sélectionner des fichiers Markdown dans des sous-dossiers ; un manifeste de package peut restreindre la recherche avec des chemins et des motifs explicites. Consultez [Réglages](settings.md#ressources) et [Packages Prism](packages.md).

Les modèles du projet deviennent des commandes dans l’éditeur une fois le projet approuvé. Examinez leur contenu avant de faire confiance à un projet que vous ne connaissez pas. Consultez [Sécurité](security.md#comprendre-la-confiance-accordée-au-projet).
