# Exécuter Prism sous Windows

> Prism cible Linux x64 : aucune version Windows n’est publiée et Prism n’est pas testé sous Windows. Cette page décrit le comportement du code dans cet environnement, à partir d’une copie du code source.

Exécutez Prism comme processus Windows natif ou dans Windows Subsystem for Linux (WSL). Sous Windows natif, les commandes Bash utilisent Git Bash par défaut ; vous pouvez aussi rendre PowerShell accessible au modèle. Dans WSL, Prism utilise l’environnement Linux et son installation de Bash.

Suivez le [guide de démarrage rapide](quickstart.md) pour installer Prism et vous authentifier. Cette page vous aide à choisir et configurer l’environnement de commandes.

## Choisir entre Windows natif et WSL

| Environnement | Environnement de commandes | À utiliser quand |
|---|---|---|
| Windows natif avec Git Bash | Git Bash pour l’outil intégré `bash` et les commandes `!` | Vos fichiers et outils de développement se trouvent surtout sous Windows |
| Windows natif avec l’outil `powershell` | PowerShell pour les appels d’outils du modèle ; Bash reste disponible pour les commandes `!` | La tâche dépend de modules PowerShell ou de commandes propres à Windows |
| WSL | Bash et outils Linux dans la distribution WSL choisie | Vos fichiers et outils sont déjà dans Linux ou WSL |

## Utiliser Git Bash sous Windows natif

Pour la plupart des utilisateurs de Windows natif, il suffit d’installer [Git for Windows](https://git-scm.com/download/win).

Prism cherche Bash dans cet ordre :

1. `shellPath` dans `~/.prism/agent/settings.json`
2. Git Bash sous `Program Files` ou `Program Files (x86)`
3. `bash.exe` dans `PATH`, notamment Cygwin, MSYS2 ou une ancienne version de Bash pour WSL

Démarrez Prism et saisissez cette commande pour vérifier le shell :

```text
!printf 'Bash is working\n'
```

Si Prism ne trouve pas Bash, il affiche les emplacements vérifiés. Installez Git for Windows, ajoutez un autre exécutable Bash à `PATH` ou configurez `shellPath`.

## Autoriser le modèle à utiliser PowerShell

L’outil facultatif `powershell` exécute les commandes avec `pwsh.exe` s’il est disponible, puis essaie Windows PowerShell. Il lance PowerShell avec `-NoProfile -NonInteractive -ExecutionPolicy Bypass`. Les règles d’exécution imposées par un administrateur peuvent rester prioritaires.

Pour remplacer par `powershell` l’outil `bash` que le modèle utilise, ajoutez ceci à `~/.prism/agent/settings.json` :

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

`["-bash", "+powershell"]` fait la même chose en conservant les autres outils par défaut que vous avez configurés.

Redémarrez Prism, puis demandez-lui d’exécuter une commande PowerShell sans danger. Les commandes d’éditeur `!` et `!!` continuent d’utiliser Bash. L’outil `powershell` n’est disponible que si Prism s’exécute dans un processus Windows natif.

Consultez [Réglages](settings.md#outils) pour d’autres combinaisons d’outils.

## Choisir un exécutable Bash personnalisé

Définissez `shellPath` si Bash est installé à un emplacement que Prism ne détecte pas automatiquement :

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

JSON utilise les barres obliques inverses pour les séquences d’échappement. Dans un chemin Windows, doublez chaque barre oblique inverse, comme ci-dessus.

Consultez [Configurer les commandes du shell](shell-aliases.md) pour les préfixes de commande, les alias et le fonctionnement complet de la sélection du shell.

## Configurer Windows Terminal

Windows Terminal réserve ou remplace certaines touches modifiées. Consultez [Windows Terminal](terminal-setup.md#windows-terminal) pour configurer `Shift+Enter` et `Alt+Enter`, et [Raccourcis clavier](keybindings.md) pour les raccourcis par défaut de Prism sous Windows et WSL.
