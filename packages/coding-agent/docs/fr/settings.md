# Référence des réglages

Cette référence répertorie les réglages configurables, leur type, leur valeur par défaut et leur fonction. Les réglages du projet sont prioritaires sur ceux du dossier agent, sauf ceux réservés au niveau global. Les listes de ressources sont combinées. Consultez [Configuration](configuration.md) pour connaître l’emplacement des fichiers et les règles de confiance.

## Modèle et réflexion

<a id="model-cycling"></a>

| Réglage | Type | Valeur par défaut | Description |
|---|---|---|---|
| `defaultProvider` | string | Automatique | Fournisseur d’IA utilisé au démarrage. |
| `defaultModel` | string | Automatique | Identifiant du modèle utilisé au démarrage. |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"medium"` | Niveau de réflexion au démarrage. |
| `modelThinkingLevels` | object | Aucun | Niveaux de réflexion au démarrage par modèle, indexés par `provider/modelId` exact. |
| `thinkingBudgets` | object | Budgets intégrés | Budgets de tokens pour les niveaux de réflexion `minimal`, `low`, `medium` et `high`. |
| `enabledModels` | `string[]` | Tous les modèles disponibles | Motifs de modèles utilisés au démarrage et pour passer d’un modèle à l’autre. Même format que `--models`. |
| `hideThinkingBlock` | boolean | `true` | Masque les blocs de réflexion dans la transcription. |
| `showCacheMissNotices` | boolean | `false` | Affiche les avis sur les échecs de cache importants, le préchauffage réussi du cache, l’utilisation du compactage et le rétablissement du fournisseur. |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"streaming"` | Garde chauds les caches de prompts admissibles du fournisseur pendant les exécutions actives ou, avec `"idle"`, entre les exécutions. Réglage réservé au niveau global. |

Le préchauffage du cache s’exécute uniquement si le modèle indique une durée de cache et que Prism estime à au moins 0,05 $ le coût des échecs de cache évités. Son utilisation est comptée dans le total de la session, mais n’entre pas dans le contexte du modèle. `/session` affiche la prochaine décision ; les extensions peuvent la remplacer avec `cache_warming_decision`. Consultez [Durées de cache des prompts](models.md#prompt-cache-lifetimes).

Consultez [Choisir un modèle](models.md) pour la sélection des modèles et les réglages de réflexion.

## Interaction

| Réglage | Type | Valeur par défaut | Description |
|---|---|---|---|
| `steeringMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | Mode d’envoi des messages de guidage mis en attente. |
| `followUpMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | Mode d’envoi des messages de suivi mis en attente. |
| `replyLanguage` | string | `"auto"` | Répond dans la langue du dernier message utilisateur ou dans la langue nommée (par exemple `"French"`). Les réglages du projet peuvent le remplacer. `/settings` > Conversation > Reply language. |
| `language` | `"auto" \| "en" \| "fr"` | `"auto"` | Langue des menus et des messages de Prism. `"auto"` suit `LC_ALL`, `LC_MESSAGES`, puis `LANG` : français pour `fr*`, anglais sinon. Les réponses du modèle suivent `replyLanguage`. `/settings` > Language. |
| `externalEditor` | string | `$VISUAL`, puis `$EDITOR`, puis la valeur de la plateforme | Commande lancée par le raccourci de l’éditeur externe. |
| `doubleEscapeAction` | `"tree" \| "fork" \| "none"` | `"tree"` | Action déclenchée par deux pressions sur Escape si l’éditeur est vide. |
| `treeFilterMode` | `"default" \| "no-tools" \| "user-only" \| "labeled-only" \| "all"` | `"default"` | Filtre initial utilisé par `/tree`. |
| `defaultProjectTrust` | `"ask" \| "always" \| "never"` | `"ask"` | Comportement par défaut pour la confiance accordée aux projets. **Peut être défini uniquement dans les réglages du dossier agent.** |

## Outils

| Réglage | Type | Valeur par défaut | Description |
|---|---|---|---|
| `defaultTools` | `string[]` | `read`, `bash`, `edit`, `write` | Outils activés au démarrage. Les noms seuls remplacent les valeurs par défaut ; `+name` ajoute un outil et `-name` le retire. Un tableau vide désactive tous les outils intégrés, mais pas ceux des extensions ou du SDK. |
| `codemode.mode` | `"on"` \| `"only"` | `"on"` | Manière dont l’outil `codemode` présente les outils quand il est actif. Avec `on`, une note sur l’appel depuis des scripts est ajoutée à la description des outils déclarés, et `codemode` ne répertorie que les outils non déclarés. Avec `only`, `codemode` répertorie tous les outils accessibles aux scripts et masque au modèle les outils intégrés et d’extension actifs ; le modèle y accède alors par `codemode`. |
| `codemode.inlineBudget` | number | `3000` | Nombre estimé de tokens (caractères / 4) que la description de l’outil `codemode` peut consacrer aux définitions d’outils. Les outils qui ne tiennent pas sont omis et trouvés avec `searchTools()`. `0` ne répertorie que les espaces de noms. |

Les outils intégrés disponibles sont `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find` et `ls`. `defaultTools` peut aussi indiquer `codemode` et `tool_search`, enregistrés mais inactifs par des extensions intégrées, ainsi que d’autres outils d’extension enregistrés mais inactifs.

Un tableau contenant uniquement des entrées `+name` et `-name` modifie la sélection héritée au lieu de la remplacer. Par exemple, cela active `codemode` avec les outils par défaut :

```json
{
  "defaultTools": ["+codemode"]
}
```

La liste `["-bash", "+powershell", "+grep"]` remplace `bash` par `powershell` et active `grep`. Les réglages du projet s’appliquent par-dessus ceux de l’utilisateur : une liste du projet contenant uniquement `+name` et `-name` modifie la sélection utilisateur, tandis qu’un nom seul la remplace. Dans une même liste, les noms seuls forment la sélection ; `+name` et `-name` s’appliquent ensuite dans l’ordre.

`/reload` active les nouveaux outils ajoutés à `defaultTools`. Il ne désactive pas les outils retirés de la liste et ne réactive pas les outils inchangés que vous avez désactivés. `--tools`, `--no-tools` et `--no-builtin-tools` remplacent aussi `defaultTools`, y compris lors du rechargement.

Les options d’outils CLI remplacent ce réglage pour une seule exécution ; `--tools` n’accepte pas `+name` ni `-name`. Consultez [Ligne de commande](../cli.md#tools).

### Recherche web

| Réglage | Type | Valeur par défaut | Description |
|---|---|---|---|
| `webSearchProvider` | `"exa" \| "brave" \| "tavily" \| "firecrawl" \| "searxng"` | `"exa"` | Fournisseur utilisé par `web_search`. Réglage réservé au niveau global. `/settings` > Web search > Provider. |
| `webSearchUrl` | string | Aucun | URL de base d’une instance SearXNG (`http` ou `https`, sans identifiants, requête ni fragment). Réglage réservé au niveau global. |

Exa fonctionne sans clé par son point de terminaison public, soumis à une limite de fréquence ; avec une clé Exa, il utilise son API. Brave, Tavily et Firecrawl nécessitent chacun leur propre clé API. SearXNG nécessite l’URL de base d’une instance. Configurez la clé ou l’URL du fournisseur sélectionné dans `/settings` > Web search ou avec `/web-key [exa|brave|tavily|firecrawl|searxng] [remove]`. Sans fournisseur indiqué, le fournisseur sélectionné est utilisé ; si vous en nommez un, sa clé ou son URL est configurée sans changer le choix actuel.

`EXA_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY` et `FIRECRAWL_API_KEY` sont prioritaires sur les clés enregistrées par `/web-key` dans `auth.json` du dossier agent. `remove` supprime la clé ou l’URL SearXNG enregistrée, mais ne retire pas les variables d’environnement. Si une clé Brave, Tavily ou Firecrawl, ou une URL SearXNG, manque, Prism signale une erreur de configuration au lieu de se rabattre sur Exa. Les recherches Firecrawl renvoient des extraits sans analyser les pages et acceptent des requêtes d’au plus 500 caractères. `web_fetch` fonctionne quel que soit le fournisseur de recherche : il utilise Exa si une clé Exa est disponible, puis récupère directement les URL.

## Sessions et contexte

| Réglage | Type | Valeur par défaut | Description |
|---|---|---|---|
| `sessionDir` | string | Dossier des sessions de l’agent | Dossier d’enregistrement des sessions. Les chemins relatifs partent du dossier de travail. `PRISM_CODING_AGENT_SESSION_DIR` et `--session-dir` remplacent ce réglage. |

### Compactage

| Réglage | Type | Valeur par défaut | Description |
|---|---|---|---|
| `compaction.enabled` | boolean | `true` | Active le compactage automatique. |
| `compaction.thresholdPercent` | number | Aucun (valeur par défaut) | Pourcentage de déclenchement supérieur à 0 et inférieur ou égal à 100, limité pour laisser assez de place au résumé. Réglage réservé au niveau global. `/settings` > Conversation > Auto-compact threshold ; la valeur par défaut utilise `contextWindow - reserveTokens`. |
| `compaction.reserveTokens` | number | `16384` | Tokens réservés à la réponse du modèle. |
| `compaction.keepRecentTokens` | number | `20000` | Tokens récents conservés sans résumé. |
| `compaction.modelOverrides` | object | Aucun | Réglages de tokens par modèle, indexés par `provider/modelId` exact. |

<a id="per-model-compaction-overrides"></a>

Les valeurs de compactage en tokens doivent être des entiers sûrs non négatifs. Chaque valeur est déterminée séparément à partir du remplacement correspondant au modèle, puis du réglage de compactage habituel, puis de la valeur intégrée par défaut. Les objets du projet et de l’utilisateur sont fusionnés avant la recherche du modèle.

Consultez la [référence du compactage](../compaction.md) pour le déclenchement, le résumé et la validation.

### Résumés des branches

| Réglage | Type | Valeur par défaut | Description |
|---|---|---|---|
| `branchSummary.reserveTokens` | number | `16384` | Tokens réservés au résumé de l’historique d’une branche. |
| `branchSummary.skipPrompt` | boolean | `false` | Ignore la demande de résumé de branche et choisit de ne pas en faire. |

## Terminal et affichage

| Réglage | Type | Valeur par défaut | Description |
|---|---|---|---|
| `theme` | string | `"prism-light/prism"` | Nom d’un thème intégré ou personnalisé, ou duo clair/sombre. Le duo par défaut suit l’apparence du terminal. `system` déduit les couleurs du thème du terminal. |
| `quietStartup` | boolean \| `"header"` | `false` | `true` masque l’en-tête de démarrage et la liste des ressources chargées. `"header"` garde l’en-tête (version et raccourcis), mais masque la ligne des modèles et la liste des ressources chargées. |
| `animations` | boolean | `true` | Les animations de Prism : le logo qui se dessine au démarrage, la ligne d'attente, les reflets, les points qui respirent, l'ouverture des menus et l'indicateur dans le titre du terminal. `false`, ou un terminal non interactif, les fige toutes. `/settings` > Appearance > Animations. |
| `animationsOff` | string[] | `[]` | Les animations désactivées une à une, sous `animations` : `intro` (logo au démarrage), `working`, `thinking`, `tools`, `menus`, `title`. `/settings` > Appearance > Animations les liste avec un aperçu. |
| `footerActions` | string[] | `[]` | Les commandes épinglées au pied de page, dans l'ordre, avant l'engrenage des réglages et « plus… » : `help`, `docs`, `tutorial`, `settings`, `perm`, `model`, `session`, `new`, `resume`, `tree`, `export`, `compact`. Celles qui n'y tiennent pas restent dans « plus… ». « plus… » > Boutons du pied de page… les épingle, les déplace et les retire. |
| `tuiMode` | `"regular" \| "fullscreen"` | `"fullscreen"` | Mode de l’interface interactive du terminal. |
| `fullscreenExitOutput` | `"transcript" \| "resume-hint"` | `"transcript"` | Texte affiché à la sortie du plein écran. |
| `fullscreenScrollbar` | `"auto" \| "always" \| "hidden"` | `"auto"` | Comportement de la barre de défilement de la transcription en plein écran. |
| `fullscreenCopyOnSelect` | boolean | `true` | Copie automatiquement le texte sélectionné en mode plein écran. |
| `fullscreenWheelScrollLines` | `"auto" \| number` | `"auto"` | Nombre de lignes défilées par mouvement de molette en plein écran, de 1 à 100. `"auto"` fait avancer d’une ligne par mouvement sur les terminaux macOS locaux, qui accélèrent déjà la molette et le pavé tactile ; ailleurs et par SSH, il accélère les mouvements rapides jusqu’à 6 lignes par mouvement. Alt+molette multiplie cette distance par cinq. |
| `editorPaddingX` | number | `0` | Marge horizontale de l’éditeur, de 0 à 3 cellules. |
| `outputPad` | `0 \| 1` | `1` | Marge horizontale de la transcription. |
| `autocompleteMaxVisible` | number | `5` | Nombre de résultats d’autocomplétion visibles, de 3 à 20. |
| `showHardwareCursor` | boolean | `false` | Affiche le curseur du terminal quand Prism le positionne pour les méthodes de saisie. |
| `terminal.showImages` | boolean | `true` | Affiche les images intégrées si elles sont prises en charge. |
| `terminal.imageWidthCells` | number | `60` | Largeur préférée des images intégrées, en cellules du terminal. |
| `terminal.clearOnShrink` | boolean | `false` | Efface les lignes vides quand le contenu affiché rétrécit. |
| `terminal.showTerminalProgress` | boolean | `false` | Affiche la progression OSC 9;4 dans l’onglet du terminal. |
| `terminal.hyperlinks` | `boolean \| "auto"` | `"auto"` | Remplace la détection des hyperliens OSC 8. |
| `terminal.images` | `"kitty" \| "iterm2" \| "auto" \| false` | `"auto"` | Remplace la détection du protocole d’images intégrées. |
| `terminal.trueColor` | `boolean \| "auto"` | `"auto"` | Remplace la détection des couleurs vraies. |
| `images.autoResize` | boolean | `true` | Redimensionne les images à 2000 par 2000 pixels au plus avant de les envoyer au modèle. |
| `images.blockImages` | boolean | `false` | Empêche l’envoi d’images aux modèles. |
| `markdown.codeBlockIndent` | string | `"  "` | Préfixe utilisé pour indenter les blocs de code affichés. |
| `markdown.mermaid` | `"off" \| "final" \| "streaming"` | `"streaming"` | Mode d’affichage Mermaid. |

Consultez [Thèmes](themes.md) et [Configurer votre terminal](terminal-setup.md) pour le format et les détails par plateforme.

## Réseau et nouvelles tentatives

| Réglage | Type | Valeur par défaut | Description |
|---|---|---|---|
| `transport` | `"auto" \| "sse" \| "websocket" \| "websocket-cached"` | `"auto"` | Transport préféré pour les fournisseurs d’IA qui en prennent plusieurs en charge. |
| `httpProxy` | string | Aucun | URL de proxy définie sous `HTTP_PROXY` et `HTTPS_PROXY` pour les clients HTTP gérés par Prism. **Peut être défini uniquement dans les réglages du dossier agent.** |
| `httpIdleTimeoutMs` | number | `300000` | Délai maximal d’inactivité des en-têtes et du corps HTTP, en millisecondes. Définissez `0` pour le désactiver. |
| `websocketConnectTimeoutMs` | number | `15000` | Délai maximal de connexion WebSocket, en millisecondes. Définissez `0` pour le désactiver. |
| `retry.enabled` | boolean | `true` | Active les nouvelles tentatives automatiques de l’agent après des erreurs temporaires. |
| `retry.maxRetries` | number | `3` | Nombre maximal de nouvelles tentatives de l’agent. |
| `retry.baseDelayMs` | number | `2000` | Délai initial du recul exponentiel, en millisecondes. |
| `retry.maxAgentDelayMs` | number | `60000` | Délai maximal entre les nouvelles tentatives de l’agent, en millisecondes. |
| `retry.provider.timeoutMs` | number | `httpIdleTimeoutMs` | Délai maximal d’une demande au fournisseur, en millisecondes. |
| `retry.provider.maxRetries` | number | `0` | Nombre de nouvelles tentatives du fournisseur. |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Délai maximal demandé par le serveur, en millisecondes. Définissez `0` pour désactiver cette limite. |

Gardez `retry.provider.maxRetries` à `0`, sauf si des tentatives du fournisseur sont nécessaires. Elles peuvent retarder le traitement des erreurs de quota et de limite d’utilisation par Prism.

## Shell

| Réglage | Type | Valeur par défaut | Description |
|---|---|---|---|
| `shellPath` | string | Valeur de la plateforme | Chemin personnalisé de l’exécutable shell. Accepte le préfixe `~`. |
| `shellCommandPrefix` | string | Aucun | Préfixe ajouté à chaque commande shell. |
| `npmCommand` | `string[]` | `npm` | Commande et arguments utilisés pour rechercher et installer des packages npm. |

Consultez [Alias shell](shell-aliases.md) pour configurer le shell et [Packages Prism](packages.md) pour le comportement du gestionnaire de packages.

## Ressources

Les chemins des réglages utilisateur partent du dossier agent. Ceux des réglages du projet partent du dossier `.prism`. Les chemins absolus et `~` sont acceptés.

| Réglage | Type | Valeur par défaut | Description |
|---|---|---|---|
| `packages` | array | `[]` | Sources de packages Prism npm, git ou locales. Consultez [Packages Prism](packages.md). |
| `extensions` | `string[]` | `[]` | Fichiers ou dossiers d’extensions. |
| `skills` | `string[]` | `[]` | Fichiers ou dossiers de skills. |
| `prompts` | `string[]` | `[]` | Fichiers ou dossiers de modèles de prompt. |
| `themes` | `string[]` | `[]` | Fichiers ou dossiers de thèmes. |
| `enableSkillCommands` | boolean | `true` | Enregistre les skills comme commandes `/skill:name`. |

Les tableaux de ressources acceptent les exclusions par motif glob avec `!pattern`, l’inclusion d’un chemin précis avec `+path` et son exclusion avec `-path`. Prism charge les ressources des réglages utilisateur et du projet.

Les extensions intégrées portent les noms suivants : `builtin:mcp`, `builtin:llama.cpp`, `builtin:codemode`, `builtin:tool-search`, `builtin:prism` (apparence Prism), `builtin:files` (explorateur de fichiers du projet, `/files`, `Alt+E`), `builtin:lsp-setup` (`/lsp-setup [all]`, suggestions de serveurs de langage), `builtin:reply-language` (consignes de langue de réponse), `builtin:machine-context` (votre système, votre matériel et votre shell, pour le modèle), `builtin:checkpoints` (`/undo`, `/checkpoints`), `builtin:background` (outil `background`, `/bg`), `builtin:memory` (`/memory`), `builtin:session-search` (outil `session_search`, qui cherche dans vos autres sessions et demande avant d'en envoyer des extraits à un modèle cloud, et `/sessions`), `builtin:notify` (notifications de bureau, `/settings` > Notifications), `builtin:web` (outils `web_fetch` et `web_search` ; la recherche utilise le [fournisseur configuré](#recherche-web)), `builtin:browser` (outil `browser` et `/browser` : l’agent utilise votre propre navigateur, dans ses propres onglets, par l’extension Prism), `builtin:desktop` (outil `desktop` et `/desktop` : l’agent utilise des programmes graphiques sur un bureau à lui, un labwc sans écran, à part du vôtre), `builtin:user-desktop` (outil `user_desktop` : l’agent utilise votre propre écran, votre pointeur et votre clavier quand vous le demandez et l’acceptez, jusqu’à ce que vous les repreniez), `builtin:append-system` (consignes génériques ajoutées après `APPEND_SYSTEM.md`), `builtin:skills` (`/skills`, le gestionnaire de skills ; les skills se chargent sans lui), `builtin:agents` (agents personnalisés, `/agents`, outil `agent`), `builtin:project-continuity` (dans un projet qui a `project/handoff.md`, le rôle de chaque document de continuité dans le prompt système ; ailleurs, un bouton `init` dans le pied de page qui lance `/init`) et les plugins tiers intégrés répertoriés dans `vendor/README.md` (`builtin:pi-lsp`, ...). Elles sont chargées par défaut, sauf `builtin:memory`, `builtin:session-search`, `builtin:browser`, `builtin:desktop` et `builtin:user-desktop`, activées par `+builtin:memory`, `+builtin:session-search`, `+builtin:browser`, `+builtin:desktop` et `+builtin:user-desktop` ; `-builtin:mcp` en désactive une. Une entrée `+builtin:<name>` ou `-builtin:<name>` dans les réglages du projet remplace le réglage utilisateur. `prism config` les répertorie sous Built-in. `--no-extensions` les désactive aussi et `-e builtin:<name>` en charge une explicitement.

## Mises à jour, télémétrie et avertissements

| Réglage | Type | Valeur par défaut | Description |
|---|---|---|---|
| `updateMode` | string | `"manual"` | `"manual"` : Prism ne demande rien à `https://prism.odelserver.space` tant que vous ne lancez pas `/update` ou `prism update`. `"notify"` : au démarrage, il vous prévient s’il existe une version plus récente. `"auto"` : au démarrage, il l’installe ; la nouvelle version s’ouvre au lancement suivant. Au plus une vérification par heure ; uniquement pour une installation faite avec le programme d’installation du site, et jamais avec `PI_OFFLINE`. Dans `/settings` › Autres › Mises à jour. |
| `collapseChangelog` | boolean | `false` | Affiche un journal des changements abrégé après une mise à jour. |
| `enableInstallTelemetry` | boolean | `true` | Active les rapports anonymes d’installation et de mise à jour et certains en-têtes d’attribution fournisseur. Ne contrôle pas la vérification des mises à jour. |
| `enableAnalytics` | boolean | `false` | Autorise le partage de données analytiques. Actuellement utilisé uniquement par l’assistant expérimental du premier démarrage. |
| `warnings.anthropicExtraUsage` | boolean | `true` | Avertit si l’authentification par abonnement Anthropic peut entraîner des frais d’utilisation supplémentaires. |

## Confidentialité et traces d'opérations

| Réglage | Type | Valeur par défaut | Description |
|---|---|---|---|
| `traceEnabled` | booléen | `false` | Conserve une chronologie JSONL locale des appels d'outils, paramètres, décisions de permission et résultats. Les clés d'authentification enregistrées et les formats courants de secrets sont masqués. Les prompts et le texte du modèle ne sont pas enregistrés. |
| `traceRetentionDays` | nombre | `7` | Au démarrage, supprime les fichiers de trace plus anciens que ce nombre de jours. |

`/trace` affiche la chronologie et le chemin du fichier de la session actuelle. Activez cette fonction dans `/settings`, sous Confidentialité, puis lancez `/reload` ; les changements s'appliquent au rechargement. Chaque paramètre est limité à 16 000 caractères ; sa longueur d'origine est conservée.
