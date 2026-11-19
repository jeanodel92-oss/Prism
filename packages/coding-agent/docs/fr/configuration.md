# Configurer Prism

Prism prend en charge la configuration utilisateur et celle du projet. La configuration utilisateur se trouve dans le dossier agent, qui est `~/.prism/agent` par défaut. Celle du projet se trouve dans `.prism`, sous le dossier de travail, et n’est chargée qu’après [l’approbation du projet](security.md#comprendre-la-confiance-accordée-au-projet). La seule exception est `sessionDir`, que Prism lit avant de vérifier la confiance pour pouvoir retrouver les sessions.

En mode interactif, utilisez `/settings` pour modifier les préférences courantes. Pour les autres options, demandez à Prism de modifier la configuration ou changez directement les fichiers concernés. Exécutez `/reload` après avoir modifié manuellement des réglages, raccourcis, consignes ou ressources.

## Dossier agent

Le dossier agent est désigné par `<agent-dir>` ci-dessous. Définissez son emplacement avec la variable d’environnement `PRISM_CODING_AGENT_DIR` ou l’option [`agentDir`](../sdk.md) du SDK.

| Chemin | Rôle |
|---|---|
| `<agent-dir>/settings.json` | [Réglages](settings.md) utilisateur, notamment les préférences, valeurs par défaut, chemins de ressources et déclarations de packages Prism. |
| `<agent-dir>/keybindings.json` | [Raccourcis clavier](keybindings.md) personnalisés de l’interface de terminal et de l’application. |
| `<agent-dir>/mcp.json` | [Serveurs MCP](mcp.md) accessibles dans tous les projets. |
| `<agent-dir>/models.json` | [Points de terminaison compatibles, modèles et remplacements de modèles](models.md#configurer-un-point-de-terminaison-compatible). |
| `<agent-dir>/auth.json` | Clés API et identifiants OAuth enregistrés. |
| `<agent-dir>/AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` ou `CLAUDE.MD` | Consignes utilisateur appliquées dans tous les dossiers de travail. |
| `<agent-dir>/SYSTEM.md` | Remplace le prompt système par défaut de Prism. |
| `<agent-dir>/APPEND_SYSTEM.md` | Ajoute des consignes au prompt système de Prism. |
| `<agent-dir>/extensions/` | [Extensions](../extensions.md) utilisateur. |
| `<agent-dir>/skills/` | [Skills](skills.md) utilisateur et fichiers utiles. |
| `<agent-dir>/prompts/` | [Modèles de prompt](prompt-templates.md) utilisateur proposés comme commandes slash. |
| `<agent-dir>/themes/` | Fichiers de [thème](themes.md) utilisateur. |

## Dossier `.prism` du projet

| Chemin | Rôle |
|---|---|
| `.prism/settings.json` | [Réglages](settings.md) du projet, chemins de ressources et déclarations de packages Prism. |
| `.prism/mcp.json` | [Serveurs MCP](mcp.md) du projet. |
| `.prism/SYSTEM.md` | Remplace le prompt système pour le projet. |
| `.prism/APPEND_SYSTEM.md` | Ajoute des consignes du projet au prompt système. |
| `.prism/extensions/` | Extensions du projet. |
| `.prism/skills/` | Skills du projet et fichiers utiles. |
| `.prism/prompts/` | Modèles de prompt du projet proposés comme commandes slash. |
| `.prism/themes/` | Fichiers de thème du projet. |

Pour `SYSTEM.md` et `APPEND_SYSTEM.md`, le fichier du projet approuvé est prioritaire sur le fichier correspondant du dossier agent. Les fichiers portant le même nom ne sont pas combinés.

## Fichiers de contexte

Les fichiers de contexte sont distincts de la configuration `.prism` du projet. Prism les charge depuis le dossier agent, le dossier de travail et les dossiers parents. Un fichier de contexte s’applique chaque fois que Prism est lancé dans son dossier ou en dessous.

Dans un même dossier, `AGENTS.override.md` remplace `AGENTS.md` ou `CLAUDE.md`. Il ne masque pas les fichiers de contexte du dossier agent ou d’autres dossiers.

La découverte des fichiers de contexte ne nécessite pas l’approbation du projet.
