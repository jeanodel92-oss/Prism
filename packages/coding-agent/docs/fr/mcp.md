# Serveurs MCP

Prism se connecte aux serveurs [Model Context Protocol](https://modelcontextprotocol.io) par stdio (entrée et sortie standard) ou HTTP en flux continu et rend leurs outils et ressources accessibles au modèle.

## Configuration rapide

Ajoutez un serveur local stdio, vérifiez la connexion, puis démarrez Prism :

```bash
prism mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
prism mcp list
prism
```

Pour un serveur distant :

```bash
prism mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN
prism mcp list
```

Par défaut, ces commandes ajoutent des serveurs à la configuration utilisateur. Ajoutez `--local` ou `-l` pour modifier plutôt la configuration du projet :

```bash
prism mcp add -l tools --env API_KEY='${TOOLS_KEY}' -- uvx tools-mcp
```

Dans une session interactive, utilisez `/mcp` pour examiner les connexions, vous connecter, rétablir une connexion, modifier l’exposition ou activer et désactiver des serveurs. Exécutez `/reload` après avoir ajouté, supprimé ou modifié un serveur en dehors de la session.

## Configurer les serveurs

Prism lit les serveurs utilisateur dans `~/.prism/agent/mcp.json` et les serveurs du projet dans `.prism/mcp.json`. La configuration du projet n’est lue qu’après [l’approbation du projet](security.md#comprendre-la-confiance-accordée-au-projet). Une entrée du projet remplace une entrée utilisateur du même nom.

Le format correspond à celui des autres clients MCP :

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search and read the product documentation"
    }
  }
}
```

Les serveurs stdio utilisent `command`, `args`, `env` et `cwd`. Les chemins relatifs de `cwd` sont résolus depuis le dossier de session. Un chemin commençant par `~/` dans `command`, un argument ou `cwd` désigne le dossier personnel.

Les serveurs HTTP utilisent `url`, `headers` et `oauth` (consultez [S’authentifier avec OAuth](#s-authentifier-avec-oauth)). Le transport SSE historique n’est pas pris en charge.

Les deux types de serveurs prennent en charge :

- `timeout` : délai maximal par demande en secondes (60 par défaut). Les notifications de progression réinitialisent ce délai.
- `enabled: false` : conserve l’entrée sans s’y connecter.
- `exposure` et `toolExposure` : déterminent comment les outils sont présentés au modèle (consultez [Contrôler l’exposition des outils](#controler-lexposition-des-outils)).
- `description` : phrase décrivant ce que le serveur fournit. Elle est ajoutée au prompt système (consultez [Contrôler l’exposition des outils](#controler-lexposition-des-outils)), sert au classement des outils du serveur dans la recherche et est renvoyée par `describeNamespace()` dans codemode. Si elle est absente, la première ligne des consignes du serveur est utilisée après la connexion.

Gardez les serveurs personnels et ceux qui utilisent des identifiants dans le fichier utilisateur. Utilisez le fichier du projet uniquement pour les serveurs nécessaires au projet, et seulement pour les projets approuvés.

### Règles de configuration

- Les noms de serveur ne peuvent contenir que des lettres, chiffres, `_` et `-`. Les outils sont nommés `mcp__<server>__<tool>` ; tous les caractères autres que les lettres, chiffres et `_` sont remplacés par `_`. Si les noms d’outils d’un serveur entrent alors en collision, ils reçoivent tous un suffixe de hachage. Des noms de serveur qui ne diffèrent que par `-` et `_` désignent le même serveur : le second est refusé et un serveur de `mcp.json` remplace un serveur enregistré.
- `type` est facultatif. `command` sélectionne stdio et `url` sélectionne HTTP en flux continu. Si `type` est présent, sa valeur doit être `stdio`, `http` ou `streamable-http`.
- `sse` est refusé. Les serveurs qui documentent un point de terminaison SSE proposent souvent aussi HTTP en flux continu, généralement sous `/mcp` au lieu de `/sse`.
- `command` indique un exécutable et `args` ses arguments. Ce n’est pas une commande shell.
- Les valeurs de `env` et `headers` peuvent utiliser des variables d’environnement comme `${GITHUB_TOKEN}`. Elles peuvent aussi exécuter une commande avec `!command`, mais celle-ci doit constituer toute la valeur, par exemple `"Authorization": "!echo Bearer $(gh auth token)"`.
- Les entrées invalides sont signalées et ignorées sans empêcher la connexion des autres serveurs.

`prism mcp add` et `prism mcp remove` permettent d’effectuer les modifications courantes depuis un shell. Consultez [Commandes MCP](../cli.md#mcp-commands) pour les options.

### Examiner ou modifier un serveur

`/mcp` affiche les serveurs configurés avec leur état, le nombre d’outils, l’exposition et la source de configuration. Les serveurs à traiter apparaissent d’abord. Sélectionnez un serveur pour examiner ses outils et sa connexion, rétablir la connexion, vous connecter ou vous déconnecter, modifier son exposition, ou l’activer ou le désactiver.

Les changements d’exposition et d’activation sont enregistrés dans le fichier qui définit le serveur, sans remplacer son contenu sans rapport. Les serveurs désactivés restent dans la liste. En dehors de l’interface interactive, `/mcp` affiche l’état des serveurs ; `/mcp login <server>`, `/mcp logout <server>` et `/mcp reconnect <server>` exécutent directement ces actions.

Les commandes shell fonctionnent sans session : `prism mcp add`, `prism mcp remove`, `prism mcp list`, `prism mcp login` et `prism mcp logout`. Elles ne chargent pas les extensions.

### Diagnostiquer les problèmes de connexion

Exécutez `prism mcp list` pour vous connecter à chaque serveur activé et afficher son état, ses outils et les erreurs. La commande renvoie le code de sortie 1 si une entrée est invalide ou si un serveur activé n’est pas connecté. `/mcp` affiche l’erreur de connexion complète et la fin de la sortie d’erreur d’un serveur stdio dont la connexion a échoué.

Prism signale une fois après le démarrage les erreurs de configuration, les échecs de connexion et les demandes de connexion. Les notifications de journal du serveur sont ajoutées à `~/.prism/agent/mcp.log` sous la forme `<time> [<server>] <level> <logger>: <message>`. Le fichier est déplacé vers `mcp.log.1` quand il dépasse 5 Mio.

Prism se connecte en arrière-plan à chaque serveur activé au démarrage d’une session. Les outils d’un serveur apparaissent dès qu’il est connecté ; la description de `codemode` ne les répertorie pas et ne change donc pas avec les connexions. Le premier prompt attend jusqu’à 10 secondes uniquement pour les serveurs qui ont des outils `direct`, lesquels doivent figurer dans sa demande. Les autres serveurs sont attendus quand ils sont nécessaires : un script codemode attend les serveurs qu’il nomme (`mcp__<server>`) et, s’il appelle `searchTools()` ou lit `ALL_TOOLS`, attend tous les serveurs ; `tool_search` et les outils de ressources les attendent aussi tous. Les erreurs réseau HTTP et états temporaires (408, 429 et 5xx) sont réessayés deux fois. Une connexion interrompue est signalée comme coupée et rétablie à l’appel suivant. Quand un serveur annonce une liste d’outils modifiée, les nouveaux outils sont ajoutés et ceux qui ont été retirés deviennent inaccessibles.

Pour arrêter un serveur stdio, Prism ferme son entrée standard, envoie SIGTERM, puis envoie SIGKILL à son groupe de processus. Cela arrête aussi les serveurs lancés avec des enveloppes comme `npx` ou `uvx`.

## Convertir la configuration d’un autre client

Déplacez l’entrée convertie sous `mcpServers` dans `mcp.json`, puis exécutez `prism mcp list` pour la valider.

| Client | Conversion |
|---|---|
| Claude Desktop, Claude Code ou Cursor | Copiez l’entrée `mcpServers` existante. |
| VS Code | Déplacez une entrée de l’objet racine `servers` et remplacez les demandes `${input:...}` par des variables d’environnement `${NAME}`. |
| Codex | Convertissez en JSON les champs TOML `[mcp_servers.<name>]`, tels que `command`, `args`, `env` et `url`. |
| OpenCode | Convertissez `"type": "local"` en entrée stdio, séparez le tableau `command` en `command` et `args`, renommez `environment` en `env` et remplacez `{env:NAME}` par `${NAME}`. Convertissez `"type": "remote"` en entrée URL. |

## S’authentifier avec OAuth

Les serveurs distants utilisant OAuth, comme Sentry, n’ont pas besoin d’identifiants dans `mcp.json` :

```json
{
  "mcpServers": {
    "sentry": { "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

Quand le serveur refuse une connexion sans authentification, `/mcp` indique qu’une connexion est nécessaire. Choisissez « Sign in », exécutez `/mcp login sentry` ou `prism mcp login sentry`. Prism ouvre la page d’autorisation et attend votre approbation. Si le navigateur tourne sur une autre machine, par exemple par SSH, collez son URL de redirection dans l’écran de connexion. Une session active utilisera les nouveaux identifiants au tour suivant.

Prism s’enregistre auprès du serveur d’autorisation, stocke les jetons dans `~/.prism/agent/mcp-auth.json` et renouvelle les jetons d’accès à leur expiration ou si le serveur les refuse. Si un serveur demande ensuite des autorisations supplémentaires, Prism vous demande de vous connecter de nouveau. La déconnexion supprime les identifiants enregistrés.

Les identifiants sont associés au nom et à l’URL d’un serveur. Des serveurs de même URL mais de noms différents, par exemple un par compte, nécessitent chacun une connexion ; des serveurs ayant le même nom et la même URL dans des fichiers `mcp.json` différents partagent une connexion.

OAuth s’applique aux serveurs HTTP sans en-tête `Authorization`. Si un serveur ne prend pas en charge l’enregistrement dynamique des clients, configurez un client enregistré :

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": { "clientId": "my-client", "clientSecret": "${EXAMPLE_SECRET}", "callbackPort": 8765 }
    }
  }
}
```

L’URI de redirection doit correspondre à l’URI enregistrée. `callbackPort` utilise `http://127.0.0.1:<port>/callback`. Pour utiliser une autre URI, définissez `callbackUrl` ; elle doit utiliser HTTP avec `localhost`, `127.0.0.1` ou `[::1]`. Prism l’envoie telle quelle. Si `callbackUrl` ne précise pas de port, Prism utilise `callbackPort` ou un port libre et l’ajoute à l’URI, comme l’autorise la RFC 8252 pour les redirections en boucle locale. `clientSecret` est facultatif ; il peut utiliser une variable d’environnement ou une commande.

Définissez `scope` sous forme de liste séparée par des espaces pour les serveurs qui n’annoncent pas les autorisations nécessaires. Sinon, Prism demande les autorisations annoncées. Les demandes d’autorisations ultérieures sont ajoutées à la valeur configurée.

Prism s’enregistre sous le nom `prism`. Certains serveurs n’acceptent que les enregistrements de clients connus. Définissez `clientName` pour envoyer un autre nom :

```json
{
  "mcpServers": {
    "figma": { "url": "https://mcp.figma.com/mcp", "oauth": { "clientName": "Claude Code" } }
  }
}
```

Ce nom est envoyé uniquement quand Prism enregistre un client. Pour vous enregistrer à nouveau sous un autre nom, déconnectez-vous d’abord.

Prism trouve le serveur d’autorisation grâce aux métadonnées de ressources protégées du serveur (RFC 9728) et vérifie que les métadonnées du serveur d’autorisation indiquent l’émetteur attendu (RFC 8414). Certains serveurs indiquent un mauvais serveur d’autorisation ou n’en indiquent aucun ; la connexion ouvre alors une page inexistante. Définissez `authServerMetadataUrl` vers le document de métadonnées du bon serveur d’autorisation :

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": { "authServerMetadataUrl": "https://example.okta.com/.well-known/openid-configuration" }
    }
  }
}
```

Prism utilise ce document au lieu de la découverte et lui fait confiance comme défini dans la configuration. Indiquez uniquement l’adresse d’un document auquel vous faites confiance. L’URL doit utiliser HTTPS, sauf pour `localhost`, `127.0.0.1` ou `[::1]`.

## Contrôler l’exposition des outils

Chaque outil du serveur est enregistré sous le nom `mcp__<server>__<tool>`. La valeur `exposure` du serveur détermine comment le modèle y accède :

| Exposition | Fonctionnement | Utilisation habituelle |
|---|---|---|
| `codemode` (par défaut) | Accessible depuis les scripts [`codemode`](../cli.md#tools), mais ni déclarée au modèle ni répertoriée dans la description de codemode. Les scripts trouvent les outils avec `searchTools()`, `describeTool()` ou `ALL_TOOLS`. | Serveurs MCP généralistes, surtout si les scripts doivent combiner ou filtrer les appels. |
| `deferred` | Pas déclarée avant que [`tool_search`](../cli.md#tools) ne charge une correspondance pour le prochain appel du modèle. | Grands serveurs dont les outils doivent être appelés directement après leur découverte. |
| `direct` | Déclarée au modèle comme un outil intégré et également accessible depuis codemode. | Petits ensembles d’outils utilisés souvent. |
| `hidden` | Enregistrée, mais inaccessible. | Serveurs ou outils qui doivent rester indisponibles. |

`codemode-deferred` est accepté comme autre nom pour `codemode`.

Les serveurs possédant des outils `codemode` ou `deferred` sont répertoriés dans la section `mcp_servers` du prompt système, avec le mode d’accès à leurs outils et une ligne de la propriété `description` configurée ou, après connexion, des consignes du serveur. Prism actualise cette section au démarrage d’un prompt, après avoir attendu les serveurs qui possèdent des outils `direct`. Si elle change, par exemple quand un serveur se connecte et que son résumé devient disponible, Prism ajoute la nouvelle section à la conversation au lieu de modifier les définitions d’outils, afin que les messages précédents restent en cache. `describeNamespace()` et l’option `namespace` de `searchTools()` acceptent `mcp__dev-radius`, `mcp__dev_radius`, `dev-radius` ou `dev_radius`.

Prism active `codemode` quand un serveur exposant des outils `codemode` se connecte. Il active `tool_search` pour un serveur dont l’exposition est `deferred`. Pour que le modèle voie un outil sans recherche, définissez son exposition sur `direct` avec `toolExposure`.

`toolExposure` remplace l’exposition du serveur pour certains outils. Les clés sont des noms exacts d’outils du serveur ou des motifs où `*` correspond à n’importe quels caractères. Les noms exacts sont prioritaires ; pour les motifs, la première correspondance est prioritaire. Un serveur exposé comme `hidden` ne peut rendre disponibles que les outils sélectionnés :

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "exposure": "deferred",
      "toolExposure": {
        "search_code": "direct",
        "get_*": "codemode",
        "delete_*": "hidden"
      }
    }
  }
}
```

`prism mcp list` marque les outils dont l’exposition diffère de celle du serveur. La vue Tools de `/mcp` affiche aussi l’exposition effective.

Les outils exposés comme `codemode` ou `deferred` sont accessibles par les deux mécanismes indirects : les scripts codemode peuvent les appeler, et `tool_search` peut les charger. Les appels codemode ne dépendent pas de l’ensemble d’outils actif ; ils restent donc disponibles après `/tree`, reprise ou création d’une branche. Les outils chargés par `tool_search` figurent dans la transcription et restent déclarés sur cette branche.

Pour garder `codemode` actif sans serveur MCP, ajoutez `"defaultTools": ["+codemode"]` aux [réglages](settings.md#outils). Pour empêcher l’activation automatique, définissez `"autoEnableCodemode": false` à côté de `mcpServers`. Une valeur de projet est prioritaire sur celle de l’utilisateur. Prism affiche un avertissement une fois si ni `codemode` ni `tool_search` n’est actif et que les outils non directs sont inaccessibles.

Les résultats textuels de plus de 20 Ko sont envoyés au modèle après suppression de leur milieu, remplacé par le marqueur `…N chars truncated…`. Le texte complet est enregistré dans un fichier temporaire indiqué dans le résultat. Les scripts codemode reçoivent le résultat complet et peuvent le réduire avant de renvoyer du texte au modèle.

Les scripts codemode reçoivent l’objet MCP `CallToolResult` complet, notamment `content`, `structuredContent` et `isError`. Un résultat avec `isError` est renvoyé normalement dans un script, mais signalé comme erreur lors d’un appel direct. `image(result.content[0])` transmet un bloc d’image. Les consignes du serveur ne font partie d’aucune description d’outil ; les scripts les lisent avec `describeNamespace("mcp__<server>")`, qui renvoie aussi les noms des outils du serveur.

## Utiliser les ressources

Quand un serveur connecté fournit des [ressources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), Prism ajoute les outils de ressources utilisés par Codex et OpenCode :

- `list_mcp_resources` répertorie les ressources en JSON : `{ server?, resources: [{ server, uri, name, ... }], nextCursor? }`. Avec `server`, il répertorie une page ; `cursor` passe à la page suivante. Sans `server`, il répertorie toutes les ressources de tous les serveurs.
- `list_mcp_resource_templates` répertorie les modèles d’URI des ressources que les serveurs ne répertorient pas directement.
- `read_mcp_resource` lit une ressource avec `server` et `uri`. Le texte est transmis au modèle en tant que texte et les images en tant qu’images. Les autres ressources binaires sont enregistrées dans des fichiers temporaires ; le modèle reçoit le chemin. Les scripts reçoivent `{ server, uri, contents }`.

Ces outils accèdent à tous les serveurs activés, non masqués et proposant des ressources. Leur exposition correspond au niveau le plus large parmi ces serveurs : `direct`, puis `codemode` ou `deferred`. Les liens de ressource dans les résultats d’outils indiquent `read_mcp_resource` et le serveur.

Les ressources des MCP Apps, identifiées par les URI `ui://` ou le type `text/html;profile=mcp-app`, sont ignorées, car Prism ne les affiche pas. Les icônes des ressources sont également ignorées.

La lecture et l’énumération des ressources sont réessayées une fois après une erreur HTTP temporaire (408, 429 ou 5xx). Les appels d’outils ne sont pas réessayés, car le serveur a peut-être déjà effectué l’opération.

## Permissions

Chaque appel MCP passe par la chaîne d’outils de Prism. Les gestionnaires d’extension `tool_call` et `tool_result`, y compris les contrôles de permissions, s’appliquent donc aussi aux outils MCP. Les appels depuis des scripts codemode portent l’identifiant d’appel codemode comme `parentToolCallId`.

`pi.getAllTools()` renvoie les annotations déclarées par chaque serveur : `readOnlyHint`, `destructiveHint`, `idempotentHint` et `openWorldHint`. Les extensions de permissions peuvent utiliser ces indications pour décider quels appels nécessitent une confirmation (consultez [Exposition des outils](../extensions.md#tool-exposure)). Les outils de ressources sont marqués en lecture seule.

<a id="other-mcp-extensions"></a>

## Extensions et SDK

### Ajouter des serveurs depuis des extensions

Les extensions peuvent ajouter des serveurs à la session actuelle avec `pi.registerMcpServer(name, config)`, en utilisant le même format qu’une entrée `mcpServers` (consultez [Serveurs MCP dans les extensions](../extensions.md#mcp-servers)). Les serveurs enregistrés se connectent comme les serveurs configurés et apparaissent dans `/mcp` avec l’extension comme source.

Les changements d’activation ou d’exposition ne s’appliquent qu’à la session actuelle. Un serveur défini dans un fichier et portant le même nom est prioritaire ; `/mcp` affiche alors l’enregistrement remplacé. Les commandes shell `prism mcp` ne chargent pas les extensions et ne voient que les serveurs définis dans des fichiers.

### Remplacer la prise en charge MCP intégrée

Une extension installée qui enregistre `/mcp`, comme `pi-mcp-adapter`, remplace la prise en charge MCP intégrée des sessions. Prism ne lit alors pas `mcp.json` et ne connecte pas ses serveurs pendant une session ; la commande `/mcp` appartient à l’extension. Supprimez l’extension pour rétablir le comportement intégré. Pour désactiver la prise en charge MCP intégrée sans la remplacer, désactivez `mcp` sous Built-in dans `prism config`, ou définissez `"extensions": ["-builtin:mcp"]` dans les [réglages](settings.md#ressources).

Une extension qui enregistre `codemode` ou `tool_search` remplace de la même façon l’outil portant ce nom. Les commandes shell `prism mcp` utilisent toujours l’implémentation intégrée.

### Utiliser MCP avec le SDK

Les sessions SDK ne chargent pas les extensions intégrées. Ajoutez l’extension MCP, l’extension codemode pour les serveurs `codemode` et l’extension de recherche d’outils pour les serveurs `deferred` au chargeur de ressources. Consultez [Codemode et MCP](../sdk.md#codemode-mcp).
