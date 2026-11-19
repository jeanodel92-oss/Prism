<a id="cli-and-modes-reference"></a>

# Ligne de commande

Cette page décrit les commandes et options intégrées de Prism. Exécutez `prism --help` ou ajoutez `--help` à une commande pour connaître l’interface exacte de la version installée. L’aide générale comprend aussi les options enregistrées par les extensions chargées.

```sh
prism [options] [--] [@files...] [messages...]
prism install <source> [options]
prism remove <source> [options]
prism uninstall <source> [options]
prism update [target] [options]
prism list
prism config [options]
prism auth <check|print-api-key|print-bearer-token> [options]
prism mcp <list|login|logout> [options]
```

<a id="modes"></a>

## Lancer Prism et afficher les résultats

```sh
prism
prism --print "Summarize this repository"
git diff | prism --print "Review this change"
prism --mode json "Inspect this repository" > events.jsonl
```

Si l’entrée et la sortie standard correspondent à un terminal, Prism ouvre son interface de terminal, sauf si `--print`, `--mode json` ou `--mode rpc` sélectionne une autre interface. Si l’un des flux est redirigé et qu’aucun mode JSON ou RPC n’est sélectionné, Prism utilise le mode d’affichage. Consultez [Intégrer Prism à la CLI](../cli-integration.md) pour choisir entre les modes interactif, affichage, JSON, RPC et l’intégration au SDK.

| Entrée | Comportement |
|---|---|
| `message` | Fournit un prompt initial |
| `@path` | Ajoute un fichier texte ou une image au premier prompt |
| Entrée redirigée | Ajoute son contenu au début du premier prompt |
| `--` | Arrête l’analyse des options pour qu’un prompt puisse commencer par `-` |

Prism résout `@path` depuis le dossier de travail actuel. Celui-ci détermine aussi la configuration du projet, la découverte des ressources et le regroupement des sessions.

`--print` indique si Prism s’exécute une fois puis se ferme. `--mode` choisit l’interface de sortie. `--mode text` n’impose pas une seule exécution lorsque l’entrée et la sortie standard sont des terminaux ; utilisez `--print` pour cela.

| Option | Comportement |
|---|---|
| `-p`, `--print` | Exécute les prompts fournis, écrit le texte final de l’assistant sur stdout, puis quitte |
| `--mode text` | Choisit la sortie texte ; ouvre quand même l’interface de terminal si l’entrée et la sortie sont des terminaux |
| `--mode json` | Exécute les prompts fournis, écrit les événements JSONL sur stdout, puis quitte |
| `--mode rpc` | Lit les commandes JSONL sur stdin et écrit les réponses et événements sur stdout jusqu’à l’arrêt |
| `--export <input> [output]` | Exporte un fichier de session en HTML puis quitte ; déduit le chemin de sortie si `output` est omis |

Le mode RPC refuse les arguments `@file`. Les modes JSON et RPC réservent stdout aux enregistrements de protocole. Consultez [Flux d’événements JSON](../json.md) et [Protocole RPC](../rpc.md).

### Budgets d'exécution

L'extension intégrée accepte des limites facultatives par session dans tous les modes :

| Option | Comportement |
|---|---|
| `--budget-time <minutes>` | Durée réelle à partir du premier démarrage de l'agent |
| `--budget-tools <n>` | Appels d'outils démarrés |
| `--budget-tokens <n>` | Tokens d'entrée, sortie, lecture du cache et écriture du cache rapportés |
| `--budget-cost <montant>` | Coût rapporté en USD ; accepté uniquement si le modèle choisi a un tarif non nul dans ses métadonnées |

`/budget` affiche la consommation et les incertitudes. `/budget time 30`, `/budget tools 50`, `/budget tokens 200000` et `/budget cost 2` définissent les limites ; `/budget off [type]` en supprime une ou toutes. Seule une commande saisie par l'utilisateur peut les modifier. Au plafond, Prism bloque les appels d'outils et requêtes modèle suivants, annule l'opération active et signale les tâches détachées comme toujours en cours.

<a id="model-options"></a>

## Modèles

```sh
prism --model sonnet:high
```

Consultez [Choisir un modèle](models.md) pour sélectionner un modèle et [Fournisseurs](../providers.md) pour gérer les identifiants.

- `--provider <name>`<br>
  Limite la recherche de `--model` à un fournisseur. Nécessite `--model`.
- `--model <pattern>`<br>
  Sélectionne un modèle selon son identifiant exact ou une correspondance approximative avec son identifiant ou son nom. Accepte `provider/id` et un suffixe facultatif `:<thinking>`.
- `--api-key <key>`<br>
  Utilise une clé API temporaire. Nécessite un modèle sélectionné avec `--model` ou `--models`.
- `--thinking <level>`<br>
  Définit `off`, `minimal`, `low`, `medium`, `high`, `xhigh` ou `max`. Est prioritaire sur un suffixe de `--model` et est limité aux capacités du modèle.
- `--models <patterns>`<br>
  Définit les modèles disponibles au démarrage et pour le parcours, dans une liste séparée par des virgules. Accepte les identifiants exacts, les correspondances approximatives, les motifs glob sans distinction de casse et les suffixes facultatifs `:<thinking>`.
- `--list-models [search]`<br>
  Répertorie les modèles disponibles, avec éventuellement une recherche approximative, puis quitte.

<a id="session-options"></a>

## Sessions

```sh
prism --continue
```

Consultez [Sessions et contexte](sessions.md) pour reprendre, créer une branche, nommer et enregistrer des sessions.

- `-c`, `--continue`<br>
  Reprend la session la plus récente du projet actuel.
- `-r`, `--resume`<br>
  Ouvre le sélecteur de session.
- `--session <path|id>`<br>
  Ouvre une session par chemin, identifiant exact ou partiel. Prism cherche d’abord dans le projet actuel et propose de créer une branche pour une session trouvée dans un autre projet.
- `--session-id <id>`<br>
  Ouvre la session du projet portant exactement cet identifiant ou la crée si elle n’existe pas. Les identifiants acceptent les lettres, chiffres, `.`, `_` et `-`.
- `--fork <path|id>`<br>
  Crée une session pour le projet actuel à partir d’une session existante.
- `--session-dir <dir>`<br>
  Remplace l’emplacement d’enregistrement et de recherche. Prioritaire sur `PRISM_CODING_AGENT_SESSION_DIR` et le réglage `sessionDir`.
- `--no-session`<br>
  Utilise une session en mémoire, qui n’est pas enregistrée.
- `-n`, `--name <name>`<br>
  Définit le nom affiché de la session.

Contraintes :

- Les identifiants de session doivent commencer et finir par une lettre ou un chiffre.
- `--fork` ne peut pas être combiné avec `--session`, `--continue`, `--resume` ou `--no-session`.
- `--session-id` ne peut pas être combiné avec `--session`, `--continue` ou `--resume`. Combinez-le avec `--fork` pour choisir le nouvel identifiant.

<a id="tool-options"></a>

## Outils

```sh
prism --tools read,grep,find,ls --print "Review this project"
```

Consultez [Réglages](settings.md#outils) pour définir la sélection d’outils par défaut.

- `-t`, `--tools <list>`<br>
  Remplace la sélection par défaut par une liste autorisée, séparée par des virgules, d’outils intégrés, d’extension ou personnalisés.
- `-xt`, `--exclude-tools <list>`<br>
  Désactive les outils indiqués après l’application de toutes les autres options de sélection.
- `-nbt`, `--no-builtin-tools`<br>
  Désactive les outils intégrés par défaut, mais conserve les outils d’extension et personnalisés.
- `-nt`, `--no-tools`<br>
  Démarre avec tous les outils intégrés, d’extension et personnalisés désactivés.

Par défaut, les outils activés sont `read`, `bash`, `edit` et `write`, sauf si `defaultTools` les modifie. `--tools` remplace toute la sélection ; nommez chaque outil voulu. `defaultTools` accepte aussi `+name` et `-name` pour modifier les valeurs par défaut.

| Outil intégré | Fonction |
|---|---|
| `read` | Lit les fichiers texte et les images prises en charge |
| `bash` | Exécute des commandes shell |
| `powershell` | Exécute des commandes PowerShell sous Windows |
| `edit` | Remplace exactement du texte dans un fichier existant |
| `write` | Crée ou remplace un fichier |
| `grep` | Recherche dans le contenu des fichiers |
| `find` | Recherche des chemins par motifs glob |
| `ls` | Répertorie le contenu d’un dossier |

Les extensions intégrées ajoutent deux autres outils. Ils sont désactivés par défaut ; l’extension MCP les active si un serveur MCP en a besoin (consultez [MCP](mcp.md)). Pour les activer vous-même, indiquez-les dans `--tools` ou `defaultTools`.

| Extension intégrée | Fonction |
|---|---|
| `codemode` | Exécute du JavaScript qui appelle les autres outils, par exemple en parallèle avec `Promise.allSettled` ; seul le résultat du script est transmis au modèle |
| `tool_search` | Recherche les outils non déclarés au modèle (exposition MCP `codemode` et `deferred`), puis déclare les correspondances pour l’appel suivant |

### Activer codemode

Pour activer `codemode` dans chaque session, ajoutez-le aux outils par défaut dans `~/.prism/agent/settings.json` ou dans `.prism/settings.json` du projet :

```json
{
  "defaultTools": ["+codemode"]
}
```

Cela conserve `read`, `bash`, `edit` et `write` et ajoute `codemode`. Pour une seule exécution, indiquez tous les outils, car `--tools` remplace la sélection :

```sh
prism --tools read,bash,edit,write,codemode
```

Codemode est aussi utile sans MCP : les scripts peuvent lancer plusieurs appels d’outils en parallèle, filtrer les longues sorties avant leur transmission au modèle, appeler des modèles de classification comme Jev de TypeSafe avec `models.classify()` (consultez [Modèles de classification](models.md)) et générer des images avec `models.generateImages()` (consultez [Modèles d’image](models.md)).

### Fonctionnement de codemode

Les scripts s’exécutent dans un environnement isolé QuickJS et accèdent aux autres outils avec `tools.<name>(args)`. La page [Codemode](../codemode.md) décrit l’API de script, le répertoire et la découverte des outils, les variables globales `store()` et `models`, ainsi que les limites.

### Recherche d’outils

`tool_search` est désactivé par défaut ; activez-le avec `"defaultTools": ["+tool_search"]` ou `--tools`. Il utilise le même classement que `searchTools()` pour les outils non déclarés et déclare les correspondances pour le prochain appel du modèle. Les outils chargés sont enregistrés dans la session comme les autres changements d’outils et restent déclarés sur cette branche.

<a id="resource-options"></a>

## Ressources

```sh
prism --extension ./review.ts
```

Consultez [Configuration](configuration.md) pour les dossiers habituels et la confiance dans les projets, [Réglages](settings.md#ressources) pour les chemins configurés et [Packages Prism](packages.md) pour les sources de packages.

- `-e`, `--extension <path>`<br>
  Charge un fichier ou dossier d’extension, ou une extension intégrée comme `builtin:mcp`. L’option peut être répétée.
- `-ne`, `--no-extensions`<br>
  Désactive les extensions détectées, configurées et intégrées. Les chemins explicites `-e` sont quand même chargés ; `prism -ne -e builtin:mcp` ne conserve donc que la prise en charge MCP intégrée.
- `--skill <path>`<br>
  Charge un fichier ou dossier de skill. L’option peut être répétée.
- `-ns`, `--no-skills`<br>
  Désactive les skills détectés et configurés. Les chemins explicites `--skill` sont quand même chargés.
- `--prompt-template <path>`<br>
  Charge un fichier ou dossier de modèle de prompt. L’option peut être répétée.
- `-np`, `--no-prompt-templates`<br>
  Désactive les modèles détectés et configurés. Les chemins explicites `--prompt-template` sont quand même chargés.
- `--theme <path>`<br>
  Charge un fichier ou dossier de thème. L’option peut être répétée.
- `--use-theme <name[/name]>`<br>
  Sélectionne le thème interactif de démarrage pour cette exécution.
- `--no-themes`<br>
  Désactive les thèmes détectés et configurés. Les chemins explicites `--theme` sont quand même chargés.
- `-nc`, `--no-context-files`<br>
  Désactive la recherche de `AGENTS.md` et `CLAUDE.md`.

Les chemins de ressources ne s’appliquent qu’au processus actuel. Les chemins relatifs partent du dossier de travail actuel.

<a id="prompt-and-display-options"></a>

## Prompts et processus

```sh
prism --append-system-prompt ./instructions.md
```

Consultez [Configuration](configuration.md) pour les réglages enregistrés, [Sécurité](security.md#comprendre-la-confiance-accordée-au-projet) pour la confiance dans les projets et [Variables d’environnement](environment-variables.md) pour les contrôles du processus.

- `--system-prompt <text|path>`<br>
  Remplace le prompt système par défaut par du texte ou le contenu d’un fichier existant.
- `--append-system-prompt <text|path>`<br>
  Ajoute du texte ou le contenu d’un fichier existant au prompt système. L’option peut être répétée.
- `--tui-mode <mode>`<br>
  Utilise le mode de terminal `fullscreen` (par défaut) ou `regular`.
- `--gui`, `--tui`<br>
  Ouvre la fenêtre de Prism, ou l’interface du terminal, pour ce lancement. Une simple commande `prism` suit **/settings › Interface › Ouvrir Prism dans** ; le premier lancement où la fenêtre peut s’ouvrir pose la question une fois. Sans affichage graphique, ou si la fenêtre ne peut pas démarrer (WebKitGTK absent), Prism dit pourquoi et s’ouvre dans le terminal.
- `--verbose`<br>
  Affiche des informations détaillées au démarrage en mode interactif et remplace `quietStartup`.
- `-a`, `--approve`<br>
  Autorise la configuration et les ressources locales du projet pour ce processus.
- `-na`, `--no-approve`<br>
  Ignore pour ce processus la configuration et les ressources locales du projet soumises à l’approbation.
- `--offline`<br>
  Désactive l’activité réseau automatique, y compris l’actualisation du catalogue de modèles. Équivaut à `PI_OFFLINE=1`.
- `-h`, `--help`<br>
  Affiche l’aide, y compris les options enregistrées par les extensions chargées, puis quitte.
- `-v`, `--version`<br>
  Affiche la version de Prism, puis quitte.

Les extensions peuvent enregistrer d’autres options longues. Les options courtes inconnues sont refusées.

## Commandes de packages

```sh
prism install npm:@scope/package
```

Consultez [Packages Prism](packages.md) pour les formats de source, le filtrage, l’installation et la portée du projet.

### Tâches courantes

| Tâche | Commande |
|---|---|
| Installer un package | `prism install <source>` |
| Répertorier les packages configurés | `prism list` |
| Supprimer un package et son entrée de configuration | `prism remove <source>` |
| Configurer les ressources chargées d’un package | `prism config` |

Ajoutez `--local` ou `-l` à `install`, `remove`, `uninstall` ou `config` pour utiliser les réglages du projet plutôt que les réglages globaux.

### Mettre Prism ou des packages à jour

Quand une version plus récente est disponible, `prism update` l’installe depuis `https://prism.odelserver.space`. Il vérifie d’abord sa signature et sa somme de contrôle, passe à la nouvelle version en une étape, conserve la version précédente et affiche les notes de version. Cette commande fonctionne si Prism a été installé depuis le site ; sinon, réinstallez-le depuis celui-ci :

```sh
curl -fsSL https://prism.odelserver.space/install.sh | sh
```

Dans Prism, `/update` fait la même chose depuis le terminal ou la fenêtre : il vérifie, puis installe à votre demande, change de canal ou revient à la version précédente ; la nouvelle version s’ouvre au lancement suivant. Prism ne vérifie de lui-même que si le réglage `updateMode` le demande (consultez [Réglages](settings.md)).

| Tâche | Commande |
|---|---|
| Mettre Prism à jour | `prism update` |
| Vérifier si une version plus récente de Prism existe | `prism update --check` |
| Revenir à la version précédente de Prism (relancer pour annuler) | `prism update --rollback` |
| Mettre tous les packages installés à jour | `prism update --extensions` |
| Mettre un package installé à jour | `prism update <source>` |
| Actualiser les catalogues de modèles | `prism update --models` |
| Mettre à jour Prism et tous les packages installés | `prism update --all` |

### Alias et options de commande

- `prism uninstall <source>` est un alias de `prism remove <source>`.
- `prism update --self` et `prism update self` sont des alias de `prism update`.
- `prism update --extension <source>` est un alias de `prism update <source>`.
- `-a`, `--approve` approuve les fichiers locaux du projet pour une commande. `-na`, `--no-approve` ignore les fichiers locaux soumis à l’approbation.
- Ajoutez `-h` ou `--help` à une commande pour voir son usage exact et les contraintes de ses options.

## Commandes d’identifiants

```sh
prism auth check --provider openai --json
```

Les commandes d’authentification nécessitent `--provider <provider>` ou `--model <model>`. Consultez [Fournisseurs](../providers.md) pour connaître les méthodes prises en charge.

| Commande | Description |
|---|---|
| `prism auth check` | Affiche `ready`, `not_ready` ou `invalid` et renvoie respectivement le code de sortie `0`, `1` ou `2` |
| `prism auth print-api-key` | Affiche la clé API résolue |
| `prism auth print-bearer-token` | Affiche le jeton OAuth bearer résolu |

| Option | Utilisation | Description |
|---|---|---|
| `--provider <provider>` | Toutes | Résout les identifiants d’un fournisseur |
| `--model <model>` | Toutes | Résout les identifiants à partir d’un modèle ; peut être combiné avec `--provider` |
| `--json` | `auth check` | Écrit le résultat structuré au format JSON |
| `--credentials` | `auth check` | Affiche l’identifiant résolu si l’état est prêt |
| `--no-refresh` | `auth check` | Ne renouvelle pas les identifiants OAuth expirés ; le renouvellement a lieu par défaut |
| `--min-expiry <duration>` | `print-bearer-token` | Impose une durée de validité restante, indiquée avec `ms`, `s`, `m` ou `h`, par exemple `30m` |

Les commandes qui affichent des identifiants écrivent les secrets sur stdout.

## Commandes MCP

Ces commandes fonctionnent en dehors d’une session ; les agents peuvent les lancer avec `bash`. Consultez [Serveurs MCP](mcp.md).

| Commande | Description |
|---|---|
| `prism mcp add <server> [options] -- <command> [args...]` | Ajoute ou remplace un serveur stdio dans `mcp.json` ; les options répétables `--env KEY=VALUE` et `--cwd <dir>` définissent son environnement et son dossier de travail. Les arguments après la commande lui sont transmis. |
| `prism mcp add <server> [options] --url <url>` | Ajoute ou remplace un serveur HTTP en flux continu ; les options répétables `--header KEY=VALUE`, `--bearer-token-env-var <NAME>` (envoie `Authorization: Bearer ${NAME}`), `--oauth-client-id`, `--oauth-client-secret`, `--oauth-callback-port` et `--oauth-client-name` configurent l’authentification. |
| `prism mcp remove <server>` | Supprime un serveur de `mcp.json` ; ses identifiants OAuth enregistrés sont conservés. |
| `prism mcp list [--json]` | Se connecte à tous les serveurs activés et affiche leur état, leurs outils et les erreurs ; renvoie `1` si une entrée de configuration est invalide ou si un serveur activé n’est pas connecté. |
| `prism mcp login <server> [--timeout <seconds>]` | Se connecte à un serveur OAuth : ouvre la page d’autorisation et attend le navigateur (300 secondes par défaut) ; dans un terminal, vous pouvez aussi coller l’URL de redirection. |
| `prism mcp logout <server>` | Supprime les identifiants OAuth enregistrés pour un serveur. |

`add` et `remove` modifient `~/.prism/agent/mcp.json`, ou `.prism/mcp.json` dans le dossier actuel avec `--local` (`-l`). `add` accepte aussi `--exposure <mode>` (consultez [Exposition](mcp.md)) et `--description <text>` ; la commande ne se connecte pas au serveur. Exécutez `prism mcp list` pour le vérifier.

Les fichiers `.prism/mcp.json` d’un projet ne sont lus que si le projet est déjà approuvé.
