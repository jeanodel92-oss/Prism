# Configurer les commandes du shell

Prism démarre un processus shell (environnement qui exécute les commandes) non interactif distinct pour chaque commande Bash. Bash ne développe pas les alias par défaut en mode non interactif et ne charge généralement pas les mêmes fichiers de démarrage qu’un terminal interactif.

Utilisez `shellPath` pour choisir l’exécutable Bash et `shellCommandPrefix` pour exécuter une préparation avant chaque commande.

## Comprendre quel shell Prism utilise

| Source de la commande | Shell |
|---|---|
| Le modèle appelle l’outil intégré `bash` | L’exécutable Bash choisi par Prism |
| Vous saisissez `!command` ou `!!command` | Le même exécutable Bash |
| Le modèle appelle l’outil facultatif `powershell` | PowerShell 7 (`pwsh.exe`) ou Windows PowerShell |
| Une extension fournit ou remplace un outil shell | Les opérations définies par cette extension |

Prism lance normalement Bash avec `bash -c`. Sous Unix, il utilise `/bin/bash`, puis `bash` dans `PATH`, et enfin `sh` si Bash est absent. Sous Windows natif, il cherche d’abord le chemin configuré, puis Git Bash, puis `bash.exe` dans `PATH`.

## Choisir un exécutable Bash

Définissez `shellPath` dans `~/.prism/agent/settings.json` si Prism doit utiliser un exécutable précis :

```json
{
  "shellPath": "~/.local/bin/bash"
}
```

Sous Windows, utilisez des barres obliques ou doublez les barres obliques inverses :

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

Exécutez `/reload` après avoir modifié le réglage. Consultez [Exécuter Prism sous Windows](windows.md) pour les valeurs par défaut sous Windows natif.

## Préparer chaque commande Bash

Définissez `shellCommandPrefix` pour ajouter une préparation à l’outil Bash intégré et aux commandes `!` ou `!!` saisies par l’utilisateur :

```json
{
  "shellCommandPrefix": "export CI=1"
}
```

Prism assemble le préfixe et la commande demandée en les séparant par un saut de ligne. Le préfixe est exécuté avant chaque commande ; gardez-le rapide et sans demande interactive.

## Activer les alias Bash

Enregistrez les alias utilisés par Prism dans un fichier compatible avec Bash, au lieu d’analyser toute la configuration d’un shell interactif.

Créez `~/.bash_aliases` :

```bash
alias ll='ls -la'
alias gs='git status --short'
```

Configurez ensuite Prism pour activer le développement des alias et charger le fichier :

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\nsource ~/.bash_aliases"
}
```

Exécutez `/reload`, puis vérifiez l’alias dans Prism :

```text
!ll
```

La commande doit afficher la même liste que `ls -la`.

Les alias doivent respecter la syntaxe de Bash. Ne chargez pas un fichier `.zshrc` quelconque dans Bash : les options, fonctions et plugins de zsh risquent de ne pas être compris ou de mal fonctionner.

## Résoudre les problèmes

### Le préfixe fonctionne avec `!`, mais pas avec un outil d’extension

`shellCommandPrefix` configure l’exécution Bash intégrée de Prism. Une extension qui remplace l’outil `bash` ou fournit ses propres opérations shell contrôle sa propre préparation. Consultez sa documentation.

### `shopt` est introuvable

Prism utilise `sh` en remplacement ou `shellPath` indique un shell autre que Bash. Installez Bash ou définissez `shellPath` vers un exécutable Bash avant d’utiliser les réglages propres à Bash, comme `shopt`.

### Une commande de préparation attend une saisie

Retirez les commandes interactives de `shellCommandPrefix`. Le préfixe s’exécute dans un processus non interactif avant chaque commande Bash.

Pour consulter la définition complète des réglages, consultez [Réglages du shell](settings.md#shell).
