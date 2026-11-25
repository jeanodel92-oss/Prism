# Permissions

Prism place une étape de confirmation avant les appels d’outils. Elle est toujours active : `--no-extensions`, `--safe` et le réglage `extensions` ne la désactivent pas. Vous seul pouvez la modifier avec `/perm` ou `--perm-mode`. Une extension installée qui enregistre `/perm` ou `--perm-mode` la remplace. `alt+m` change de mode.

Cette étape décide si un appel s’exécute ; la [sandbox](sandbox.md) limite ce qu’une commande shell peut faire une fois lancée. Dans les modes `safe`, `ask` et `broad`, les commandes de l’agent s’exécutent par défaut dans la sandbox : elles ne peuvent modifier que le projet, ne lisent ni les identifiants de Prism ni vos clés, et ne joignent que les hôtes que vous autorisez. Les règles de cette page cherchent des motifs dans les commandes et les chemins ; seules, elles ne forment pas une frontière de sécurité. Hors de la sandbox (mode `unrestricted`, commandes que vous en excluez, outil `sudo`), une commande autorisée peut tout faire avec les permissions de votre compte. Pour isoler tout le processus Prism, consultez [Conteneuriser Prism](containerization.md).

## Actions contrôlées en mode `ask`

Le mode par défaut, `broad`, exécute sans demander les écritures et les commandes dans le projet ; les appels dangereux demandent toujours votre accord. Consultez [Modes](#modes).

| Action | Comportement |
|---|---|
| `read`, `grep`, `find`, `ls` | autorisées, sauf si le chemin est protégé |
| bash sûr : `ls`, `cat`, `grep`, `rg`, `git status/log/diff/show`, ... | autorisé |
| `write` / `edit` dans le projet | demande une confirmation |
| autres commandes bash (`npm install`, `git push`, `rm file`, `node ...`) | demande une confirmation |
| redirections bash vers des fichiers | demande une confirmation (dangereuses en dehors du projet) |
| `sudo`, `rm -rf`, `curl \| sh`, `git push --force`, `npm publish`, `chmod 777`, ... | dangereuses |
| écritures en dehors du projet | dangereuses |
| chemins protégés : `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.netrc`, `authorized_keys`, `.git/hooks/**`, `trust.json`, `permissions.json` | dangereux |
| écritures dans la configuration de Prism, dont les réglages, extensions et agents personnalisés | refusées ; utilisez `configure_prism` pour les changements pris en charge |
| écritures dans les permissions, la confiance, les identifiants et autres réglages de sécurité | refusées ; seul l'utilisateur peut les modifier |
| tout autre outil (extension) | demande une confirmation |

Une boîte de dialogue dit en clair ce que chaque choix autorise : **Autoriser une fois**, **Autoriser « lancer npm install » pendant 15 minutes**, **dans cette session**, **dans ce projet**, **Bloquer cette action une fois**, ou **Bloquer « lancer npm install » dans ce projet**. « Dans ce projet », pour autoriser comme pour bloquer, vaut pour chaque session ouverte dans le même dossier (le chemin réel de sa racine Git, chaque worktree à part) ; c’est gardé dans `project-permissions.json`, dans le dossier de configuration et jamais dans le projet, et listé dans `/settings` › Permissions › Autorisé ou bloqué dans ce projet, où chacun peut être retiré. Un hôte autorisé dans ce projet ne vaut que pour la commande qui l’a demandé (« Autoriser registry.npmjs.org pour « lancer npm install » dans ce projet ») : un autre programme du projet est redemandé. Si l’enregistrement échoue, la boîte de dialogue le dit et repose la question. Un appel dangereux propose de l’autoriser une fois, d’autoriser cet appel exact dans cette session (jamais enregistré : une session reprise redemande ; pas proposé pour les chemins protégés et les identifiants), ou de le bloquer, et demande même en mode `broad`. `/perm window` liste ce qui est autorisé dans cette session et permet de le retirer. Sans réponse, l’appel est refusé après 3 minutes.

Un hôte autorisé **dans cette session** depuis la question réseau d'une commande est
également lié à sa règle (par exemple `npm install`), au premier plan comme en fond.
Une autre commande redemande ; si aucune règle ne couvre sûrement la commande, seul
son texte exact est couvert. Les outils réseau natifs comme `web_fetch` gardent leurs
autorisations d'hôtes valables pour toute la session.
Autoriser une commande **dans ce projet** enregistre aussi les hôtes probables montrés
dans sa question, avec la même règle. La prochaine exécution correspondante ne pose
plus de question réseau pour ces hôtes ; retirer la règle retire aussi ses hôtes.
Les autres hôtes restent demandés et les hôtes bloqués restent refusés.
Prism surveille `project-permissions.json` et le `settings.json` global : retirer un
hôte autorisé coupe les connexions qui n'ont plus d'accord dans chaque session ouverte,
et les suivantes nécessitent de nouveau un accord. Le remplacement atomique du fichier
est détecté ; un réglage incomplet ou invalide conserve les dernières règles valides.
Si la surveillance est indisponible, une lecture périodique détecte les changements
(une fois par seconde).

Sans interface interactive (`-p`, `--mode json`), toute action qui demanderait une confirmation est bloquée, sauf si une règle l’autorise ou si le mode est `broad` ou `unrestricted`.

## Avertissement d’injection de prompt

Le module intégré `injection-warning` est actif par défaut. Il examine le texte de
tous les résultats d’outils (fichiers, commandes, web, MCP et appels imbriqués) avant
la requête suivante au modèle. Des ordres suspects, du texte Unicode masqué ou des
marqueurs de changement de rôle suspendent l’agent avec un avertissement au terminal
ou dans la fenêtre Prism. Le dialogue indique la source et des extraits courts où
les caractères invisibles deviennent visibles.
**Arrêter l’agent** est le premier choix, par défaut ; **Continuer** transmet le
résultat original ; le troisième choix continue sans redemander pour cette source
pendant la session. Un arrêt conserve aussi le résultat original dans la session.
Fermer le dialogue arrête l’agent.

Sans dialogue (print/JSON ou RPC sans client interactif), l’avertissement part vers
stderr ou les notifications RPC et l’exécution continue. Le contenu n’est jamais
filtré ni réécrit. `/settings` > Permissions et sandbox > **Alerte sur les
instructions cachées** désactive immédiatement le contrôle (`"injectionWarning": false` dans
le `settings.json` global). Le module peut aussi être désactivé comme les autres
modules intégrés.

C’est une **réduction du risque, sans garantie ni frontière de sécurité**. Un score
de 3 déclenche l’avertissement : un signal fort ou trois catégories faibles distinctes.
Une discussion neutre et des consignes ordinaires ne devraient pas le déclencher.
Le contrôle examine au plus les premières et dernières 65 536 unités UTF-16 d’un résultat ;
il peut manquer une attaque déguisée ou située au milieu non examiné. La sandbox et
les autorisations restent nécessaires. Une exception vaut seulement dans la session
en cours, sans survivre au redémarrage ni au rechargement.

## Sudo contrôlé

Activez **Commandes en root (sudo)** dans `/settings` › Permissions et sandbox,
puis `/reload`. L'outil dédié lance un programme système en root hors de la sandbox,
sans shell. Il refuse en mode `safe` et sans interface interactive. Sa question montre
la commande exacte dans tous les modes, même `unrestricted`. **Autoriser sudo pour
cette session** couvre les prochaines commandes sudo ; `/perm window` permet de retirer cet
accord. Il reste seulement en mémoire et disparaît au changement ou à la fermeture
de session, à `/reload`, ainsi qu'à la mise en veille du moteur de la fenêtre.

L'arrêt du groupe de processus exige le `timeout` de GNU coreutils. Prism privilégie
`gnutimeout` lorsqu'il est installé (notamment sur Ubuntu 26.04) et vérifie l'implémentation
avant d'utiliser sudo. Un limiteur non GNU est refusé ; installez `gnu-coreutils` ou choisissez GNU `timeout`.

À côté de sudo, **Garder le mot de passe sudo en mémoire 5 minutes** règle
`sandbox.sudoRememberPassword` (booléen global, faux par défaut). Le projet et
`configure_prism` ne peuvent modifier aucun réglage `sandbox`. Si cette option est
activée, Prism garde le mot de passe accepté jusqu'à cinq minutes après sa saisie,
sans prolongation à l'usage. Les prochains appels ne montrent plus le champ masqué,
mais demandent encore l'accord sans autorisation pour la session. Avec les deux,
l'appel passe sans question et le résultat signale le mot de passe mémorisé et
l'accord de session. Un mot de passe refusé, la désactivation du réglage ou de sudo,
l'expiration, le changement ou la fermeture de session et `/reload` retirent la référence.

Chaque appel garde sa propre FIFO `SUDO_ASKPASS` à usage unique, `sudo -k -A` et le
`sudo -k` final : sudo ne garde aucun identifiant. Le mot de passe ne va jamais au
modèle, dans la session, les logs, traces, variables d'environnement ou fichiers
enregistrés ; la sortie le masque par `***`. Une chaîne JavaScript ne peut pas être
effacée, seulement déréférencée. Le compromis de cette fenêtre et de l'accord de
session : un programme du même utilisateur ne lit pas plus facilement la mémoire de
Prism, mais un processus Prism compromis détient le mot de passe mémorisé jusqu'à
cinq minutes. Un appel encore en cours conserve
aussi sa référence locale jusqu'à son retour.

## Périmètre de tâche

Avant une longue tâche, l’agent peut proposer ce dont il aura besoin (`propose_scope`) : des opérations en mots simples (« Installer les dépendances : lance npm install, se connecte à registry.npmjs.org ») et une durée. Vous retirez des lignes, dites si vous **restez là** ou si vous **vous absentez**, puis approuvez ; rien n’est autorisé avant. Vous pouvez aussi en fixer un vous-même avec `/perm scope` (modifier les fichiers du projet, lancer des commandes dans la sandbox).

Pendant la tâche, ce que le périmètre couvre passe sans question. Le reste est demandé si vous restez là (avec « pendant cette tâche » pour élargir le périmètre), ou refusé tout de suite si vous êtes absent ; vous avez la liste des refus à la fin de la tâche. Un refus vaut pour toute la tâche : la même action est refusée de nouveau sans question. Un périmètre ne couvre jamais un appel dangereux, une commande exclue de la sandbox ni ce que le mode bloque. Il s’arrête avec la tâche (une exécution de l’agent), à la fin de sa durée, ou depuis `/perm scope` ; une commande de fond lancée pendant le périmètre garde ses hôtes jusqu’à la fin de la durée.

Un périmètre limite les commandes lancées, les fichiers modifiés et les hôtes que joignent les commandes de la sandbox. Il ne limite pas la lecture des fichiers hors du projet (sauf les dossiers masqués), les commandes lancées hors de la sandbox, ni ce qu’un programme autorisé fait de ses connexions.

## Modes

    /perm mode ask           # safe operations pass, the rest asks
    /perm mode safe          # read-only agent: anything not allowed outright is blocked
    /perm mode broad         # default: works in the project and /tmp without asking; asks for
                             # dangerous calls, reads outside the project and the first
                             # browser or desktop use; deny rules still apply
    /perm mode unrestricted  # no dialogs at all; only your deny rules apply

`broad` s’appelait `yolo` ; `yolo` reste accepté. Le mode `unrestricted` ne pose aucune question, même pour les appels dangereux et les écritures en dehors du projet. Vous l’activez une fois dans une boîte de dialogue d’avertissement (le choix est enregistré dans le `permissions.json` global sous la forme `"unrestrictedAccepted": true`) ou explicitement en ligne de commande (`--perm-mode unrestricted`). Le `permissions.json` d’un projet ne peut pas l’activer. Ses commandes s’exécutent hors de la sandbox, sauf si vous l’activez pour ce mode dans `/settings` › Permissions et sandbox ; hors de la sandbox, l’agent peut tout faire avec les permissions de votre compte.

Vous pouvez aussi utiliser ces options pour une seule exécution : `--perm-mode safe`, `--perm-mode broad`. Le mode choisi avec `/perm mode` ou `alt+m` est enregistré dans la session et rétabli quand vous la reprenez ; `/perm default <mode>` définit le mode des nouvelles sessions.

## Commandes

    /perm                      open /settings > Permissions et sandbox (without a UI: status)
    /perm window               modes and the permissions in effect
    /perm status               status
    /perm scope                task scope: set one for the next task, or end the one in effect
    /perm mode <ask|safe|broad|unrestricted>
    /perm default <ask|safe|broad|unrestricted>
    /perm allow <rule>         allow for this session
    /perm deny <rule>          deny for this session
    /perm always <rule> [-g]   save an allow rule to the project config (-g: global)
    /perm never <rule> [-g]    save a deny rule to the project config (-g: global)
    /perm rules                list session and config rules
    /perm clear                clear session rules
    /perm help

## Configuration

Le fichier `permissions.json` du dossier de configuration (global) et `<project>/.prism/permissions.json` (pour les projets approuvés uniquement, fusionné avec le fichier global) :

    {
      "mode": "ask",
      "allow": ["bash(npm run test*)", "write(src/**)"],
      "ask":   ["bash(git push*)"],
      "deny":  ["bash(sudo*)", "write(.env*)"],
      "protectedPaths": ["secrets/**"],
      "tools": { "deploy": "ask" }
    }

Syntaxe des règles : `tool` ou `tool(pattern)`. Les motifs sont des globs comparés à :

- `bash` : la commande complète (`*` et `?` correspondent à n’importe quel caractère) ;
- `read`, `write`, `edit` : le chemin résolu, absolu et relatif au projet (`*` ne traverse pas `/`, `**` le traverse) ;
- les autres outils : `JSON.stringify(input)`.

Les restrictions de configuration précèdent le mode et les règles d'autorisation. Pour les autres appels, l'ordre de priorité reste : règles de refus, puis `unrestricted`, catégorie dangereuse, règles d’autorisation, `broad`, règles et catégorie de confirmation, puis valeur par défaut de l’outil. Une règle d’autorisation ne remplace pas la détection des actions dangereuses : elles demandent une confirmation même si une règle les autorise.

## Outil de configuration du modèle

Activez **config-tool** dans `/settings` > Modules, puis lancez `/reload`. Il est désactivé par défaut.
`configure_prism` est le seul moyen pris en charge pour le modèle de modifier sa configuration :
réglages globaux, activation des modules intégrés facultatifs, création ou remplacement d'agents
personnalisés. Il n'installe pas de paquets, ne modifie pas le code des extensions/hooks et ne supprime pas d'agents.
Le réglage `extensions` n'accepte que les modules intégrés (`builtin:<nom>`, `+builtin:<nom>`,
`-builtin:<nom>`) : paquets et fichiers s'ajoutent par l'utilisateur.

Chaque appel montre la valeur enregistrée et la valeur proposée (`ancienne -> nouvelle`), puis
demande **Autoriser ce changement une fois** ou **Refuser ce changement**. Un changement pouvant
exécuter du code montre les risques : extensions, hooks, commandes shell, outils d'agents.
Aucune règle, aucun périmètre de tâche et aucun mode `unrestricted` ne remplace cet accord.
Sans réponse après **120 secondes**, le changement est refusé ; une réponse tardive ne fait rien.
Les modes `safe` et Plan en lecture seule refusent les changements. Cette version exige le
terminal interactif : modes texte/JSON et RPC refusés, même si RPC expose un relais de dialogues.
Réglages et modules s'appliquent après `/reload` ou redémarrage ; les agents à leur prochaine utilisation.

Pour le modèle, un changement par appel :

```json
{"action":"setting","key":"theme","value":"light"}
{"action":"module","name":"memory","enabled":true}
{"action":"agent","name":"reader","description":"Read files","tools":["read"],"instructions":"Explain the files you read."}
```

Réglages pris en charge : `theme`, `animations`, `replyLanguage`, `language` (`auto/en/fr`),
`interfaceMode` (`simple/advanced`), `hideThinkingBlock`, `showHardwareCursor`, `editorPaddingX`
(0–10), `autocompleteMaxVisible` (1–50), `defaultProvider`, `defaultModel`, `defaultThinkingLevel`,
`defaultTools`, `enabledModels`, `extensions`, `skills`, `prompts`, `themes`, `shellPath`,
`shellCommandPrefix`, `externalEditor`, `npmCommand`. Les listes contiennent du texte.
Un agent comprend nom, description, consignes, outils et modèle facultatif.
Seuls les modules intégrés facultatifs sont acceptés ; le garde de permissions reste actif.
Les autres réglages sont refusés.

La sécurité reste **réservée à l'utilisateur dans tous les modes**, même `unrestricted` :
`permissions.json` (mode, règles allow/ask/deny, chemins protégés, règles d'outils, accord unrestricted),
`trust.json`, `project-permissions.json` (dont les autorisations réseau), `auth.json`, `models.json` ;
et les réglages `sandbox`, `secrets`, `defaultProjectTrust`.
L'outil refuse aussi les noms de champs de sécurité `permissions`, `permissionMode`, `mode`,
`allow`, `ask`, `deny`, `protectedPaths`, `tools`, `unrestrictedAccepted`, `trustedFolders`, `auth`.
Les clés inconnues et chemins imbriqués sont refusés. La liste de référence est dans
`src/fork/config-policy.ts`. Utilisez vous-même `/perm`, `/settings`, `/trust` ou les fichiers.

`write`, `edit` et les outils déclarant une écriture de fichier (comme LSP) refusent les fichiers
de sécurité listés, `settings.json`, `keybindings.json`, `mcp.json`, `lsp.json`, `consult-models.json`,
`consult-budgets.json`, `plan-mode.json`, `pi-plan-mode.json`, et les dossiers agents/extensions/
hooks/skills/prompts/themes du dossier global et du dossier de configuration du projet, liens
symboliques compris. Pour le shell, les chemins écrits en clair sont aussi refusés : redirections,
`sed -i`, `tee`, `cp`, `mv`, `dd`, options de sortie, code d'interpréteur et préfixes `cd` simples.
Des lectures dans des commandes complexes peuvent être refusées par prudence.
La détection ne couvre pas fiablement les chemins calculés, variables autres que HOME, code encodé,
scripts ou programmes qui écrivent sans nommer les fichiers, alias par liens physiques et courses
d'accès aux fichiers. La sandbox reste nécessaire : des motifs ne créent pas une isolation.
Ne réessayez jamais un changement refusé avec un autre outil.
