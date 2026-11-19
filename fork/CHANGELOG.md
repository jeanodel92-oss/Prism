# Changelog du fork

Changements propres au fork. Les changements d'upstream sont dans
`packages/*/CHANGELOG.md`.

Format : sous `## [Unreleased]`, les sections `### Added`, `### Changed`, `### Fixed`
et `### Removed`. Chaque version publiée a sa propre section, qu'on ne modifie plus
ensuite. Avant une release, déplacer les entrées de `[Unreleased]` sous
`## [<version>] - <date>` : `fork/scripts/release.sh` en tire les notes de version
et refuse une version sans section.

## [Unreleased]

### Added
- Fenêtre et app Android : les formules mathématiques des réponses s'affichent mises en forme (KaTeX 0.19.1, chargé seulement quand une réponse en contient). Les mêmes délimiteurs que le terminal sont reconnus (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`), un prix ou une variable comme `$HOME` reste du texte, et une formule invalide s'affiche telle quelle.
- App Android dans un dépôt F-Droid : ajoutez `https://prism.odelserver.space/fdroid/repo?fingerprint=243AE77A78F2809378D26DA9A5BE865F155D49035A141CEFFE0BC0E0FCCC795C` à F-Droid (ou Droid-ify, Neo Store), ou la même adresse sans `?fingerprint=…` à Obtainium (source « F-Droid Third-Party Repo »), pour recevoir chaque version stable de l'app.
- `/update`, dans le terminal et la fenêtre (aussi `/settings` › Autres › Rechercher une mise à jour) : vérifie s'il existe une version plus récente de Prism et l'installe à votre demande ; passe aussi au canal canary ou revient au canal stable, et revient à la version précédente. La version en cours continue de tourner ; la nouvelle s'ouvre au lancement suivant.
- Réglage « Mises à jour » (`/settings` › Autres) : manuelle par défaut (Prism ne demande rien à son site), « me prévenir » (vérifie au démarrage) ou « automatique » (installe au démarrage). Au plus une vérification par heure. Il remplace le réglage `updateCheck`.
- App Android : réglage « Mises à jour » (seulement quand vous le demandez, par défaut, ou au démarrage avec un message) et « Rechercher une mise à jour », qui propose de télécharger la nouvelle version dans le navigateur du téléphone.
- Module navigateur : Prism vous prévient, au démarrage et dans `/browser`, quand l'extension chargée dans un navigateur vient d'une autre version de Prism ; `/browser setup` la met à jour.
- Module navigateur : l'extension installée depuis addons.mozilla.org ou le Chrome Web Store est comparée par son numéro de version ; Prism dit si elle est plus ancienne (le magasin la met à jour) ou plus récente (`/update` met Prism à jour). L'extension passe en 0.1.2.
- Release : une release stable contient les paquets de l'extension pour addons.mozilla.org et le Chrome Web Store, signés avec le reste ; le serveur de build les envoie aux deux magasins quand leur version est nouvelle.
- Release : une nouvelle version de l'extension du navigateur peut partir aux magasins avant la version de Prism qui la livre (`fork/scripts/release-extension.sh`), le temps de leur relecture.
- Canal canary : une nouvelle version canary chaque fois qu'un changement passe tous les tests, pour Linux (terminal et fenêtre ; l'app Android reste aux versions stables). Les canaries sont signées avec leur propre clé, que l'installateur n'accepte que pour elles : une canary ne peut pas se faire passer pour une version stable. Une installation d'avant cette version passe en canary une fois mise à jour.

### Changed
- Sans mode de permission choisi, Prism démarre en mode large (`broad`) au lieu de « demander » (`ask`) : il travaille dans le projet sans poser de question et demande avant d'en sortir, avant `sudo` et avant un appel dangereux. Le mode choisi à l'accueil ou avec `/perm default` reste prioritaire.
- En mode large, sans bac à sable, les outils d'écriture et de modification écrivent dans `/tmp` sans demander, comme les commandes le faisaient déjà. Les chemins protégés, un dossier personnel placé sous `/tmp` et un lien qui sort de `/tmp` restent soumis à la question.
- Le modèle ne se présente plus comme « un assistant expert en code » : ce rôle le ramenait au code dès qu'une question en sortait. Il aide maintenant à tout ce qu'on lui demande, et se sert de ses outils quand la tâche le demande.
- Le modèle connaît votre ordinateur : système, bureau, processeur, mémoire, espace disque libre et shell. Avec fish ou zsh, il écrit dans leur syntaxe les commandes que vous tapez. Une soixantaine de jetons en plus ; module « Votre ordinateur, pour le modèle », désactivable.
- Licence : le code propre à Prism est sous GPL-3.0-or-later, et Prism tel qu'il est distribué aussi. Le code repris de pi reste sous MIT, avec sa mention ; les composants tiers gardent la leur. L'archive de release contient `LICENSE` (GPL-3.0) et `LICENSES/` (textes des licences).
- Les licences et mentions de copyright des bibliothèques Rust de la fenêtre, du serveur du téléphone et de l'app Android, que ces licences exigent, sont livrées avec la release : `LICENSES/THIRD-PARTY-RUST.txt` dans l'archive, et le même fichier dans la fenêtre et l'APK. Elles manquaient jusqu'à fork.11.
- L'APK contient aussi les licences et mentions de ses bibliothèques Java et Kotlin (AndroidX, Material, Kotlin, ZXing, Jackson…).
- App Android : le scanner de QR code décode avec ZXing (libre) au lieu de ML Kit de Google. Il marche maintenant sur un téléphone sans services Google, et l'app ne contient plus de composant non libre.
- Un modèle retiré par son fournisseur disparaît de `/model` sans attendre de mise à jour de Prism : dès que le catalogue de pi.dev du fournisseur, plus récent que celui de Prism, ne le liste plus. Votre modèle par défaut et les modèles nommés dans `models.json` restent. Hors ligne, ou rafraîchissement désactivé dans `/settings`, rien ne change.

### Fixed
- Un refus du mode sûr ne finit plus par deux points (« (curl).. »).
- Fenêtre : chercher des éléments dans une conversation ne passe plus tous les résultats d'un message en arguments d'un seul appel, qui pouvait dépasser la limite de la pile sur un très long message.
- Fenêtre : une très longue conversation s'ouvre vite et reste légère. Seuls les messages proches de la vue sont dans la page ; à 20 000 messages, la mémoire de la fenêtre passe d'environ 1,2 Gio à environ 320 Mio et l'ouverture d'environ 22 s à environ 2,4 s. La recherche couvre toujours toute la conversation.
- Documentation livrée : `/debug` écrit `prism-debug.log` (et non `pi-debug.log`), et les pages Utilisation, Démarrage rapide, Sécurité et Permissions décrivent les modes de permission au lieu de dire que Prism ne demande jamais d'accord.
- Modèles Claude par l'abonnement Claude Code : les résumés du raisonnement s'affichent ; le bloc de raisonnement restait vide.
- Permissions : des commandes passaient sans question alors qu'elles écrivaient ou lançaient un programme (audit de sécurité de fork.12). Elles demandent maintenant :
  - un programme `awk` où un `/` peut ouvrir une expression régulière ou diviser, comme `print /"/; print "x" | "/bin/sh"` ;
  - un indice de tableau ou une position de sous-chaîne qui n'est pas un nombre (`${y[x]}`, `${y:x}`), et `$[…]` : bash les évalue comme de l'arithmétique, ce qui peut lancer une commande cachée dans une variable ;
  - une commande précédée, plus tôt dans la ligne, d'une variable d'environnement changée : `PATH=$PWD/bin:$PATH; ls` lançait le `ls` du dépôt ;
  - `man` avec une option autre que celles qui choisissent et affichent une page (`-C` lisait une configuration qui nomme les programmes de mise en forme, `-l` incluait n'importe quel fichier) ;
  - `git status`, `git diff`, `git log`… quand la configuration du dépôt nomme un programme que Git lancerait (`core.fsmonitor`, `diff.external`, un filtre ou un `textconv`), par exemple dans un dépôt reçu en archive. Les hooks, les alias et le `fsmonitor` intégré de Git ne demandent rien. Git demande aussi quand le dossier où il tourne n'est pas connu (`cd "$X" && git status`).
- Mode Plan : `python3 -c CODE --version`, `rg --hostname-bin PROG`, `npm test --script-shell=PROG`, `go test -exec PROG`, `cargo test --config`, `pytest --basetemp=DOSSIER` (vidé) ou `vitest --outputFile` écrivaient un fichier ou lançaient un programme. Un interpréteur ne passe plus qu'avec `--version` seul, et les lanceurs de tests n'acceptent que leurs options courantes (filtres, verbosité, paquet, nombre de passages…).
- Sandbox : une commande pouvait réécrire les caches de paquets partagés (`~/.npm`, `~/.cargo/registry`, `~/.cargo/git`, `~/go/pkg`, `~/.bun/install/cache`), et `npx` ou Cargo exécutaient ensuite ce code hors de la sandbox, par exemple au `npx` suivant lancé dans votre terminal. Une commande lit toujours vos caches, mais ce qu'elle y écrit est jeté à sa fin. Conséquence : ce qu'un `npm install` ou un `cargo build` télécharge dans la sandbox est retéléchargé la fois suivante s'il n'est pas déjà dans votre cache. Avec un bubblewrap antérieur à 0.11 (Debian 12, Ubuntu 24.04), chaque projet a ses propres caches, vides au départ.
- Sandbox : une commande pouvait lire le journal système (lignes de commande et messages de tous les programmes, quand votre compte est dans `wheel` ou `adm`), les vidages mémoire des programmes plantés et le courrier local. Ils sont maintenant cachés ; `read.allow` en rend un visible.
- Sandbox : une commande pouvait ouvrir une socket `vsock`, qui atteint l'hôte quand Prism tourne dans une machine virtuelle. Seules les sockets réseau (IPv4, IPv6) et netlink restent permises.
- Sandbox : quand le `PATH` commence par un dossier du projet (après `source .venv/bin/activate`), Prism lançait hors sandbox, par leur seul nom, des programmes qu'une commande sandboxée pouvait écrire là : `rg` et `fd` (outils `grep` et `find`, complétion), `secret-tool` (qui recevait la clé à ranger), `notify-send`, `xdg-open`, `wl-copy`, `trash`, `flatpak`, `pgrep`, `systemctl`, `systemd-analyze`, `labwc`, `gh`, `tmux` et le `sh` de la mise à jour. Ils sont maintenant cherchés comme Git et bubblewrap, jamais dans un dossier que la sandbox écrit, et l'installateur de `/update` reçoit un `PATH` sans ces dossiers.
- Permissions : une commande, un chemin ou un texte proposé par le modèle pouvait contenir des séquences de terminal ou des caractères invisibles qui cachaient une partie de la question (texte masqué, texte noir, inversion du sens d'écriture), écrivaient dans le presse-papiers ou dessinaient de fausses lignes. Les questions de permission, celle du mot de passe de `sudo` l'écran d'une tâche planifiée proposée par le modèle, celui des tâches existantes de `/schedule`, les questions sur les hooks et la configuration Git, les autorisations de session listées par `/perm` le bilan d'une portée de tâche et le texte d'une portée proposée par le modèle (écran d'approbation, `/perm scope`) les montrent maintenant sous la forme `<U+XXXX>`. Une commande ou une consigne sur plusieurs lignes s'affiche dans un bloc marqué `│` à gauche, pour qu'aucune de ses lignes ne passe pour une ligne de la question.
- Sandbox : un nom autorisé qui mène à une adresse privée (réseau local, Tailscale, service de métadonnées cloud, adresse IPv6 locale) demande une seconde fois en montrant l'adresse, une fois par nom et adresse, pour `web_fetch`, le navigateur et les commandes, même quand les questions sur les nouveaux hôtes sont coupées. Avant, autoriser `router.example.com` laissait ce nom mener à votre box. L'accord se garde sous la forme `nom@adresse`.
- Sandbox : bloquer une adresse (`192.168.1.1` dans les hôtes bloqués) bloque aussi chaque nom qui y mène, pour `web_fetch`, le navigateur, les registres vérifiés avant un `npm install` et les commandes. Avant, seule l'adresse écrite telle quelle était refusée.
- Sandbox : Git par SSH vers un hôte qui mène à une adresse privée demande aussi cette adresse (`ssh://nas@192.168.1.10`), ou la refuse si elle est bloquée ; l'hôte vérifié est celui que votre configuration SSH désigne (sauf à travers un hôte de rebond, qui résout le nom lui-même). L'aide des hôtes autorisés cite la forme `nom@adresse`.
- Sandbox : une commande pouvait modifier un fichier suivi par Git puis le marquer « assume unchanged » ou « skip worktree » (`git update-index`) : la modification n'apparaissait plus dans votre `git status` ni dans `git diff`. Les drapeaux posés par la commande sont maintenant effacés quand Prism publie l'index ; ceux que vous aviez posés restent, comme « skip worktree » dans une extraction partielle.
- Sandbox : une commande pouvait créer un dépôt Git dont la configuration lance un programme, l'ajouter au projet comme sous-module et committer ; votre `git status` suivant lançait ce programme hors sandbox. Prism le signalait seulement dans la sortie de la commande. Vous êtes maintenant averti dans l'interface, `/sandbox` liste ces dépôts, et Prism refuse de publier les changements Git de la commande quand l'index ou un nouveau commit ajoute un tel dépôt comme sous-module (même retiré de l'index ensuite).
- Lien téléphone : un téléphone retiré pendant qu'il était connecté, et qui lisait moins vite que Prism n'écrivait, continuait de recevoir les messages des sessions (texte du modèle, sorties d'outils, questions) tant qu'il restait en retard. Il est maintenant coupé au plus une seconde après le retrait, dans les deux modes (serveur seul et fenêtre partagée).
- Lien téléphone : un téléphone qui ne lit plus (application figée, réseau bloqué) gardait sa connexion ouverte et faisait grossir sans limite, côté PC, la file de ce qui l'attendait. Une écriture qui n'avance plus pendant 30 secondes coupe maintenant la connexion, de même que plus de 128 Mio en attente. Les sessions continuent sur le PC ; le téléphone les reprend en se reconnectant.
- Lien téléphone : le serveur des téléphones lancé comme service (ou par la fenêtre, ou par `/phone`) écrivait un code d'appairage valide dans le journal à chaque démarrage. Il n'en affiche plus que lancé à la main dans un terminal ; la fenêtre et `/phone` demandent un code quand vous voulez lier un téléphone.
- Images : un petit fichier dont l'en-tête annonce un dessin immense (plus de 8192 × 8192 points) n'est plus décodé : il est refusé avec un message au modèle (outil `read`, fichier joint, image collée, image rendue par un outil, affichage au terminal), au lieu de faire monter la mémoire de Prism au-delà de 4 Gio. Une image dont la taille ne se lit pas dans l'en-tête (formats autres que PNG, JPEG, GIF, WebP et BMP) n'est plus convertie.
- Clés masquées : un fichier dans lequel vous laissez l'agent écrire une clé lui reste caché jusqu'à la fin de la session (y compris après reprise) : `read` et `grep` le refusent, `edit` doit garder l'étiquette de chaque clé, et les commandes de la sandbox ne peuvent pas le lire. Avant, une commande classée sûre (`sed 's/./& /g' config.env`) relisait la clé. La question le dit ; sans sandbox, elle dit que les commandes peuvent encore le lire.
- Fichiers secrets du projet : une trentaine de noms courants de fichiers d'identifiants (`.npmrc`, `.envrc`, `credentials.json`, `kubeconfig`, `*.tfstate`, `*.p12`, `wp-config.php`…) sont protégés comme `.env` : l'outil de lecture et `cat` demandent, et le mode sûr les cache aux commandes. Lire ou modifier le `.npmrc` d'un projet pose donc une question à chaque fois. Limite : un tel fichier committé se relit par l'historique Git (`git show HEAD:.env`).
- Lecture étendue (`/settings` › Ce que l'agent lit) : les identifiants de gcloud, Azure, Cargo, Claude Code, Codex, Copilot, rclone, sops, `pass`, du portefeuille KDE, de Thunderbird et des navigateurs Edge, Vivaldi, LibreWolf et Zen sont cachés aux commandes, ainsi que `~/.npmrc` et les historiques du shell.
- Permissions : `jq` dont le programme lit l'environnement (`env`, `$ENV`) ou vient d'un fichier, et awk avec `SYMTAB`, demandent avant de s'exécuter, comme `printenv`.
- Contrôle des paquets npm : `mkdir app && cd app && npm install …` était refusé (« configuration could not be read or parsed »), parce que le dossier n'existait pas encore quand Prism vérifiait les paquets. Un dossier que la commande crée elle-même par `mkdir` est maintenant vérifié avec la configuration des dossiers au-dessus ; un autre dossier absent reste refusé.
- Module navigateur : `scroll` vers le bas ne faisait rien sur une page qui défile en douceur (`scroll-behavior: smooth`, comme les notes de version de firefox.com) ; le défilement est maintenant immédiat.
- `/export-zip` jugeait hors du projet, et refusait, un fichier écrit dans un dossier dont le nom commence par deux points (`..notes/`).
- `/tree` dans la fenêtre écrivait `~ice/…` pour un chemin `/home/alice/…` quand le dossier personnel est `/home/al`.
- Sur les noyaux Linux antérieurs à 6.13 (Debian 13, Ubuntu 24.04…), deux modifications d'un fichier dans la même milliseconde ou presque pouvaient laisser Prism sur l'ancienne version : permissions du projet, règles de permission, réglages de la sandbox, `auth.json` et `models.json`. Une permission ajoutée par une autre session au même instant pouvait se perdre. Un fichier modifié il y a moins de 2 s est maintenant relu, et une modification sous verrou relit toujours le fichier.
- Une session lancée pendant qu'une autre sauvegardait ses réglages pouvait démarrer sans les réglages globaux (thème, langue, modèle par défaut…) et n'en sauvegarder plus aucun, sans message. Le chargement lit maintenant `settings.json` sans attendre la fin de l'autre sauvegarde.
- Outil sudo : avec un mauvais mot de passe, si Prism était occupé à ce moment, sudo redemandait le mot de passe et attendait jusqu'au délai de la commande au lieu d'échouer tout de suite, sans dire que le mot de passe avait été refusé. Il échoue maintenant aussitôt, refus signalé.
- Construction de la fenêtre : sur un système dont ImageMagick n'a pas librsvg (Debian, Ubuntu), l'icône ne se dessinait pas et la construction échouait. `rsvg-convert` prend alors le relais.
- La sandbox refuse de publier un index ou un commit qui ajoute comme sous-module un dépôt dont les crochets ou la configuration lancent un programme, même quand une commande précédente a créé ce dépôt : le `git status` de l'utilisateur à la racine du projet ne l'exécute plus.
- Les commandes isolées ne peuvent plus épuiser les connexions de l'utilisateur au bus système : Prism en ouvre au plus 16 à la fois pour elles, et les suivantes reçoivent un refus qui donne la raison.
- CI : la canary est construite par un runner à part, seul à pouvoir déposer une release pour le signataire ; les jobs de test, qui exécutent le code des dépendances de développement, ne le peuvent plus. Le signataire refuse une canary trop en avance sur la dernière publiée.
- Une image JPEG qui cachait sa vraie taille derrière un octet `FF 00` n'est plus décodée : la taille est lue comme le décodeur la lit, et une image trop grande est refusée.
- Une fenêtre à l'arbre d'accessibilité très profond n'arrête plus l'aide du bureau de l'agent : au-delà de 512 niveaux, la liste des éléments est marquée tronquée.
- Un flux de l'API Anthropic avec une ligne géante ne fige plus Prism et ne le fait plus planter : la lecture est linéaire, et un évènement de plus de 8 Mio termine le tour par une erreur claire.
- Même correctif pour les flux de Mistral, de Codex (abonnement ChatGPT) et des fournisseurs `pi-messages` (comme Radius) : un évènement géant ne fige plus Prism, et au-delà de 8 Mio le tour se termine par une erreur claire.
- Module navigateur : une session ne s'arrête plus au démarrage quand le fichier des réglages reste verrouillé trop longtemps par un autre Prism (vu sur une machine très chargée) ; l'assistant d'installation n'est simplement pas proposé cette fois-là.
- App Android : l'identité du téléphone et ses PC appairés ne partent plus dans la sauvegarde Android ni dans le transfert vers un nouveau téléphone.
- Une sauvegarde `/undo` dont le tag d'authentification est tronqué est refusée.
- Une commande de la sandbox ne peut plus réécrire les copies de l'extension du navigateur dans `~/Prism` (dossier de travail de la fenêtre ouverte dans le dossier personnel), que le navigateur exécute ensuite : elles sont en lecture seule pour les commandes, dans tous les modes.
- Quand une page ouverte par l'agent redirige vers un autre hôte (un port de cette machine, une adresse privée, un site non accordé), Prism pose la même question qu'à l'ouverture ; refusée, l'onglet est fermé sans être lu.
- Interface simple : la ligne d'action au-dessus d'une question montre les retours à la ligne et les caractères invisibles comme la question (`<U+XXXX>`), et nomme chaque programme d'une commande composée (« Run a command (echo, rm) ») au lieu du premier seulement.
- Le fichier de sortie complète d'une commande `!` (ou `bash` en RPC) masque les clés connues, comme celui de l'outil `bash` du modèle.
- Mode Plan en mode large : les lanceurs de tests, les commandes npm, `tsc --noEmit` et `git status` d'un dépôt dont la configuration nomme un programme lançaient le code du projet ou y écrivaient sans question ; tant que le mode Plan est actif, le mode large pose maintenant la question pour ce qui lance un programme ou écrit dans le projet, comme le mode demander.
- Les outils `edit` et `write` demandent toujours avant de modifier les copies de l'extension du navigateur dans `~/Prism`, mode large compris.

## [1.0.0-fork.11] - 2026-11-15

### Added
- L'app Android sur le site, à partir de cette version : chaque release publie l'APK arm64, signée avec la clé de l'app, et la dernière stable à une adresse fixe. « Lier un téléphone » et l'accueil de la fenêtre en donnent le lien et un QR code à scanner avec l'appareil photo du téléphone ; les réglages du téléphone ont « Télécharger la dernière version de l'app ». Le serveur du téléphone (`prism-remote`) est livré avec la fenêtre.
- App Android (QA du 2026-11-13) : « Scanner le QR code » sur l'écran d'appairage et dans les réglages : la caméra s'ouvre derrière une visée, avec Annuler (la touche Retour annule aussi), et un code Prism lu lie le téléphone aussitôt. La lecture passe par les services Google Play ; sans eux, coller le code reste possible.
- Fenêtre (QA du 2026-11-13) : « Lier un téléphone », proposé dans l'accueil tant qu'aucun téléphone n'est lié et dans les réglages (section Fenêtre). Prism démarre le serveur du téléphone, au choix pendant qu'il est ouvert ou toujours (service de la session), et montre le code d'appairage en QR et en texte à copier, avec les adresses que le téléphone essaiera : Tailscale d'abord quand il est connecté, le réseau local sinon, et un lien pour installer Tailscale s'il manque. Les téléphones liés sont listés et peuvent être révoqués. `prism-remote invite` et `status` demandent un nouveau code ou l'état au serveur qui tourne.
- Fenêtre (QA du 2026-11-13) : la ligne « en attente de toi » du téléphone, au même endroit, sous la barre du haut : elle apparaît quand une autre conversation attend une réponse ou a fini pendant que vous regardiez ailleurs, se déplie, et une entrée ouvre sa conversation. Une pastille suit le nom de ces conversations dans le panneau latéral. Les notifications du bureau (« attend votre réponse », « terminé ») ne partent plus quand la fenêtre est au premier plan.
- Journaux (QA du 2026-11-13) : le panneau Journaux de la fenêtre et du téléphone dit aussi ce qui a marché : démarrage de session avec le modèle, requête envoyée au modèle, réponse HTTP et son délai, réponse finie (fin, jetons envoyés, lus du cache, reçus, durée), chaque outil avec son issue et sa durée, changement de modèle ou de réflexion, compaction. Jamais les arguments d'un outil ni le texte d'un message.
- Utilisation de l'ordinateur (QA du 2026-11-13) : une section « Utilisation de l'ordinateur » dans les réglages regroupe les modules du navigateur et des deux bureaux, le raccourci de reprise et « Régler un navigateur ». `/browser setup` devient un assistant pas à pas, dans la fenêtre comme dans le terminal : choix du navigateur, déclaration de l'hôte, ajout de l'extension (page des extensions ouverte, chemin du dossier copié), puis vérification de bout en bout (un onglet ouvert, lu et fermé) ; en cas d'échec, il dit ce qui est en place et ce qui manque. Il s'ouvre seul la première fois que le module navigateur tourne sans navigateur lié. Lier un autre navigateur en fait celui de l'agent, sans redémarrer. Firefox charge une copie de l'extension sans `key` ni permission `debugger` (plus d'avertissements). Dans la fenêtre, une icône du rail ouvre `/desktop` quand le module du bureau de l'agent est activé.
- App Android (QA du 2026-11-13) : fermer un panneau ou les réglages ne rouvre plus le clavier sur la barre de saisie ; elle ne prend le clavier que touchée.
- App Android (décision du propriétaire, 2026-11-13) : « Régler un navigateur » n'est plus proposé sur le téléphone (il ouvre des pages et copie des dossiers sur l'écran du PC), ni ouvert seul au premier démarrage depuis le téléphone ; le serveur du téléphone le signale aux moteurs (`PRISM_REMOTE_CLIENT=phone`).
- Fenêtre (QA du 2026-11-13) : une conversation commencée ailleurs (le téléphone, un terminal) apparaît dans la liste sans recharger : la liste est relue quand la fenêtre revient au premier plan et toutes les 20 s quand elle est affichée.
- Fenêtre (QA du 2026-11-13) : les téléphones liés sont listés directement dans les réglages (section Fenêtre, « Lier un téléphone »), chacun avec un bouton « Retirer » ; la liste est relue à l'ouverture des réglages et après un retrait.
- App Android (QA du 2026-11-13) : le clavier qui s'ouvre ne laisse plus la fin de la réponse sous la zone de saisie : une conversation qui était au bas reste au bas quand la page rétrécit ; une conversation remontée garde sa place.
- App Android (QA du 2026-11-13) : les réglages ouverts avant que la couche du téléphone soit prête (pendant le chargement de la première conversation) s'affichent à l'écran juste, liste ou section ; la touche Retour, depuis la liste des réglages, les ferme et laisse la conversation au lieu d'ouvrir l'accueil sous la fenêtre restée ouverte.
- App Android (QA du 2026-11-13) : après une coupure du lien, les moteurs du PC continuent 5 minutes ; le téléphone qui revient reprend le même moteur, avec son tour fini ou en cours, ses autorisations « dans cette session » et ses questions restées sans réponse, sans « Conversation reprise ». Avant, le dernier tour était perdu. Une notification permanente garde l'app reliée au PC quand elle est en arrière-plan ; elle se désactive dans les réglages (PC lié, « Rester relié en arrière-plan »).
- App Android, parité avec la fenêtre ([relevé](docs/app-android-parite.md)) : le bouton « + » joint des images et des textes courts du téléphone ; les liens s'ouvrent dans le navigateur du téléphone ; le bouton Stop arrête une commande `!` ; après une coupure, le téléphone se reconnecte seul au PC et relance la conversation affichée, avec une ligne « PC injoignable » entre-temps. Un collage sur le téléphone ne lit plus le presse-papiers du PC ; « Parcourir » (dossiers du PC) est caché sur le téléphone.
- App Android : un design propre au téléphone ([spécification](docs/app-android-design.md)) : accueil en mosaïque de dalles de verre posées sur la roche, une session par dalle à sa teinte, la session au travail allumée et qui respire, celle qui attend une réponse allumée sans respirer avec « Demande », celle dont le tour s'est terminé pendant qu'on regardait ailleurs marquée « Fini » jusqu'à ce qu'on l'ouvre, « PC injoignable » dans l'en-tête et le rai de lumière du sol éteint quand le PC ne répond pas ([brief](docs/accueil-telephone-brief.md)), bandeau tiré avec un orbe de lumière pour changer de session, faisceau de travail en ondes, notifications repliables des autres sessions. La fenêtre du bureau ne change pas.
- App Android : `/login` depuis le téléphone. Une connexion qui passe par une page web (compte d'un fournisseur) revient vers le navigateur du PC, que le téléphone ne peut pas atteindre : la page n'est plus ouverte sur le PC et Prism dit de lancer `/login` sur l'ordinateur. Une clé d'API, un serveur compatible et une connexion par code se font toujours depuis le téléphone.
- App Android : les fichiers passent par le lien, dans les deux sens. Le téléphone envoie n'importe quel fichier au PC pour le joindre à un message (100 Mio par fichier, 32 par envoi), et « Ouvrir » ou « Enregistrer sur le téléphone » dans Fichiers, comme les exports, téléchargent le fichier sur le téléphone. Le PC n'accepte en pièce jointe que ce que cette connexion vient d'envoyer, une seule fois.
- Fenêtre et téléphone partagent une session en direct (décision B1) : un seul moteur, le même flux des deux côtés, les questions sur les deux écrans, et la réponse donnée sur l'un ferme la question sur l'autre (« Répondu sur l'autre écran »). Les moteurs sont dans une caisse commune, `fork/host`, qui remplace les copies de la fenêtre et du serveur du téléphone. Sans téléphone lié, rien n'écoute et la fenêtre garde ses moteurs comme avant ; « Lier un téléphone » en mode « avec la fenêtre » ouvre un socket privé (`hub.sock`, mode 600) pour le serveur du téléphone. Le serveur en mode service a ses propres moteurs et ne partage pas avec une fenêtre ; le terminal ne partage pas encore. Un écran qui ouvre la session au milieu d'un tour, ou qui revient après une coupure, affiche la réponse en cours depuis son début et chaque message une seule fois, avec les statuts, les widgets et la file d'attente du moment. Une commande `!` lancée sur un écran s'affiche sur l'autre pendant qu'elle tourne.
- Un téléphone révoqué est coupé dans la seconde, même connecté.
- App Android : notifications. Quand l'app n'est pas à l'écran, Android annonce une conversation qui « attend ta réponse » (question, permission) et une conversation « terminée » ; elles s'effacent au retour dans l'app. Greffon `tauri-plugin-notification` 2.8.0 (approuvé le 2026-11-13) ; il faut « Rester relié en arrière-plan » (activé par défaut).
- App Android : les raccourcis du clavier, au doigt. Un appui long sur Envoyer met le message en file après la tâche en cours au lieu de l'orienter ; une loupe dans la barre du haut cherche dans la conversation ; l'écran de terminal d'un module a un bouton « Touches » qui déplie Échap, Tab, les flèches et Entrée.
- App Android reliée au PC ([plan](docs/app-android.md)) : `prism-remote serve` sur le PC, appairage par code, sessions et réponses du modèle sur le téléphone. La fenêtre du bureau garde maintenant affichée l'erreur d'un moteur qui ne peut pas démarrer (elle disparaissait au premier rafraîchissement).
- App Android, socle ([plan](docs/app-android.md)) : l'interface de la fenêtre construite en APK (`fork/android`), et un canal chiffré entre le PC et le téléphone avec appairage par QR code (`fork/android/link`).
- Fenêtre : menu latéral en rail d'icônes ([plan du propriétaire](docs/menu-lateral.md)). Chaque icône ouvre son panneau ; un clic sur l'icône active ou sur le bouton de la barre haute replie le panneau, le rail reste. Panneaux :
  - Conversations : l'ancienne barre latérale (le champ de filtre, devenu inutile avec la recherche, est retiré).
  - Rechercher une session : par nom ou par texte, dans ce dossier ou dans tous, avec l'extrait trouvé.
  - Tâches planifiées (module activé) : un clic ouvre `/schedule` sur la tâche ; `+` en crée une.
  - Sous-agents (dès qu'un agent a tourné dans la conversation) : les lancements, en cours puis terminés ; un clic montre le transcript complet (tâche, réponses, réflexion, chaque outil avec sa sortie), qu'on peut actualiser ou arrêter pour un agent en cours. Chaque sous-agent garde sa propre session à côté de celle qui l'a lancé (`<id>.agents/`), jamais listée parmi les sessions ; les agents lancés avant ce changement n'ont pas de transcript.
  - Mémoire (module activé) : mémoire globale et mémoire du projet, avec Modifier et Mettre à jour depuis cette conversation.
  - Trace (affichage Avancé) : les dernières opérations tracées ; un clic sur une opération ouvre `/trace`.
  - Journaux (affichage Avancé) : la sortie technique du moteur, en direct et secrets masqués, pour le débogage, même pendant son démarrage ou après son échec.
  Réglages passe en pied du rail.
- Navigateur (fork.11), désactivé par défaut (`/settings` › Modules) : l'agent utilise votre propre navigateur par l'extension Prism, dans des onglets qu'il ouvre lui-même et regroupés sous « Prism » ([conception](docs/navigateur.md)). Outil `browser` : ouvrir, lire la page et ses éléments, cliquer, taper, touches, défiler, capture, évaluer du JavaScript, attendre un texte. Sous Chromium, Chrome, Brave, vrais clics et vraie frappe, et le bandeau du navigateur permet d'arrêter l'agent d'un clic (`/browser resume` pour reprendre) ; sous Firefox, clics par script, ou vrais clics après `/browser firefox`, qui relance Firefox avec le contrôle à distance (WebDriver BiDi) ; le port de ce contrôle est refusé aux commandes de l'agent. Un curseur violet dessiné dans la page montre où l'agent clique et tape ; ses propres captures ne le montrent pas. `/browser setup` relie les navigateurs trouvés, y compris Helium, Zen, LibreWolf, Waterfox, Opera, Ungoogled Chromium (Flatpak) et ceux installés en Flatpak (après accord pour qu'ils lancent Prism hors de leur sandbox) ; `/browser` montre ceux qui sont reliés. Chaque adresse ouverte suit la règle d'hôtes de `web_fetch`.
- Bureau de l'agent (fork.11), désactivé par défaut (`/settings` › Modules) : l'agent utilise des programmes graphiques sur un bureau à lui, un labwc sans écran lancé par Prism, avec son propre pointeur et son propre clavier ; vos fenêtres restent hors de sa portée ([conception](docs/bureau-separe.md)). Outil `desktop` : démarrer, capture, cliquer (bouton, double clic), déplacer, glisser, molette, taper du texte (Unicode, quelle que soit votre disposition de clavier), touches et combinaisons, arrêter. L'agent y lance ses programmes avec `desktop launch`, hors de la sandbox (qui refuse la connexion au bureau) : Prism demande d'abord, même en mode large, sauf règle comme `desktop(firefox*)` ; une autorisation de tout l'outil `desktop` (donnée pour un clic ou une capture, ou `"tools": { "desktop": "allow" }`) ne couvre pas `launch`. `/desktop` donne l'état, `/desktop stop` l'arrête. Demande labwc, que la première installation propose d'installer ; saisie et captures passent par `prism-desktop-helper`, un petit programme en C livré dans l'archive. Dans la fenêtre, `/desktop` montre ce bureau en direct, avec le pointeur de l'agent, et l'arrête d'un bouton ; au terminal aussi, en plein écran, quand il sait afficher des images (kitty, Ghostty, WezTerm, iTerm2 ; Échap pour fermer).
- Bureau (fork.11) : l'agent lit les fenêtres de son bureau comme une liste d'éléments (`desktop elements` : rôle, nom, état, texte des champs), clique un élément par sa référence et tape dans un champ, sans passer par une capture. Les pages WebKitGTK (fenêtre Prism, applications Tauri) sont listées aussi. Les programmes lancés par l'agent ont leurs propres bus D-Bus, séparés des vôtres : l'agent ne voit jamais vos applications. Demande `at-spi2-core` ; Chromium et les applications Electron doivent être lancés avec `--force-renderer-accessibility`. Les programmes lancés par l'agent n'ont plus accès à votre trousseau ni à vos notifications.
- Bureau (fork.11) : l'agent peut remplacer tout le texte d'un champ par sa référence (`type` avec `replace`), retours à la ligne compris, au lieu de taper par-dessus ce qu'il contenait. La description de l'outil donne les limites de la liste d'éléments (300 éléments, noms à 100 caractères, textes à 300, jamais le texte d'un mot de passe, rien pour les terminaux et les jeux), et la liste dit quand un nom ou un texte a été coupé, pour que l'agent passe à une capture. La vue en direct du bureau, dans la fenêtre et au terminal, montre environ 7 images par seconde au lieu de 2.
- Bureau (fork.11) : l'agent voit son pointeur sur ses captures (flèche violette) et sa position dans chaque résultat ; un grand écran lui est montré réduit par Prism (au plus 1366×768 pour un 16:9), et ses clics sont convertis en vrais pixels : plus de clic décalé quand un fournisseur réduit l'image.
- Navigateur et bureau, permissions (fork.11) : même en mode large, Prism demande avant que l'agent utilise le navigateur ou un bureau. Répondez « dans cette session » pour ne plus être interrompu ensuite ; « 15 minutes » redemande à l'échéance ; `/perm` retire l'autorisation. Nouvelle ligne « Utiliser un navigateur ou un bureau » dans le tableau des modes (`computer` pour les modules qui la déclarent).
- Bureau de l'utilisateur (fork.11, module Bureau) : sur votre accord, l'agent agit sur l'écran où vous êtes. Pendant ce temps, le statut le dit ; vous reprenez la main avec `ctrl+shift+q` (réglable dans `/settings` > Permissions et sandbox, ou par `desktopTakeBackKey` dans `settings.json`) ou en bougeant la souris environ 2 s. Sous Hyprland, le raccourci n'est déclaré que pendant ce temps et le clavier de l'agent ne déclenche aucun de vos raccourcis. Sous GNOME et KDE, par le portail du bureau : le bureau demande l'autorisation (sous GNOME, quel écran partager et l'interaction à distance), une fois si vous le laissez s'en souvenir ; son bouton d'arrêt du partage rend aussi la main ; pour que GNOME y accepte le raccourci, Prism écrit la première fois une entrée de bureau cachée (`space.odelserver.prism.gui.desktop`), que la désinstallation retire. Un second petit programme en C, `prism-portal-helper`, est livré dans l'archive ; il demande libei et PipeWire, que la première installation propose d'installer quand ils manquent. Sur Debian 12 et Ubuntu 22.04, qui n'ont pas de paquet libei, elle dit que ce n'est pas possible au lieu de proposer une commande qu'`apt` refuserait.
- Bureau de l'utilisateur : l'agent peut y lancer un programme (`desktop launch`) après votre accord, demandé à chaque fois sauf si vous répondez « Oui, et ne plus demander dans cette session ». Le programme s'ouvre sur votre bureau et reste ouvert après que l'agent vous a rendu la main.
- Clés masquées utilisables sans être lues : quand l'agent écrit l'étiquette `[secret hidden: NOM]` d'une clé connue dans une commande ou un fichier, Prism demande (cette fois, jusqu'à la fin de la session pour ce programme ou ce fichier, ou toujours pour ce programme par une règle `passEnv`) puis met la vraie clé à l'exécution seulement ; la session, l'interface et le modèle ne voient que l'étiquette, la sortie reste masquée. La première fois que l'agent voit l'étiquette d'une clé dans une session, une note lui dit qu'il peut l'écrire ([détails](docs/secrets.md#7-utiliser-une-clé-masquée-sans-la-lire-2026-11-12)).
- Accueil de premier lancement (QA de fork.11) : une étape « Utilisation de l'ordinateur » à part, avec votre navigateur (extension Prism, l'étape actuelle et pas l'ancien Chrome DevTools), un bureau à l'agent et votre bureau. À la fin, Prism dit quoi installer pour ceux qu'on allume (labwc avec la commande de la distribution, `sudo dnf install labwc` par exemple ; une session Wayland) et met `/browser setup` dans la zone de saisie pour l'extension du navigateur. Le module du bureau de l'agent donne aussi cette commande quand labwc manque.
- Terminal (QA de fork.11) : `/phone` lie un téléphone comme « Lier un téléphone » dans la fenêtre : serveur du téléphone pendant que ce Prism est ouvert ou toujours (service de la session), code d'appairage en QR (caractères blocs) et en texte, téléphones liés et retrait. Dans la fenêtre, `/phone` ouvre son propre panneau. Au terminal, « Lier un téléphone » est aussi dans `/settings` › Autres. Le serveur (`prism-remote invite`) donne aussi le QR en texte ; l'app accepte un code collé avec des retours à la ligne.
- Recherche dans la conversation (QA de fork.11) : une loupe dans la barre du haut de la fenêtre ; ctrl+F l'ouvre au terminal comme dans la fenêtre (avant : ctrl+Maj+F seul, que kitty prend pour ses fenêtres). Comme sous Windows, ctrl+F ne déplace plus le curseur de la zone de saisie ; la flèche droite reste.
- Bureau de l'agent (QA de fork.11) : `/settings` › Utilisation de l'ordinateur › « Lancer des programmes sur son bureau sans demander ». C'est la règle `desktop(*)` du `permissions.json` global : visible dans `/perm`, les règles de refus l'emportent toujours.
- Sécurité, secrets : réglage avancé « Ne passer que les variables connues » (désactivé par défaut) : les commandes de l'agent ne reçoivent que les variables courantes, celles que vous ajoutez et celles qu'une règle passe ; un secret sous un nom inhabituel ne leur parvient plus.
- Fenêtre (QA de fork.11) : une conversation ouverte sur le téléphone apparaît sous « Ouvertes » sur le PC, avec un rond cerclé (« Ouverte sur le téléphone »), dans les 3 s. L'ouvrir sur le PC affiche la même conversation en direct ; elle quitte la liste quand le téléphone la lâche, sauf si elle a été ouverte sur le PC. Fermée sur le PC pendant que le téléphone l'a, elle n'y revient pas.
- App Android (QA de fork.11) : le téléphone garde tous les PC appairés (`pcs.json`) ; l'écran d'appairage et le panneau des réglages listent les autres avec un bouton « Utiliser » pour changer de PC.

### Changed
- App Android : changer de session en glissant sur le bandeau est un carrousel qui suit le doigt et se pose sur la session la plus proche ; toucher le nom centré ou l'orbe l'ouvre. La poignée prend les touchers sur toute sa zone (la conversation en recouvrait la moitié) et un glissement vers le bas sur la barre du haut l'ouvre aussi. Faisceau de travail moins haut, au-dessus du texte de la saisie. Réglages en deux écrans (sections, puis la section touchée). Le logo du panneau latéral ramène à l'accueil. L'icône de l'app est celle de la version PC.
- Raisonnement (QA de fork.11) : chaque modèle reprend le dernier niveau de raisonnement utilisé avec lui (enregistré à chaque message envoyé, dans `modelThinkingLevels`), dans la fenêtre comme au terminal ; le niveau propre au mode plan n'est pas retenu. Le niveau par défaut global (ctrl+S dans le sélecteur) ne vaut plus que pour un modèle jamais utilisé.
- Sécurité, lien téléphone : le dossier `~/.prism/remote` (clé du PC, téléphones appairés, sockets) est réservé à l'utilisateur comme `auth.json` : l'agent n'y écrit pas, le lire est une action dangereuse, et la sandbox le masque.
- Sécurité, lien téléphone : avant l'appairage, une connexion a droit à une première ligne de 1 Kio et à 10 s en tout ; 32 connexions au plus peuvent attendre ainsi.
- Sécurité, secrets : les variables `TOKEN`, `API_KEY`, `KEY`, `SECRET*`, `*APIKEY`, `*_KEY`, `*PASSWD*`, `*_PAT`, `*_PWD`, `*_PASS`, `*_PW`, et celles dont la valeur est une adresse avec mot de passe (`DATABASE_URL`), sont retirées des commandes de l'agent. Une variable retirée à tort se repasse par `passEnv`.
- Sécurité, reprise de session : le mode et les règles « dans cette session » ne sont rendus que si le fichier de session porte le sceau de cette installation ; sinon seuls les refus et un mode pas plus large que le mode configuré sont gardés, avec un avertissement. Une session enregistrée avant ce changement en mode large ou avec des règles d'autorisation les perd une fois.
- Sécurité, votre bureau (`user_desktop`) : la question d'accord dit en rouge que l'agent pourra aussi lancer des programmes et des commandes avec vos droits, hors de la sandbox, sans autre question ; en mode `safe`, la prise en main est refusée sans question.
- Sécurité, navigateur : la question d'hôte, posée aussi en mode large, propose « ce site cette fois », « ce site pour la session » et « tous les sites pour la session (navigateur seulement) », et dit en rouge qu'une page ouverte, ses liens et les scripts que l'agent y lance atteignent d'autres sites sans autre question. « Tous les sites » se voit et se retire dans `/perm`.
- Les questions peuvent porter un avertissement, affiché en rouge sous le titre dans le terminal, la fenêtre et l'app Android (champ `warning` de `select` et `confirm`, transmis en mode RPC et par les agents).
- Catalogue des modèles : un modèle retiré par son fournisseur reste dans le catalogue, marqué obsolète, tant que le code ou les tests de Prism le nomment ; le rafraîchissement hebdomadaire du catalogue ne casse plus pour cette raison.

### Fixed
- Assistant de réglage du navigateur (QA du 2026-11-13) : le dossier de l'extension à choisir est maintenant `~/Prism/browser-extension` (Chromium) ou `~/Prism/browser-extension-firefox` (Firefox), visible dans n'importe quel sélecteur de dossier et court, au lieu d'un dossier caché sous `~/.prism` ou du dossier d'installation. Les copies sont refaites à chaque passage de l'assistant ; l'identifiant de l'extension ne change pas.
- Zen en Flatpak (QA du 2026-11-13) : cause trouvée. Zen envoie le native messaging par un portail absent de la machine et ne lit pas `~/.zen/native-messaging-hosts`. L'assistant déclare aussi l'hôte sous `~/.mozilla`, demande les accès Flatpak utiles (`--persist=.mozilla`, et `--filesystem=~/Prism` pour que le navigateur lise l'extension) et dit de mettre `widget.use-xdg-desktop-portal.native-messaging` à 0 dans `about:config`. Ce dossier est en lecture et écriture, plus en lecture seule (QA de la candidate fork.11, 2026-11-15) : le sélecteur de fichiers de Firefox demande l'écriture, et sans elle le portail Flatpak ne donnait au navigateur qu'une copie de `manifest.json`, d'où « Loading failed for background.js ». `/browser setup` redemande l'accès à qui ne l'a qu'en lecture. L'assistant reconnaît aussi l'hôte de Zen, qui se présente comme « Firefox » : il distingue les hôtes par processus, pas par nom ; un hôte de Zen déjà relié au départ lui faisait attendre le nouveau sans le voir.
- Assistant de réglage (QA du 2026-11-13) : Chromium ouvre sa page Nouvel onglet quand on lui passe `chrome://extensions` (mesuré, aucune variante de ligne de commande n'y mène). Le bouton lance le navigateur, copie l'adresse dans le presse-papiers et l'écran dit de la coller dans la barre d'adresse. Firefox et dérivés ouvrent bien `about:debugging`.
- Assistant de réglage du navigateur (QA du 2026-11-13) : il ne s'ouvre plus en double au premier démarrage. Plusieurs moteurs lancés ensemble lisaient tous « pas encore proposé » avant qu'aucun n'écrive ; la vérification et l'écriture se font maintenant d'un seul geste, sous le verrou des réglages.
- Votre bureau sous Hyprland (QA du 2026-11-13) : à la prise en main, Prism montre un espace de travail vide, pour que l'agent ne voie ni vos fenêtres ni Prism ; l'agent change d'espace par l'action `workspace` (vos raccourcis comme Super+1 ne lui sont pas accessibles) ; quand il rend le bureau, l'écran revient à votre espace.
- Bureau (QA du 2026-11-13) : votre propre bureau devient un module à part, « Votre bureau », désactivé par défaut comme « Le bureau de l'agent » ; l'agent l'utilise par l'outil `user_desktop`. Une fois la prise en main acceptée, plus aucune question, lancement de programme compris (vous reprenez la main par votre raccourci ou la souris).
- Bureau de l'agent (QA du 2026-11-13) : `launch` présente ce qu'un programme encore lancé a écrit au démarrage comme des messages de démarrage, pas comme une sortie d'erreur (LibreOffice écrivait « Failed to open display » alors que sa fenêtre s'ouvrait) ; la description de `key` dit que sur le bureau de l'utilisateur les raccourcis du bureau (Super+1…) ne passent pas.
- Navigateur de l'agent (sessions de QA du 2026-11-13) : un vrai clic dans Chromium prenait 5 s, plus jusqu'à 10 s d'attente sur une page qui ne finit jamais de charger (publicités) ; mesuré à 0,3 s après correction. Une référence dont la page a reconstruit l'élément est retrouvée par rôle et nom. `snapshot` accepte `scope` et `visible`, `wait` attend un sélecteur ou une disparition, et les résultats nomment le navigateur.
- App Android : un écran avec un champ de recherche (Fichiers, Modèle, Tutoriel…) n'ouvre plus le clavier tout seul ; l'aperçu d'un fichier touché dans Fichiers vient à l'écran (il était sous toute la liste) ; les boutons plus hauts que leur texte le centrent (menu de Goal).
- Fenêtre : une notice de plusieurs lignes (les instructions de `/browser setup`) reste jusqu'à sa fermeture au lieu de disparaître après quelques secondes.
- Fenêtre et app Android : le texte d'attente « Prism travaille… », plus long, était coupé dans une fenêtre étroite ou sur le téléphone ; la zone de saisie reprend sa hauteur.
- Bureau : `desktop drag` ne faisait pas de glisser-déposer dans une page web (Firefox, Chromium) : le bouton était relâché avant que le navigateur ne commence le glisser. Le glisser prend maintenant environ une demi-seconde, avec un dernier mouvement sur la cible.
- Bureau de l'agent : après un défilement dans Firefox, `desktop elements` listait encore les lignes de la page visibles au début et jamais les nouvelles.
- Bureau de l'agent : un dialogue absent de l'arbre d'accessibilité (bienvenue de LibreOffice au premier lancement) recevait les frappes de l'agent sans qu'il le sache. `desktop elements` prend la fenêtre au premier plan auprès du compositeur et liste par leur titre les fenêtres sans arbre ; `type` par référence est refusé si la fenêtre de l'élément n'est pas au premier plan.
- Bureau de l'agent : dans LibreOffice Calc, `desktop elements` prenait 5 à 8 s et s'arrêtait après la ligne 2 de la feuille. Il liste maintenant les cellules à l'écran qui ont un texte (et la cellule active) en moins d'une demi-seconde, et dit quelle zone il a lue.
- Bureau de l'agent : les éléments des menus GTK 4 apparaissent avec leur libellé au lieu de « menu item » seul.
- Bureau de l'agent : le texte d'un champ sur plusieurs lignes garde ses retours à la ligne dans `desktop elements` (écrits `\n`).
- Bureau : une même action répétée plus de 15 fois d'affilée est refusée, avec le conseil de regarder où en est l'agent ; un modèle avait envoyé 340 fois `ctrl+End` jusqu'à la fin de son temps.
- `read`, `write` et `edit` : une erreur nomme le fichier demandé au lieu d'un chemin interne `/proc/self/fd/…`.
- Moteur (revue de code du 2026-11-09) :
  - un script codemode sans délai indiqué s'arrête au bout de 10 minutes (avant : jamais, sauf Échap) ;
  - modules que la revue n'avait pas lus : en mode Plan, une commande qui écrit un fichier ou lance un programme ne passe plus par une option groupée ou abrégée (`sort -uo FICHIER`, `sort --o=FICHIER`, `fd -Hx COMMANDE`, `pandoc -so FICHIER`), un script `sed` donné par `-e` ou `-f`, un nom de fichier `-l` après l'archive de `unzip` ou `bat cache` ; une sous-commande déclarée sûre (`safeSubcommands`) ne couvre plus que son propre segment (`make lint; rm -rf src` passait sans question) ; sandbox : une commande qui crée un sous-module avec son propre filtre Git ne fait plus exécuter ce filtre hors de la sandbox par le `git status` de Prism (onglet Produits de `/files`, continuité du projet) ;
  - mineurs de la relecture Fable : `/undo` refuse une sauvegarde en clair (une sauvegarde remplacée n'est plus restaurée sans la clé ; celles d'avant le chiffrement non plus) et retrouve l'historique d'une session enregistrée avant le changement de nom de son dossier ; `pi.exec` avec un délai ne tue plus un processus que la commande a laissé tourner après sa sortie ; MCP stdio : le groupe d'un serveur sorti n'est plus gardé ni signalé quand un descendant qui l'a quitté tient ses sorties ; un sous-agent n'est plus arrêté quand le parent restreint son mode deux fois de suite ; un message en file dont l'image est en cours de traitement est rendu à l'éditeur quand on vide la file, et une relance arrivée à la fin du tour est remise dans ce tour ;
  - relecture des lots de la revue : en mode lecture seule, Prism ne laisse plus passer sans demander un `sed` qui écrit un fichier après une classe `[/]`, un `awk` qui écrit sur une ligne continuée ou choisit ses fichiers par `ARGV`, un fichier protégé nommé par une variable (`${X:-.env}`, `"$S"v`, `${S:0}`, une valeur non citée, `${S:=…}`) ou par une classe POSIX (`.en[[:alpha:]]`), une option cachée dans une variable (`find . $S`, `sort $S`) ni une option abrégée de `git branch` (`--unset-u`) ; l'aperçu des PDF et documents fonctionne avec bubblewrap 0.9 (Ubuntu 24.04) ; `edit` et `write` écrivent de nouveau un fichier monté seul (conteneur, `docker -v fichier:fichier`) ;
  - `/skills` : mettre à jour un paquet affiché pour ce projet ne met plus à jour, en plus, la même source installée pour tous les projets ;
  - restes de la passe sandbox et sessions : l'arbre de session de la fenêtre étiquette chaque résultat d'outil avec son propre appel quand un id est réutilisé ; `/export-zip` refuse plus de 32 766 sessions avant d'en charger aucune et écarte les fichiers au-delà de 65 535 entrées ; `prism --flag-booleen "consigne"` n'est plus pris pour un lancement simple qui suivrait le réglage de la fenêtre ;
  - décisions du 2026-11-12 sur la file de la revue : l'authentification OAuth `client_secret_basic` encode l'identifiant et le secret (un identifiant avec `:` n'est plus coupé) ; sans sandbox, une session reprise, dupliquée ou forkée donne au modèle les chemins de ses pièces jointes dans son propre /tmp privé ; sur le bureau de l'agent sans registre d'accessibilité, les programmes lancés gardent un bus de session propre au bureau ; une fois un budget épuisé, un nouveau message est refusé sans appel au modèle ; réglages, `auth.json` et sessions montés seuls (`docker -v`) sont écrits sur place au lieu d'échouer ;
  - Git en lecture seule, onboarding et sélecteurs : en mode lecture seule sans sandbox, `git branch -f`/`-m`/`-c` ou un nouveau nom et `git reflog expire`/`delete` demandent ; `/onboarding` part du mode en vigueur dans la session et l'applique, puis attend qu'il soit appliqué avant de recharger les modules ; deux choix qu'une traduction rendrait identiques restent distincts, et deux options de connexion au même libellé rendent chacune la leur ;
  - bureau, navigateur et fenêtre : un long texte tapé sur le bureau de l'agent ne reprend plus les caractères d'un texte précédent ; sans registre d'accessibilité, les programmes lancés sur le bureau de l'agent n'atteignent plus vos bus D-Bus ; un second Prism ne peut plus prendre votre bureau Hyprland pendant qu'un autre l'a (il ne retire plus son raccourci de reprise) ; `browser type` choisit une option dans la liste déroulante qui a le focus ; dans la fenêtre, l'Entrée ou l'Échap d'une saisie en méthode de saisie (japonais, chinois) ne répond plus à une question ; une entrée de menu `prism.desktop` à vous n'est plus supprimée, ni remplacée, par le réglage du menu ou par `install.sh --uninstall` ; un clic pendant l'ouverture d'un panneau n'agit plus sur une autre ligne que celle sous le pointeur ;
  - reprise, projets et états enregistrés : un dépôt créé dans un sous-dossier pendant la session devient le projet des permissions « pour ce projet », et une recherche Git interrompue est refaite ; un prompt resté sans réponse (ou des outils sans réponse finale) est signalé comme interrompu à la reprise et dans `/state` ; les anciennes entrées de permissions, de budgets et de Goal ne changent plus en mémoire après leur écriture ;
  - sandbox, Git, LSP, remote-pi, paquets, sessions, file d'attente, budgets, export : un dépôt dont un delta est à plus de 2 Gio de sa base, ou un index que Git refuse, est traité correctement ; une URL de `web_fetch` avec une virgule reste entière ; `socketpair` n'ouvre plus de socket datagramme hors sandbox ; `/sandbox` décrit le D-Bus filtré quand il l'est ; `lsp_fix` gère les fins de ligne CR/CRLF et les serveurs qui ne renvoient que des commandes ; un fichier `..generated.ts` est accepté ; le réseau d'agents ferme ses connexions muettes, n'acquitte plus un message d'agent de type `ack`, rend l'id d'envoi et accepte plusieurs destinataires ; un paquet n'exporte que ce que son manifeste nomme, les globs `[ab]` et `{a,b}` marchent et une déclaration directe l'emporte sur le paquet ; `--min-expiry 30M` vaut 30 minutes ; une règle `----` n'est plus un frontmatter ; une image très fine garde au moins 1 px ; un ZIP de plus de 65 535 entrées est refusé ; les tuples codemode sont typés ; charger une session ne l'écrit plus ; le pied de page voit un dépôt créé après le démarrage ; un outil séquentiel imbriqué ne tourne plus en parallèle d'un autre ; les images des messages en file sont traitées comme celles d'un prompt ; le maintien du cache ne remplace plus `/sent` et compte dans les budgets, comme la compaction et les résumés ; le budget de temps ne compte plus l'attente entre deux invites ; l'export HTML et `/state` relient chaque résultat à son appel quand un id revient ; une copie de session garde ses pièces jointes ; un flag booléen d'extension n'avale plus le prompt ;
  - mesure des modules, MCP et agents : la mesure garde les extensions globales données par un chemin relatif et compare vraiment le module activé et désactivé quand le projet change son état ; le marqueur MCP remonte au résultat d'un script même à travers un outil intermédiaire ; avec « seulement quand mon message contient @agent », le mot-clé est cherché dans le dernier message envoyé (steer compris) tel qu'il a été tapé, pas dans le texte d'un template ;
  - modules du fork, suite : les points de reprise de la session ouverte ne sont plus supprimés, et les fichiers non sauvegardés restent signalés après reprise ; plus de notification « en attente » quand une règle a déjà décidé ; `/lsp-setup` reconnaît les serveurs configurés sous un autre nom ; la souris dans les listes suit les raccourcis changés ; la recherche de sessions trouve celles du projet courant même quand d'autres projets en ont de plus récentes, lit un dossier de sessions choisi (RPC) et centre bien l'extrait sur un texte accentué ; la passation se sait périmée pour un nouveau fichier dans un nouveau dossier et lit bien un renommage ; les tâches planifiées gardent les `$` du dossier de l'agent ; deux trousseaux qui ont une clé pour le même fournisseur sont tous deux masqués ; la mémoire est une section du prompt et n'efface plus les consignes ajoutées après elle (elle n'est plus ajoutée quand une autre extension impose un prompt complet) ;
  - modules du fork : un nombre saisi dans un formulaire généré arrive tel quel au modèle ; un projet dont une session est un lien cassé reste dans les projets récents ; `web_fetch` lit directement une page sur un autre port qu'Exa n'a pas livrée, et signale l'échec d'une page dont l'adresse commence par celle d'une page livrée ;
  - `prism config` : activer une extension exclue sous une autre forme de son chemin la charge ; basculer un fichier d'un paquet ne change plus les autres ; un fichier listé hors des dossiers automatiques reste listé une fois désactivé ;
  - collages et pièces jointes : un gros collage garde son texte après l'éditeur externe, une fenêtre d'extension ou un changement d'éditeur ; une pièce jointe modifiée par l'agent revient modifiée à la reprise ; un nom de fichier avec un guillemet reste une pastille dans la fenêtre ;
  - RPC, export et installation : une session changée par RPC démarre ses extensions une seule fois ; le client RPC attend une commande ou une compaction de plus de 30 s ; le texte pipé reste séparé de la consigne ; un répertoire d'installation relatif donne un lien valide ; les `$` d'une sortie, d'un export HTML ou d'un chemin affiché restent intacts ;
  - fenêtre, suite : rouvrir une conversation endormie respecte la limite de mémoire comme une nouvelle conversation ; deux diagrammes identiques sont tous deux dessinés ; la recherche suit les blocs dépliés ou repliés ; un module du tutoriel sans exercice se coche une fois lu ; un graphique aux valeurs extrêmes reste dessiné ; un exemple de balise `<file>` cité dans un message n'est plus pris pour une pièce jointe ;
  - terminal, outils de fichiers et MCP : les raccourcis `ctrl++`, `ctrl+f5` et semblables fonctionnent, et un modificateur mal écrit ne déclenche plus le raccourci sur la touche seule. Les collages et la complétion par Entrée ne modifient plus le brouillon envoyé. `@` trouve les fichiers aux noms comme `+page.svelte` ou `[slug]`. Le Markdown affiche `&amp;` et `&#233;` décodés. `edit`, `find`, `grep`, `read` et `bash` traitent exactement les espaces, noms à caractères spéciaux, fichiers UTF-16, positions non entières et très longues lignes. MCP : provenance et pagination des ressources exactes, noms d'outils sans collision, flux SSE à fins de ligne CR et reprise exacte après coupure ou avec un id Unicode ;
  - bureau de l'utilisateur sous GNOME ou KDE : le raccourci de reprise arrête la frappe de l'agent tout de suite, au lieu d'attendre la fin du texte en cours (jusqu'à plusieurs secondes), et relâche les touches tenues ;
  - fenêtre : une conversation rouverte pendant sa mise en veille repart sur un moteur neuf avec ses autorisations ; une réponse arrivée après un changement de conversation retourne dans le brouillon de sa conversation ; un panneau `/share` fermé pendant l'export ne crée plus de gist ; une commande abandonnée n'ouvre plus son panneau par-dessus la suivante ; la complétion groupe les frappes rapides et arrête la recherche qu'on n'attend plus ; les surlignages de `/docs` survivent au replacement du panneau ; l'accueil n'anime plus deux boucles ; un composant d'extension construit après sa fermeture est libéré ;
  - Les listes trop hautes défilent au lieu de déborder : `/settings` (domaines, fenêtres surgissantes, listes), `/perm`, la validation de la portée d'une tâche et le tutoriel. Les très petites largeurs ne cassent plus l'affichage. `/context` et le footer montrent le contexte que le modèle reçoit vraiment et le seuil d'auto-compaction réglé. Le résumé de branche respecte la fenêtre et ne renvoie plus ce qui a été retiré du contexte. L'archive portable indique quels messages une compaction a gardés ;
  - suite de la revue : un réglage de modèle enregistré dans `/settings` ne remet plus l'ancien modèle si vous en choisissez un autre pendant l'enregistrement ; dans l'explorateur de la fenêtre, passer à un autre fichier arrête l'extraction de l'aperçu précédent ; la détection d'un serveur, la liste de ses modèles et la vérification npm lisent leur réponse jusqu'à une limite ; la sandbox refuse au-delà de 1024 connexions ouvertes à la fois par commande, sans couper les autres ; un périmètre proposé par l'agent compte au plus 64 chemins ; un échec de rafraîchissement des ressources MCP s'affiche sur le serveur ; un outil au schéma irreprésentable n'empêche plus codemode de décrire les autres ;
  - une tâche de fond en cours reste suivie après un `/reload` (`/bg`, arrêt) et son rapport de fin arrive toujours ; un hôte bloqué après le `/reload` (ou après `/new`) ferme aussi les connexions qu'elle avait ouvertes avant ;
  - une confirmation ne s'applique plus qu'à ce qu'elle a montré : si l'état change pendant la question, elle est reposée avec le nouvel état, et rien n'est fait après trois changements de suite. Concerne `/undo` et `/checkpoints` (refusés aussi pendant un tour), `/mcp add` (et un ajout global masqué par le `mcp.json` du projet est signalé), le retrait d'une entrée dans `/settings`, la révocation dans `/perm`, la création d'une tâche planifiée (un nom pris entre-temps est refusé ; la fenêtre crée la tâche de son résumé), `memory-edit` (ce qui a été enregistré entre-temps est montré pour être repris) et la confiance d'un outil MCP modifié. `lsp_fix` n'écrit plus un fichier modifié pendant l'analyse du serveur.
  - navigateur : quand vous arrêtez le contrôle depuis la barre de débogage de Chromium, l'action en cours s'arrête aussi (avant, la fin d'un clic ou d'une saisie partait quand même) ;
  - bureau : une session fermée pendant le démarrage du bureau ne laisse plus de compositeur ni de bus derrière elle, et la commande `launch` en attente ne tourne plus ; un bureau de l'utilisateur accordé après la fermeture est rendu aussitôt ; le mode Plan désactivé puis rechargé n'est plus proposé par `/init` ni basculé par la fenêtre ;
  - `remote-pi` après un changement de session : le renommage, la relance du relais et le modèle choisi depuis l'app visent le projet de la session courante, plus celui du lancement ; l'app reçoit l'historique de la session courante seulement ; une photo arrivée pendant le changement n'est plus envoyée à la nouvelle session ; un relais qui ne répond pas est abandonné après 10 s, et l'arrêt ferme une connexion encore en ouverture ;
  - fenêtre : la liste de sessions et le menu latéral ignorent une réponse arrivée après un changement de portée, de recherche ou de moteur ; une réponse de connexion envoyée deux fois ne répond plus à la question suivante ; annuler la suppression d'un agent renommé n'en crée plus un second à l'enregistrement ;
  - un agent déjà lancé suit les restrictions que sa session ajoute ensuite (mode plus étroit, refus) ; s'il ne les applique pas, il est arrêté ;
  - RPC : un changement de session qui échoue après la fermeture de l'ancienne arrête le moteur avec une erreur, au lieu de continuer sur une session fermée ;
  - un arrêt pendant la lecture d'une longue commande à autoriser, ou pendant la question de confiance MCP, ferme le dialogue et refuse l'appel au lieu d'attendre une réponse (TUI et RPC) ;
  - un identifiant du trousseau renouvelé par une autre session est relu au lieu de rester l'ancien en cache (le marqueur de `auth.json` porte une révision) ;
  - le pied de page n'affiche plus la branche Git du projet précédent quand une résolution lente finit après la reprise d'une session d'un autre projet ;
  - `prism config` : après un changement global, l'onglet du projet montre l'état hérité à jour et en part pour son override ;
  - `grep` et `find` arrêtés pendant leur préparation (téléchargement de `rg`, recherche du dépôt) ne lancent plus leur programme ;
  - `read` arrêté pendant la lecture d'un très gros fichier ou l'extraction d'un document arrête ce travail, au lieu de le poursuivre et de bloquer les écritures du fichier ; de même pour le contexte de `grep` ;
  - deux changements de session demandés ensemble (RPC) : le second est refusé, au lieu de laisser tourner une session sans propriétaire ;
  - changer de session ferme les vues d'extension encore ouvertes dans la fenêtre, comme annulées, et retire leurs widgets ;
  - deux compactions manuelles demandées ensemble : la seconde est refusée au lieu de faire échouer les deux ;
  - arrêter un prompt pendant sa préparation (extension lente avant le tour) n'envoie plus rien au modèle ;
  - un prompt envoyé pendant une navigation `/tree` est refusé, au lieu d'arriver dans la mauvaise branche ;
  - une navigation `/tree` annulée laisse la session où elle était.
- Permissions (revue de code du 2026-11-09) :
  - passer en `safe` pendant qu'une question d'autorisation est ouverte, ou ajouter une règle qui bloque l'action, refuse l'action même si la question reçoit ensuite « Autoriser une fois » ;
  - passer en `safe` pendant que `sudo` demande le mot de passe refuse la commande : rien ne s'exécute en root ;
  - deux changements de mode rapprochés gardent le dernier choisi, même si la sandbox du premier finit de démarrer après ;
  - un périmètre de tâche terminé pendant la vérification d'une installation npm ne couvre plus la commande : elle est demandée ;
  - enregistrer un réglage de modèle depuis la fenêtre ne remet plus ce modèle si vous en avez choisi un autre entre-temps.
- Serveurs MCP (revue de code du 2026-11-09) :
  - couper un serveur qui n'a pas encore répondu au démarrage l'arrête tout de suite, au lieu de le laisser tourner jusqu'à 60 s ;
  - un serveur activé puis désactivé aussitôt dans les réglages ne démarre plus ;
  - après deux changements rapprochés de ses outils ou ressources, la liste gardée est la plus récente : un outil retiré ne réapparaît plus ;
  - l'ancienne connexion d'un serveur HTTP qui a perdu sa session est fermée ;
  - se déconnecter d'un serveur pendant que ses jetons se renouvellent (dans cette session ou une autre) ne laisse plus de jetons enregistrés ;
  - un appel à un serveur HTTP annulé ou terminé ne garde plus sa connexion ouverte et n'est plus repris ;
  - une extension écartée (extension de projet refusée parce qu'elle remplace `/perm`, ou extension remplacée par une autre) ne laisse plus ses serveurs MCP ni ses abonnements actifs.
- Annulations et changements de session (revue de code du 2026-11-09) :
  - `web_fetch` annulé ne télécharge plus les URL suivantes ;
  - une tâche planifiée proposée par l'agent n'est plus créée si vous répondez après l'annulation du tour ;
  - le panneau des budgets d'un client RPC disparaît avec son module ;
  - `/sent` ne montre plus la requête de la session précédente ;
  - une recherche de sessions annulée s'arrête, sans poser ensuite sa question ;
  - les images collées ne restent plus en mémoire après l'envoi ou le changement de session.
- Fin de session (revue de code du 2026-11-09) : une tâche de fond, un sous-agent ou une notification de test qui finit après `/new`, `/resume`, `/fork` ou `/reload` n'arrête plus Prism et ne touche plus la nouvelle session. Avant, le rapport d'un sous-agent, ou le relais réseau d'une simple tâche de fond, pouvait arrêter le moteur ; et la fin d'une ancienne tâche effaçait le compteur « bg » de la nouvelle session. Un sous-agent qui a répondu reste listé tant que ses tâches de fond tournent.
- Serveur MCP local qui écrit sans fin (revue de code du 2026-11-09, séance réelle) : Prism ferme la connexion au premier message trop long, en moins d'une seconde. Avant, il occupait un cœur entier pendant 60 s, et l'interface ralentissait. Un long message est rassemblé sans être recopié à chaque morceau.
- Calculs trop longs (revue de code du 2026-11-09) : `lsp_fix` vérifie le chevauchement de dizaines de milliers de modifications en quelques millisecondes au lieu de plusieurs secondes, et un motif de permission ambigu (`src/*a*a*…*b`) ne bloque plus Prism pendant la décision. Un glob d'écriture proposé par le modèle pour un périmètre est limité à 256 caractères.
- Structures très profondes (revue de code du 2026-11-09) : une longue session dans l'arbre de la fenêtre graphique, un caractère large dans un éditeur d'une ou deux colonnes, une formule LaTeX très imbriquée et un schéma d'outil très profond dans codemode ne font plus tomber le rendu. Une formule de plus de 64 niveaux est affichée telle quelle. Une session dont les entrées forment un cycle de parents est refusée au chargement au lieu de bloquer Prism.
- Très grands volumes (revue de code du 2026-11-09) : un long bloc de code collé, un tableau `show_ui` affiché dans un terminal très étroit, une liste MCP de plus de 150 000 ressources et une recherche aux occurrences très nombreuses dans la fenêtre graphique ne lèvent plus « Maximum call stack size exceeded ». Tronquer une très longue sortie MCP ne demande plus un tableau d'un élément par caractère retiré.
- Lecture des PDF, `.docx` et `.odt` (revue de code du 2026-11-09) : le programme d'extraction ne peut plus prendre plus de 1 Gio de mémoire, et deux extractions au plus tournent à la fois. Un document piégé (quelques centaines de Kio qui se décompressent en centaines de Mio) est refusé au lieu d'épuiser la mémoire de la machine.
- Fenêtre graphique (revue de code du 2026-11-09) : fermer un moteur qui ne répond plus le tue au bout de son délai, même quand sa connexion à la page est déjà fermée.
- Bureau de l'agent (revue de code du 2026-11-09) : un helper qui ne répond plus est arrêté au bout de 30 s au lieu de bloquer toutes les actions, et un tour annulé n'envoie plus les actions restantes. Ce qu'un programme lancé laisse tourner s'arrête avec le bureau ou avec Prism. Relancer le bureau après la mort de son helper arrête l'ancien compositeur.
- Arrêt des serveurs MCP et de sudo (revue de code du 2026-11-09) : fermer un serveur MCP local arrête aussi ce qu'il a lancé, même quand le serveur s'est déjà terminé. Après l'arrêt d'une commande sudo, Prism vérifie que ses processus sont finis ; sinon, le message dit que la fin n'est pas confirmée au lieu d'annoncer le groupe arrêté.
- Arrêt des programmes lancés (revue de code du 2026-11-09) : une commande lancée par une extension (`pi.exec`) qui ignore SIGTERM est tuée 5 s plus tard, avec ses descendants. L'arrêt d'une tâche de fond attend que tous ses processus soient finis avant de l'annoncer arrêtée, et ne peut plus viser un autre programme. Une tâche de fond qui échoue à démarrer ne laisse plus de journal ouvert ni de commande lancée. Un `fd` ou `rg` défectueux qui ne répond pas à `--version` ne bloque plus Prism au démarrage. Les programmes lancés par une extension ou un agent sont arrêtés à la sortie de Prism.
- Codemode et progression des outils (revue de code du 2026-11-09) : un script codemode qui produit sans fin du texte ou des images s'arrête au-delà de 16 Mi caractères ou de 10 000 éléments, avec un message et la sortie déjà produite. Un outil très bavard en progression ne remplit plus la mémoire quand un client RPC lit lentement : au-delà de 64 mises à jour en attente, seules la plus récente et la dernière sont livrées.
- Sorties d'autres programmes (revue de code du 2026-11-09) : un serveur de langage qui annonce un message démesuré, ou qui écrit sans fin sur sa sortie d'erreur, est arrêté au lieu de remplir la mémoire. Une grande capture d'écran du navigateur n'est plus recopiée à chaque morceau reçu. Un serveur MCP qui ne lit plus ce qu'on lui envoie est déconnecté avec un message. Une commande qui n'affiche que des retours chariot (une barre de progression) n'accumule plus de morceaux vides.
- Réseau et D-Bus de la sandbox (revue de code du 2026-11-09) : une commande qui ne lit plus une connexion, ou un service qui ne lit plus, ne fait plus grossir la mémoire de Prism. Chaque connexion de la sandbox a sa propre fenêtre de 256 Kio, et une connexion bloquée n'arrête plus les autres ; le relais D-Bus et le proxy conteneurs suspendent ce qui écrit vers un côté qui ne lit pas. Une requête au service de conteneurs s'arrête quand la commande ferme la connexion, ou après 30 s de silence.
- Outils de recherche et de liste (revue de code du 2026-11-09) : `grep` avec un `context` démesuré (`1e9`) répond aussitôt au lieu d'épuiser la mémoire ; une correspondance sur une ligne géante (un fichier minifié d'une seule ligne) garde son numéro de ligne et montre son début, sans charger la ligne entière. `find` et `ls` refusent `limit: 0` (fd le lisait comme « sans limite »), `find` arrête la collecte au-delà de ce que la réponse peut montrer, `ls` lit un dossier entrée par entrée en ne gardant que les premières. `session_search` ne garde que ses meilleurs résultats pendant la recherche ; le repérage des langages s'arrête à 5 000 entrées sans lire tout un dossier d'abord.
- Réponses HTTP (revue de code du 2026-11-09) : un serveur MCP HTTP ou un service de recherche web qui répond par un corps démesuré ou sans fin est refusé à sa limite au lieu de remplir la mémoire ; d'une erreur, seul un extrait est lu ; une requête MCP abandonnée arrête aussi la lecture de sa réponse.
- Lectures de fichiers (revue de code du 2026-11-09) : un FIFO (tube nommé) ne bloque plus Prism quand il est ouvert comme session, aperçu d'`edit`, mémoire, handoff, fichier Git de la barre d'état ou `@chemin` ; une image de plus de 20 Mo est refusée par `read` et `@chemin` au lieu d'être chargée ; `@chemin` extrait le texte d'un PDF, `.docx` ou `.odt` et refuse les autres fichiers binaires ; checkpoints, journaux, mémoire et copie Git ne lisent plus un gros fichier en entier pour n'en garder qu'une partie ; joindre ou exporter un fichier tronqué pendant la copie ne bloque plus.
- Verrous et noms partagés entre sessions (revue de code du 2026-11-09) : deux lancements d'une même tâche planifiée ne passent plus tous les deux ; une session qui démarre ne retire plus les verrous Git d'une publication encore en cours dans une autre ; `remote-pi` ne supprime plus le socket d'une instance vivante ; un second `/browser firefox` ne remplace plus le port de contrôle du Firefox déjà lancé, que la sandbox doit refuser ; une installation de paquet Git ratée ne supprime plus celle qu'une autre session vient de réussir ; deux éditeurs de thème ouverts en même temps enregistrent deux copies ; une nouvelle pièce jointe ne prend plus le nom de la copie gardée d'une ancienne ; deux téléchargements de `rg` ou `fd` n'utilisent plus la même archive.
- Identité de remote-pi (revue de code du 2026-11-09) : deux sessions qui démarrent remote-pi pour la première fois en même temps gardent une seule identité ; un trousseau vide ne remplace plus l'identité d'une machine qui a des appareils appairés (ce qui les révoquait tous) : remote-pi s'arrête et dit comment retrouver l'identité ; deux sessions qui appairent un appareil en même temps les gardent tous deux ; un `peers.json` illisible n'est plus remplacé par le seul nouvel appareil.
- Installation et mises à jour (revue de code du 2026-11-09) : deux installations ou mises à jour lancées en même temps passent l'une après l'autre (la seconde le dit), au lieu de pouvoir supprimer la version que l'autre allait activer ; `flock` (util-linux) est désormais nécessaire. Une session ouverte depuis une version plus ancienne que la précédente garde ses fichiers (export HTML) : une mise à jour ne retire plus une version qu'un processus utilise encore. Passer d'un canal à l'autre sans nouvelle version ne change plus le canal rendu par `prism update --rollback`. `install-local.sh` garde l'installation précédente jusqu'à ce que la nouvelle soit en place.
- Fichiers durables (revue de code du 2026-11-09) : réglages, configuration MCP, index des checkpoints, fichier de session migré, `capabilities.json`, `models.json` et autorisations du projet sont remplacés entiers ; un arrêt ou un disque plein laisse l'ancien fichier complet. `edit` et `write` font de même pour un fichier ordinaire à un seul nom qui vous appartient ; un fichier à plusieurs noms (lien physique) ou à un autre propriétaire est toujours écrit sur place. Deux sessions qui modifient les réglages, les règles de permissions, `auth.json` ou `capabilities.json` gardent chacune sa modification, y compris par un lien symbolique ; deux `edit` par deux liens physiques d'un même fichier aussi. Un `capabilities.json` invalide n'est plus remplacé par la seule modification. Les anciennes clés de `settings.json` n'en sont retirées qu'une fois écrites dans `auth.json`. Une restauration `/undo` ratée garde son checkpoint pour réessayer, et un fichier recréé retrouve ses droits. Un premier enregistrement de session raté ne bloque plus les suivants.
- Formes de chemin (revue de code du 2026-11-09) : un nom de fichier avec un espace insécable ou une espace finale désigne ce fichier quand il existe, plus son voisin à l'espace ordinaire ; un `.env` sous un dossier dont le nom contient un saut de ligne est protégé ; un dépôt dont le nom contient un saut de ligne ne rend plus lisible le dossier voisin ; une session dont le dossier est devenu un fichier propose de continuer dans le dossier courant ; un `AGENTS.md` lu par un cwd lié compte pour la confiance ; un chemin relatif dans la configuration SSH ou de signature est jugé depuis les deux dossiers possibles, ou refusé ; un fichier modifié par un lien apparaît dans les fichiers produits ; `ls` montre un lien pendant.
- Identifiants (revue de code du 2026-11-09) : un fichier de session dont l'identifiant n'est pas valide (`../x`) n'est plus ouvert ; deux projets dont les chemins donnent le même nom de dossier (`/a-b/c`, `/a/b-c`) ne voient plus les sessions l'un de l'autre ; deux sessions au même `--session-id` ont chacune leurs checkpoints (ceux d'une session en cours avant la mise à jour ne sont plus proposés par `/undo`) ; deux sessions qui lancent leur première tâche de fond en même temps ont chacune leur journal ; deux dépôts Git sur deux ports du même hôte sont deux paquets.
- Fichiers réservés (revue de code du 2026-11-09) : une recherche `grep` ne montre plus les lignes d'un fichier protégé (`.env`, clés, motifs `protectedPaths`) et dit combien elle en a laissé ; un chemin donné à un outil MCP est jugé comme par `read`, et réservé comme pour `write` quand l'outil peut écrire ; `mcp-tools.json`, `pi-lsp.json`, `pi-goal.json` et le dossier `remote/` de remote-pi ne peuvent plus être écrits par le modèle ; un `CARGO_HOME` déplacé garde ses identifiants cachés et sa configuration reconstruite, comme `~/.cargo`.
- Fichiers ouverts par Prism (revue de code du 2026-11-09) : `write`, `edit` et `read` ouvrent le fichier que la permission a jugé ; un lien posé ensuite sur son chemin (par une commande de fond) n'est plus suivi, un autre fichier mis à sa place est refusé, comme un lien physique ajouté entre-temps. `/undo`, la copie d'une pièce jointe dans le `/tmp` de l'agent et le tampon de `/handoff` ne suivent plus de lien posé par l'agent. Écrire un fichier qui a plusieurs noms (lien physique) demande confirmation dans tous les modes. `read` vérifie le type du fichier et lit ses octets dans un même état du fichier. Deux écritures du même fichier par un dossier lié et par son vrai chemin attendent l'une l'autre. Le nom d'un fichier temporaire d'une autre session écrit par le modèle dans un résultat ne rend plus ce fichier lisible.
- Réseau (revue de code du 2026-11-09) : `web_fetch` et le garde npm se connectent aux adresses que la permission a vérifiées, plus à une seconde réponse DNS qui mènerait à un port de cette machine non autorisé ; une recherche web ne suit plus de redirection ; une connexion de la sandbox n'est plus ouverte quand la commande a fini pendant la résolution DNS ; une installation npm globale n'est plus vérifiée auprès du registre du projet (aucune requête : elle demande confirmation) ; un hôte bloqué ou autorisé écrit en Unicode s'applique aussi à sa forme ASCII ; le relais remote-pi n'accepte plus `http://` vers un nom qui commence par `127.`.
- Programmes lancés hors sandbox (revue de code du 2026-11-09) : Git, bubblewrap, les outils d'aperçu de documents et les programmes lancés à chaque session (`secret-tool`, `gdbus`, `dbus-daemon`, `mkfifo`, `nsenter`) ne sont plus pris dans un dossier du `PATH` que la sandbox peut écrire (un `.venv/bin` du projet) ; Git lancé par Prism n'exécute plus le fsmonitor, les hooks ni les filtres déclarés par le dépôt (`/handoff`, fichiers produits). Le SSH de Git refuse une configuration qu'il ne sait pas juger : `Include` avec motif ou jeton atteignant un dossier inscriptible, `ProxyCommand` avec guillemets, variable ou motif, lien remplaçable du projet. Un `git am` interrompu ne peut plus laisser une option qui écrit hors du projet à sa reprise.
- Arguments des programmes que Prism lance (revue de code du 2026-11-09) : un sous-agent reçoit les `-e` analysés au lancement, jamais un mot du prompt ; une tâche planifiée dont la consigne commence par `-` est envoyée telle quelle, et une option Node `--import=…` vers le projet empêche de la planifier ; `--gui` avec d'autres arguments (`--safe`, `--no-approve`, une consigne…) reste dans le terminal et le dit, au lieu de les perdre ; un chemin collé dans une commande `!` de la fenêtre est cité (`;`, `|`, `*`) ; l'entrée du menu d'applications et le lanceur de l'installation locale gardent un chemin avec `$`, guillemet ou antislash.
- Confiance et chargements (revue de code du 2026-11-09) : un dossier refusé reste refusé quand ses extensions réapparaissent puis `/reload` ; `--safe` n'installe plus les paquets déclarés dans les réglages ; `/mcp` n'ouvre qu'une adresse d'autorisation https (ou http locale) ; le client RPC lance son propre paquet, plus le `dist/cli.js` du dossier ouvert ; Photon ne charge plus un WASM du dossier courant.
- Secrets connus (revue de code du 2026-11-09) : une clé que Prism connaît (trousseau, `auth.json`, variable retirée des commandes) n'atteint plus le modèle ni aucun fichier que Prism écrit, même avec un guillemet, un antislash ou un saut de ligne, même en nom de propriété. Couverts en plus des résultats d'outils : prompt système, prompts (`@fichier`, stdin), sortie des commandes `!`, messages des extensions (fin de tâche de fond, échec d'un sous-agent), compaction, progression des outils, session, exports HTML et JSONL et `/share`, archive portable (noms de fichiers compris), journaux des tâches de fond et MCP, sortie complète MCP, journal de crash, `/debug`, trace, inspecteur. Une clé collée dans le prompt n'est donc plus vue par le modèle. Une clé d'`auth.json` donnée par `$VAR` est masquée et sa variable retirée des commandes. Le code d'appairage de remote-pi n'est plus envoyé au modèle.
- Sauvegardes de `/undo` chiffrées (revue de code du 2026-11-09) : le fichier restauré reste exact, la sauvegarde ne contient plus rien en clair ; clé dans `checkpoint.key` (0600) dans le dossier de l'agent. Les journaux, sorties complètes et vidages de diagnostic sont créés lisibles par vous seul.
- Réglages de registre (revue de code du 2026-11-09) : une adresse avec identifiant écrite avec des échappements TOML (`\u0040`) n'est plus recopiée dans la sandbox.
- Succès annoncés à tort (revue de code du 2026-11-09) : `prism install`, `prism remove` et `prism config` disent quand `settings.json` n'a pas pu être enregistré et sortent en erreur ; `prism -p --mode json` sort en 1 sur une réponse en erreur ; une commande tuée par un signal ne sort plus en 0 ; un résumé de compaction vide est refusé ; `install.sh --check` n'installe plus rien quand la version installée ne répond pas ; la mise à jour des skills signale un paquet non mis à jour.
- Erreurs avalées (revue de code du 2026-11-09) : un sous-agent sans clé est rapporté tout de suite au lieu d'attendre le délai ; une tâche de fond dont le journal échoue se termine et le dit ; un fichier que `/undo` ne pourra pas restaurer est signalé à l'écriture ; l'éditeur externe, le partage gist et le renommage de session affichent leur échec ; une complétion qui échoue ne bloque plus les suivantes ; la sortie complète d'une commande qui n'a pas pu être enregistrée est dite « not saved » au lieu d'un chemin inexistant ; la connexion au bus système est abandonnée si le bus ferme ou se tait pendant la négociation.
- Noms venus de l'extérieur (revue de code du 2026-11-09) : un outil, un serveur MCP, un champ de formulaire, une variable, une commande ou un mot nommé `constructor`, `toString` ou `__proto__` ne fait plus planter la complétion, la traduction, l'environnement des commandes ou le rendu, et n'est plus perdu à l'enregistrement. Une règle de permissions de projet mal écrite garde la dernière version valide ; un registre d'outils MCP altéré est refusé au lieu d'être réécrit.
- Lignes malformées (revue de code du 2026-11-09) : une ligne RPC `null`, une trame `null` du relais remote-pi, une progression MCP sans texte ou une requête mal formée sur le retour OAuth n'arrêtent plus le moteur. La fenêtre refuse une ligne qu'elle ne sait pas lire au lieu de la transmettre (pièces jointes réservées).
- Texte accentué ou emoji coupé entre deux paquets (revue de code du 2026-11-09) : la sortie du shell (même avec des erreurs intercalées), des commandes des extensions, du navigateur et du journal plafonné garde ses caractères ; un emoji tapé avec le protocole clavier Kitty n'est plus inséré deux fois ; un Échap juste avant un collage n'est plus perdu ; grep montre les correspondances d'un fichier dont le nom n'est pas UTF-8 ; la validation Git du bac à sable distingue deux noms de fichiers non UTF-8.
- Contenu externe affiché au terminal (revue de code du 2026-11-09) : un nom de dossier, un id de modèle, un argument d'outil, une réponse du modèle, un nom de session, un diagnostic ou une image MCP ne peuvent plus envoyer de commande au terminal (presse-papiers par OSC 52, titre, effacement d'écran). Concerne le titre de la fenêtre, la notification de repli sans `notify-send`, le rapport des copies Git au démarrage, le compositeur, l'en-tête et le pied (Prism et interface d'origine), l'action en interface simple, les avertissements, `prism -p` vers un terminal (un tube ou un fichier reçoit toujours les octets exacts), le sélecteur de sessions, `/tree`, `/fork`, `/context`, le questionnaire du modèle, `/doctor`, `/state` et `prism config`. Une image dont les données ne sont pas en base64 s'affiche en texte. Un collage dans un champ d'une ligne perd ses caractères de contrôle.
- Champ d'une ligne : remplacer sa valeur ne coupe plus un caractère Unicode en deux ; un clic place le curseur sur le bon caractère quel que soit le préfixe du champ.
- Connexion en plusieurs étapes : annuler ou recoller dans l'étape suivante ne fait plus réapparaître une clé saisie à l'étape précédente.
- Notification d'autorisation groupée : le nombre d'autres demandes en attente est juste (il en manquait une).
- Chemins abrégés : `~` ne remplace plus le début d'un dossier voisin du dossier personnel (`/home/alice-backup` restait affiché `~-backup`).
- Catalogue des modèles : le rafraîchissement hebdomadaire échouait encore sur quatre tests qui citaient des modèles retirés par Fireworks ; ils sont maintenant sautés quand leur modèle a quitté le catalogue.
- Permissions, commandes shell (revue de code du 2026-11-09) : la porte lit les mots que bash exécute vraiment (guillemets, `\`, `--`, motifs comme `.[e]nv`, `$PWD`, `~`, `cd` et `env -C` suivis, lien suivi de `..`, documents en ligne, substitutions). Un fichier protégé nommé ainsi demande comme dangereux ; `printf -v`, `xargs` qui donne des options à `find`, `yq` et `time -o` demandent. Moins de questions : `grep "a|b"` n'est plus coupé au `|` ; `sed` et `awk` qui ne font que lire passent sans question ; `rm` dans le projet ou dans `/tmp` et une redirection vers `/tmp` sont une question ordinaire (le mode large les autorise), « dangereux » restant pour ce qui ne se rattrape pas (`sudo`, `push --force`, `curl | sh`, `rm -r` hors du projet, écriture hors du projet). Un outil d'extension nommé `toString` ou `constructor` n'est plus autorisé d'office, et ne fait plus planter la construction du prompt système.
- Mode sûr : la sandbox cache aux commandes les fichiers secrets du projet (`.env`, `.env.*`, clés `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `.netrc`, `authorized_keys`) ; une commande qui les lit reçoit « Permission denied », et le modèle une note qui dit que la sandbox les cache. Les autres modes ne changent pas.
- App Android, accueil en dalles (QA de fork.11) : rendu net à la résolution de l'écran (jusqu'à 3×, quatre échantillons par pixel quand l'appareil le permet) au lieu de 1× crénelé ; une image rapide s'affiche d'abord, puis l'image complète la remplace par bandes. La dispersion (franges rouge, vert, bleu) est six fois plus faible et les veines du sol plus discrètes ; reflets plus doux et facettes du dessus moins marquées. En thème sombre, l'accueil est environ 1,7 fois plus foncé (contraste des titres de 4 à 6). Seule une session au travail bouge (sa lumière respire). Changer seulement les titres ne retrace plus le verre.
- Votre bureau sous GNOME et KDE (QA de fork.11) : la fenêtre de Prism se réduit pendant que l'agent a votre bureau, pour qu'il ne la voie pas ; elle revient d'elle-même quand il le rend sous KDE (mesuré sous KWin sans écran), mais reste réduite sous GNOME, qui refuse à une app de se remettre au premier plan d'elle-même. Hyprland ne change pas (l'écran passe déjà sur un espace vide).
- Votre bureau sous KDE (QA de fork.11) : la boîte de KDE qui confirme le raccourci de reprise vient avant la prise de contrôle, plus après.
- App Android (QA de fork.11) : une conversation créée sur le PC apparaît sur l'accueil du téléphone en 3 s au plus (avant : jusqu'à 20 s) ; le téléphone ne relit la liste que si un fichier de session est apparu ou a disparu (commande `sessions_stamp`). Quand Prism repart sur le PC dans un autre dossier, le téléphone repart dans ce dossier au lieu de garder la conversation de l'ancien.
- App Android (QA de fork.11) : un téléphone que le PC a retiré revient à l'écran d'appairage avec la raison, au lieu d'un échec de communication ; il cesse de réessayer et oublie ce PC. Après « Oublier ce PC », une tentative de connexion déjà en cours pouvait encore reconnecter le téléphone (2 fois sur 6 dans le test).
- App Android (QA de la candidate fork.11) : Prism fermé sur le PC, chaque conversation ouverte sur le téléphone échouait à son tour (« Connection refused »). Elle attend maintenant le PC, sous la seule ligne « PC injoignable », et celle à l'écran repart quand il revient.
- App Android (QA de fork.11) : `/sent` et les autres inspecteurs tiennent sur un écran de téléphone : onglets sur une ligne qui défile, faits plus serrés, recherche sur une ligne. La requête s'affiche dans le panneau au lieu de rester sous le pli.
- Permissions (QA de fork.10.5) : une commande longue (un heredoc de 60 lignes) remplissait le terminal et poussait les choix de la question sous l'écran : Entrée, ou la molette qui déplace la sélection, répondait sans voir le choix, jusqu'à « Toujours bloquer ». La question ne montre plus que le début et la fin d'une commande de plus de 10 lignes ou 800 caractères (avant : 4000 caractères) et propose de la lire en entier avant de l'autoriser.
- Bureau : quand l'assistant du bureau refuse puis s'arrête (« l'utilisateur a refusé de partager son écran »), sa raison n'est plus remplacée par « The desktop helper stopped. » sur une machine chargée (mesuré : 4 fois sur 20 avant, 0 sur 20 après).
- Réglages (QA de fork.11) : un module qui ne peut pas marcher ici (bureau de l'agent sans `labwc`, « votre bureau » hors d'une session Wayland, donc sous X11) est marqué « indisponible » dès l'ouverture de `/settings`, même éteint ; avant, la mention n'apparaissait qu'à l'ouverture suivante, une fois le module allumé et chargé. Dans la fenêtre, la mention est en couleur, séparée du nom du module.
- Bureau de l'agent (QA de fork.11) : un programme lancé qui tourne ne renvoie plus au modèle que les 6 dernières lignes de ce qu'il a écrit au démarrage (600 caractères au plus) ; les dizaines d'avertissements sans conséquence remplissaient son contexte. Un programme qui s'arrête aussitôt garde toute sa sortie.
- Fenêtre sous KDE et GNOME (QA de fork.11) : l'entrée du menu des applications nomme la fenêtre (`StartupWMClass=prism-gui`, son identifiant Wayland), qui avait sinon une icône générique ; une entrée écrite avant est complétée au lancement de la fenêtre.
- Navigateur (QA de fork.11) : la question de site redemandait à chaque action sur le même site (« cette fois ») ; elle propose maintenant « ce site pour cette demande » et « tous les sites pour cette demande », valables jusqu'à ce que l'agent ait fini de répondre, en plus des choix pour la session.
- `/browser setup` (QA de fork.11) : ne liste que les navigateurs installés (programme présent, entrée de bureau ou Flatpak installé), plus ceux dont il ne reste que le dossier. Le navigateur s'ouvre simplement, avec des boutons pour copier l'adresse de la page des extensions et le chemin du dossier ; la page passée en argument n'ouvrait pas toujours la bonne (Zen). Pour un Flatpak qui vient de recevoir ses permissions, et pour Zen (réglage `about:config`), le redémarrage du navigateur est demandé en premier, avant d'ajouter l'extension, qu'un redémarrage retire ; l'ordre inverse laissait Zen sans le réglage.
- Mode plan (QA de fork.11) : activé puis désactivé avant tout message, il laissait au modèle un contrat « mode normal » qui parlait d'un mode plan jamais vu, et le modèle appelait `plan_mode_complete` en boucle. Il ne laisse plus rien.

### Removed
- Module `remote-pi` (décision du propriétaire, 2026-11-12) : le module, la commande `/remote-pi`, ses réglages, ses textes d'accueil et ses dépendances (trousseau natif, `ws`, `croner`, `qrcode-terminal`, `@noble/ed25519`) sont retirés ; l'app Android de Prism le remplace. Les anciens réglages qui le nomment (`+builtin:remote-pi`) sont ignorés sans erreur, et le dossier `remote/` existant n'est pas supprimé.
- Module « Pilotage de Chrome » (`pi-chrome-devtools`, `/chrome-devtools`), remplacé par le module Navigateur (décision du propriétaire, 2026-11-08). Un fichier `pi-chrome-devtools.json` existant n'est plus lu.
- Code expérimental jamais livré : protocole client-serveur (`pi-protocol`, `pi-server`, `pi-client`, `pi-durable`, `chord`) et commandes expérimentales, environ 93 000 lignes. Le contrat entre le moteur et les clients reste le mode RPC JSONL. L'installation ne télécharge plus esbuild.

## [1.0.0-fork.10.5] - 2026-11-08

### Added
- Fournisseur « Claude Code (claude -p) » : les modèles Claude avec l'abonnement de l'utilisateur, par son propre Claude Code non modifié. Prism lance `claude -p` sans ses outils et lui donne les outils de Prism (sandbox, permissions et affichage de Prism). `/login` › « Se connecter avec un compte » ; la connexion se fait dans Claude Code (`claude`), Prism ne lit pas ses identifiants. Les modèles proposés sont ceux du Claude Code installé. Avant la connexion, une phrase rappelle qu'Anthropic autorise l'abonnement dans Claude Code non modifié sans dire si une application peut le lancer, et que le risque pour le compte est à la charge de l'utilisateur.
- Fenêtre : « Choose a project folder » propose les dossiers récents (tirés des sessions enregistrées, le plus récent d'abord) ; un clic ouvre une session dans le dossier.
- Fenêtre : un bouton « Copy » à côté des chiffres de fin de tour copie la réponse finale du modèle.
- Fenêtre : la bascule Simple │ Avancée est toujours visible dans Réglages, sous le titre, comme dans le `/settings` du terminal ; elle n'est plus seulement un réglage du domaine Interface.
- `show_ui` : sa description donne un exemple de chaque bloc (tableau, liste, faits, graphique, choix, formulaire), repris dans l'erreur d'un document refusé.
- `/init` sans plan dans le projet propose « Pas encore de plan : l'écrire d'abord en mode plan » : le mode plan s'active et Prism dit d'exporter le plan (PLAN.md) puis de relancer `/init`, qui le propose.
- Fenêtre : les messages en attente pendant une réponse s'affichent au-dessus de la zone de saisie, chacun avec son moment d'envoi (« Prochaine étape » pour un guidage, « Après la réponse » pour une suite), et un bouton « Modifier » les remet dans la zone de saisie ; avant, une petite mention « En file » en bas.
- Terminal et fenêtre : la jauge de contexte ouvre `/context`, qui dit aussi comment la compaction automatique se déclenche et propose de compacter tout de suite ou d'ouvrir ses réglages (dans le terminal : touches `c` et `s` de l'onglet Stats) ; avant, la jauge ouvrait un petit menu séparé et `/context` ne proposait pas de compacter. « Réglages de la compaction » ouvre les Réglages sur Conversation, où sont les deux réglages de la compaction, plus sur leur premier domaine.
- Fenêtre : un champ « Rechercher un réglage » dans les réglages cherche dans les préférences de la fenêtre et dans tous les domaines du moteur à la fois, comme la recherche de `/settings` au terminal ; chaque résultat indique son domaine et se modifie sur place, et choisir une section ou vider le champ termine la recherche.
- Icône de bureau redessinée (`fork/gui/icon.svg`) : le prisme en volume du site, de face un triangle équilatéral, verre sombre, arêtes grises, faisceau blanc venant d'en haut à gauche et éventail spectral sombre, au lieu du favicon de 32 pixels agrandi ([aperçu à 512, 64 et 32 px](feedback/img/2026-11-07-icone-bureau.png)).
- Serveurs MCP configurables sans éditer de JSON : `/mcp` propose « Ajouter un serveur » (aussi `/mcp add`), qui demande comment le joindre (une commande ou une adresse), son nom, sa commande et ses variables d'environnement ou son adresse et sa clé, puis où l'utiliser ; Prism écrit le `mcp.json` et recharge pour le connecter. Chaque serveur d'un `mcp.json` a aussi « Supprimer ». Au terminal comme dans la fenêtre.
- Réglages en interface simple lisibles par un débutant : les modules portent un nom en mots (« Recherche web », « Mode plan », « Questions du modèle »…, leur nom technique reste dans la description et la recherche) ; passent en Avancé les réglages techniques : messages pendant et après le travail, double Échap, niveau de réflexion par modèle, modèles du cycle Ctrl+P, trace des opérations et sa durée, interrupteur de chaque serveur de langage (la page « Serveurs de langage » reste), et dans Permissions et sandbox les règles, la durée maximale du périmètre de tâche, les hôtes, les modes de la sandbox, les commandes `!`, la signature Git, les conteneurs, l'état des services, sudo, les commandes hors sandbox, les ressources des outils, les lectures en plus et les variables masquées ; « Déplacer les identifiants vers le trousseau » reste visible tant qu'il y a des identifiants en clair. Le mode Avancé les montre toujours.

- Vue des sous-agents, au terminal et dans la fenêtre : pendant qu'un agent travaille, sa ligne dit ce qu'il fait (« ✓ read src/a.ts », « … bash npm test ») ; une fois fini, elle compte ses étapes. Dépliée (ctrl+o, ou un clic dans la fenêtre), la carte montre la tâche, chaque outil appelé avec sa cible et son issue (✓, ✗), ce que l'agent dit entre deux appels, puis sa réponse. Les 200 dernières étapes sont gardées.

- Sous-agents : en plus des outils choisis pour eux (lecture, shell, écriture…), ils ont tous les outils de la session (tâches de fond, web, serveurs de langage, MCP, navigateur…), sauf ceux qui s'adressent à l'utilisateur ou pilotent la session (questions, interfaces générées, mode plan, objectifs, propositions à approuver, configuration de Prism, sudo) et `agent` lui-même. Une tâche de fond lancée par un sous-agent continue après sa réponse : il reste ouvert jusqu'à la fin de ses tâches, lit leur résultat, et son compte rendu arrive à l'agent principal comme message (« luna : tâche de fond terminée »). Si Prism se ferme avant, le sous-agent et la sortie de ses tâches s'arrêtent avec lui.

### Changed
- Sous-agents : un agent travaille maintenant comme une tâche de fond. L'outil `agent` rend la main tout de suite (« luna · en arrière-plan ») et le modèle principal continue ; la réponse de l'agent arrive ensuite comme message (« luna a répondu (ag1) »), qui relance le modèle après son tour en cours, sans s'insérer dans le texte qu'il écrit. Pendant ce temps, la barre d'état montre l'étape en cours de chaque agent (« luna : … bash npm test ») ; déplié, le message montre la tâche et chaque étape. Échap ne l'arrête pas, comme une tâche de fond ; pour l'arrêter : `/agents` › « ■ Arrêter luna (ag1) » (dans la fenêtre, un clic sur son statut ouvre `/agents`, bouton « Arrêter »). Arrêté, il ferme la question qu'il avait laissée ouverte, et un message « luna arrêté (ag1) » prévient le modèle sans le relancer. Sinon, il s'arrête avec la session. Sans interface (`-p`), l'outil attend la réponse comme avant.
- Sous-agents : un agent travaille dans le même `/tmp` que la session qui l'a lancé ; un fichier qu'il y écrit, l'agent principal le trouve (avant, chacun avait le sien et le poème de luna était introuvable).
- `/login`, au terminal et dans la fenêtre : l'avertissement sur l'abonnement Claude (Anthropic) est en gras et en rouge, celui de Claude Code (`claude -p`) en gras et en jaune. Dans la fenêtre, celui de Claude Code n'est plus affiché deux fois.

### Fixed
- `/agents`, au terminal et dans la fenêtre : on peut de nouveau changer le nom d'un agent existant (le champ était bloqué). Le nouveau nom est écrit comme à la création (« Lecteur Rapide » devient `lecteur-rapide`) et ne peut pas reprendre celui d'un autre agent ; au terminal, une réponse vide garde le nom actuel.
- Fournisseur Claude Code : la connexion refusait un compte connecté (« Claude Code n'est pas connecté ») avec Claude Code 2.1.319, qui ne donne plus la source du jeton quand on est connecté avec un abonnement. Prism reconnaît aussi le compte à son adresse ou à son abonnement.
- Fenêtre : un `show_ui` refusé n'affiche plus que la raison, plus le document renvoyé en entier (une centaine de lignes de JSON).
- Fenêtre : un deuxième `/login` juste après avoir fermé le premier ne faisait rien tant que le premier finissait (mise à jour des modèles) ; il s'ouvre maintenant.
- Fenêtre : une question du modèle avec de longs aperçus montre toujours ses options (l'aperçu défile au-dessus), et prend le clavier quand le champ de saisie est vide ; avant, les options étaient réduites à zéro et les touches partaient dans le champ de saisie.
- Fenêtre : « Stop » ferme la question du modèle restée ouverte ; avant, son panneau restait affiché alors que plus rien n'attendait la réponse.
- Fenêtre : une question posée par le modèle (`ask_user_question`) s'affiche en entier ; l'énoncé et les options passent à la ligne au lieu d'être coupés par « … ».

## [1.0.0-fork.10.2] - 2026-11-07

### Added
- Le catalogue des modèles se met de nouveau à jour depuis pi.dev pendant l'utilisation (au démarrage, dans `/model`, après `/login`, au plus toutes les 4 h, pour les fournisseurs connectés) : les nouveaux modèles, comme GPT 6.1 Terra pour l'abonnement ChatGPT, apparaissent sans mise à jour de Prism. `/settings` › Réseau & web › « Mettre à jour le catalogue des modèles » le coupe (réglage avancé). Un modèle reçu de pi.dev garde l'adresse du fournisseur fixée dans Prism.
- `/settings` › Modèles, page d'un modèle d'un serveur ajouté (`/login` › serveur compatible, ou écrit dans `models.json`) : « Retirer ce modèle de Prism » et « Retirer le serveur … et ses modèles » (avec sa clé enregistrée), au terminal et dans la fenêtre. Le dernier modèle retiré retire le serveur. « Mettre à jour la liste des modèles du serveur … » relit sa liste `/models` : les nouveaux modèles sont ajoutés, ceux qu'il ne sert plus sont retirés, les autres gardent leurs corrections.
- Avant la connexion « Anthropic (Claude Pro/Max) », au terminal et dans la fenêtre : un avertissement dit qu'Anthropic interdit l'abonnement Claude dans une application tierce et que le compte peut être suspendu ou banni sans préavis ; « Se connecter quand même » ou « Retour ». La voie autorisée est une clé d'API de la Claude Console.
- Sans WebKitGTK 4.1 (par exemple sur CachyOS), l'installation, `prism update` et l'échec d'ouverture de la fenêtre donnent la commande exacte pour la distribution (`sudo pacman -S --needed webkit2gtk-4.1`, `dnf`, `apt` ou `zypper`, d'après `/etc/os-release`) ; à l'installation dans un terminal, Prism propose de la lancer.

### Fixed
- Une commande ordinaire comme `cd <projet> && python3 x.py; rm -f x.py` était refusée comme une modification de la configuration (« Use configure_prism… ») : le dossier du `cd`, qui contient `.prism`, était pris pour la cible du `rm`. Seuls les arguments de la commande qui supprime, déplace ou copie comptent maintenant ; `rm -rf` du dossier du projet ou de son parent reste refusé.
- Fenêtre ouverte depuis le menu des applications : elle recevait le PATH du bureau (sous Hyprland, `/usr/local/bin:/usr/bin`), si bien que les serveurs de langage installés dans `~/.bun/bin`, `~/.cargo/bin`, `~/.local/bin` ou le dossier npm global étaient « introuvables » et que les commandes n'avaient pas les outils de l'utilisateur. Elle prend maintenant le PATH du shell de connexion de l'utilisateur, lu une fois au lancement (5 s au plus) ; si le shell échoue, les dossiers d'outils usuels qui existent sont ajoutés.
- Capture Chrome DevTools enregistrée sous `/tmp` (`savePath`, par exemple `/tmp/image.png`) : elle était jugée comme une écriture hors du projet et demandait une autorisation même en mode `broad`. Avec la sandbox, elle va maintenant dans le `/tmp` privé de la session, comme l'outil `write`, où les commandes la trouvent au même chemin.
- Fenêtre : le sélecteur de modèles montrait toujours tous les modèles, quoi que choisissent `/scoped-models` ou la liste cochée après `/login`. Il montre d'abord les modèles choisis, dans l'ordre de Ctrl+P, avec une ligne « Afficher tous les modèles », comme le terminal.
- `/agents` : un nom avec des majuscules, des espaces ou des accents était refusé sans dire le format attendu ; il est maintenant converti (« Relecteur de Code » devient `relecteur-de-code`). Le mot-clé peut rester vide quand son option est désactivée.
- Fenêtre : une longue ligne sans espace dans le raisonnement (une URL, du balisage) élargissait la conversation, qui défilait sur le côté dans une fenêtre en demi-écran ; elle passe maintenant à la ligne.
- Fenêtre : fermer la conversation affichée montrait un instant la bannière d'erreur « moteur arrêté ». Une conversation fermée exprès ne la montre plus ; un moteur qui s'arrête de lui-même la montre toujours.
- La sandbox ne crée plus de dossier `.pi` vide dans chaque projet, seulement `.prism` (un `.pi` existant reste en lecture seule) ; `/files` cache un dossier de configuration vide.
- Fenêtre ouverte depuis le menu des applications : elle travaille dans `~/Prism`, le même dossier à chaque lancement, au lieu d'un nouveau dossier dans `/tmp` à chaque fois ; ses conversations se reprennent.
- Sandbox : un processus laissé en marche par une commande bash (`sleep 400 &`) s'arrête avec elle, comme avant, mais le résultat de la commande le nomme maintenant, et le prompt de la sandbox le dit au modèle (avec le renvoi vers l'outil `background`).
- Catalogue des modèles : le rafraîchissement hebdomadaire échouait dès qu'un fournisseur retirait un modèle cité par un test ; ces tests sont maintenant sautés quand leur modèle a quitté le catalogue. Catalogue régénéré le 2026-11-07.

## [1.0.0-fork.10.1] - 2026-11-06

### Fixed
- Fenêtre ouverte depuis le menu des applications (ou par `prism --gui` dans le dossier personnel) : elle démarrait dans le dossier personnel, où la lecture limitée au projet bloquait toute commande (« Sandbox : en panne »). Elle s'ouvre maintenant dans un nouveau dossier de travail dans `/tmp`, comme la réponse par défaut du terminal ; « Choisir un dossier de projet » reste disponible.

## [1.0.0-fork.10] - 2026-11-06

### Added
- La scène optique et l'icône de la fenêtre viennent d'une copie versionnée des ressources du site (`fork/gui/site/`) : la construction ne dépend plus d'une copie locale du site.
- `/hotkeys` est retirée du terminal aussi, comme de la fenêtre : `/help` liste les raccourcis.
- Démarrage de la fenêtre sous Hyprland avec un GPU NVIDIA (QA-005) : la fenêtre pose elle-même `GDK_GL=always` dans ce seul cas, sauf si `GDK_GL` est déjà défini. `prism --gui` attend que la fenêtre ait dessiné ses premières images au lieu d'un délai fixe ; si elle s'arrête avant, il dit pourquoi et où lire son journal (`gui.log` dans le dossier de l'agent).
- Captures et pièces jointes (QA-003, LIV-06 à LIV-08). Au terminal, la touche de collage met une capture du presse-papiers dans le message sous la forme d'un repère `[Image #1]` et l'envoie au modèle comme une image, montrée sous le message ; elle n'insère plus le chemin d'un PNG temporaire que le modèle devait lire. Dans la fenêtre, Ctrl+V d'une capture l'ajoute comme pièce jointe avec sa miniature (le presse-papiers système est lu quand WebKitGTK ne transmet pas l'image), et le bouton « + » du composeur ouvre le sélecteur de fichiers du système, n'importe quel dossier : une image part comme image, un fichier texte (256 Ko au plus) avec son contenu, sans changer de projet ni ouvrir le dossier à l'agent ; un autre fichier (PDF, document, archive, texte plus long) est copié dans le `/tmp` privé de la conversation, où l'agent le lit et le modifie avec ses outils sans question d'autorisation, et le message donne le chemin de la copie ; les copies sont gardées avec la session et remises en place à la reprise. Un fichier déposé sur la fenêtre ou collé depuis le gestionnaire de fichiers est joint de la même façon ; au terminal, des fichiers copiés puis collés donnent une image comme image et un fichier hors du projet comme le chemin de sa copie. Le message envoyé montre ses images et le nom de ses fichiers. Avec un modèle sans images, un avertissement le dit dès l'ajout.
- Lancement hybride : `prism --gui` ouvre la fenêtre, `prism --tui` le terminal ; une simple commande `prism` suit `/settings` › Interface › « Ouvrir Prism dans », demandé une fois au premier lancement où la fenêtre peut s'ouvrir, choisir la fenêtre ajoute son entrée au menu des applications (retirable dans `/settings` › Interface). Sans affichage ou sans WebKitGTK, Prism dit pourquoi et reste au terminal. La fenêtre est dans l'archive de la release ; sans WebKitGTK 4.1 sur le système, l'installation et `prism update` nomment le paquet à ajouter.
- Avertissement d’injection de prompt : contrôle borné des résultats de tous les outils avant le prochain appel au modèle, pause avec choix d’arrêter (par défaut), continuer ou ne plus demander pour cette source pendant la session, au terminal et dans la fenêtre. Sans dialogue, avertissement sans blocage. Actif par défaut, réglable dans Permissions et sandbox ; contenu inchangé, réduction du risque sans garantie (D13).
- Fenêtre : les diagrammes Mermaid d'une réponse sont dessinés (mermaid 12.2.0, en image), selon le réglage Diagrammes Mermaid du moteur (off, final, streaming) ; redessinés au changement d'apparence. Tauri ne gèle plus `Object.prototype` (`freezePrototype`), ce que Mermaid exige.
- Fenêtre : `/scoped-models` natif : chaque modèle coché ou non, tous, aucun, ceux d'un fournisseur, l'ordre de Ctrl+P, Enregistrer ; chaque changement vaut tout de suite pour la session, comme au terminal. Aussi depuis `/settings` › Modèles.
- Fenêtre : les réglages du moteur dans la fenêtre Réglages (bouton en bas à gauche, Ctrl+, ou `/settings`), agrandie : la section Fenêtre, puis les domaines du moteur à gauche, les réglages du domaine choisi à droite ; on passe d'un domaine à l'autre depuis n'importe quelle page.
- Fenêtre : `/settings` natif, les domaines puis les réglages de chacun (listes, boutons, recherche), pages des réglages (seuil de compaction, modèle par défaut, budgets, règles et listes des permissions, sandbox, recherche web, avertissements, réflexion par modèle, réglages d'un modèle, déplacement vers le trousseau, coût des modules) ; mêmes réglages, regroupement, enregistrement et application que le terminal, rechargement après un changement de modules. Une ligne qui lance une commande ferme les réglages et la lance. Les réglages propres au terminal (domaine Terminal, animations, éditeur de thème, curseur, marges) n'y figurent pas.
- Fenêtre : `/share` natif, progression de l'envoi dans un panneau ; Arrêter ou fermer le panneau annule l'envoi, comme la touche d'annulation du terminal. Même envoi et même lien.
- `/export-zip` : « Change the destination » sur le récapitulatif, aux deux interfaces : un fichier ou un dossier (relatif au projet, `~` accepté, `.zip` ajouté) ; un dossier introuvable ou un fichier existant est refusé sur place.
- Fenêtre : `/trust` natif, options de confiance du projet en liste, choix enregistré marqué et sélectionné ; même enregistrement et même message que le terminal.
- Fenêtre : `/export-zip` natif, sessions puis fichiers en cases à cocher, récapitulatif des fichiers inclus, exclus et manquants et confirmation ; Retour garde les cases. Aucune session ou des sessions trop grosses s'affichent sur l'écran des sessions au lieu de terminer la commande. Mêmes liste, fichiers proposés et refusés, limite, contenu et écriture sans écrasement du moteur.
- Fenêtre : `/init` natif, choix du point de départ (plan trouvé, dépôt existant, plan à coller dans un champ multiligne), puis tableau des documents à créer ou adapter et confirmation ; Retour garde le plan saisi. Mêmes plan, relecture, message et instruction du moteur ; fermer sur la relecture n'écrit rien et le dit.
- Fenêtre : `/onboarding` natif, une étape par écran avec Retour, langue appliquée dès l'étape suivante, avertissement du mode Illimité et note du module tiers affichés avec le choix, modules en cases à cocher ; mêmes enregistrement, mode de permission (avertissement d'Illimité toujours à accepter), modules et rechargement du moteur. Fermer le panneau garde les étapes passées, comme Échap au terminal.
- Fenêtre : `/web-key` sans argument en écrans natifs, chaque fournisseur de recherche avec la clé en vigueur (variable d'environnement, clé enregistrée, aucune), clé saisie masquée ou URL SearXNG vérifiée sur place, retrait ; mêmes enregistrement, avertissement et rechargement du moteur. La clé enregistrée n'est jamais renvoyée à la fenêtre.
- Fenêtre : `/login` et `/logout` natifs : méthode de connexion (serveur compatible, compte, clé d'API), fournisseurs filtrables avec leur état, clé masquée, page de connexion ouverte et code d'appareil affiché, Retour qui annule la connexion, puis la liste des modèles du fournisseur à cocher ; mêmes connexions, enregistrements, choix du modèle et messages que le terminal.
- Fenêtre : `/llama` natif, liste des modèles du routeur, chargement (avec choix de garder ou décharger les modèles chargés), déchargement, recherche Hugging Face, choix de la quantification et progression avec barre et arrêt confirmé ; mêmes opérations et annulations du moteur. La recherche part à la validation de la requête au lieu de la frappe.
- Fenêtre : `/mcp` natif, liste des serveurs mise à jour en direct pendant les connexions, détail du serveur avec erreurs, outils, exposition, connexion OAuth avec URL de retour à coller, activation et désactivation ; mêmes opérations du gestionnaire, rien ne réapparaît après fermeture du panneau.
- Fenêtre : `/skills` natif, liste filtrable avec description, provenance et état, détail et actions du gestionnaire existant ; filtres conservés au retour, confirmation des sources et du retrait des paquets inchangée.
- Fenêtre : `/agents` natif, liste filtrable et formulaire complet (rôle, modèle, outils, instructions), politique d'appel, confirmations de suppression et désactivation. La création d'un agent refuse d'écraser un homonyme dans les deux interfaces.
- Fenêtre : `/lsp-setup` natif, filtre et interrupteurs des serveurs, catalogue du projet ou complet, préparation d'une commande d'installation sans l'exécuter ; mêmes refus du moteur, `sudo` reste au terminal.
- Fenêtre : `/checkpoints` et `/undo` natifs, liste filtrable, tous les chemins à restaurer/supprimer et confirmation. Restauration refusée pendant un tour actif ou après modification des snapshots depuis la relecture.
- Fenêtre : inspecteurs natifs `/sent`, `/trace`, `/state`, `/lsp` depuis les données du moteur ; sections JSON consultables en entier par pages, recherche, copie et export masqué de `/sent` sans écrasement. Le statut LSP ne lance aucun serveur.
- Fenêtre : menus Goal, Plan et Chrome DevTools en formulaires natifs, depuis les définitions du kit livré ; valeurs directes, cases, recherche et relecture avant application, mêmes actions et validations du moteur.
- Fenêtre : choix du dossier de projet depuis l'accueil ou le pied ; chaque conversation conserve son dossier au réveil.
- Fenêtre : documentation native avec recherche et liens internes ; recherche floue dans l'aide, filtre des raccourcis, icônes de fichiers et aperçu de code coloré.
- Fenêtre : nouvelle direction artistique : fond de lumière (prisme ou éclipse du site au démarrage, animés et légèrement flous à l'accueil, davantage flous dans la conversation), surfaces en verre, logo en prisme avec son ouverture, indicateur de travail lumineux sur le composer, transitions et mise au point de ce qui arrive, outils en lignes et questions en liste.
- Terminal : plusieurs styles par catégorie d'animation (logo, ligne d'attente, réflexion, outil, menus, titre) et préréglages globaux (Par défaut, Calme, Vif, désactivé), aperçu en direct dans `/settings`.
- Terminal : personnaliser un thème passe par neuf couleurs de base ; les autres suivent en gardant leurs écarts de luminosité ; la liste complète reste sous « Avancé ». Un enregistrement sous 4,5:1 de contraste est refusé en le disant.
- Terminal : `/budget` ouvre un menu (une ligne par limite, valeur attendue expliquée, tout désactiver, complétions) ; `/budget status` donne l'ancien résumé.
- Terminal : `/schedule` propose des fréquences (tous les jours, du lundi au vendredi, chaque lundi, chaque heure, ou expression libre).
- `/docs` : chaque résultat montre le nombre de correspondances et un extrait, le mot trouvé souligné, avant toute sélection.
- `/init` sans argument propose d'abord le plan trouvé dans le projet (racine, `docs/`, `plans/`).
- Réglage « Longest task scope » (`scopeMaxMinutes`) : durée maximale d'une portée de tâche.
- Le pied du terminal : la puce du mode ouvre `/perm window`, la nouvelle puce sandbox ouvre `/sandbox`.
- La sandbox s'active aussi en mode `unrestricted` (désactivée par défaut).
- Fenêtre : `/sandbox` (réglages modifiables, listes, état), `/changelog`, `/tutorial`, `/budget` (jauge, limites), `/schedule` (préréglages de fréquence, relecture) et `/sessions` (recherche, tous les dossiers, renommer, supprimer) en écrans de la fenêtre, depuis les données du moteur.
- Fenêtre : `/perm` (modes, ce qui est en vigueur, règles, portée de tâche, raccourcis), `/bg` (journal, arrêt, nettoyage, puce cliquable) et `/files` (explorateur avec aperçu, fichiers produits) en écrans de la fenêtre, depuis les opérations du moteur.
- Fenêtre : « plus… » n'ouvre qu'un menu à la fois ; épingler une commande met le pied à jour aussitôt ; « Back » et les choix de navigation des menus sont traduits.
- Fenêtre : `run.sh local` détecte le contexte et le raisonnement du modèle sur le serveur.
- Fenêtre : `/context` en onglets (répartition des tokens en barre et tableau, prompt système, outils, messages, recherche et copie).
- Fenêtre : `/model-settings` en tableau (propriété, serveur, valeur de Prism modifiable sur place, rétablir) ; les notifications ne recouvrent plus les panneaux ouverts.
- Fenêtre : `/tree` et `/doctor` en écrans de la fenêtre, depuis les données du moteur : arbre filtrable avec ses branches, détail d'une entrée, reprise, étiquette et copie ; diagnostic par état, détail de chaque vérification et export.
- Fenêtre : bilan de fin de tour (durée, outils, échecs, tokens, coût), le même que celui du terminal, formulé par le moteur depuis la session ; bascules Plan, Objectif et Fichiers à droite de la ligne de saisie, avec leur touche, comme dans l'éditeur du terminal.
- Fenêtre : /reload recharge le moteur dans la même session, comme le terminal (mêmes refus pendant une réponse ou une compaction), au lieu de relancer un moteur sur le fichier : une session bifurquée sans réponse, pas encore écrite sur disque, gardait son nom seulement en apparence.
- Fenêtre : « plus… », commandes épinglées et menu de la jauge de contexte du pied du terminal, dans la barre d'état ; mêmes menus, posés par le moteur, mêmes épingles (réglage `footerActions`).
- Tests : scénarios de la fenêtre sous GNOME Shell sans affichage (`fork/gui/scripts/drive-gnome.sh`), bus de session privé et dossiers jetables.
- Fenêtre : les vues des extensions du terminal (/perm, /bg, /doctor, /files, /docs, /sent, /mcp, /llama, aide des permissions…) s'ouvrent dans la fenêtre, rendues par le moteur avec les mêmes composants et pilotées au clavier et à la souris ; les fonctions réservées au terminal (configuration, /schedule, /export-zip, sudo, menu et réglages de /goal) acceptent la fenêtre, avec les mêmes vérifications.
- Fenêtre : les commandes intégrées du terminal qui ont leur commande RPC (/new, /name, /session, /compact, /export, /copy, /clone, /fork, /model, /thinking, /resume, /reload) passent par le moteur ; les touches du terminal (suivi, reprise de la file, cycle du modèle et de la réflexion, sorties d'outils, réflexion, copie, alt+g/alt+e/alt+j et raccourcis des extensions comme alt+m) viennent du moteur, keybindings.json compris ; Échap rend les messages en attente à la zone de saisie, comme dans le terminal. Un message envoyé avant que le précédent soit accepté reste dans la zone de saisie au lieu d'être perdu.
- Fenêtre : `!commande` et `!!commande` (hors contexte du modèle) passent par la commande `bash` du moteur, donc par les mêmes crochets `user_bash` que le terminal (sandbox des commandes utilisateur comprise) ; sortie en direct, code de sortie, Échap pour annuler, enregistrement après la réponse en cours.
- Fenêtre : /help, /changelog, /trust et /tree ouvrent les composants du terminal, rendus par le moteur (résumé de branche demandé par une question de la session, navigation par `navigateTree`) ; /expand, /hotkeys (touches du moteur, keybindings.json compris) et /quit ; historique ↑/↓ de la zone de saisie comme l'éditeur du terminal ; collage de fichiers (chemins) et d'images (fichier écrit par le moteur dans le dossier temporaire, comme dans le terminal) ; touche de l'arbre de session.
- Fenêtre : une seule langue pour la fenêtre et les textes du moteur ; « Comme le terminal » suit le réglage `language`.
- Fenêtre : le réglage `theme` du terminal choisit les couleurs de la fenêtre et de ses vues, thèmes de l'utilisateur compris.
- Fenêtre : recherche dans la conversation (Ctrl+Maj+F, Entrée et Maj+Entrée, Échap) et saut entre les messages de l'utilisateur (Ctrl+↑/↓), avec les touches et la règle de recherche du terminal.
- Fenêtre : déposer des fichiers sur la fenêtre insère leurs chemins dans le composeur, comme un collage de chemins dans le terminal.
- Fenêtre : double Échap sur un composeur vide ouvre `/tree` ou `/fork` selon `doubleEscapeAction`, et Échap abandonne une commande `!`, comme dans l'éditeur du terminal.
- Fenêtre : `/import` et `/share` comme dans le terminal (mêmes questions, même envoi, progression rendue par le moteur ; commandes RPC `import_session` et `share`).
- Fenêtre : `/resume` ouvre le sélecteur de sessions du terminal (recherche, tous les dossiers, tri, renommage, suppression), rendu par le moteur (commande RPC `show_sessions`).
- UI générée par le modèle : l'outil `show_ui` affiche un tableau, une liste, des faits, un graphique, des choix ou un formulaire, validés par le moteur ; la fenêtre les dessine (aperçu pendant l'écriture), le terminal en montre l'équivalent texte complet. Une réponse à un choix ou un formulaire part comme un message simple construit par le moteur : aucune commande, aucun privilège en plus.
- Fenêtre : complétion de l'éditeur du terminal sous la zone de saisie (commandes `/` et leurs alias, arguments, fichiers `@`, Tab, complétions des extensions) ; la liste vient du moteur (commandes RPC `complete` et `apply_completion`), construite par le même module que dans le terminal.
- Prototype de fenêtre graphique Linux (fork.10, branche `fork/fork10-gui`) : `fork/gui/`, client du moteur en mode RPC.
- Mode RPC : commande `list_sessions`, événement `extension_ui_dismissed` quand une question se ferme sans réponse (délai, interruption), champ `toolCallId` sur les questions d'autorisation.

### Changed
- Autorisations réseau (D14–D16, décisions du propriétaire du 2026-11-05) : un hôte autorisé dans la session par une commande reste lié à sa règle ; les outils réseau natifs gardent leur portée de session. Autoriser une commande dans le projet garde aussi ses hôtes probables avec la même règle, retirés avec elle. Le retrait d'un hôte du `settings.json` global ferme aussi ses connexions dans les autres sessions ouvertes, par la même surveillance que les permissions de projet.
- Connexion OpenAI par abonnement (Codex, navigateur) : Prism se présente sous son nom (`originator=prism`) au lieu de pi, comme le flux ChatGPT ; la page locale de retour était déjà celle de Prism.
- Fenêtre : les notices passent en bas à droite, au-dessus du panneau ouvert ou du composer, la plus récente en bas (décision E21 du 2026-11-05).
- Fenêtre : l'avertissement d'injection de prompt s'affiche comme un avertissement (titre et filet dans la couleur d'avertissement) dans la carte de l'appel d'outil.
- Sandbox, « Les commandes lisent l'état des services » : seuls des champs d'état passent (identité, états, PID, résultats, codes de sortie, horodatages) ; l'environnement, la ligne de commande et les identifiants des services ne sortent plus. `systemctl status`, `is-active`, `list-units` et `show -p` marchent toujours (décision du propriétaire, 2026-11-05).
- `/files` › ouvrir avec l'application du système : un lanceur `.desktop` reconnu à son contenu (sans extension) est refusé, et une page web (`.html`, `.svg`…, ou sans extension et reconnue à son contenu) n'est plus ouverte dans le navigateur, qui exécuterait ses scripts : Prism montre son code (revue L9, décision du propriétaire du 2026-11-05).
- Éditeur de thème : une couleur de base sous 4,5:1 de contraste est enregistrée avec un avertissement qui donne le rapport mesuré, au lieu d'être refusée (décision du propriétaire, 2026-11-05).
- `/docs` : une page ouverte depuis la recherche s'ouvre sur les mots cherchés, surlignés, au terminal et dans la fenêtre ; Échap revient à la liste.
- `/fork` finit par « Toute la conversation, telle qu'elle est », qui fait ce que faisait `/clone`, au terminal et dans la fenêtre. `/clone` quitte la liste `/` mais reste tapable.
- `/copy`, `/expand`, `/trace`, `/files`, `/sent` et `/clone` quittent la liste `/`, au terminal et dans la fenêtre ; tapés, ils marchent toujours.
- Mode Plan : `session_search` est autorisé, et `$?` (code de sortie de la commande précédente) dans une commande bash.
- `configure_prism` : le réglage `extensions` n'accepte que les modules intégrés de Prism ; paquets et fichiers s'ajoutent par l'utilisateur.
- sudo : option globale désactivée par défaut pour garder le mot de passe uniquement dans la mémoire de Prism pendant cinq minutes après sa saisie, sans prolongation à l'usage ; accord sudo pour la session, révocable dans `/perm`. Refus du mot de passe, désactivation, expiration, changement/fermeture de session ou `/reload` l'oublient ; une exécution sans question est signalée dans le résultat. Décision D11 du propriétaire, 2026-11-05, assouplissant D7/SEC-04 ; sudo garde son cache désactivé et le mot de passe ne passe jamais au modèle ni sur disque.
- `/mcp` en français, au terminal et dans la fenêtre : liste et état des serveurs, menus d'un serveur, outils, exposition, connexion OAuth, sous-commandes `login`, `logout`, `reconnect` et leurs messages. Noms de serveurs et d'outils, chemins, modes d'exposition et messages des serveurs restent tels quels ; la section envoyée au modèle reste en anglais.
- Statut de l'Objectif (`/goal`) en français dans le pied du terminal et la fenêtre (« actif 2m · automatique 3/25 », « en pause · limite automatique 25/25 », « terminé »…) ; un objectif terminé éteint le bouton Objectif dans les deux langues.
- Fenêtre : titre d'un plan (« Plan proposé », « Plan enregistré », « Plan en cours d'implémentation ») dans la langue de la fenêtre ; le message lu par le modèle garde son titre anglais.
- Questions posées par le modèle (`ask_user_question`) en français : raccourcis, relecture, « Écrire autre chose. », consignes des questions à choix multiples et titres des aperçus. La question, les choix et les réponses rendues au modèle restent tels quels.
- Chrome DevTools en français : menus, réglages du navigateur, choix des outils, notifications, confirmation WebMCP, états et description de `/chrome-devtools`. Les outils, leurs résultats et ce qui part au modèle restent en anglais ; le plug-in est désormais un fork (`vendor/forks/pi-chrome-devtools`).
- Statuts de pi-lsp (activité, `/lsp all`, configuration ignorée) et de l’état du relais remote-pi en français ; noms de serveurs, commandes et résultats d’outils inchangés.
- Erreurs du moteur affichées en français : modèle introuvable, nom de session vide, duplication sans entrée, échec du résumé automatique, aucun modèle pour le résumé.
- Fenêtre : chaque réglage du moteur affiché dans la fenêtre y agit. Thème : aperçu en direct, Automatique suit l'apparence de la fenêtre (descriptions réécrites, plus de « selon le terminal ») ; Cacher la réflexion ouvre ou replie aussitôt les réflexions ; hauteur de la liste de complétion. Les réglages sans effet dans la fenêtre (message de démarrage, avertissements et notes de version au démarrage, notes de cache, images en ligne, aspect Prism du terminal) n'y figurent plus ; le terminal les garde.
- Fenêtre : conversation, panneaux et composer plus larges (54rem au lieu de 46) ; quand la barre du composer manque de place, les raccourcis des pastilles disparaissent avant que le modèle et le niveau de réflexion soient tronqués.
- Liste des langues : « English » garde son nom en français, comme « Français » en anglais.
- Fenêtre : `/llama` n'est plus proposé (ni complétion ni liste ; tapé, il est refusé comme commande du terminal), décision du propriétaire. Le terminal le garde.
- Fenêtre : l'éclipse de l'accueil est redessinée en vectoriel comme le prisme (couronne, disque et point lumineux en calques, parallaxe) ; le shader du site ne sert plus que de repli. Le prisme perd sa particule de lumière et son reflet, sa face arrière forme un prisme régulier et le rayon blanc entrant est plus discret.
- Fenêtre : au plus 10 conversations ouvertes gardent leur moteur en mémoire ; au-delà, la moins récemment vue s'endort (son fil reste affiché), sauf si elle travaille.
- Fenêtre : un clic hors d'un menu ou d'un panneau ouvert par une commande le ferme ; les questions posées par l'agent ou une extension restent ouvertes.
- Fenêtre : le prisme de l'accueil est redessiné en vectoriel, net à la résolution de l'écran (verre, faisceau avec poussière, spectre en fondu, reflet sur l'arête, parallaxe par calques) ; il recule flou derrière la conversation. Variante claire en verre sur papier dans le thème clair. L'éclipse reste celle du site.
- Fenêtre : Inter et JetBrains Mono embarquées (OFL) ; cases à cocher, onglets segmentés et cartes de mode de `/perm` redessinés dans la DA.
- Fenêtre : toute l'interface reprise dans la DA de verre et de lumière : composer en une dalle avec ses contrôles, bouton d'envoi et Stop lisibles, modes en pastilles, barre latérale (nouvelle session, lignes, réglages), code et tableaux, question d'autorisation mise en avant, panneaux, champs et dialogues ; la barre latérale se replie et glisse en étroit, l'accueil s'efface sous un panneau.
- Fenêtre : surface des messages légèrement assombrie dans le thème Prism sombre ; parallaxe visible du prisme et de l'éclipse, vérifiée sur captures.
- Messages envoyés pendant le travail : tous lus au prochain tour par défaut (`steeringMode` : `all`).

- Fenêtre (fork.10) : modèle et niveau de réflexion en bas à gauche du composer, comme dans le terminal ; barre d'état organisée comme le pied du terminal (dossier et états à gauche, consommation et contexte à droite).

### Fixed
- sudo : sur Ubuntu 26.04, le `timeout` uutils laissait des descendants vivants après la limite ou l'annulation. Prism privilégie le `gnutimeout` GNU déjà installé sur cette distribution et vérifie son implémentation avant de transmettre le mot de passe ; un limiteur non GNU est refusé.
- Permissions : sans surveillance de fichiers disponible (EMFILE), un fichier de réglages remplacé avec la même date de modification est maintenant vu : un hôte retiré ferme aussi les connexions déjà ouvertes (RT-001).
- Fenêtre : Shift+Entrée dans le composeur ne fait plus passer la fin de la conversation sous le composeur agrandi (QA-006).
- Fenêtre : pendant l'écriture d'une réponse, remonter quitte la fin même à petits pas (pavé tactile, défilement doux) et la vue ne revient plus en haut toute seule ; redescendre en bas reprend le suivi (QA-007).
- Pilote de test de la fenêtre : un scénario dont une étape échoue, mal écrit ou sans étape `quit` sort avec le code 1 au lieu de 0 (VAL-001).
- Sandbox : un dossier `.git` sans `HEAD` au-dessus du projet (un squelette vide laissé dans le dossier personnel par un autre outil) restreignait les écritures de toutes les commandes ; Prism l'ignore comme Git, en le gardant en lecture seule.
- Permissions et réglages : attendre le verrou détenu par une autre session ne bloque plus la boucle de l'interface ; les sauvegardes et leurs erreurs sont attendues au terminal comme en RPC. Même correction pour les permissions de projet et l'initialisation du réseau de session, sans changer les fichiers, les délais de refus ni la récupération des verrous périmés (revue du 2026-11-01, L2).
- Sandbox : après une commande Git (un gros `git fetch`), les packs et objets ne sont plus lus en mémoire dans Prism mais copiés en flux et validés depuis des fichiers privés ; sur 100 Mio, l'interface reste fluide (blocage maximal 17 ms au lieu de 50) et la mémoire ne monte plus que de 32 Mio au lieu de 100.
- Fenêtre : dans les réglages en français, les lignes d'action (« ouvrir », « envoyer ») sont traduites comme au terminal.
- Fenêtre : remonter dans une longue réponse en cours d'écriture ne ramène plus la vue en bas à l'image suivante.
- Fenêtre : une conversation ouverte depuis l'historique s'affiche aussitôt (environ 60 ms au lieu de 2,5 s), lue par un moteur déjà lancé pendant que le sien démarre.
- Moteur : moins de mémoire au fil d'une conversation (100 tours de lecture : 214 Mo au lieu de 380) ; `/sent` et la copie remise aux modules ne recopient plus tout le texte de la conversation à chaque requête, et la reprise ne masque plus que les appels d'outil interrompus.
- Fenêtre : la jauge de contexte se met à jour après chaque réponse et chaque résultat d'outil, plus seulement à la fin du tour.
- Fenêtre : un clic à côté ferme « plus… » et le menu de la jauge de contexte.
- Fenêtre : en fenêtre étroite, les commandes épinglées qui ne tiennent pas dans la barre d'état restent dans « plus… », comme au terminal ; la jauge n'est plus poussée hors de la fenêtre.
- Fenêtre : ouvrir un menu sur une conversation vide ne fait plus remonter le texte d'accueil avant qu'il disparaisse.
- Fenêtre : le mode clair des réglages s'applique aussi quand le thème du terminal est fixé à un thème sombre (Prism) ; il ne repasse plus en sombre au chargement.
- Fenêtre : ouvrir une conversation de l'historique n'affiche plus « aucune session enregistrée » pendant le chargement ; une conversation fermée apparaît tout de suite dans l'historique.
- Fenêtre : la scène de l'accueil reste entière après un redimensionnement pendant son chargement (WebKitGTK continuait de dessiner à l'ancienne taille) et n'a plus d'image isolée, sombre ou claire, à la fin de son fondu quand on change de conversation.
- Fenêtre : la scène de l'accueil ne clignote plus, ne tremble plus et ne reste plus noire après un redimensionnement. WebKitGTK 2.54 affichait une image sur deux un tampon périmé du canevas WebGL ; le shader dessine maintenant hors de la page et chaque image est copiée dans un canevas 2D.
- Fenêtre : la scène de l'accueil dessine sur un contexte WebGL neuf à chaque affichage et rend le précédent une fois cachée. Après une perte du contexte, elle montre l'image fixe et repart une seconde plus tard sur un nouveau canevas ; à la troisième perte en une minute, elle garde l'image fixe au lieu de clignoter entre les deux.
- Fenêtre : « Parcourir » du choix de dossier ouvre le sélecteur de dossiers du système ; Entrée dans le champ liste toujours le chemin saisi.
- Fenêtre : la puce Permissions ne devenait plus cliquable une fois le statut des permissions traduit (sandbox décochée, changement de mode) ; ce statut, lu par le pied du terminal et par la fenêtre qui le formulent eux-mêmes, reste en anglais.
- `/perm` › En vigueur › portée de tâche : « Terminer la portée maintenant » termine la portée dans la fenêtre, au lieu de rouvrir le même résumé.
- Fenêtre : la recherche de `/docs` donne pour chaque page son nombre d'occurrences et sa première ligne correspondante, dans la ligne du résultat, au lieu d'un même extrait tronqué sous la liste.
- Fenêtre : la scène de l'accueil garde son image fixe tant que la première image animée n'est pas affichée, au lieu d'un fond noir au lancement et à la nouvelle conversation ; une perte du contexte WebGL montre l'image fixe au lieu du noir, puis l'animation reprend ; un redimensionnement sans changement de taille ne vide plus le canevas ; le thème n'est réappliqué que s'il change. Correctifs du clignotement et du noir signalés en QA non reproduits sur le poste de test.
- Interface en français : les textes du moteur du fork restés en anglais sont traduits (permissions, sandbox, copies Git conservées, tâches de fond, `/undo`, `/checkpoints`, `/lsp-setup`, `/docs`, `/notify`, descriptions des commandes et de leurs arguments, écrans natifs). Ce que reçoit le modèle reste en anglais.
- Fenêtre : l'état d'une session dont le dernier tour a été interrompu s'affiche en carte native au-dessus du composer, aussi à la réouverture depuis l'historique où il manquait, au lieu de lignes de terminal ; il disparaît au message suivant.
- Fenêtre : le lien de `/share` s'affiche en clair dans le toast, sans les séquences de lien du terminal.
- Fenêtre : plus aucune commande n'ouvre de vue du terminal. La portée de tâche (`/perm` › « Set a task scope… », et la proposition de l'agent) s'approuve sur un écran natif, avec les mêmes lignes, durée, présence et démarrage. « Start the tutorial » à la fin de `/onboarding` ouvre le tutoriel de la fenêtre. `/perm window|help|scope` suivis d'un mot, `/doctor` avec un argument autre que `export <chemin>` et `/state` avec un argument ouvrent leurs écrans de la fenêtre, comme le moteur lit ces arguments.
- Fenêtre : le thème choisi dans `/onboarding` s'applique à la fin de l'assistant, sans `/reload` ; l'aide de l'étape le dit, au lieu de promettre un aperçu que la fenêtre ne montre pas.
- Fenêtre : un clic envoyé pendant l'action précédente d'un panneau natif (case cochée puis « Continue » aussitôt) était ignoré sans signe ; il part maintenant après elle.
- Fenêtre : après une action dans un panneau natif (case cochée, réglage changé), le clavier reste sur le contrôle au lieu de retomber sur la page quand l'écran suivant arrive avant la fin de l'action.
- Fenêtre : les listes des menus natifs ouvrent sur l'élément courant (par exemple l'exposition actuelle) au lieu du premier, et gardent la sélection pendant une mise à jour de l'écran.
- `/skills` : après une installation depuis un chemin relatif, la vérification du contenu cherche dans le dossier installé, au lieu d'annoncer à tort un paquet sans skill ; correctif commun au terminal et à la fenêtre.
- `/state` : les arguments sensibles des appels interrompus sont masqués avant leur troncature, dans le terminal comme dans la fenêtre.
- Lanceur de QA GUI : `user` sélectionne le profil Prism (`~/.prism/agent` ou `PRISM_CODING_AGENT_DIR`) au lieu du profil pi des sources ; même choix avec `--terminal`. Les campagnes vérifient désormais le résolveur réel avec les deux identités et des profils isolés.
- Fenêtre : une complétion calculée sur un ancien texte ne corrompt plus la commande, et sa réponse tardive ne remplace pas un nouveau brouillon ; le lien Docs du tutoriel ne bloque plus sur la fin de sa propre commande.
- Fenêtre : les commandes d'une extension personnelle remplacent correctement leurs panneaux intégrés ; la puce Permissions accepte aussi l'ancien préfixe de statut ; Sandbox explique son indisponibilité avec un contrôle Permissions remplacé.
- Fenêtre : Espace ferme un panneau hors champs et boutons (raccourci configurable) ; le lecteur de changelog affiche les notes Prism également depuis les sources.
- Fenêtre : le début d'une réponse ne s'affiche plus deux fois pendant l'écriture, et la vue ne saute plus à la fin d'une réponse ; la ligne de fin de tour reste visible.
- Fenêtre : les listes et la barre d'état ne sont plus reconstruites quand rien n'a changé (survol et clic en cours conservés).
- Interrompre pendant un outil n'affiche plus « modèle inaccessible » et ne relance plus de requête.
- Fermer le moteur pendant un tour ou une question ne produit plus d'`extension_error` ; le tour est abandonné, la question annulée, l'attente bornée.
- Deux envois coup sur coup : le second est refusé ou mis en file, plus jamais annoncé puis perdu.
- Sans `fs.watch` (limite inotify), le retrait d'une autorisation de projet est vu par relecture périodique du fichier.
- `ctx.reload()` d'une commande en RPC ne double plus les enveloppes de complétion.
- Mode Plan : `cd` est permis, le reste de la ligne reste contrôlé.
- Un clic à côté d'une question d'autorisation ne la ferme plus.
- `/sessions` demande sa recherche, liste les résultats dans un menu qui se ferme et ouvre la session ; plus de widget collé en bas.
- Liste des commandes : plus de `[t]` sur les modules inclus, ordre par usage.
- `propose_scope` : quand l'utiliser, refus en mode sûr et pour les commandes dangereuses avant toute question.
- `/help` garde la même hauteur quand on se déplace ou qu'on filtre.
- Réglages : descriptions traduites de tous les modules ; connexion rangée dans Modèles.

- Fenêtre : un panneau fermé disparaît aussitôt, sans fondu (170 ms mesurées avant, 15 ms après).
- Fenêtre : le texte du composeur reste dans sa conversation et ne suit plus dans les nouvelles sessions ; l'accueil ne déborde plus quand le composeur grandit.
- Mode plan : activer et désactiver le mode en boucle n'ajoute plus de message au contexte ; son contrat n'est ajouté qu'à l'envoi d'un message.
- Fenêtre (fork.10) : une conversation mise en veille garde ce qui a été autorisé « dans cette session » (actions dangereuses, hôtes) et le retrouve au réveil ; rien n'est écrit sur le disque.
- Sécurité (A1) : sans sandbox, le mode `safe` n'exécute que des commandes simples ; substitutions, expansions évaluées et redirections vers un fichier sont refusées, le classifieur seul pouvant s'y tromper.
- Sécurité (M7) : une commande trop longue pour sa question doit être affichée en entier avant de pouvoir être autorisée.
- Une règle d'autorisation couvre de nouveau les commandes qui contiennent `printf` sans `-v` ou `command -v`.
- Sécurité (revue du 2026-11-01, C1) : une recherche `grep` depuis `/` lisait les clés SSH et les autres
  identifiants sans question ; elle pose maintenant la question des actions dangereuses, comme `grep -r . /`.
- Sécurité (M2) : les outils natifs protègent les mêmes dossiers d'identifiants que la sandbox (`~/.aws`,
  `~/.kube`, `~/.config/gh`, `~/.docker`, profils de navigateurs, trousseaux, chemins masqués de l'utilisateur).
- Sécurité (H3, M3) : un `permissions.json` ou `project-permissions.json` invalide ne fait plus perdre les règles
  de refus : la dernière version valide s'applique, sinon tout appel d'outil est refusé avec la cause, et un
  enregistrement ne réécrit jamais un fichier invalide. Les écritures se font sous verrou et par remplacement.
- Sécurité (H4) : une commande de la sandbox qui change un remote Git (URL, nouveau remote, refspec de push)
  ou l'identité des commits ne publie plus ce changement en silence dans le vrai `.git/config` : Prism montre
  chaque valeur avant et après, avec le risque hors de Prism, et ne l'applique qu'avec votre accord.
- Sécurité (C2) : les serveurs de langage (`lsp_diagnostics`, `lsp_fix`) tournent dans la sandbox de la session,
  avec le projet comme dossier ; sans sandbox, Prism pose une question « potentiellement dangereuse » avant de les
  lancer, et le mode `safe` les refuse. Un serveur exécute du code du projet (`build.rs`, macros).
- Sécurité (H2) : une règle « toujours autoriser », une commande exclue de la sandbox ou une variable confiée à
  certaines commandes ne couvrent plus une commande qui cache du code (`<(…)`, `${x@P}`, arithmétique, `eval`…) :
  elle pose la question. Effet visible : une commande avec `${VAR}` (accolades) n'est plus couverte par une règle ;
  `$VAR` l'est toujours.
- Sécurité (H1) : en mode `safe`, la sandbox monte le projet en lecture seule. Une commande que le classifieur
  laisserait passer ne peut plus écrire dans le projet. Le `/tmp` privé et les caches de paquets restent
  inscriptibles. Le classifieur reconnaît aussi `>& fichier`, `sort --out=…` et `cat <(touch …)`.
- Une commande exclue de la sandbox tourne vraiment hors d'elle quand `shellCommandPrefix` est réglé (M1).
- Questions de permission : la commande est montrée en entier (jusqu'à 4 000 caractères, puis début et fin) ; la
  question nomme la partie qu'aucune règle ne couvre ; `git push origin +main`, `--mirror`, `:main` et une commande
  dangereuse cachée dans `awk`, `sed`, `eval`, `<(…)` ou `git -c…` posent la question « dangereuse » (M4 à M7).
- Fenêtre : ouvrir beaucoup de conversations ne fige plus la machine. « Nouvelle conversation » réutilise la
  conversation vide, les conversations inactives se mettent en veille (moteur arrêté, transcription gardée,
  réveil à l'ouverture ; les autorisations « dans cette session » prennent fin), et sous forte pression
  mémoire aucun nouveau moteur ne démarre (message).

- Terminal : en français, la bascule Plan restait éteinte quand le mode plan était actif (le module écrit son statut traduit, « plan actif », comparé à l’anglais) ; la règle est partagée avec la fenêtre.
- Mode RPC : une interruption (`abort`) pendant une question d'autorisation la ferme et refuse l'action, au lieu de rester sans réponse jusqu'au délai de 3 minutes.
- Fenêtre (fork.10) : Entrée dans un composer vide n'interrompt plus le tour en cours (une Entrée réflexe pendant une question d'autorisation annulait le tour et affichait « Model request failed ») ; arrêter reste le bouton Arrêter ou Échap.
- Fenêtre (fork.10) : une nouvelle conversation s'affiche aussitôt (accueil et composer) pendant le démarrage de son moteur, signalé discrètement sous le composer, au lieu d'un écran vide et d'une bannière.
- Fenêtre (fork.10) : l'éclipse de l'accueil ne glisse plus vers le haut et ne se fige plus à l'envoi du premier message (elle défilait avec la conversation et s'arrêtait au début du fondu) ; la barre d'état tient sur une ligne, sa hauteur ne redimensionne plus la scène.
- Fenêtre (fork.10) : la lumière de l'éclipse suit de nouveau le pointeur, comme sur le site (elle ne recevait aucun mouvement).
- Fenêtre (fork.10) : la fenêtre se redessine dès le premier message d'une conversation (titre, accueil), au lieu d'attendre le changement d'état suivant.
- Fenêtre (fork.10) : une conversation fermée ne publie plus les messages de l'arrêt de son moteur sur la conversation affichée ; les messages d'une conversation en arrière-plan portent son titre.
- Fenêtre (fork.10) : avec un profil jetable (`run.sh demo`, `local`, `empty`), le stockage de la page (apparence, langue, animations) est rangé dans ce profil et non plus dans `~/.local/share/space.odelserver.prism.gui`, commun à tous les profils et à la fenêtre de l'utilisateur ; un scénario interrompu ne transmet plus ses réglages au suivant.
- Fenêtre (fork.10) : les vues des extensions (Files, /context, /doctor…) ne changent plus de taille en boucle (leur hauteur venait de l'espace qu'elles réduisaient elles-mêmes) ; une commande relancée par sa bascule ou sa touche ferme son panneau au lieu d'en ouvrir un second, une autre commande remplace la première.
- Fenêtre (fork.10) : les menus et questions des extensions (Goal, Plan, « plus… »…) s'affichent dans un panneau au-dessus du composer et ne laissent plus de traces « Answered: … » dans la conversation ; un menu à plusieurs écrans reste un seul panneau. La décision d'une question d'autorisation devient l'état de l'appel d'outil.
- Fenêtre (fork.10) : l'éclipse de l'accueil ne rétrécit plus quand le composer grandit (liste `/`, long collage) ; la liste `/` montre toutes les commandes et défile.
- Fenêtre (fork.10) : /help, /session, /hotkeys et le choix de /fork sont des panneaux de la fenêtre (liste filtrable, faits, tableau) au lieu de la vue du terminal ou de messages dans la conversation.
- Fenêtre (fork.10) : modèle et niveau de réflexion se choisissent par des boutons qui ouvrent un panneau filtrable (fournisseur, contexte, réflexion, images ; élément en cours coché), au lieu de menus natifs ; le niveau de réflexion est visible et traduit.
- Fenêtre (fork.10) : le pied est lisible et cliquable comme au terminal : permissions (couleur du risque) → /perm, sandbox → /sandbox, init → /init ; plus de ligne permanente « Enter to send… » sous le composer.
- Fenêtre (fork.10) : les cartes d'outils montrent le diff d'une modification, le contenu d'une écriture et le contenu lu (replié) ; l'en-tête les déplie, Ctrl+O toutes à la fois.
- Fenêtre (fork.10) : une conversation se renomme en cliquant sur son titre (ou /name seul) ; une conversation rouverte s'affiche sous son nom avec « Ouverture de la conversation… », plus comme une nouvelle conversation.
- Fenêtre (fork.10) : les messages des commandes (/export, /reload, /share…) sont des notifications, plus des lignes du transcript ; un chemin ou un lien reste jusqu'à sa fermeture.
- Fenêtre (fork.10) : en français, pied, réflexion, noms de touches, nombres et coûts traduits ; les bilans de tour et descriptions du moteur arrivent dans la langue choisie dès l'ouverture et après un changement de langue ; plus de ligne vide sélectionnable sous l'accueil.
- Sécurité : minimatch passe de 10.2.6 à 11.0.3, qui corrige l'avis GHSA-g3hv-75wg-m249 (déni de service par des motifs glob amplifiés, modéré). L'audit npm de l'arbre livré est de nouveau vert.
- `show_ui` : un modèle local (Qwen sur llama.cpp) envoyait des graphiques sans étiquettes ni séries, refusés à chaque essai. La grammaire du serveur garde l'ordre des propriétés du schéma, où l'unité venait après les étiquettes ; elle vient maintenant avant. Mesuré : 6 graphiques incomplets sur 7 avant, aucun sur 10 après.
- `/changelog` de la fenêtre lancée par `run.sh` : notes de Prism de nouveau affichées (vide depuis que le moteur y tourne sous le nom prism).
- Sandbox Git : les objets libres créés par une commande passent par le fsck complet de Git avant d'être publiés, comme les packs (alias de `.git` sur NTFS/HFS+, contenu de `.gitmodules`, ordre des arbres).
- Terminal : une image affichée dans la conversation ne passe plus par-dessus une fenêtre ouverte (`/context`, menus) ; elle est masquée tant que la fenêtre la recouvre, puis revient.
- `/context` dans un terminal étroit : les chiffres par catégorie passent au-dessus de la grille au lieu de déborder et de couper le cadre ; une ligne trop longue est coupée avant la bordure. Le plugin `pi-context-inspector` est désormais livré comme fork (`vendor/forks/`).
- Fenêtre : la section Réglages › Apparence se décrit par ce qu'elle contient dans la fenêtre (réflexion, diagrammes, suggestions), plus par les couleurs et marges du terminal.

### Removed
- Écran natif `/llama` de la fenêtre, inatteignable depuis que la fenêtre ne propose plus `/llama` (décision du propriétaire, 2026-11-05).
- `/notify` retirée du terminal et de la fenêtre, décision du propriétaire : les notifications de bureau, d'approbation et le test sont dans `/settings` › Notifications.
- `/hotkeys` retirée de la fenêtre et de la complétion, décision du propriétaire ; la commande tapée reste dans le terminal tant que le code d'origine est gelé (intégration de fork.9).
- Fenêtre : le thème du terminal n'y a plus d'effet. Le réglage Apparence › Thème, sa page et l'étape Thème de `/onboarding` sont retirés de la fenêtre ; elle montre le thème Prism clair ou sombre choisi dans Fenêtre › Thème. Le terminal garde son réglage.

## [1.0.0-fork.9.1] - 2026-10-29

Correctif de maintenance de fork.9 : mise à jour de sécurité d'undici.

### Fixed

- Sécurité : undici passe de 8.10.2 à 8.12.3, qui corrige les avis de
  sécurité GHSA-4qv8-2p9j-2685, f72v-6w45-q472, xjj6-f33q-929c, 4w7w-5xrc-9h26,
  2m5v-pch6-74hx, qrxm-fqhp-jwvm, 9fm3-97px-rjf6 et 55wc-3pg8-jfw6. undici sert
  notamment `web_fetch` vers des serveurs non maîtrisés.

## [1.0.0-fork.9] - 2026-10-29

Harness terminal complet : sandbox avec lecture limitée et Git isolé, autorisations
réseau par hôte, garde npm, planification de tâches, export portable,
agents, MCP traité comme contenu externe, fichiers produits lisibles sans shell,
et les corrections de la QA de fork.8 et de la candidate.

### Added

- npm : avant une installation directe avec npm, pnpm, yarn ou bun, un
  paquet absent du registre, au nom proche d'un paquet populaire, créé il y a
  moins de 30 jours ou téléchargé moins de 1 000 fois par semaine fait poser
  une question (une fois, même en mode large) ; sans interface, l'installation
  est refusée. Un registre privé est interrogé à la place du public, jamais en
  plus.
- MCP : chaque résultat d'un outil ou d'une ressource MCP commence par une
  ligne qui nomme le serveur et le présente comme des données, pas des
  instructions (traduite pour l'utilisateur) ; un outil MCP dont la
  description, les paramètres ou les indications changent depuis sa première
  vue, même d'une session à l'autre, est annoncé et redemandé avant son appel
  suivant, même en mode large et malgré une règle d'autorisation.
- Export portable : `/export-zip` écrit une archive ZIP des sessions et des
  fichiers choisis un à un (aucun fichier coché par défaut), avec
  `manifest.json`, un guide `IMPORT.md` pour un modèle d'un autre outil, les
  messages en JSON et en Markdown. Les secrets connus de Prism sont masqués ;
  les fichiers d'identifiants (`.env`, clés, `auth.json`…), les fichiers hors
  du projet, les liens symboliques et ceux de plus de 10 Mo sont exclus et
  listés ; un fichier disparu est marqué manquant. Un chemin avec `..`, un
  dossier intermédiaire qui est un lien et un fichier remplacé entre la
  vérification et la lecture sont refusés ; l'archive n'écrase jamais un
  fichier existant ni la cible d'un lien. La confirmation rappelle
  que le reste n'est pas analysé.
- Tâches planifiées : `/schedule` crée, met en pause, reprend et supprime des
  tâches lancées par un timer systemd utilisateur, sans démon. La création
  montre tout ce que la tâche pourra faire et les unités écrites, et attend
  une confirmation ; le modèle peut proposer une tâche, qui passe par le même
  écran. Sans utilisateur, seule la portée choisie passe (fichiers du projet,
  commandes non dangereuses en sandbox, hôtes réseau nommés), le reste est
  refusé et consigné, règles d'autorisation et réglages réseau globaux
  compris ; sandbox, mode `ask` et budgets imposés ; un passage manqué est
  signalé, pas rattrapé, par défaut. Refusé depuis un Prism modifiable par un
  agent (sources, dépôt Git). La réponse du modèle reste hors du journal
  système ; un échec ou un refus envoie une notification, et le démarrage
  suivant résume les passages. Aucun `enable-linger`.
- Outil `sudo`, désactivé par défaut (`/settings` › Permissions et sandbox
  › « Commandes en root (sudo) ») : une commande sans shell, en root hors de
  la sandbox, après la saisie du mot de passe dans un champ masqué qui
  montre la commande exacte, à chaque appel et dans tous les modes. Refusé
  en mode `safe` et sans utilisateur. Le mot de passe passe par un
  assistant `SUDO_ASKPASS` d'un seul usage, jamais par le modèle ni la
  session ; aucun accord ne sert à l'appel suivant. À la limite de temps ou
  à l'annulation, la commande et son groupe de processus sont arrêtés
  (SIGTERM puis SIGKILL), et le message dit ce qui peut encore tourner.
- Migration des identifiants en clair vers le trousseau : `/settings` ›
  Permissions et sandbox › « Déplacer les identifiants vers le trousseau »
  liste les clés et jetons encore en clair dans `auth.json` et ne les
  déplace qu'après une double confirmation. Chacun est enregistré dans le
  trousseau puis relu avant qu'`auth.json` n'en garde qu'un marqueur ; un
  échec le laisse en clair, avec la raison, et rouvrir la page reprend le
  reste. Les références (`!commande`, `$VAR`) restent.
- Trousseau pour les nouvelles connexions (Secret Service, par
  `secret-tool`) : la clé ou les jetons d'une nouvelle connexion vont au
  trousseau, `auth.json` ne garde qu'un marqueur. Les clés déjà en clair
  restent dans `auth.json` jusqu'à l'assistant de migration (étape
  suivante). Sans trousseau du tout, l'identifiant est enregistré en clair
  avec un avertissement. Un trousseau présent mais verrouillé, lent ou qui
  refuse n'enregistre rien : `auth.json` reste tel quel et le message dit de
  déverrouiller puis de réessayer. Un identifiant déjà au trousseau ne passe
  jamais en clair. `/doctor` indique où sont les identifiants.
- Rappel de handoff, désactivé par défaut (`/settings` › Conversation) :
  dans un projet avec `project/handoff.md`, tous les 100 appels d'outils
  (50, 200 ou 500 au choix), Prism rappelle au modèle de proposer la mise à
  jour du handoff dans sa réponse finale. Le modèle n'est pas interrompu,
  `/handoff` n'est pas lancé, et un seul rappel par exécution.
- `/skills` (aussi `/settings` › Conversation › Skills) : liste les skills
  trouvés avec leur provenance (global ou projet, dossier ou paquet) et leur
  état ; active ou désactive un skill, installe un paquet de skills (npm,
  git, URL ou dossier local), met à jour les paquets de skills et en retire
  un. Avant d'installer ou de mettre à jour un paquet, il montre la source,
  sa portée (ce projet ou tous les projets) et prévient qu'un paquet peut
  exécuter du code ; rien ne se fait sans confirmation. Repose sur le
  mécanisme de pi (`prism install`, `prism config`) ; les changements
  s'appliquent à la fermeture.
- Sandbox : Git par SSH (`git push`, `fetch`, `clone` vers `git@hôte:…` ou
  `ssh://…`) vers les hôtes que vous autorisez (`ssh://github.com` dans les
  hôtes autorisés, ou en réponse à la question). Prism lance `ssh` hors de
  la sandbox avec votre agent SSH, pour les seules commandes de Git ; la
  clé doit être dans l'agent ou sans phrase de passe, et la clé de l'hôte
  déjà connue. Un `ssh` lancé directement reste sans réseau.
- Sandbox : signature des commits et des tags (`git commit -S`,
  `commit.gpgSign`, `git tag -s`), OpenPGP ou SSH, avec le réglage « Git
  signs with my key » de `/settings` › Permissions & sandbox, désactivé par
  défaut. Prism signe hors de la sandbox avec la clé et le programme de
  votre configuration Git ; la clé n'y entre jamais, et rien d'autre qu'un
  commit ou un tag n'est signé.
- Sandbox : `docker ps`, `docker images`, `podman ps` et `podman images`
  voient vos conteneurs, avec le réglage « Commands see my containers » de
  `/settings` › Permissions & sandbox, désactivé par défaut. Lecture seule :
  créer, arrêter, supprimer, `inspect` et `logs` sont refusés, et les listes
  ne montrent ni l'environnement, ni les étiquettes, ni la commande des
  conteneurs.
- Sandbox : `systemctl status`, `is-active`, `show` et `list-units` lisent
  l'état des services du système, avec le réglage « Commands read the state
  of services » de `/settings` › Permissions & sandbox, désactivé par
  défaut. Démarrer, arrêter ou modifier un service, et tout autre service du
  bus système (logind…), sont refusés avec la raison.
- Sandbox : une écriture refusée dit au modèle si le chemin est hors des
  dossiers modifiables (et quel réglage en ajoute un) ou protégé (hooks et
  configuration Git, réglages de Prism du projet), et les notes sur les
  conteneurs et D-Bus nomment le réglage qui les ouvre.
- Sandbox, activé par défaut : `sandbox.read.limit` (`"project"`, sauf
  `"all"` écrit dans `settings.json` ; une autre valeur garde la limite)
  limite ce que les commandes lisent dans le dossier personnel au projet,
  aux ressources des outils (Git, Rust, npm, Python, nvm…) et aux dossiers
  de `sandbox.read.allow` ; le reste du dossier personnel, les autres
  comptes et les supports montés ne sont pas montrés, et `~/.cache` est
  propre à chaque projet. Les outils `read`, `grep`,
  `find` et `ls` demandent avant de lire hors de cet ensemble (ce fichier ou
  son dossier, pour la session ou le projet) et refusent sans interface ;
  un accord vaut aussi pour les commandes. Réglages dans `/settings` ›
  Permissions & sandbox : « Ce que l'agent lit », « Ressources des
  outils », « Aussi lisible ». Les outils de fichiers ne lisent pas les
  sorties complètes ni le `/tmp` des autres sessions. Ouvert dans le
  dossier personnel, Prism demande où travailler : un nouveau dossier de
  `/tmp` (par défaut), tout le dossier personnel jusqu'à sa sortie, ou rien.
  Les commandes voient `~/.npmrc`, `pip.conf`, `uv.toml` et le
  `config.toml` de Cargo reconstruits avec les seuls champs autorisés
  (registre, index, préfixe…), sans jetons ni identifiants.
  MCP, LSP et Chrome ne sont pas limités ; un appel MCP qui passe un chemin
  hors de cet ensemble demande comme les outils de fichiers (une aide, pas
  une protection : le serveur lit ce qu'il veut).
  Avec la limite active, l'écran du périmètre de tâche, `/perm scope` et
  `/settings` disent que la lecture reste limitée au projet, au lieu de
  « ne limite pas la lecture ». Au premier lancement où elle s'applique, une
  ligne le dit, avec où l'élargir.
- Transitions : les panneaux (`/settings`, `/files`, `/perm`, `/doctor`,
  `/docs`, tâches de fond…) et les menus affichés à la place de la saisie
  (Goal, Plan…) s'ouvrent depuis leur milieu et se replient avant de
  disparaître ; d'un écran à l'autre d'un même menu, pas de transition. Le
  clavier revient à la saisie dès la fermeture. Les
  détails d'un outil et un bloc de réflexion se déplient et se replient au
  clic. Chaque transition suit son interrupteur existant (« Ouverture des
  menus », « Outil en cours », « Libellé de réflexion ») ; coupée, elle
  n'arme aucun minuteur. ctrl+o et ctrl+t restent instantanés.
- Questions de permission : une action dangereuse peut être autorisée
  « dans cette session », pour cet appel exact, jamais enregistré (une
  session reprise redemande ; pas proposé pour les chemins protégés et les
  identifiants) ; `/perm` la liste et la retire. Une question ordinaire
  propose aussi « Bloquer … dans ce projet », gardé comme « Autoriser … dans
  ce projet » et retiré depuis `/settings` › Autorisé ou bloqué dans ce
  projet.

- Fichiers produits et documents lisibles sans shell : `/files` (ou
  `alt+e`) a un onglet « Produits » qui liste les fichiers écrits ou
  modifiés pendant la session, les sorties complètes de commandes longues
  et, dans un dépôt Git, les fichiers créés par une commande, avec leur
  état (absent, modifié depuis). Pour chacun : lire dans Prism (texte,
  Markdown, CSV en colonnes, images, texte des PDF, `.docx` et `.odt`),
  ajouter au message, copier le chemin, ouvrir avec l'application du
  système (refusé pour les programmes et scripts), copier dans un dossier.
  Le modèle qui lit un PDF, un `.docx` ou un `.odt` reçoit son texte
  extrait. L'extraction utilise `pdftotext` (paquet `poppler-utils`) et
  `pandoc` s'ils sont installés, toujours isolés par bubblewrap : ni
  réseau, ni environnement, ni autre fichier que `/usr` et le document.
  Sinon Prism dit quoi installer ou autoriser.
- Interface en français presque partout : sélecteurs de modèle, de niveau de
  réflexion, de thème, de connexion, de sessions et l'arbre de session,
  sous-menus, notifications des modules intégrés et avertissements de
  démarrage (`fd`, `tmux`), `/hotkeys`, `/scoped-models`, `/doctor`. Les
  noms de commandes, les valeurs enregistrées et ce qui part au modèle
  restent en anglais.
- Interface en français aussi pour les textes courants restés en anglais :
  confirmations Oui/Non, budget de coût, aides « pour déplier » des
  sorties d'outils, indicateurs de résumé et de nouvelle tentative,
  `/session`, confiance du projet, notices de cache, messages de
  connexion, nouveautés. Restent en anglais : `/share`, `prism config`,
  l'assistant de premier lancement d'upstream et quelques écrans rares.

- Le modèle peut changer sa configuration par un outil dédié,
  `configure_prism` (module `config-tool`, coupé par défaut) : réglages
  courants, modules et agents personnalisés. Chaque changement montre
  l'ancienne et la nouvelle valeur et ses risques, demande votre accord une
  fois et expire en refus au bout de 2 minutes ; refusé en mode prudent, en
  Plan, en `-p` et en RPC.
- Configurer les modèles de `consult` sans éditer de fichier :
  `/settings` > Modules > Configurer les modèles ajoute un de vos modèles
  sous un nom court (`/ask <nom> …`), change son modèle, le renomme ou le
  retire, et règle le budget d'une consultation. Les alias restent dans
  `consult-models.json`, les budgets dans `settings.json` ; ce qui a été
  écrit à la main est conservé.
- Animations réglables une à une : `/settings` > Apparence > Animations
  liste le logo de démarrage, la ligne de travail, le reflet de « Réflexion… »,
  le point d'un outil en cours, l'ouverture des menus et le titre du
  terminal, chacun avec son interrupteur et un aperçu animé, sous
  l'interrupteur global. Le changement s'applique en moins d'une seconde
  (le logo, au prochain démarrage). Réglage `animationsOff`.
- Personnaliser le thème : `/settings` > Apparence > Personnaliser le thème
  modifie une copie du thème utilisé, couleur par couleur, avec l'aperçu sur
  toute l'interface pendant la saisie. Entrée enregistre la copie en JSON
  dans le dossier `themes/` de l'agent et en fait le thème utilisé (un
  réglage automatique clair/sombre garde l'autre côté) ; un thème déjà dans
  ce dossier est modifié sur place.
- Protection contre le DNS rebinding : un nom qui pointait vers une adresse
  publique et pointe ensuite vers la machine ou le réseau local est refusé,
  dans la sandbox comme dans `web_fetch`. Un nom local dès le départ (serveur
  auto-hébergé) reste joignable.
- Périmètre de tâche : avant une longue tâche, l'agent propose ce dont il a
  besoin, en mots simples (« Installer les dépendances : lance npm install,
  se connecte à registry.npmjs.org »), avec une durée ; vous retirez des
  lignes, dites si vous restez là ou vous absentez, et approuvez. Pendant la
  tâche, ce qu'il couvre passe sans question ; le reste est demandé, ou
  refusé tout de suite si vous êtes absent, avec la liste des refus à la fin.
  Aussi depuis `/perm scope`. L'écran dit ce qu'un périmètre ne limite pas
  (la lecture hors du projet).
- `/settings` › Modules, `/help` et l'appel d'une commande disent pourquoi une
  fonctionnalité manque : module désactivé, dépendance absente (pi-lsp sans
  serveur de langue pour le projet, « indisponible ») ou modèle qui ne sait
  pas s'en servir (« pas avec ce modèle »). Une commande d'un module
  désactivé le dit, au lieu d'être envoyée au modèle comme un message.
- Canaux stable et canary : `prism update --channel canary` passe aux
  versions expérimentales (`1.0.0-fork.N.canary.M`), `--channel stable` en
  revient, `--rollback` remet aussi le canal. Une installation stable refuse
  toute canary, même mal listée ; une canary le dit à chaque démarrage.
- Sandbox des commandes (bubblewrap), active par défaut en mode `broad`
  (`sandbox.modes` dans `settings.json` pour `ask`, `safe` ou pour la
  couper). Les commandes de l'agent et les tâches de fond n'écrivent que
  dans le projet, `/tmp` et les caches des gestionnaires de paquets ; les
  identifiants (`~/.ssh`, dossier de Prism…), le bus D-Bus et le réseau
  leur sont fermés ; `.git/hooks`, `.git/config` et la config Prism du
  projet restent en lecture seule. Un filtre seccomp y refuse les sockets
  Unix (rouvertes par `sandbox.allowSystemBus`), la création d'espaces de
  noms, `ptrace`, `mount`, `bpf`, `io_uring` et les autres appels système
  qui ouvrent une sortie. Une sandbox qui ne fonctionne pas
  (bubblewrap absent ou refusé, filtre non appliqué) arrête Prism au lieu de laisser passer les
  commandes. Le réseau passe par un proxy de Prism, par nom d'hôte : à la
  première connexion vers un hôte, une question (une fois, la session,
  enregistrer dans `sandbox.network.allow`, bloquer), désactivable par
  `sandbox.network.askNewHosts` ; `sandbox.network.deny` bloque toujours.
  Les programmes qui ignorent `HTTP_PROXY` n'ont pas de réseau.
  `/sandbox` montre l'état, les chemins en écriture et masqués et les hôtes ;
  le pied de page affiche « sandbox » quand elle est active. Le modèle
  connaît les chemins masqués, et une commande qui échoue sur l'un d'eux ou
  sur D-Bus se termine par une ligne qui le dit. `sandbox.userCommands`
  met aussi les commandes `!` dans la sandbox ; `sandbox.excludedCommands`
  lance hors sandbox les commandes simples qui commencent par une entrée
  (`docker`, `docker compose`…), avec la question du garde même en
  `broad`, sauf règle d'autorisation de l'utilisateur.
- `/model-settings` règle un budget de réflexion par modèle (tokens, à tous
  les niveaux). Pour un serveur llama.cpp, Prism ajoute le champ que le
  serveur lit (`thinking_budget_tokens`) ; pour un autre serveur compatible,
  un avis dit quel réglage ajouter dans `models.json`.

### Changed

- `web_fetch` et `web_search` suivent les autorisations réseau de la sandbox.
  En mode `broad`, `web_fetch` reste appelé sans question, mais chaque
  destination nouvelle fait l'objet d'une question ciblée, et rien n'est
  envoyé avant la réponse : ni à la page, ni à Exa. Les redirections sont
  vérifiées une à une, un hôte bloqué l'est toujours, et un port de cette
  machine demande sa propre autorisation. `web_search` refuse un fournisseur
  dont l'hôte est bloqué.
- Une commande de la sandbox qui change `core.hooksPath` (installation de
  Husky) n'est plus refusée d'office : Prism demande, avec le dossier
  effectif, les hooks qu'il contient, les scripts qu'ils lancent et le risque
  d'exécution hors sandbox. Refus ou absence de réponse : rien de la commande
  n'est publié. Ensuite, le dossier des scripts de Husky (`.husky`) est en
  lecture seule dans la sandbox. `core.hooksPath=.` reste refusé.
- Sandbox : `localhost` est la boucle locale de la sandbox, partagée par
  les commandes et tâches de fond de la session. Un serveur lancé en tâche
  de fond (`npm run dev`) répond à `curl localhost:5173` d'une commande
  suivante, et un relais ne lui prend plus son port. Les ports de la
  machine se joignent par `host.prism.internal:<port>` (règles
  `localhost:<port>` inchangées) ; un port accordé pendant une commande y
  est servi aussitôt, un port retiré se ferme. Chaque commande ne joint
  que son propre relais. Le proxy refuse le `localhost` de la sandbox
  (`localhost`, `127.0.0.1`, `::1` et leurs autres écritures) avec un
  diagnostic, au lieu de mener à la machine ; seul l'alias y mène. Sans
  `nsenter`, ou si le système refuse l'espace réseau de la session, Prism
  le signale au démarrage, dans la langue de l'interface.

- ctrl+o et ctrl+t déplient et replient aussi en douceur les résultats
  d'outils et les blocs de réflexion visibles à l'écran, comme un clic
  (interrupteurs « Outil en cours » et « Libellé de réflexion » des
  animations). Les blocs au-dessus de l'écran changent d'un coup.
- `session-search` est désactivé par défaut (`/settings` › Modules, ou
  `+builtin:session-search`). L'outil `session_search` cherche dans vos
  autres sessions, plus dans celle en cours, et demande votre accord (cette
  fois, pour la session, ou non) avant d'envoyer leurs extraits à un modèle
  qui n'est pas sur votre machine ou votre réseau local ; sans interface, il
  ne les envoie pas. Le réglage avertit du risque de confidentialité.
- Tâches de fond : la fin d'une tâche (terminée, en échec ou arrêtée) est
  transmise d'elle-même au modèle, avec son état, la fin de sa sortie (2 000
  octets au plus) et le chemin de son log ; il n'a plus à l'interroger en
  boucle. Un modèle qui travaille la reçoit après son travail en cours, sans
  être interrompu ; un modèle qui attend la reçoit dans un nouveau tour.
  Rien n'est transmis pour une tâche que le modèle a arrêtée lui-même, ni
  après la fermeture de la session. Le transcript en montre l'essentiel dans
  la langue de l'interface (tâche, état, log), le rapport complet avec ctrl+o.
- Tâches de fond : durée maximale facultative (`timeout`, en secondes) pour
  `background` `run`. Sans elle, rien ne change : une tâche peut tourner des
  heures. Passé ce délai, la tâche reçoit SIGTERM puis SIGKILL après le délai
  de grâce habituel, prend l'état `timed_out` (« délai dépassé »), distinct
  de `failed` et `stopped`, et sa fin est transmise au modèle comme les
  autres, après publication Git et fermeture du log.
- `/init` et `/handoff` : la consigne que Prism rédige (et les faits Git
  qu'il mesure pour `/handoff`) n'est plus envoyée comme si vous l'aviez
  écrite. Elle part en section temporaire du prompt système
  (`<command_instruction>`), pour le seul tour que lance la commande ; la
  requête suivante la retire. Votre message reste ce que vous avez tapé
  (`/handoff votre note`, `/init votre plan`). Ni les fichiers du projet, ni
  la mémoire, ni le handoff ne vont dans le prompt système.
- `/agents` dit quand le modèle peut lancer un agent : de lui-même (par
  défaut), quand votre message en demande un, quand il contient un mot-clé
  (`@agent` par défaut, modifiable), ou les deux derniers. Prism vérifie le
  mot-clé seul et refuse alors l'appel sans lui ; une demande formulée
  librement reste une règle que le modèle suit. Les permissions s'appliquent
  dans tous les cas. `/agents` › « Désactiver les agents » coupe le module,
  comme `/settings` › Modules.
- Thèmes Prism : titres, code inline et liens prennent chacun une teinte pâle
  (au moins 13:1 en sombre, 7:1 en clair), aussi dans `/export` ; gris du
  thème sombre éclaircis (encre 3 à 7,4:1) ; pastilles ○ et rails à 3:1 au
  moins ; la ligne choisie de `/files` reçoit la barre ▌ de `/settings`.
- Markdown : le gras garde sa graisse et prend la teinte du nouveau jeton de
  thème facultatif `mdBold` (lavande des titres dans `prism` et
  `prism-light`), dans les messages de l'utilisateur et du modèle, la
  réflexion et `/export`. Un thème sans ce jeton garde le gras dans la
  couleur du texte.
- Prompt système : la section sur la documentation de Prism passe de 1 394
  à 675 caractères (environ 350 à 170 tokens, estimation). Elle dit quand
  la lire (seulement si l'utilisateur pose une question sur Prism) et où
  (dossier des docs, à lister ; README ; exemples), sans index des sujets.
- Sandbox : `write` et `edit` vers `/tmp/…` écrivent dans le `/tmp` privé de
  la session, celui que voient ses commandes ; sans question en mode large,
  avec la question ordinaire en mode demander, comme dans le projet. Le
  modèle et la question montrent `/tmp/…`, et la règle proposée est
  `/tmp/**`. `read`, `grep`, `find` et `ls` y lisent un fichier qui s'y
  trouve, sinon dans le vrai `/tmp`. Une écriture à travers un lien qui sort
  du `/tmp` privé est refusée. Sans la sandbox, rien ne change.
- Sandbox : Git travaille dans une copie privée des métadonnées du dépôt
  (`.git` sans ses objets, lus en lecture seule). Après la commande, Prism
  vérifie ce qu'elle a changé (références, index, configuration ordinaire,
  objets et packs) et le reporte dans le vrai dépôt d'un bloc ; commits,
  branches, tags, stash, rebase et fetch marchent comme hors sandbox. Un
  changement refusé (hook, configuration exécutable…) ou une branche
  déplacée entre-temps par un Git de l'hôte laisse le vrai dépôt intact : la
  sortie de la commande dit pourquoi et où l'état de la commande est gardé.
  Les worktrees liés en profitent aussi (`git worktree add`, commits
  dedans, `git worktree remove` ; si Git s'arrête avant les fichiers du
  worktree, comme Git 2.43, la sortie le dit et donne la commande `rm -r`),
  ainsi que les sous-modules (une copie par
  dossier Git de sous-module ; `git submodule add` et `submodule update
  --init` publiés après vérification du nouveau dossier Git, sans hook) et
  les dépôts imbriqués dans le projet ou dans un dossier
  inscriptible. Après chaque commande, Prism signale tout dépôt apparu ou
  remplacé hors de cette protection dont les hooks ou la configuration
  exécuteraient un programme, sans le modifier ; un dépôt dont le `.git`
  pointe vers un dossier que la sandbox ne montre pas est signalé sans que
  Prism y lise quoi que ce soit. `/sandbox` et les notes
  au modèle nomment les dépôts en copie privée. Une tâche de fond publie
  ses changements Git à sa fin, refus notés dans son journal. Une copie
  qu'un arrêt ou un crash laisse non vérifiée (y compris celle d'une tâche
  qui survit à Prism) est signalée une fois au démarrage suivant, sans le
  bloquer, et listée dans `/sandbox` avec sa provenance, son état, les refs
  qui diffèrent du dépôt et une commande pour la lire ; Prism ne la publie,
  ne la supprime ni ne la reprend jamais. La commande de lecture d'une copie
  gardée utilise la configuration du dépôt réel, pas celle écrite dans la
  sandbox (dont le pager se serait exécuté hors de la sandbox), et
  n'ouvre aucun pager (`git --no-pager`). Pour
  l'instant : les très gros dépôts gardent l'ancienne protection. Un
  réglage `core.hooksPath` écrit dans la sandbox (première installation de
  Husky) n'est pas reporté, sans contournement automatique ; la sortie
  avertit que le régler hors de Prism (`npx husky`) exécute hors sandbox du
  code installé ou modifié dans le projet, à vérifier avant ; une fois la
  clé réglée, ces hooks tournent dans la sandbox.
  Une URL distante locale doit être un chemin absolu.

- Sandbox : avec un Node compilé sans instantané de démarrage (celui de
  Fedora), le relais réseau démarre depuis un instantané que Prism
  construit une fois par binaire Node : ≈ 50 ms de moins par commande
  (161 → 112 ms pour une commande courte). Sans effet avec les Node
  officiels, qui en ont déjà un. Repli automatique sur le démarrage
  habituel ; `PRISM_SANDBOX_RELAY_SNAPSHOT=0` le coupe.

- Sandbox : la maintenance automatique de Git (`git maintenance run --auto`
  après un commit ou un `fetch`, `git gc --auto`) ne tourne plus dans la
  sandbox, où elle laissait des verrous derrière elle. Réglé par
  l'environnement des commandes seulement (`maintenance.auto=false`,
  `gc.auto=0`), jamais dans vos fichiers de configuration. `git gc`,
  `git repack` et `git maintenance run` demandés explicitement ne
  toucheraient que la copie privée : rien n'en est reporté dans le dépôt, et
  la sortie de la commande dit de les lancer hors de Prism.

- Sandbox : un service de cette machine s'autorise port par port
  (`localhost:5432` dans les hôtes autorisés, ou en réponse à la question),
  quelle que soit l'adresse qui la désigne (`127.0.0.1`, `::1`,
  `localhost`, une adresse de ses interfaces). Les autres ports restent
  fermés ; `localhost` ou `127.0.0.1` seuls n'ouvrent plus tous les ports,
  et les questions désactivées n'en ouvrent aucun. Les programmes qui
  ignorent le proxy (`psql`, `redis-cli`…) joignent aussi les ports
  accordés ; un port accordé pendant une commande, à partir de la
  suivante. Les ports sous 1024 ne sont joignables que par le proxy.

- Le modèle ne peut plus écrire dans les fichiers de configuration de
  Prism avec `write`, `edit` ou `bash`, même si vous l'acceptiez : il passe
  par `configure_prism`. Les réglages de sécurité (permissions, confiance,
  identifiants, sandbox, secrets) ne sont modifiables que par vous, dans
  tous les modes, `unrestricted` compris.
- La question réseau de la sandbox nomme la commande qui veut se
  connecter. « Autoriser pour cette commande » remplace « Autoriser une
  fois » : toutes les connexions de cette commande vers l'hôte passent,
  jusqu'à sa fin, sans que la commande suivante en profite. Une réponse
  vaut pour la commande qui l'a demandée, plus pour une autre qui vise le
  même hôte en même temps ; un hôte bloqué ou laissé sans réponse ne
  redemande pas pendant la même commande. Un hôte retiré des hôtes
  autorisés, ou ajouté aux hôtes bloqués, coupe aussi ses connexions déjà
  ouvertes.
- La question de permission d'une commande qui télécharge (`npm install`,
  `pip install`, `cargo build`, `go mod download`, `git clone https://…`)
  indique les hôtes qu'elle contactera probablement ; l'autoriser les
  couvre pour cette exécution, sans seconde question. Ce n'est qu'une
  suggestion : un registre privé ou un autre hôte reste demandé à part.
- La question de permission d'une commande dit en clair ce qu'elle
  autorise (« Autoriser « lancer npm install » dans cette session ») et
  propose « dans ce projet » à la place d'enregistrer la règle dans
  `permissions.json`. La question réseau propose aussi « dans ce projet »
  à la place d'enregistrer l'hôte dans `settings.json`. Ce qui est donné
  pour un projet revient dans chaque session sur ce dossier (chemin réel
  de la racine Git ; chaque worktree est un projet à part), est gardé dans
  le dossier de Prism (`project-permissions.json`), jamais dans le dépôt,
  et se retire dans `/settings` › Permissions › Autorisé dans ce projet.
  Les hôtes autorisés pour la session apparaissent dans la fenêtre des
  permissions (`/perm window`) et s'y retirent ; retirer un hôte coupe ses
  connexions ouvertes.
- Un hôte autorisé « dans ce projet » ne vaut que pour la commande qui
  l'a demandé (« Autoriser registry.npmjs.org pour « lancer npm install »
  dans ce projet ») : un autre programme du projet, comme `curl`, est
  redemandé. Si l'enregistrement échoue, la question revient avec l'erreur
  au lieu de devenir une autorisation de session. Deux sessions de Prism qui
  enregistrent en même temps gardent chacune leur autorisation, et un hôte
  retiré dans l'une coupe aussi ses connexions dans les autres.
  `npm run build` propose « lancer npm run build », plus tous les scripts.
- Un blocage voulu dit maintenant au modèle ce qui est bloqué, que c'est
  voulu et comment l'utilisateur le lève, pour qu'il ne réessaie pas en
  vain ni ne cherche une autre cause : conteneurs et nouveaux espaces de
  noms (Podman, Docker, `unshare`), sockets Unix, SSH, `ping` et DNS hors
  du proxy, `localhost` de la sandbox (qui n'est pas celui de la machine),
  hôtes refusés par le proxy pendant la commande (bloqués par
  l'utilisateur, sans réponse ou dans les hôtes bloqués), question de
  permission sans réponse (l'utilisateur est peut-être absent : continuer
  sans, puis dire ce qui reste), refus de l'utilisateur, sandbox en panne.
- La règle proposée par une question de permission vise la partie de la
  commande qui la demande : `cd x && npm test` propose `bash(npm test*)`,
  plus `bash(cd*)`. Une sandbox en panne refuse la commande sans poser
  d'abord une question de permission inutile.
- Les noms des variables retirées ne sont plus listés dans le prompt
  système : une commande qui en utilise une (`$NOM`, un programme qui la
  lit seul comme `gh` pour `GITHUB_TOKEN`, ou une sortie qui la nomme)
  reçoit une ligne qui la nomme, jamais sa valeur.
- Les commandes de l'agent (`bash`, tâches de fond, dans la sandbox ou
  non) ne reçoivent plus les variables d'environnement sensibles : noms en
  `*_TOKEN`, `*_API_KEY`, `*_SECRET*`, `*PASSWORD*`, agents d'identification
  (`SSH_AUTH_SOCK`…) et toute variable qui contient une clé d'`auth.json`.
  Une règle de l'utilisateur en passe une à une commande précise
  (`/settings` › Permissions & sandbox › Variables hidden from commands,
  ou `"secrets": { "passEnv": { "GITHUB_TOKEN": ["bash(gh *)"] } }`). Le
  modèle ne voit jamais les valeurs ; les secrets connus
  sont masqués dans tous les résultats d'outils. Les commandes `!` gardent
  l'environnement de l'utilisateur.
- La sandbox est active par défaut en `ask` et `safe` aussi (avant :
  `broad` seulement). Une sandbox qui ne fonctionne pas n'arrête plus
  Prism : le chat et les réglages restent accessibles, les commandes shell
  restent bloquées (jamais lancées hors sandbox), le pied de page affiche
  « sandbox not working » et `/settings` › Permissions & sandbox propose
  « Check the sandbox again » une fois le problème réglé. Passer à un mode
  dont la sandbox est en panne n'est plus refusé. En `-p`, le diagnostic va
  sur stderr.
- `/settings` suit la maquette validée : nouveaux domaines Models (modèle
  par défaut, niveau de réflexion, réflexion par modèle, modèles du cycle
  Ctrl+P), Network & web (avec la recherche web, qui quitte Modules) et
  Notifications (qui remplace Warnings & notices). Le domaine Tools
  disparaît ; Other finit par des raccourcis vers les commandes d'action
  (`/login`, `/onboarding`, `/trust`, `/budget`, `/llama`, `/lsp-setup`,
  `/remote-pi`).
- Chaque modèle a sa page dans `/settings` › Models (valeurs du serveur à
  côté de celles de Prism, modification sur place, « Retirer mes
  modifications ») ; la recherche trouve le réglage de chaque modèle
  (« max output » liste les modèles) ; `/model-settings` ouvre la page du
  modèle actuel.
- Domaine Permissions & sandbox de `/settings` : mode de la session et mode
  par défaut, règles (ajout avec effet et portée globale ou projet, retrait
  par une deuxième Entrée), chemins protégés, et tous les réglages de la
  sandbox (modes, hôtes autorisés et bloqués, question pour un nouvel hôte,
  commandes `!`, commandes lancées hors sandbox, D-Bus système, chemins
  inscriptibles et masqués). Un réglage de sandbox modifié s'applique tout
  de suite à la session. `/perm` ouvre ce domaine, `/perm window` la
  fenêtre des modes et des permissions en vigueur, `/sandbox` la ligne
  Sandbox.
- `/settings` › Conversation règle les budgets par défaut (durée, appels
  d'outils, tokens, coût) d'une nouvelle session ; `/budget` ne change que
  ceux de la session en cours. Le budget de coût ne s'applique qu'avec un
  modèle dont le prix est connu.
- `/settings` › Notifications règle les notifications du bureau et celles
  des approbations, gardées d'une session à l'autre, et envoie une
  notification de test. `/notify` sans argument ouvre ce domaine ;
  `/notify on|off` ne vaut que pour la session.
- `/settings` › Servers active ou coupe chaque serveur MCP et règle son
  exposition (mode avancé), comme `/mcp`, et ouvre `/lsp` et `/mcp`.
- `/settings` › Servers active ou coupe chaque serveur de langage. Un
  serveur coupé n'est plus lancé par `lsp_diagnostics` ni `lsp_fix`, et
  `/lsp` le montre coupé. Les serveurs non installés n'apparaissent qu'en
  mode avancé.
- Un dossier pas encore approuvé ne fournit plus rien avant votre accord :
  ni réglages, ni extensions, ni instructions (`AGENTS.md`, `CLAUDE.md`),
  ni documents de continuité. Un dossier qui n'a qu'un `AGENTS.md` pose
  donc la question une fois. Sans interface (`-p`), il reste non approuvé
  et un avertissement le dit.
- Un modèle dont la réflexion passe par le modèle de chat (`thinkingFormat`
  `chat-template`, comme Qwen sous llama.cpp) garde sa réflexion des tours
  précédents : Prism envoie toujours `preserve_thinking: true`. Une valeur
  écrite dans `models.json` reste prioritaire.

### Fixed

- `/export-zip` : les sessions choisies sont plafonnées à 200 Mo au total
  (taille des fichiers, vérifiée avant de les charger ; pic mesuré d'environ
  cinq fois cette taille). Au-delà, rien n'est exporté et le message demande
  de choisir moins de sessions, au lieu de construire l'archive en mémoire
  sans limite.
- Sessions : les nouveaux fichiers de session sont créés en `0600` et les
  dossiers créés pour eux en `0700`, quel que soit l'umask (sous umask 022
  ils étaient lisibles par les autres comptes) ; les fichiers et dossiers
  existants gardent leurs permissions.
- Tâches planifiées : quand `enable --now` puis la désactivation de secours
  échouent toutes deux, la tâche et ses unités sont conservées et l'erreur
  dit qu'elle peut encore s'exécuter, au lieu de tout effacer avec un timer
  dans un état inconnu ; `/schedule` peut la supprimer une fois systemd
  rétabli.
- Sandbox : un `settings.json` présent mais invalide ou illisible dès le
  démarrage (JSON corrompu, fichier inaccessible, champ de la sandbox au
  mauvais type) ne fait plus appliquer les réglages par défaut : chaque
  appel d'outil, commande `!`, outil `sudo` et passage planifié est refusé,
  dans tous les modes, avec le chemin, la ligne et la colonne en cause, sans
  citer le fichier. Les règles lues plus tôt dans la session restent en
  vigueur ; un fichier absent ramène aux défauts ; Prism reprend dès que le
  fichier est réparé.
- Sandbox : un `settings.json` illisible (faute de frappe, ou lu pendant
  qu'une autre session le réécrit) ne fait plus retomber silencieusement les
  réglages de la sandbox aux défauts, ce qui levait les chemins masqués
  (`hide`), les hôtes bloqués et les modes désactivés ; les dernières règles
  lues restent en vigueur. Seul un fichier absent ramène aux défauts.
- `/export-zip` : l'archive étant construite en mémoire (pic mesuré ≈ 1,4 ×
  les fichiers inclus, 660 Mo de RSS pour 30 fichiers de 10 Mo), les
  fichiers au-delà de 100 Mo au total sont listés comme exclus (« la taille
  maximale de l'archive est atteinte ») ; même mesure après correctif : 406
  Mo.
- Tâches planifiées : une installation qui échoue à une étape (écriture
  d'une unité, `daemon-reload`, `enable`) désactive le timer et retire la
  définition et les unités qu'elle a écrites ; une suppression dont
  `systemctl disable` échoue est signalée comme un échec et conserve la
  tâche, au lieu d'annoncer « supprimée » alors que le timer peut encore
  tourner. Une seconde suppression termine le travail.
- Garde npm (revue de durcissement) : `pnpm install`/`i <paquet>`, `bun i`,
  les alias d'installation de npm (`in`, `isntall`, `it`…) et les préfixes
  `sudo`, `time`, `nice`, `nohup`, `command`, `exec`, `corepack` sont
  vérifiés ; une option du préfixe (`sudo -u`…) rend le registre invérifiable.

- Registre des versions des outils MCP (revue de durcissement) : les
  enregistrements de plusieurs sessions Prism ne s'écrasent plus (verrou de
  fichier) ; un `mcp-tools.json` illisible n'est plus lu comme vide ni
  remplacé : chaque outil MCP demande avant ses appels tant que le fichier
  n'est pas réparé ou supprimé, et la session le signale.

- Tâches planifiées (revue de durcissement) : `/schedule` refuse aussi un
  Prism dont les fichiers (paquet, script, Node.js), par leur chemin ou par la
  cible de leurs liens, sont dans un dossier que les commandes de la sandbox
  peuvent écrire : cache npm (`npx`), caches d'outils, `sandbox.allowWrite`.

- Garde npm (revue de durcissement) : le registre nommé par un `.npmrc`, une
  variable ou la configuration utilisateur n'est contacté que si les
  permissions réseau l'autorisent déjà sans question (hôte, ou port de cette
  machine) ; un hôte bloqué ou retiré n'est plus contacté, y compris
  `registry.npmjs.org`. Les requêtes ne vont qu'aux adresses vérifiées (garde
  DNS). Un `.npmrc` d'un dossier parent (racine de workspace) qui nomme un
  registre rend le registre indéterminé : aucun nom n'est envoyé au registre
  public.

- `prism doctor` et `/doctor` : un `models.json` absent est signalé comme
  absent (« les valeurs par défaut s'appliquent »), sans problème, au lieu
  d'être dit valide (QA fork.9).
- `/schedule` : un nom vide (Entrée sans rien saisir) annonce que la tâche
  n'a pas été créée, au lieu d'annuler sans rien dire ; Échap reste silencieux,
  et rien n'est écrit ni installé (QA fork.9).
- `/help` : une action longue passe à la ligne sous sa colonne, à la largeur
  du terminal, au lieu d'être coupée ; sous 41 colonnes, l'action de la ligne
  choisie reste affichée en entier sous la liste (QA fork.9).
- Menu Contexte (clic sur la jauge) sans modèle : il dit qu'aucun modèle
  n'est configuré et que sa fenêtre de contexte n'est pas connue, au lieu
  d'une « fenêtre de 0 tokens » (QA fork.9).
- Tutoriel : Entrée sans rien saisir sur un exercice pas encore fait dit
  quoi faire (écrire une demande, joindre un fichier avec @, ou la touche à
  presser) au lieu de ne rien faire ou de quitter le module ; l'exercice
  n'est pas validé, → et « Module suivant » restent disponibles (QA fork.9).
- Action dangereuse refusée sans interface (`-p`, RPC) : le message ne conseille plus
  de relancer en mode `broad`, qui pose aussi la question ; il dit de la lancer
  dans une session interactive (QA fork.9).
- Clic sur le nom du modèle (ou ctrl+p) sans aucun modèle : le statut dit
  « Aucun modèle disponible » et comment en ajouter, au lieu de « Only one model
  available » en anglais (QA fork.9).
- `/export` : du code collé sans fences dans un message utilisateur s'affiche
  en un bloc de code, comme dans le terminal, au lieu d'être lu comme du
  Markdown (gras, italique, indentation perdue) (QA fork.9).
- En français, l'aide de démarrage du mode `--safe` et l'arrêt sur une
  extension qui ne se charge pas (erreur et conseil) sont traduits (QA fork.9).
- Commande d'un module désactivé : le message nomme le module comme
  `/settings › Modules` (« fichiers » en français, et non « files ») (QA fork.9).
- Sélection à la souris : le toast « Copié ! » (ou l'échec de la copie) suit
  la langue de l'interface (QA fork.9).
- `read` d'un PDF, `.docx` ou `.odt` sans le programme d'extraction : le
  refus nomme le paquet à installer (`poppler-utils`, `pandoc`) au lieu de
  « fichier binaire » avec le conseil de lancer ce même programme absent.
- Les champs de saisie affichent leur texte d'exemple, jusque-là ignoré :
  format de la source dans `/skills` (`npm:nom`, `git:…`), nom et durée
  proposés par `/schedule`, mot de passe de sudo.
- `/skills` : un paquet installé qui n'apporte aucune skill (skills hors du
  dossier `skills` et sans clé `pi`) le dit et propose de le retirer ; il
  n'était listé nulle part dans `/skills`, donc impossible à retirer de là.
- Une ancienne ligne de statut ne reprend plus le texte du dernier
  message après un changement de thème ou de taille (par exemple « /onboarding
  permet de refaire ces choix. » affiché deux fois en fin d'onboarding).
- Sans modèle configuré, l'en-tête et la barre du composeur affichent « aucun
  modèle » au lieu de « unknown · unknown », et l'aide de `/login` qui
  accompagne « Aucun modèle disponible » est traduite.
- Français : `/budget` et `/state` mettent l'espace avant les deux-points
  (« Coût : », « Dernier tour : ») ; l'en-tête de démarrage traduit le niveau
  de réflexion (« moyen » et non « medium »), comme le pied de page.
- Deux sessions qui créent `settings.json` en même temps ne perdent plus le
  réglage de l'autre : l'écriture refait sa fusion une fois le verrou pris.
- Husky : après l'accord à la question sur son dossier de hooks
  (`core.hooksPath=.husky/_`), la session suivante n'empêche plus les
  commandes de ce dépôt. La vérification de démarrage de la sandbox tient
  compte de la copie privée de `.git` qu'auront les commandes ; rien n'est
  créé dans le vrai `.git`.
- Un trousseau verrouillé ou lent ne fige plus Prism : `secret-tool` tourne
  sans bloquer l'interface, arrêté après 10 s ou à l'annulation, sans rien
  écrire ni passer en clair. Les identifiants sont lus au trousseau hors du
  verrou d'`auth.json`, donc les autres écrivains ne l'attendent plus ; un
  écrivain dont le verrou a pu passer à un autre (arrêt prolongé du
  processus) refuse d'écrire au lieu d'écraser l'écriture de l'autre, et ne
  lui retire pas son verrou.
- `auth.json` n'est plus réécrit sur place : un fichier temporaire du même
  dossier (droits 0600, puis ceux de l'ancien fichier), écrit en entier et
  synchronisé, le remplace par renommage. Un arrêt pendant l'écriture laisse
  l'ancien fichier ou le nouveau, jamais un fichier tronqué ; le temporaire
  d'un processus mort est retiré à l'écriture suivante.
- La sortie de `bash` affichée pendant l'exécution montrait en clair une
  clé connue (variable passée par une règle, clé stockée) que le résultat
  final masquait. Le flux est désormais masqué lui-même.
- Ce masquage retenait les 29 derniers octets de la sortie en cours, déjà
  masqués : l'aperçu montrait « [se » au lieu du nom du secret, ou cachait
  une invite (« Continuer ? [o/N] ») tant que la commande restait muette.
  Seule la fin qui commence un secret attend désormais le morceau suivant.
- Trousseau : un élément n'est retiré qu'une fois `auth.json` écrit sans
  lui. Avant, un échec d'écriture après la suppression laissait un marqueur
  sans son identifiant.
- Mode Plan en français : le bandeau au-dessus de l'éditeur (replié, plus
  coupé à 64 colonnes), l'état de la barre, la description de `/plan`,
  « (indisponible) », « Tapez pour chercher » et les libellés de la liste
  d'outils (« intégré, limité »…) sont traduits ; « 1 sélectionné » au
  singulier. Les textes sont traduits un par un, sans motif général : un nom
  d'outil, un modèle ou une valeur reste tel quel. L'anglais reste identique
  octet pour octet.
- `/settings` laissait voir la bordure de la saisie sur les bords gauche,
  droit et bas de sa fenêtre. La saisie est masquée tant que `/settings` est
  ouvert et revient à sa fermeture.
- Goal et Plan en français : les menus de Goal (« Aucun objectif n'est
  défini », réglages, budget, limites), ses fenêtres et ses notifications,
  et les menus de `/plan` suivent la langue du harness, avec leurs aides
  de touches (« ↑/↓ parcourir • Entrée choisir • Échap fermer »). Le texte
  saisi par l'utilisateur et les valeurs enregistrées ne changent pas.
- Plan en français : les notifications propres au plug-in Plan
  (activation, plan gardé, export, erreurs d'implémentation, réglages)
  suivent la langue du harness, comme l'action « cocher/décocher » des
  listes à cocher. Reste en anglais le widget du mode Plan au-dessus de
  l'éditeur. `/chrome-devtools` reste en anglais (exception temporaire,
  module remplacé en fork.11).
- Un agent tournait dans le mode de permission configuré (`permissions.json`)
  et sans les refus de la session, même quand la session parente était plus
  stricte : un agent lancé depuis une session en mode « ask » pouvait écrire
  sans demander si la configuration disait « broad ». Il reprend désormais
  le mode courant du parent et ses refus de session.
- Une tâche d'agent commençant par « / » s'exécutait comme une commande dans
  l'agent : `/perm always bash` enregistrait une règle d'autorisation dans le
  projet pour toutes les sessions suivantes, et l'appel ne se terminait
  jamais. La tâche est désormais toujours transmise comme texte.
- Connexion OAuth refusée par le fournisseur (jeton de rafraîchissement
  révoqué ou expiré, `invalid_grant`, 401 ou 403) : l'erreur dit
  « La connexion à <fournisseur> n'est plus acceptée. Reconnectez-vous avec
  /login. » après une requête, à la place du renvoi vers `/doctor`, et dans
  `/model` après « actualisation impossible ».
- `/doctor` sous `--no-session` : le dossier de session est « non testé »
  au lieu d'un problème sur un chemin vide.
- Export de `/doctor` et de `prism doctor` : l'aide et le message promettent
  le masquage des seules informations sensibles reconnues, et recommandent
  de relire le rapport avant de le partager.
- `/settings` : une commande intégrée choisie dans les réglages (« Scoped
  models », « Sign in », « Trust this folder ») ouvre son écran au lieu
  d'être envoyée au modèle comme message, et le brouillon du composeur est
  conservé. alt+j n'envoie plus `/bg` au modèle quand le module des tâches
  de fond est coupé : un message dit que la commande n'est pas disponible.
- `/settings` : une fenêtre ouverte depuis les réglages (« Modes and
  permissions in effect », « Task scope ») revient aux réglages, sur la
  même ligne, quand on la ferme (Esc ou ✕), au lieu de tout fermer. Les
  commandes qui écrivent seulement dans la conversation ne reviennent pas.
- Plein écran : ouvrir à la souris « Modes and permissions in effect »
  depuis `/settings`, puis fermer la fenêtre, ne prive plus le composeur
  du clavier jusqu'à un clic dedans. Le clic rendait le focus au menu
  qu'il venait de fermer.
- `/settings` : un clic dans une liste de sous-menu (seuil de compaction,
  thème…) choisit la ligne cliquée. Quand la description du sous-menu
  tenait sur moins de lignes dans toute la fenêtre que dans la colonne
  des réglages, le clic tombait deux lignes plus bas (70 % donnait 85 %).
  « Thinking level for each model » répond aussi à la souris : un clic sur
  un modèle, puis sur un niveau, le choisit ; avant, il ne faisait rien.
- Notifications de bureau : avec le serveur en mode « Ne pas déranger »
  (SwayNotificationCenter), elles n'étaient ni affichées ni gardées dans
  sa liste ; elles y restent désormais. Chaque notification remplace la
  précédente au lieu de s'empiler (l'identifiant fixe ne remplaçait rien).
  `/notify test` et « Test notification » disent où la notification est
  allée (identifiant donné par le serveur) ou pourquoi elle a échoué.
- Permissions : `/perm rules` et « Règles enregistrées » de la fenêtre des
  permissions ouvrent l'éditeur de règles de `/settings` au lieu de
  l'ancienne liste en anglais. L'aide de `/perm` s'ouvre dans un lecteur
  qui défile (flèches, pages, molette) au lieu d'une liste dont chaque
  ligne se choisissait, et elle est traduite. L'avertissement du mode sans
  limite, au démarrage et dans la boîte qui l'active, est traduit et n'est
  plus coupé au milieu des phrases.
- Serveurs de langage : « Serveurs de langage » de `/settings` › Serveurs
  ouvre leur gestionnaire, `/lsp-setup`, au lieu de `/lsp`. Il liste les
  serveurs du projet (ou tous) comme prêts, à installer ou désactivés ;
  choisir un serveur propose de mettre sa commande d'installation dans la
  saisie (rien ne s'exécute avant Entrée) et de l'activer ou le désactiver.
  `/lsp` résume en trois lignes (serveurs prêts, désactivés, nombre de
  serveurs non installés) au lieu de deux lignes par serveur dans un
  avertissement ; `/lsp all` garde la liste complète.
- Onboarding : l'étape Permissions propose les quatre modes, sans
  « recommandé » ; « Sans limite » dit ce qu'il permet et ne s'applique
  qu'après l'avertissement accepté (refusé, le mode précédent reste et un
  avis le dit). L'étape Modules en propose onze (MCP, Plan, Objectif, points
  de restauration, notifications, second avis en plus) et renvoie à
  `/settings` › Modules ; la recherche web ne dit plus qu'il faut une clé ;
  Remote Pi dit qu'il est tiers, que son relais lit les messages et qu'un
  téléphone appairé agit pour vous. L'étape Modèle ne dit plus « un modèle
  est déjà disponible » quand le modèle choisi n'a ni clé ni serveur : elle
  nomme le modèle configuré et précise qu'il n'a pas encore été contacté.
- Tutoriel : la fenêtre garde la même hauteur et ses boutons la même place
  sur toutes les pages (« Retour » grisé sur une première page, « Essayer
  pour de vrai » en dernier). Un exercice fait, Entrée ou → passent au
  module suivant, comme « Module suivant ». `/perm`, `/tree` et `/settings`
  tapés dans un exercice ouvrent une démonstration de leur menu : on y
  choisit une ligne avec ↑↓ et Entrée, et le tutoriel dit ce que la vraie
  commande ferait, sans rien changer.
- Consultation : `/ask` avec un modèle inconnu propose d'ouvrir
  « Configurer les modèles » de `/settings` › Modules au lieu de renvoyer à
  l'édition de `consult-models.json` ; l'aide de `/ask` indique ce chemin
  et distingue consulter (avis, aucun fichier modifié), déléguer
  (`@delegate`, peut modifier des fichiers) et les agents de `/agents`.
- Agents : `/agents` explique ce qu'est un agent et ce qui le distingue
  d'une consultation ; après la création, Prism dit de demander au modèle
  de l'utiliser au lieu de nommer l'outil interne qui le lance.
- Goal et Plan : les menus de `/goal` et `/plan` (boutons et alt+g
  compris) s'ouvrent dans une fenêtre encadrée comme `/settings` et
  `/perm`, avec leur titre, une croix ✕ qui ferme tout le menu et les
  touches en bas ; Échap revient d'un niveau. Sur un terminal bas, la
  fenêtre retire d'abord ses lignes vides et ses séparateurs. Les menus du
  module navigateur, faits avec la même bibliothèque, prennent le même
  cadre.
- Diagnostic : `prism doctor` (`details`, `export <fichier>`, `--help`)
  vérifie l'installation sans démarrer l'interface, donc aussi quand Prism
  ne démarre plus : réglages, `models.json`, capacités, permissions,
  dossiers et plantages récents, chacun lu à part, une lecture qui échoue
  devenant un problème du rapport. Il ne charge pas les extensions et le
  dit. Code de sortie 1 s'il trouve un problème ; l'export masque secrets
  et dossier personnel (mode 0600). `/doctor` signale aussi les plantages.
- `/doctor` lisible : une ligne de bilan, puis un bloc par élément, les
  problèmes en premier, marque ✗ ? ✓ en couleur et nom en gras ;
  Observation, Cause et Action en retrait, et seulement l'observation pour
  ce qui est correct. La fenêtre prend la hauteur du terminal au lieu de
  18 lignes.
- Documentation : taper dans une page ouverte de `/docs` (ou dans l'aide
  de `/perm`) y cherche le texte, sans tenir compte des accents ni des
  majuscules. Les occurrences sont soulignées, l'occurrence courante en
  inverse, et la ligne dit « résultat 2/34 ». Entrée passe à la suivante,
  Maj+Entrée à la précédente (les touches de la recherche du transcript),
  Échap efface la recherche puis ferme.
- Nouveautés : `/changelog` ouvre les notes dans ce lecteur, refermable et
  avec la même recherche, la version la plus récente en tête, au lieu
  d'ajouter tout l'historique à la conversation.
- Code collé : un programme collé dans un message sans fences s'affiche en
  un seul bloc de code, entier, lignes vides et indentation comprises, au
  lieu de quelques morceaux reconnus au hasard. La prose, les listes et le
  code déjà entre fences autour restent tels quels ; le modèle reçoit le
  texte tel qu'il a été tapé.
- Footer : un clic sur le nom du modèle passe au suivant, comme Ctrl+P ;
  un clic sur la jauge de contexte explique ce qu'elle mesure et ce que
  fait `auto`, et propose de compacter ; un engrenage ouvre `/settings`.
  « plus… » et l'engrenage restent visibles à toute largeur : les statuts
  sont coupés avant eux.
- Footer personnalisable : « plus… » > « Boutons du pied de page… »
  épingle des commandes au footer, les retire ou change leur ordre ; le
  choix est enregistré (`footerActions`), et celles qui n'y tiennent pas
  restent dans « plus… ».
- `/settings` : les libellés longs se lisent en entier. La liste des choix
  d'un réglage passe à la ligne au lieu de couper (« Ne jamais faire
  confiance »), l'aide montre le nom complet du réglage et l'effet de
  chaque choix, une ligne étroite coupe son libellé avant sa valeur, et la
  page d'un modèle garde entiers les libellés traduits longs.
- Connexion : un fournisseur ajouté par `/login` (clé d'API, compte ou
  serveur compatible) après qu'une autre connexion a restreint la liste des
  modèles (`enabledModels`) apparaît dans `/model`. Ses modèles rejoignent
  la liste (`deepseek/*`) quand ils sont tous récents, ou quand la liste de
  choix est fermée par Échap, au lieu de rester cachés jusqu'à
  `/scoped-models`.
- Animations : le menu qui s'ouvre n'arme plus son minuteur de 16 ms quand
  l'animation « Ouverture des menus » est coupée ; elle ne coûte plus rien
  une fois désactivée.
- Confiance : en français, la question posée au démarrage pour un dossier
  de projet (titre, explication, choix) est en français, comme `/trust`.
  Le choix fait est enregistré comme avant.
- Modules : en français, la raison pour laquelle un module n'est pas pris
  en charge par le modèle est en français (« … ne sait pas appeler
  d'outils… ») au lieu d'une phrase anglaise terminée par « outils ». Six
  autres textes à variables prenaient la traduction d'un texte plus court ;
  chacun prend désormais la sienne.
- Affichage en français : l'avis de lecture limitée dit « et non le reste
  de votre dossier personnel » (il disait l'inverse) ; le niveau de
  réflexion sous la saisie est traduit (« moyen ») ; `/files` et `/help`
  nomment les touches Entrée, Échap, Haut et Bas ; `/perm status` affiche
  le mode traduit (« Permissions : large », non « perm: broad »).
- Terminaux étroits : `/help` montre sous la liste la description complète
  de la ligne choisie (elle était coupée à 64 colonnes, absente à 40) ;
  l'aide des touches de `/settings` et de `/perm` revient à la ligne au
  lieu de perdre « Échap fermer » ; l'en-tête et l'aide de `/resume`
  reviennent à la ligne au lieu d'être coupés ; une règle enregistrée trop
  longue passe sa portée à la ligne ; une autorisation en cours garde son
  bouton « Révoquer » et sa portée entière ; un chemin long dans une
  question d'autorisation se coupe après un « / ».
- Réglages : un libellé long (« Les commandes voient mes conteneurs »)
  s'affiche en entier quand la fenêtre a la place, au lieu d'être coupé à
  32 colonnes.
- `/doctor` indique sous le rapport sa position et les touches pour
  défiler et fermer.
- Connexion par compte : la page de retour dans le navigateur montre le
  nom et le logo de Prism, et pour ChatGPT, OpenAI propose « Prism » comme
  nom d'agent au lieu de « Pi ». La marque n'atteignait pas les flux de
  connexion, chargés à part dans la version installée.
- Tâches de fond : ce que les processus d'une tâche écrivent après la fin
  de son shell (un programme laissé en arrière-plan, par exemple) n'est plus
  perdu. La tâche reste « en cours » jusqu'à la fermeture de sa sortie, et
  son journal est entièrement écrit sur le disque avant qu'elle soit
  marquée finie et notifiée.
- fd et ripgrep, téléchargés par Prism quand ils manquent, sont pris dans
  une version fixée (fd 10.5.0, ripgrep 15.2.0) et refusés si l'archive n'a
  pas son empreinte SHA-256 connue, au lieu de la dernière version sans
  vérification.
- Sandbox, réglage « Commands read the state of services » : une commande
  pouvait s'abonner aux signaux de n'importe quel service du bus système et
  recevait tout ce que le bus renvoyait à Prism. Les abonnements sont
  limités aux signaux de systemd, et seules les réponses à ses propres
  appels lui parviennent.
- Sandbox : un `TMPDIR` hérité que la sandbox masque ou laisse en lecture
  seule (dans le dossier personnel, ou un sous-dossier du `/tmp` de la
  machine) faisait échouer `mktemp` et les outils. Les commandes de la
  sandbox reçoivent alors le `/tmp` privé de la session, au premier plan
  comme en tâche de fond ; un `TMPDIR` utilisable dans la sandbox est gardé.
- Le fichier de sortie complète d'une commande (`/tmp/pi-bash-*.log`)
  n'avait pas de taille maximale : une commande en boucle sans fin a écrit
  5,5 Go dans `/tmp`, qui est en mémoire. Il s'arrête à 32 Mio : le début
  et la fin de la sortie, autour d'une ligne qui dit combien d'octets
  manquent. La fin est gardée aussi quand la commande est annulée ou que
  Prism se ferme pendant qu'elle tourne. La mémoire utilisée pendant la
  commande reste bornée.
- Sandbox : sur un dossier personnel neuf, `npm install`, `cargo build`, uv
  et Go échouaient faute de pouvoir créer leur cache (`~/.npm`,
  `~/.cargo/registry`, `~/.cache`…). Prism crée avant la commande les caches
  absents des outils présents dans le `PATH`, seulement ceux que la sandbox
  ouvre déjà en écriture, sans rien remplacer ni suivre de lien.
- Sandbox : le dossier personnel ou un dossier au-dessus dans
  `sandbox.allowWrite` ou `sandbox.read.allow` n'élargit plus la sandbox
  (avec la limite, il faisait échouer chaque commande sans explication) :
  les commandes sont refusées avec un message qui propose un dossier
  précis, et il n'ouvre rien aux outils natifs. Un `TMPDIR` dans le dossier
  personnel ne casse plus le réseau de la sandbox ; le fichier que nomme
  `GIT_CONFIG_GLOBAL` est lu, en lecture seule, avec la limite. Le client
  Podman ne s'arrête plus faute de `~/.config`, montré vide sauf les
  ressources qu'il contient.
- Sandbox : un hôte bloqué pendant une question réseau reste bloqué, même si
  la réponse à cette question l'autorise ; une connexion dont l'hôte est
  bloqué pendant la résolution DNS se ferme aussitôt (HTTPS et Git par SSH).
- Sandbox, Git par SSH : rien de ce que lit le `ssh` de Prism (fichiers de
  configuration et leurs `Include`, commandes, clés, `ssh` lui-même) ne peut
  venir d'un fichier que la commande peut modifier ; sinon refus, avec le
  fichier et la ligne. Les alias, clés et rebonds de `~/.ssh/config` restent
  suivis.
- `ssh` peut lire sa configuration dans la sandbox
  (`ssh -G`) : il ne refuse plus les fichiers inclus de `/etc/ssh` avec
  « Bad owner or permissions ». La connexion SSH reste bloquée.
- Une commande `systemctl` refusée dans la sandbox reçoit la
  ligne d'explication de Prism, aussi avec le message de systemd 25x.
- Sandbox : les protections de `.git`, des hooks et de `.pi` résistent
  aussi au remplacement de leurs parents. Les worktrees liés et les
  chemins réels de `core.hooksPath` sont couverts. Une configuration Git
  atypique peut restreindre certaines écritures, avec son motif précis ;
  Prism et les lectures restent disponibles, sans désactiver la sandbox.
- Sandbox : les métadonnées Git des sous-modules (`.git/modules/…`, y
  compris imbriqués, et le fichier `.git` du sous-module) sont en lecture
  seule. Une commande ne peut plus y écrire un hook, une configuration ou
  un `commondir` qui agirait à votre prochaine commande Git hors de Prism.
  En contrepartie, les écritures Git dans un sous-module (`add`, `commit`,
  `fetch`, `switch`, `stash`, `submodule update`…) échouent dans la
  sandbox, avec un message qui dit pourquoi ; lancez-les hors de Prism.
  Les fichiers sources du sous-module restent modifiables, les lectures
  Git (`status`, `log`, `diff`) et les commits du dépôt principal
  fonctionnent.
- Sandbox : un hook Git qui est un lien vers un script du projet
  (`.git/hooks/pre-commit` vers `scripts/pre-commit`) rend ce script
  non modifiable par le modèle, qui pouvait sinon en changer le contenu
  avant votre prochain commit.
- Sandbox : avec un `core.hooksPath` relatif (husky écrit `.husky/_`), un
  push reçu par le dépôt lit ses hooks dans `.git/<chemin>`, où une
  commande pouvait en créer un. Tant que ce dossier n'existe pas, les
  commandes sandboxées sont refusées avec un message qui nomme le réglage
  et le dossier ; créez-le (`mkdir -p .git/.husky/_`, il reste vide et la
  sandbox le garde en lecture seule) ou mettez un chemin absolu. Prism ne
  crée rien dans `.git` et ne désactive pas la sandbox.

- Taper « /session » puis Entrée affiche de nouveau les informations de la
  session, au lieu d'ouvrir la reprise de session (trouvée par un synonyme).

- Correctifs de sécurité repris d'upstream : connexion OAuth des serveurs
  MCP (émetteur refusé sans métadonnées, requête annulée non renvoyée après
  un renouvellement de jeton), scripts `codemode` qui modifient les objets
  intégrés, et réponses tardives du terminal qui pouvaient être lues comme
  des touches (texte injecté dans la saisie, éditeur externe ouvert).
- Correctifs des fournisseurs repris d'upstream (v1.0.1 à v1.4.0) : plus
  de nouvelles tentatives sur les erreurs passagères (serveur occupé,
  passerelles, flux coupés), arguments d'appels d'outils réparés ou
  signalés, réflexion envoyée correctement à Gemini 4 et aux modèles OpenAI
  sur Bedrock, jetons OAuth renouvelés conservés, reprise de Copilot après
  une requête trop grosse, estimation du contexte plus juste.

- Sandbox : une connexion dont le client ferme son envoi en premier (comme Git
  par SSH) reçoit maintenant la réponse ; le relais et le proxy la perdaient.

- En mode `-p`, une sandbox qui ne marche pas arrête vraiment Prism : le
  prompt n'est plus envoyé au modèle et le code de sortie vaut 1. Avant,
  « Prism stopped » s'affichait, mais la réponse du modèle aussi.
- Les notifications d'approbation partent de nouveau : celle de « en attente
  de toi » ne partait qu'une fois la question répondue, car `notify` se
  chargeait après la barrière de permissions. Les notifications affichent
  « Prism » avec une majuscule.
- La sandbox démarre sur Ubuntu : bubblewrap échouait sur `/var/run/dbus`
  (lien absolu vers `/run`). Sur Ubuntu 24.04, bubblewrap a aussi besoin
  d'un profil AppArmor ; le message d'arrêt donne
  la commande qui l'installe.
- Dans les résultats de recherche de `/settings`, une valeur coupée ne
  touche plus le nom du domaine (« ask ▾Permissions & sandbox »).
- `web_fetch` ne fige plus Prism sur une page piégée : la conversion du HTML
  en texte se fait en une passe (2 Mio de balises non fermées : 88 ms, contre
  plusieurs minutes avant, interface bloquée). Une entité hors plage
  (`&#99999999;`) ne fait plus échouer la lecture de la page. Le découpage
  des résultats de la recherche sans clé est lui aussi linéaire.
- `/login` sur un serveur local ne bloque plus sur un modèle de chat piégé
  (25 s pour 840 Ko avant, quelques ms maintenant), ne plante plus sur une
  très longue liste de slots, et une liste de modèles mal formée donne un
  message clair au lieu d'une erreur interne.
- remote-pi : un message mal formé venu de l'app ou du relais ne fait plus
  quitter Prism ; l'app reçoit une erreur `invalid_message`.
- Un `chat_template_kwargs` saisi dans « Autres paramètres » s'ajoute aux
  arguments que Prism construit au lieu de les remplacer : il ne coupe plus
  la réflexion sans le dire.
- MCP : un bloc mal formé dans le résultat d'un serveur (texte qui n'est pas
  une chaîne, image sans données, ressource absente) devient un court avis
  `[Invalid MCP … content block …]` ; les autres blocs du résultat sont
  gardés. Avant, l'outil échouait en entier, ou le résultat cassait
  l'affichage et toutes les requêtes suivantes vers Anthropic.
- `consult_model` et `delegate_model` : un caractère accentué coupé entre
  deux morceaux de la sortie du modèle consulté n'est plus remplacé par
  `��`, et une ligne JSON qui n'est pas un événement ne ferme plus Prism.
  La lecture d'une très longue ligne (consultation ou `/agents`) se fait en
  une passe (16 Mio : 1,2 s avant).
- Recherche de sessions : une ligne `null` ou un en-tête mal typé dans un
  fichier de session ne fait plus échouer toutes les recherches.
- `/undo` : une entrée abîmée de l'index des points de reprise est ignorée ;
  elle faisait écrire tous les instantanés suivants dans le même fichier,
  et `/undo` restaurait le contenu d'un fichier dans un autre.
- `lsp_fix` (pi-lsp, désormais forké dans `vendor/forks/pi-lsp`) : des
  modifications mal formées envoyées par le serveur font échouer le
  correctif au lieu d'abîmer le fichier, et les gros messages du serveur
  sont lus en une passe (32 Mo : 4,3 s avant).
- Permissions : `chrome_devtools_screenshot` avec `savePath` est jugé comme
  une écriture de ce fichier (refusé en mode `safe`, et plus seulement
  « accès réseau ») ; `lsp_fix` est jugé sur le fichier qu'il réécrit, donc
  une écriture hors du projet pose la question « dangereux » même en mode
  `broad`.
- Sandbox : `/tmp` est maintenant propre à chaque session. Ses commandes le
  partagent, les autres sessions et le reste de la machine n'y ont plus
  accès (avant, une commande lisait le vrai `/tmp`, dont les sorties
  complètes des commandes des autres sessions). Il est supprimé à la fin de
  la session, à la sortie de Prism (ctrl+c compris) ; une tâche de fond
  encore active le garde jusqu'à sa fin. Après un arrêt brutal (`kill -9`),
  le démarrage suivant de Prism le supprime.
- Textes à valeur variable : une valeur contenant `$&` ou `{1}` (nom de
  fournisseur, chemin, message d'erreur) était déformée à l'affichage, et
  un nom de commande pouvait être traduit (« /ask » affiché « /demander »
  quand le module de consultation est coupé). Les valeurs s'affichent
  maintenant telles quelles.
- Interface en français : le modèle recevait une partie des textes de
  Prism traduits (description de l'outil `agent`, erreurs et résultats
  d'`agent` et de `configure_prism`, refus d'écriture de configuration,
  blocage du budget, refus du mode sûr, résultat d'un périmètre de tâche
  accepté). Il les reçoit en anglais quelle que soit la langue ; l'écran
  les montre traduits, sauf les raisons de blocage dans le fil, qui
  restent en anglais comme les autres. Les noms de fichiers, commandes,
  hôtes, thèmes, alias et modèles insérés dans un texte traduit
  s'affichent tels quels (un fichier nommé « Done » n'est plus affiché
  « Terminé »).
- Les réglages « Git signe avec ma clé », « Les commandes voient mes
  conteneurs » et « Les commandes lisent l'état des services » sont traduits
  en français.
- Sélection à la souris : relâcher le bouton hors de la fenêtre (au-dessus
  ou à gauche) arrête le défilement de la sélection, au lieu de le laisser
  continuer jusqu'à la prochaine action. Avec les positions au pixel, kitty
  donne alors des coordonnées négatives, que Prism ignorait.

### Removed

- `consult` (`/ask`, `/consult`, `consult_model`) et la délégation
  (`@delegate`, `delegate_model`) : l'outil `agent` les remplace, sans
  migration. Les fichiers `consult-models.json` et `consult-budgets.json`
  existants ne sont ni lus ni supprimés.
- Sandbox : le réglage « D-Bus système » (`sandbox.allowSystemBus`). Il
  rouvrait toutes les sockets Unix de la machine, dont une qui permettait
  de faire exécuter une commande hors de la sandbox. S'il reste dans
  `settings.json`, il est ignoré ; les sockets Unix restent refusées.

## [1.0.0-fork.8] - 2026-10-21

Correctif urgent : le mode plan ne pouvait pas lire de documents Word ou PDF,
et la session finissait arrêtée par un dépassement de contexte.

### Fixed

- Le mode plan accepte les redirections inoffensives (`2>/dev/null`, `2>&1`,
  `>/dev/null`) et les extracteurs de texte qui n'écrivent que sur la sortie :
  `antiword`, `catdoc`, `pdftotext FICHIER -`, `unzip -p` ou `-l`, `pandoc`
  sans `-o`, sans filtre et sans Lua. Quand il refuse une commande, il dit au
  modèle ce qui est permis, au lieu de le laisser tâtonner.
- `read` refuse les fichiers binaires (`.doc`, `.docx`, `.pdf`, archives…) et
  propose l'extracteur à utiliser, au lieu de verser des dizaines de Ko
  d'octets bruts dans le contexte.
- Le message « Context size has been exceeded. » de llama.cpp est reconnu
  comme un dépassement de contexte : Prism compacte et réessaie au lieu
  d'arrêter la session.

## [1.0.0-fork.7] - 2026-10-21

### Added

- `/tutorial` : neuf modules courts (premiers pas, bien demander, suivre le
  travail, permissions, plan et objectif, sessions, modèles et réglages,
  travailler sur un projet, aller plus loin), chacun avec un exercice que
  Prism vérifie sans appeler le modèle, et la progression gardée. Proposé à
  la fin de l'onboarding et dans le menu « plus… ».
- Après `/login`, une liste à cocher des modèles du fournisseur quand il en
  propose d'anciens ou d'obsolètes (42 avec une clé OpenAI, dont GPT-4 et
  o1) : les récents sont cochés (sortis au plus six mois avant le plus récent
  du fournisseur, non obsolètes), le choix est enregistré comme une sélection
  de `/scoped-models` ; échap les garde tous. Le catalogue garde pour cela la
  date de sortie et le statut « obsolète » donnés par models.dev, pour tous
  les fournisseurs.
- Bouton « plus… » dans la barre du bas : un clic ouvre un menu des commandes
  courantes (aide, documentation, réglages, permissions, modèle, session,
  nouvelle session, reprise, arbre, export, compaction). Le brouillon en
  cours est gardé.
- `/perm` ouvre une fenêtre : les quatre modes côte à côte, ce que chacun
  permet pour chaque type d'action (lire, modifier le projet ou au-dehors,
  commandes, internet, sudo, réglages de sécurité, outils de modules), une
  ligne qui résume le mode choisi, les autorisations en cours avec leur temps
  restant et un bouton « Révoquer », puis « Garder ce mode par défaut », les
  règles et l'aide. Clavier et souris. Sous la largeur utile, les modes
  passent en onglets et le tableau ne montre que le mode choisi.
- Autorisations de 15 minutes : la question propose « pendant 15 minutes »
  en plus de « une fois », « cette session » et « enregistrer ». L'échéance
  est une date : rouvrir la session après ne la ranime pas. `/perm clear`
  les efface aussi.

- `/docs` : taper dans la liste cherche dans les titres puis dans le texte
  des pages ; quitter un document revient à la liste.
- `/model-settings` règle aussi le nom affiché du modèle, les pénalités de
  présence, de fréquence et de répétition, et d'autres paramètres transmis
  tels quels au serveur (objet JSON, par exemple `{"seed": 42}`).
- Continuité de projet (module `project-continuity`, désactivé par défaut,
  `/settings` > Extensions) : dans un projet qui a `project/handoff.md`, le
  prompt système dit au modèle à quoi sert chaque document de continuité
  (règles, spécification, feuille de route, journal, passation, questions) et
  comment le tenir à jour. Ailleurs, ou coupé, rien n'est ajouté. `/init`
  (module activé) met la structure en place à partir d'un plan ou du dépôt
  existant : il montre ce qui sera créé ou adapté, demande confirmation, puis
  le modèle écrit les documents avec ses outils, sous vos permissions.
  `/handoff` fait mettre à jour `project/handoff.md` par le modèle, avec la
  branche, le commit, les fichiers non commités et les tâches de fond relevés
  par Prism ; au démarrage, une passation qui ne correspond plus au dépôt
  (commit différent, modifications non commitées plus récentes) est signalée.
- Budgets d'exécution (`/budget`, `--budget-time`, `--budget-tools`,
  `--budget-tokens`, `--budget-cost`) : limites facultatives par session,
  avertissement à 80 %, arrêt au plafond (plus de nouvel appel d'outil ni de
  tour du modèle, appel actif annulé), état gardé dans la session et repris
  par `/budget`. Le coût n'est limité que si le modèle a un tarif connu.
- Outils de mesure par module : `fork/tools/prompt-cost.sh --modules` donne
  le coût en prompt de chaque module, `fork/tools/bench.sh --settings
  --startup-only` compare le démarrage d'un même build avec des réglages
  différents.
- Coût par module (`/settings` > Extensions, mode avancé, « Measure module
  cost ») : pour un module ou tous, compare Prism avec et sans lui dans un
  processus isolé, hors ligne, sans lire vos identifiants : tokens ajoutés au
  prompt (estimation), démarrage et mémoire (mesurés, « sous le bruit »
  quand l'écart est plus petit que la dispersion), processus enfants.
  Méthode affichée. Tous les modules : environ 4 minutes.
- Benchmark complet : `fork/tools/bench.sh` mesure aussi la latence des
  touches, le surcoût du harness par tour (hors attente du modèle et des
  outils) et le temps de chaque outil, et note la charge et le profil
  d'énergie de la machine. Le rapport JSON sépare les cinq mesures de F-L2.
- Trace des opérations (désactivée par défaut, `/settings` > Confidentialité) :
  une chronologie JSONL locale par session dans `<agentDir>/traces/` avec
  chaque appel d'outil, ses paramètres, la décision de permission et le
  résultat. Clés enregistrées et secrets courants masqués, prompts et texte
  du modèle jamais enregistrés, fichiers plus vieux que la rétention
  (7 jours par défaut) supprimés au démarrage. `/trace` affiche la
  chronologie de la session.
- `/model-settings` : contexte, sortie maximale, images, réflexion et
  échantillonnage (température, Top P, Top K, Min P) du modèle courant, avec
  côte à côte ce que le serveur indique (llama.cpp, Ollama) et ce que Prism
  envoie ou suppose. Une valeur corrigée est enregistrée dans `models.json`
  (`modelOverrides`), survit à une nouvelle détection et prime sur elle.
- Les fonctionnalités suivent les capacités du modèle. Un modèle dont le
  serveur dit qu'il ne gère pas les appels d'outils (ou que l'utilisateur
  coupe dans `/model-settings`, nouvelle ligne « Appels d'outils ») répond
  sans outils, avec un avis ; une image jointe à un modèle sans images est
  signalée comme non envoyée. Quand le serveur refuse une requête qui
  utilisait une capacité qu'il ne déclare pas, un avis la nomme comme cause
  possible, non confirmée.
- `/sent` montre la dernière requête envoyée au modèle : destination
  (fournisseur, endpoint, modèle), prompt préparé et données remises au
  fournisseur, avec les secrets masqués ; `/sent export <chemin>` l'écrit en
  JSON. Gardée en mémoire seulement. Une ligne d'état discrète signale le
  passage d'un modèle local à un modèle cloud (réglage « Local to cloud
  warning »).
- Onboarding : au premier démarrage sans modèle, six étapes animées (langue,
  thème avec aperçu, affichage simple ou avancé, permissions, modules
  facultatifs, connexion d'un modèle par `/login`). Échap passe la suite en
  gardant les choix faits. `/onboarding` le relance à tout moment.

- `/doctor` : vérifications locales, sans réseau ni modèle (fichiers de
  réglages, `models.json`, extensions en échec, modèle courant et ses
  capacités enregistrées, serveur local ou cloud d'après son URL,
  permissions, dossiers). Chaque point dit ce qui a été observé, si la cause
  est confirmée ou une hypothèse, et quoi faire ; ce qui n'a pas pu être
  testé est dit. `/doctor details` ajoute le détail technique horodaté,
  `/doctor export <chemin>` l'écrit en JSON, secrets masqués. Un échec de
  requête au modèle ou d'extension au démarrage renvoie à `/doctor`.

- Tâches longues : `/bg` et alt+j ouvrent le panneau des tâches lancées en
  arrière-plan (état, durée, dossier), avec leur sortie en direct et l'arrêt
  après confirmation. Le pied de page compte les tâches en cours. On peut
  continuer à écrire à l'agent pendant qu'elles tournent.

- Interruption et reprise : une session reprise après un arrêt brutal pendant
  un outil montre l'appel resté sans résultat, ses arguments, les points de
  restauration du tour et quoi faire. `/state` affiche le même état à la
  demande (dernier tour, appels interrompus, tâches d'arrière-plan en cours).
- `/agents` : créer, modifier et supprimer des agents personnalisés depuis
  l'interface (nom, rôle, modèle, outils, consignes), sans éditer de fichier.
  Le modèle les lance avec l'outil `agent` : un Prism enfant tourne avec le
  modèle et les seuls outils choisis, et ses demandes de permission
  s'affichent dans la session, préfixées du nom de l'agent. Module
  `builtin:agents` ; l'outil n'apparaît dans le prompt qu'une fois un agent
  créé.

- Automatisation : page `docs/automation.md` sur l'usage sans interface
  (`-p`, `--mode json`, `--mode rpc`, SDK) et le sort des actions à confirmer.

### Changed

- Direction artistique, les trois propositions retenues par le propriétaire :
  les appels d'outils consécutifs forment un bloc serré, sans ligne vide
  entre eux ; chaque tour se termine par un filet qui porte ses chiffres
  (durée, outils, échecs, jetons envoyés et reçus, coût) ; les tableaux
  markdown sont tracés en filets, sans cadre ni traits verticaux, comme sur
  le site.
- `/export` plus proche de la direction du site : barre latérale aérée, en
  sans-serif et sans couleur par rôle ; libellés de l'en-tête en
  sans-serif ; le filet de l'en-tête part de la marque dans le spectre sombre.
- La continuité de projet est active par défaut ; `/settings` > Modules la
  coupe. Dans un projet sans `project/handoff.md`, elle n'ajoute rien au
  prompt et affiche un bouton « init » dans la barre du bas, qui lance
  `/init` et disparaît une fois le projet initialisé.
- Permissions par capacité : chaque outil déclare ce qu'il fait (lire,
  écrire, lancer un programme, internet, droits administrateur) et le mode
  décide pour chaque capacité. Internet demande en mode prudent. Un outil
  d'extension qui ne déclare rien est refusé en prudent et en demander
  (autorisé en large), avec un message qui dit comment l'autoriser
  (`/perm allow <outil>`). Les extensions tierces déclarent leurs outils avec
  le champ `permissions` de `registerTool`.

- Barre du bas : en interface simple, des mots (« envoyés 18k  reçus 1.3k »)
  au lieu des flèches ; `/help` explique les abréviations de l'interface
  avancée (↑ ↓, R W, CH, jauge, « auto »).
- Interface en français : les valeurs et descriptions de `/settings`, la
  barre sous la saisie (plan, objectif, fichiers), le mode de permission en
  bas et le libellé de réflexion sont traduits.
- `/settings` s'ouvre dans une fenêtre par-dessus l'écran, de taille fixe :
  domaines numérotés à gauche, réglages à droite, aide en bas qui décrit le
  réglage et chacun de ses choix. `/` cherche dans tous les réglages ;
  oui/non se basculent d'Entrée ou d'un clic ; un réglage à choix ouvre la
  liste de ses choix décrits. « All settings » laisse place à la recherche,
  Extensions et Recherche web deviennent « Modules ». Sous 80 colonnes, une
  seule colonne.
- Mode simple : chaque action tient sur une ligne en mots simples, sans
  commande ni sortie ; `ctrl+o` ou un clic sur l'action montre les détails.
  Les réglages avancés n'y sont plus ni montrés ni modifiables, « All
  settings » compris.
- Un module activé ou coupé dans `/settings` > Extensions s'applique à la
  fermeture des réglages, sans `/reload`. La requête suivante annonce
  l'outil ajouté ou retiré à la fin de la conversation : le cache de prompt
  de tout ce qui précède reste valable.
- Une capacité que le serveur ne déclare pas (images, réflexion) reste
  disponible au lieu d'être coupée ; seule une capacité que le serveur dit
  absente est coupée.
- Affichage simple : la barre d'état montre « cache 63% » au lieu de
  `R4.0k W600 CH63.5%` (gardé en affichage avancé), et une commande shell en
  échec dit comment elle s'est terminée sur sa ligne (« failed (code 3) »,
  « stopped after 30 s (time limit) ») au lieu de laisser la ligne
  `Command exited with code 3` à la fin de sa sortie.
- Sur une ligne d'outil trop étroite, c'est la commande qui est tronquée,
  plus l'état ni la durée.
- Permissions : sans interface (`-p`, `--mode json`), une action bloquée
  faute de confirmation possible est aussi signalée sur stderr, avec la façon
  de l'autoriser.
- Les touches du menu Goal (`alt+g`) et de l'explorateur de fichiers
  (`alt+e`) se changent dans `keybindings.json` (`app.goal.menu`,
  `app.files.browse`) ; le composeur et `/help` affichent la touche choisie.
- Remote Pi n'accepte plus qu'un relais en `https://` (ou `http://` vers
  cette machine). Un relais `http://` déjà configuré, ou donné par
  `REMOTE_PI_RELAY`, n'est plus utilisé : les messages ne sont pas chiffrés
  de bout en bout, donc n'importe qui sur le réseau pouvait les lire et en
  forger (valider un outil en attente).
- `/memory-edit` ouvre la mémoire globale dans l'éditeur intégré au lieu de
  lancer `$EDITOR` (qui ne recevait pas le terminal).
- `/undo` signale les fichiers de plus de 8 Mo non sauvegardés, et rappelle
  que les changements faits par bash ne sont pas suivis.
- Tâches de fond : elles tournent avec le shell de l'outil bash (plus de
  shell de connexion) ; `kill` attend la fin réelle (« arrêt en cours », puis
  SIGKILL après 3 s) ; les journaux de plus de 7 jours sont supprimés.
- `remote-pi` (contrôle depuis un téléphone) est coupé par défaut : il
  demande un relais auto-hébergé et une application tierce. `/settings` >
  Extensions le réactive.

### Fixed

- Doc des réglages : `builtin:remote-pi` figure parmi les modules coupés
  par défaut (elle disait encore qu'il se chargeait).
- Fluidité avec un long historique : chaque token reçu redessinait et
  redécorait tous les messages de la session. Les messages terminés gardent
  leur rendu et l'usage du contexte n'est recalculé qu'à chaque nouveau
  message. Mesuré sur 5 000 messages : 24,5 → 4,0 ms par token en plein
  écran, 30,9 → 7,6 ms en mode normal (`bench.sh --sizes`).
- Souris : un clic hors d'un menu ou d'un panneau (fichiers, `/docs`,
  `/settings`, `/perm`, Goal, Plan) le ferme, comme Échap ; la molette avance
  d'un fichier par cran dans l'explorateur (trois auparavant) et fait défiler
  les pages de `/docs` ; `/perm`, Goal et Plan se pilotent à la souris
  (molette, clic sur une option).
- Sortie maximale des serveurs locaux : `/login` écrit la limite du serveur,
  ou à défaut son contexte, au lieu des 16 384 jetons envoyés par défaut qui
  coupaient les longs raisonnements. Un arrêt sur limite dit quelles limites
  l'ont causé et où les relever.
- `edit` refuse un fichier de plus de 32 Mio sans le lire, et dit au modèle
  de passer par bash (`sed`, `awk`, `perl`, `python3`) ; avant, un fichier de
  plusieurs centaines de Mo faisait échouer l'outil ou gonflait la mémoire.
- L'onboarding dit quand les changements de modules s'appliquent : à la fin
  de `/onboarding`, ou au démarrage suivant lors du premier lancement.
- Réflexion : un refus (« ce modèle ne prend pas en charge la réflexion »)
  dit maintenant comment l'activer (`/model-settings` > Réflexion), au
  raccourci comme avec `/thinking`. La détection des serveurs locaux lit le
  mode routeur de llama.cpp (modèles déjà chargés seulement, sans en charger),
  reconnaît un modèle qui raisonne d'après les capacités de son gabarit, ne
  prend plus un modèle LM Studio sans réglage de raisonnement pour un modèle
  qui ne raisonne pas, et lit les valeurs de réflexion d'Ollama.
- Dépendances avec failles connues : `brace-expansion` 5.0.12 (livrée, motifs
  `{…}` qui pouvaient bloquer le processus) et `shell-quote` 1.12.0 (exemple
  d'extension `sandbox`, non livré).
- `grep` avec des lignes de contexte ne charge plus tout un gros fichier : il
  ne lit que les lignes autour des correspondances. Au-delà de 512 Mo, il
  affichait « unable to read file » à la place des lignes.
- `find` signale les dossiers qu'il n'a pas pu ouvrir au lieu de les sauter
  sans rien dire ; chercher dans un dossier illisible répondait « aucun
  fichier trouvé ».
- `read` lit les gros fichiers texte (plus de 16 Mo) en flux et ne garde que
  ce qu'il affiche : un fichier de 257 Mo coûtait 1 Go de mémoire, il en coûte
  environ 50 Mo ; au-delà de 512 Mo, la lecture échouait, quel que soit
  `offset`.
- `grep` garde ses résultats quand un fichier ou un dossier est illisible, et
  signale les chemins ignorés. Avant, un seul dossier sans droits faisait
  échouer toute la recherche.
- `read`, `edit` et `write` refusent les tubes nommés (FIFO), les
  périphériques et les sockets, avec un message qui renvoie vers `bash`.
  Avant, une FIFO bloquait l'outil et `/dev/zero` remplissait la mémoire.
- Permissions : un `permissions.json` dont un champ a le mauvais type
  (`"allow": {}`) est ignoré comme un JSON invalide, et le mode par défaut
  s'applique. Avant, le garde plantait et chaque appel d'outil échouait sur
  une erreur interne.
- Permissions : un lien symbolique ne contourne plus les confirmations. Le
  garde juge le fichier réellement touché en plus du chemin écrit : écrire ou
  lire `auth.json` ou `.env` à travers un lien placé dans le projet, ou écrire
  hors du projet à travers un dossier lié, demande confirmation, y compris en
  mode large. La boîte de dialogue montre `lien -> cible`, et une règle
  « autoriser » doit correspondre à la cible réelle.
- `write` à travers un lien précise le fichier réellement écrit
  (`Successfully wrote to notes.json (symlink to …)`).

- Rendu sûr : le texte du modèle, des outils, des notifications et des
  sessions ne peut plus agir sur le terminal (presse-papiers OSC 52, titre,
  notifications, images kitty/sixel, effacement d'écran, curseur) ; les
  couleurs restent. Un lien dont le texte diffère de sa cible affiche la cible
  et n'est plus cliquable ; une image Markdown distante n'est jamais chargée,
  ni dans la TUI ni dans l'export HTML, qui gagne une Content-Security-Policy.

- Avec un serveur llama.cpp aux slots de tailles différentes, la fenêtre de
  contexte retenue est celle du plus petit slot : la compaction se déclenche
  avant qu'une requête ne dépasse le contexte réel.
- Le build avec un catalogue de modèles frais ne casse plus : OpenCode Go
  accepte les modèles servis par l'API Google (`gemini-4-argon-contributor`)
  et les fournisseurs OpenCode passent sur `opencode.ai/inference`. Correctif
  d'upstream repris tel quel (`195120a91`).
- Les modèles par défaut de NVIDIA (`nemotron-3.5-super-vl-120b-a12b`) et de
  Xiaomi (`mimo-v2.6-pro`) existent à nouveau dans le catalogue ; les
  anciens en avaient été retirés. Correctifs d'upstream repris
  (`95364a54e`, `90d863f7c`).
- Sessions simultanées : deux instances qui partagent le même dossier agent
  ne perdent plus les mises à jour l'une de l'autre dans `models.json` et
  `capabilities.json` (verrou de fichier).
- `/undo` restaure le bon fichier quand une session tourne dans un autre
  dossier que le processus (SDK) : les chemins relatifs suivent le dossier de
  la session.
- Permissions (revue de code du 2026-10-20) :
  - les chemins `~/…` et `@…` sont jugés comme les outils les résolvent :
    `read ~/.pi/agent/auth.json` ou `write ~/.bashrc` passaient sans question ;
  - les commandes bash « sûres » demandent quand une option écrit ou exécute
    (`sort -o`, `find -fprint`, `git diff --output`, `rg --pre`, `man -P`…),
    quand elles visent un fichier de secrets (`cat ~/.ssh/id_ed25519`), ou
    avec un préfixe `VAR=` ; `printenv` et `env` seuls demandent ;
  - une commande dangereuse est reconnue derrière `timeout`, `env`, `nice`,
    `xargs`, un chemin (`/usr/bin/sudo`), des guillemets, `bash -c`, `eval`,
    `find -exec`, une sous-coquille ou un `if` ; une redirection vers
    `$HOME/…` ou `&>` hors du projet aussi ;
  - une règle d'autorisation bash couvre chaque commande d'une ligne, pas
    seulement la première (`npm run x; node evil.js` passait sans question) ; une
    règle de refus attrape la commande où qu'elle soit (`true && curl`) ;
  - `grep` sur un dossier qui contient des secrets demande ;
  - `.git/config` est protégé ; un lien à travers un chemin profond est suivi.
- `/undo` restaure un fichier écrit par un chemin `~/…` ou `@…`.
- `/init ~/plan.md`, `/doctor export ~/r.json` et `/sent export ~/r.json`
  développent `~`.
- L'installateur refuse un dossier d'installation qu'il n'a pas créé, au lieu
  d'effacer son `versions/`.
- `web_fetch` arrête de lire une réponse directe à 2 Mo au lieu de la charger
  entière, et ne retélécharge plus une URL qu'Exa a renvoyée sous une forme
  normalisée.
- Le panneau `/bg` ne lit plus que la fin du journal (un journal de 300 Mo
  figeait l'interface ; au-delà de 512 Mo, il n'affichait plus rien).
- Consultations et agents : l'annulation ou le délai dépassé arrête aussi les
  commandes bash de l'enfant (SIGTERM, puis SIGKILL après 3 s) ; sa sortie
  d'erreur et ses lignes partielles ont une taille bornée.
- `/sessions` et `session_search` lisent l'en-tête avant le fichier et ne
  figent plus l'interface.
- Le pied de page n'additionne plus tout l'historique à chaque réponse.

## [1.0.0-fork.6] - 2026-10-14

### Changed

- Les thèmes `prism` et `prism-light` prennent la direction artistique du
  site : fond noir, trois encres et des filets ; la couleur est réservée aux
  états (erreur, avertissement, succès), aux diffs, aux familles d'outils
  (teintes sobres) et à une coloration syntaxique pâle. Nouveau logo : un
  prisme symétrique, son faisceau et son spectre ; ouverture rejouée dans
  cet ordre (verre, faisceau, arêtes, spectre). L'indicateur de travail est un reflet
  qui glisse sur un filet ; l'état d'un outil est un point (●), suivi de
  « échec » après une erreur. En-tête, menus, notices et `/settings`
  (domaines numérotés, ● on/off, lignes « Pourquoi ») passent en texte
  plutôt qu'en pastilles. `/export` suit le site : marque du site, filets,
  coins de 3 px, polices du site sans téléchargement (V2.34).

## [1.0.0-fork.5] - 2026-10-13

### Fixed

- En mode simple, le téléchargement de `fd` et `rg` au premier lancement
  n'est plus annoncé ; un échec reste signalé. `/settings` > Interface
  (simple ou advanced) remplace l'interrupteur « Advanced settings » et
  s'enregistre (V2.26).

- `ask_user_question` ne se bloque plus au premier appel dans l'installation
  Node : le plugin préassemblé attendait indéfiniment avant d'afficher son
  questionnaire, et gelait les autres outils du même lot (V2.1).
- Échap termine le tour même quand un outil ne répond plus : après 1 s, l'outil
  reçoit une erreur explicite et les autres résultats de son lot sont gardés.
  Un questionnaire ouvert se ferme à l'annulation (V2.2).
- `web_fetch` accepte une liste d'URL passée en texte JSON (`'["https://…"]'`) ;
  `read` ne voit plus vide un fichier qu'une édition parallèle est en train
  d'écrire (V2.3).
- Sous Linux, l'aide n'annonce plus « paste files on macOS » : ctrl+v colle
  une image ou du texte.
- Avec un `pi-lsp.json` à soi, `/lsp-setup` ne dit plus « ready » pour un
  serveur que cette config ne liste pas, puisque pi-lsp ne l'utilisera pas.

### Changed

- Contrastes relevés à 4,5:1 au moins : texte atténué (`dim`) des thèmes
  `prism` et `prism-light` (libellés et aides des menus, chemins, versions),
  commentaires du code et couleur des avertissements en thème clair.
- `/login` > serveur compatible lit le template de chat de llama.cpp et propose
  les niveaux de raisonnement qu'il accepte (par exemple `off`, `low`,
  `medium`, `xhigh` pour un Qwen), envoyés au serveur à chaque tour. Refaire
  `/login` pour un serveur déjà ajouté (V2.4).
- Un thème clair dans un terminal sombre (ou l'inverse) éclaircit vraiment toute
  l'interface : Prism règle le fond du terminal pendant la session et le
  rétablit en quittant. `/settings` explique le lien entre thème et terminal
  (V2.5).
- Plein écran : glisser la barre de défilement suit la souris au pixel près dans
  les terminaux qui le permettent (kitty, entre autres), au lieu de sauter d'une
  case de piste, soit des centaines de lignes sur une longue session (V2.6).
- Un double-clic sur la marge du composer ne le recouvre plus d'une barre de
  sélection blanche (V2.6).
- Plein écran : le curseur de la barre de défilement est dessiné en blocs au
  huitième de case et bouge avec la molette au lieu de rester figé puis de
  sauter (V2.6).
- `remote-pi` ne demande plus de relais ni ne relance son assistant à chaque
  nouvelle session : la configuration se fait par `/remote-pi` (V2.7).
- Permissions : le mode `yolo` s'appelle `broad` (l'ancien nom reste accepté) ; un
  vrai mode `unrestricted`, sans aucune confirmation, s'active explicitement
  après un avertissement. `/perm` ouvre un menu, `/perm default` règle le mode
  de départ et `alt+m` change de mode (V2.8).
- Identité visuelle plus sobre : logo en traits fins, titres d'une seule couleur,
  filets adoucis, animations plus lentes et toutes coupées par le réglage
  `animations` (V2.9).
- `/settings` explique concrètement chaque réglage, marque les réglages avancés,
  n'ouvre plus de section vide (Network) et ouvre les permissions, les modèles
  à faire défiler, les serveurs de langage et Remote Pi depuis « Tools » (V2.10).
- `/login` propose d'abord le serveur compatible (modèles locaux) et ne propose
  plus Radius ; la page de retour des connexions OAuth affiche Prism (V2.11).
- Nouveau logo en pixel art (prisme, faisceau, spectre), dessiné à la main en
  trois tailles selon la largeur du terminal (grand dès 100 colonnes, petit dès
  64, mini en dessous), avec une variante pour thème clair et une intro
  d'environ 800 ms (aucune avec `animations` désactivé). L'en-tête ne garde que
  deux raccourcis en pastilles (`/` commandes, `ctrl+o` plus) ; l'aide complète
  emploie des mots simples (V2.28).
- Panneaux en « tuiles » de pixel art : le composer et les messages de
  l'utilisateur sont des aplats aux bords en demi-rangée et aux coins coupés,
  la sortie des outils un panneau enfoncé (au lieu du rail `│`), l'état d'un
  outil un `■`, le raisonnement un rail fin de la couleur de son niveau, et
  l'indicateur de travail une vague aux couleurs du spectre. Texte atténué un
  peu plus contrasté dans les thèmes `prism` et `prism-light` (V2.28).
- Barre d'état : la jauge de contexte est une rangée de pixels avec un repère
  à l'endroit où l'auto-compaction démarre ; elle passe à l'avertissement
  10 points avant ce seuil, à l'erreur au-delà. Le mode de permission est une
  pastille de la couleur de son risque (V2.28).
- Menus et dialogues (permission, `/settings`, `/model`…) en tuile : titre dans
  une pastille, ligne choisie en sous-tuile avec sa barre d'accent, au lieu du
  cadre arrondi aux couleurs du spectre (V2.28).
- `/settings` dessiné : à partir de 90 colonnes, deux volets (les domaines à
  gauche, les réglages du domaine survolé à droite ; → ou Entrée pour y
  entrer, ← ou Échap pour revenir) ; en dessous, la liste comme avant. Les
  valeurs sont des contrôles : interrupteur pour on/off, pastille entre ‹ ›
  pour un choix, petite jauge pour le seuil d'auto-compaction. Descriptions sur
  un panneau enfoncé, « Advanced » en pastille, réglage Interface en contrôle
  Simple │ Advanced cliquable dans le titre. Texte de la ligne choisie des
  menus plus contrasté en thème clair (V2.29).
- `/export` dans la DA pixel art : logo en pixels (variante claire avec le
  thème clair) dans l'en-tête, en-tête et messages de l'utilisateur en
  tuiles aux coins coupés d'un pixel, appels d'outils et blocs de code en
  tuiles enfoncées avec le `■` d'état du terminal, boutons et filtres en
  pastilles. La page reste autonome, sans ressource externe (V2.30).
- Langage simple : 93 textes de l'interface reformulés (réglages, aide,
  permissions, connexion, compaction) ; les termes techniques restent, suivis
  d'une courte définition. En mode d'interface simple, « Steering » et
  « Follow-up » deviennent « Messages sent while working » et « Messages sent
  after the task » (V2.31).
- `/docs` : la documentation dans Prism, par sujet, dans un lecteur défilable ;
  les messages renvoient à `/login` et `/docs` au lieu de chemins de fichiers
  (V2.12).
- `/` montre moins de commandes : les sous-commandes d'un plugin (`/remote-pi …`)
  apparaissent après son nom ; des synonymes trouvent et lancent les commandes
  (`/exit` → `/quit`, `/config` → `/settings`…) (V2.13).
- Plan, Goal, raisonnement et permissions se changent sans commande : sous le
  composer, cliquer sur le niveau de raisonnement passe au suivant, sur « plan »
  active ou coupe le mode Plan (`alt+p`), sur « goal » ouvre le menu Goal
  (`alt+g`) ; dans la barre d'état, cliquer sur le mode de permission ouvre
  `/perm`. Un mode actif s'affiche en couleur. Les listes d'outils du mode Plan
  ne proposent plus les outils bloqués ou dépréciés ; un outil bloqué déjà
  listé dans `defaultPlanTools` reste affiché (V2.14).
- `/settings` > Conversation : seuil d'auto-compaction réglable en pourcentage
  du contexte (Default garde le comportement actuel), avec le nombre de tokens
  effectif ; les valeurs trop hautes sont plafonnées pour laisser la place au
  résumé (V2.16).
- Ctrl+O ouvre ou ferme vraiment tous les blocs, raisonnements compris, même
  ceux qu'un clic avait ouverts ou fermés ; les nouveaux blocs suivent cet
  état (V2.15).

### Added

- Prism en français : menus, réglages, aide, dialogues, messages d'état et
  guides de `/docs`. `/settings` > Language : `auto` (suit la langue du
  système), `English` ou `Français`, appliqué tout de suite. Ce qui n'est pas
  traduit reste en anglais ; les réponses du modèle suivent toujours Reply
  language (V2.32).
- Avertissement quand le seuil d'auto-compaction choisi est trop bas pour le
  modèle (seuil en tokens au plus égal aux tokens gardés tels quels, donc rien
  à résumer) : au démarrage, au changement de modèle et dans `/settings`. La
  valeur choisie n'est jamais modifiée (V2.24).
- Firecrawl comme fournisseur de recherche web : `/settings` > Web search,
  clé par `/web-key firecrawl` ou `FIRECRAWL_API_KEY`, masquée dans les
  résultats et les erreurs. Requêtes limitées à 500 caractères, sans
  extraction des pages (V2.23).

- Explorateur de fichiers en panneau latéral : `alt+e`, `/files` ou le bouton
  « files » sous le composer. Flèches pour naviguer, Entrée pour ouvrir un
  dossier ou ajouter `@chemin` au message en cours, Tab pour en marquer
  plusieurs, ← pour remonter, Échap pour fermer ; clic pour choisir, second clic
  pour ajouter. Pleine largeur sur un terminal étroit ; désactivable dans
  `/settings` (V2.18).
- Serveurs de langage : dans un projet qui contient du code, Prism indique une
  seule fois lesquels installer pour ses langages ; `/lsp-setup` les liste
  (« ready » ou « to install ») et met la commande d'installation dans
  l'éditeur, à lancer soi-même. Rien n'est téléchargé automatiquement
  (V2.19).
- Langue des réponses : le prompt système demande au modèle de répondre dans la
  langue du dernier message de l'utilisateur, ou dans une langue fixe
  (`/settings` > Conversation > Reply language). Utile surtout aux modèles
  locaux qui répondaient en anglais à un message en français ; code, commandes
  et noms d'outils ne sont pas traduits (V2.20).
- Recherche web : en plus d'Exa (toujours sans clé par défaut), Brave et Tavily
  avec une clé, et SearXNG sur sa propre instance. Choix dans `/settings` >
  Web search, clé ou URL par `/web-key <fournisseur>` ; une configuration
  manquante donne un message clair, et les clés sont masquées dans les résultats
  et les erreurs de `web_search` (V2.17).

## [1.0.0-fork.4] - 2026-10-13

Base upstream : v1.0.0.

### Fixed

- Mode normal : remonter ou sélectionner pendant que le modèle répond ne renvoie
  plus en bas. Une ligne modifiée hors de l'écran (bloc d'outil terminé, logo
  animé) ne vide plus l'historique du terminal ; elle reste dans son ancien état
  dans l'historique (R1.5).

### Changed

- Passe graphique de Prism (R4.10) :
  - les options longues d'un dialogue (permissions) s'alignent sous leur texte ;
  - le cadre des menus passe du violet en haut à l'aqua en bas, des deux côtés ;
  - le mode de permission est une pastille colorée dans la barre d'état ;
  - au démarrage, une ligne résume les ressources chargées (« 1 skill ·
    2 extensions ») ; ctrl+o montre toujours le détail ;
  - les avertissements et erreurs sont des encarts à barre colorée ;
  - à faible largeur, les raccourcis de l'en-tête passent à la ligne au lieu
    d'être coupés ;
  - outils : icône par famille dans une couleur du spectre, point d'état (en
    cours, réussi, échoué), durée au bout de la ligne d'en-tête ;
  - un filet en dégradé précède chaque message de l'utilisateur ;
  - « Thinking… » est balayé par un reflet (sauf si `animations` est désactivé) ;
  - thème `prism-light`, choisi automatiquement sur un terminal clair ;
    `/export` suit aussi le thème du terminal (clair ou sombre).
- `/changelog` affiche les notes de version de Prism (ce fichier) au lieu du
  changelog d'upstream pi (R10.2).

## [1.0.0-fork.3] - 2026-10-13

Base upstream : v1.0.0. Première release avec des notes : elles reprennent tout ce
que le fork a changé depuis le début (`1.0.0-fork.1` et `.2` n'en avaient pas).

### Added

- Notes de version (R10.2) : chaque release publie la section de ce fichier qui
  la concerne (`NOTES.md`, couverte par la signature) ; `prism update` l'affiche
  après la mise à jour.
- Canal de mise à jour (R10.1) : `prism update` installe la dernière release du
  site si elle est plus récente, avec les mêmes vérifications que l'installation
  (signature, somme), bascule de façon atomique et garde la précédente ;
  `prism update --check` et `prism update --rollback`. Vérification au démarrage
  seulement avec le réglage `updateCheck` (désactivé par défaut). `install.sh`
  range désormais les releases dans `versions/` avec les liens `current` et
  `previous`, et refuse en mise à jour une version plus ancienne que l'installée.
- `/export` soigné (R4.7) : texte en police proportionnelle, en-tête en carte avec
  le liseré spectral, métadonnées en grille, messages et appels d'outils en cartes
  avec un liseré d'état (succès, erreur), tableaux et blocs de code arrondis. Le
  style s'ajoute au gabarit upstream et suit les couleurs du thème.
- Premières releases signées (R1.9b) : `fork/scripts/release.sh` construit une
  archive linux-x64 avec Node inclus et signe `SHA256SUMS` avec minisign ;
  `fork/scripts/install.sh`, servi par `https://prism.odelserver.space`, vérifie
  la signature (minisign ou openssl 3) et la somme avant d'installer, sans sudo ;
  `fork/tools/test-release.sh` le vérifie dans un conteneur. Release
  `1.0.0-fork.1` publiée.
- `/expand` : déplie le raisonnement et les sorties d'outils ensemble (de nouveau :
  replie les deux) (R4.6).
- `/help` : raccourcis et actions courantes, les plus fréquents d'abord,
  filtrables ; Entrée sur une commande la place dans l'éditeur (R4.3).
- `/login` > serveur compatible lit ce que le serveur dit de ses modèles
  (llama.cpp, Ollama, LM Studio ; lectures seules) et écrit dans `models.json` le
  contexte réellement alloué, la vision et le raisonnement quand ils sont
  confirmés (R2.2).
- Documentation du fork.
- Règles pour les agents (`fork/AGENTS.md`), avec un renvoi vers elles depuis
  `AGENTS.md` et `CLAUDE.md`.
- Hook SessionStart pour les sessions Claude Code cloud (`.claude/settings.json`,
  `fork/scripts/cloud-setup.sh`).
- Outils de test visuel de la TUI (`fork/tools/`).
- Copie de référence du pack visuel Prism (`fork/reference/pi-prism/`).
- `fork/scripts/brand-binary.sh` : un binaire construit devient `prism`, avec sa
  config dans `~/.prism`.
- `fork/FEATURES.md`, la liste des features éditée à la main par le propriétaire.
- Règle « model-agnostic » dans `fork/AGENTS.md` : les fichiers propres à un outil
  ne sont que des points d'entrée vers `AGENTS.md`.
- Plan du contenu embarqué : extensions, plugins tiers, skills, permissions.
- Copies de référence des extensions maison livrables et d'`APPEND_SYSTEM.md`
  (`fork/reference/`).
- Mode de secours `--safe` : démarre sans extensions, skills, modèles de prompt,
  thèmes ni fichiers de contexte découverts, ignore le thème de `settings.json`,
  et l'annonce à l'écran ; l'erreur de chargement d'une extension le propose ;
  logs et outils de debug documentés.
- `fork/tools/bench.sh` : mesures de performance reproductibles (démarrage,
  mémoire, coût de rendu par token) avec le fournisseur factice.
- `fork/tools/prompt-cost.sh` : coût du prompt par partie (sections du prompt
  système, fichiers de contexte, skills, définitions d'outils), estimation locale
  et compte exact facultatif via un serveur llama.cpp.
- Tests de non-régression du fork (`test/fork-regressions.test.ts`) : télémétrie,
  `/bug`, vérification de version, mise à jour de soi, renommage du binaire.
- `fork/tools/net-audit.sh` : audit des connexions sortantes d'une session, sans
  laisser sortir de paquet (espace réseau privé, journal `LD_PRELOAD`).
- Contrôle des permissions intégré (`/perm`, `--perm-mode`), mode `ask` par
  défaut : confirmation avant les écritures et les commandes non sûres,
  confirmation « dangereuse » pour les fichiers de config et d'identifiants de
  Prism. Toujours chargé, même avec `--safe`. Ce n'est pas une sandbox
  (`docs/permissions.md`).
- `/login` > « Connect a compatible server (URL) » : ajoute un serveur compatible
  OpenAI depuis son URL, sans éditer de fichier. Le fournisseur et ses modèles vont
  dans `models.json`, la clé éventuelle dans `auth.json`.
- Pack visuel Prism livré comme extension intégrée `builtin:prism`, désactivable,
  et thème `prism` disponible (R1.7).
- Extension intégrée `builtin:checkpoints` : instantané des fichiers avant
  `write` et `edit`, `/undo` et `/checkpoints` par tour (R1.8b).
- Extension intégrée `builtin:background` : outil `background` (commandes shell
  longues en arrière-plan), `/bg` et `/bg-clear` (R1.8b).
- `fork/tools/fake-provider.ts` : prompt `call <outil> <arguments JSON>`.
- Extension intégrée `builtin:memory`, désactivée par défaut (`+builtin:memory`
  dans le réglage `extensions` l'active) : `/memory`, `/memory-project`,
  `/memory-edit`, `MEMORY.md` ajouté au prompt système (R1.8b).
- Option `disabledByDefault` des extensions intégrées (R1.8b).
- Extension intégrée `builtin:session-search` : outil `session_search` et
  `/sessions` (recherche dans les sessions passées) (R1.8b).
- Extension intégrée `builtin:notify` : notifications bureau en fin de tour long et
  pendant une demande d'autorisation, `/notify` (R1.8b).
- Extension intégrée `builtin:web` : outil `web_fetch` sans clé, `web_search` avec
  une clé Exa enregistrée dans `auth.json` par `/web-key` (R1.8b).
- `fork/tools/fake-provider.ts` : prompt `tools?` (liste des outils envoyés).
- Extension intégrée `builtin:consult`, désactivée par défaut et livrée sans aucun
  modèle : `/ask`, `/consult`, outils `consult_model` et `delegate_model`, alias
  déclarés dans `consult-models.json` (R1.8b).
- Extension intégrée `builtin:append-system` : les consignes génériques
  d'`APPEND_SYSTEM.md` ajoutées au prompt système (R1.8b).
- Plugins tiers embarqués sans modification dans
  `packages/coding-agent/vendor/node_modules/`, provenance et mise à jour dans
  `vendor/README.md`, chacun en extension intégrée remplaçable (R1.8a) :
  `builtin:pi-lsp` (`@narumitw/pi-lsp` 0.49.8), `builtin:pi-context-inspector`
  (`pi-context-inspector` 1.3.0), `builtin:pi-plan-mode` (`@narumitw/pi-plan-mode`
  0.58.3, avec sa dépendance `@narumitw/pi-tui-kit` 0.59.0), `builtin:pi-goal`
  (`@narumitw/pi-goal` 0.54.8), `builtin:pi-chrome-devtools`
  (`@narumitw/pi-chrome-devtools` 0.53.4), `builtin:rpiv-ask-user-question`
  (`@juicesharp/rpiv-ask-user-question` 2.12.0, avec sa dépendance
  `@juicesharp/rpiv-config` 2.12.0), `builtin:remote-pi` (`remote-pi` 0.7.0,
  désactivé par défaut, avec `@napi-rs/keyring`, `@noble/ed25519`, `croner`,
  `qrcode-terminal` et `ws`).

### Changed

- Doc livrée réécrite au nom de Prism (R4.11) : `README.md` du paquet et les 41 pages
  de `docs/` parlent de Prism, de la commande `prism`, de `~/.prism` et de
  l'installation par `https://prism.odelserver.space`. Les noms de code, de paquets
  npm et de fichiers restent. Les pages qui décrivent upstream pi (Termux, kits
  Docker Sandboxes et OpenShell) ou une plateforme non ciblée (Windows) le disent.
  Trois ancres cassées héritées d'upstream sont réparées.
- Logo Prism redessiné : prisme symétrique, spectre en bandes horizontales qui sort
  de la face droite, contours plus lisibles (R4.9).
- Le logo de l'en-tête est un prisme qui décompose un faisceau en spectre : il se
  dessine au démarrage, et reste figé avec le réglage `animations` à `false`
  (`/settings` > Appearance > Animations) ou hors terminal interactif ; l'en-tête
  de secours (`--safe`) en montre une version réduite. L'aide de `update` et la
  présentation de Radius dans `/login` ne promettent plus d'auto-mise à jour ni
  n'attribuent Prism aux auteurs de pi (R4.9).
- `fork/scripts/install-local.sh` installe Prism exécuté par Node (défaut,
  `--runtime node`) : 2 à 2,6 fois moins de temps de rendu par token que le
  binaire Bun au banc ; le binaire reste disponible par `--runtime bun` (R1.4).
- Les noms du harness visibles par l'utilisateur viennent du nom de l'application
  (`prism` dans le binaire) : prompt système, en-tête et aide, notifications,
  titres, messages de `/login`, MCP, `background`, `consult`, permissions et
  remote-pi (R4.9, premier passage).
- Le pack Prism ne patche plus les composants de pi : il passe par des points
  d'accroche typés (messages, outils, bordures, markdown, cadre des menus) ;
  rendu inchangé (R4.8).
- `/settings` est rangé par domaine (apparence, conversation, terminal, images et
  confidentialité, réseau, avertissements, extensions, recherche web), avec un
  mode avancé pour les réglages techniques et la liste complète consultable ;
  chaque extension intégrée a son interrupteur (R4.1).
- `remote-pi` est remplacé par un fork compatible avec l'application mobile
  (`vendor/forks/remote-pi/`), activé par défaut : fichiers dans le dossier de
  config de Prism, entrée de trousseau propre, trousseau natif chargé dans le
  binaire, aucun relais par défaut (Prism le demande au premier démarrage),
  démons désactivés (R1.18).
- `web_search` marche sans clé, par le point d'accès public d'Exa (limité en
  débit), comme oh-my-pi ; une clé enregistrée par `/web-key` passe par l'API
  d'Exa (R1.17).
- `consult` : le budget générique (tours, appels d'outil, plafonds, arrêts durs)
  se règle dans `settings.json` (`consult.*`) ; `consult-budgets.json` le
  surcharge par alias (R1.14).
- Thème `prism` par défaut quand aucun thème n'est réglé ; `--safe` garde le thème
  système (R1.16).
- Raisonnement replié par défaut (`hideThinkingBlock: true`) ; `ctrl+t` le déplie
  et le choix est enregistré dans les réglages.

- Le catalogue de modèles n'est plus téléchargé depuis pi.dev en arrière-plan
  (démarrage, `/model`, `/login`) ; seulement par `prism update --models`.
- Spécification fonctionnelle complète de Prism (intention, principes,
  exigences par domaine, décisions ouvertes) et liste ordonnée des objectifs.
- Politique vis-à-vis d'upstream : reprise sélective.
- Révision de la spécification et de la roadmap : séquence unique de traitement
  (prototype installable et observable d'abord, parité ensuite), statuts
  « en cours », « bloqué », « implémenté non validé » et « vérifié » avec ligne de
  preuve, dépendances corrigées, sécurité de base séparée de la sécurité avancée,
  secrets et `/login` sans mauvaise pratique transitoire, capacités des modèles à
  trois états.
- Version des binaires : `<version upstream>-fork.<n>`, fixée par
  `fork/scripts/brand-binary.sh`.
- `prism update` n'interroge plus pi.dev et ne se met pas à jour lui-même.
- `/bug` est coupé, et le réglage de télémétrie retiré de `/settings`.
- Le serveur expérimental écrit dans `~/.prism/server`.
- Pas de vérification de version vers pi.dev au démarrage.
- Télémétrie coupée totalement : ni rapport d'installation, ni en-têtes
  d'attribution envoyés aux fournisseurs.
- `fork/tools/tui-drive.sh` isole aussi `PRISM_CODING_AGENT_DIR`, pour piloter un
  binaire `prism`.
- `fork/scripts/cloud-setup.sh` lance l'hydratation des données de modèles avec
  `NODE_USE_ENV_PROXY=1`, pour que le `fetch` de Node passe par le proxy des
  sessions cloud.
- Commande `prism`, dossier de config `~/.prism`, linux-x64 seule.

### Fixed

- Démarrage deux fois plus rapide sous Node (762 → 389 ms au banc) : `remote-pi`
  réutilise les modules du harness au lieu d'en charger une seconde copie, et
  l'installation assemble `rpiv-ask-user-question` et `pi-context-inspector` en un
  fichier chacun (`fork/scripts/prebundle-vendored.mjs`).
- Contrôle des permissions : une règle `allow` ne passe plus avant la détection
  « dangereuse » (fichiers de config de Prism compris) ; une extension de projet
  ne peut plus remplacer le contrôle (une extension de l'utilisateur le peut
  toujours) ; la commande de `background` est analysée comme celle de `bash`,
  `yolo` compris ; `ask_user_question`, `plan_mode_question`,
  `plan_mode_complete` et `background` `status`/`logs` ne demandent plus de
  confirmation (R1.19).
- Les clés d'API saisies ou collées dans `/login` (clé d'API, serveur compatible) et
  `/web-key` sont masquées à l'écran, y compris après validation ; la clé
  enregistrée est inchangée (R1.20).
- Mode normal : le coût d'une frame ne repasse plus sur tout l'historique pour la
  normalisation des lignes et la recherche d'images Kitty. À 1000 messages, coût
  par token p95 de 14,3 à 10,0 ms (binaire, 3 paires de mesures alternées).

- Le modèle Together `deepseek-ai/DeepSeek-V4-Pro-0813` retrouve ses réglages de
  raisonnement ; tests du catalogue alignés sur les tarifs officiels (Kimi K3,
  Claude Sonnet 5.5).
- `fork/tools/test-install-local.sh --skip-build` : la réinstallation recevait un
  argument vide et échouait (« unknown option: »).
- `executeBashWithOperations` (commandes `!` et mode RPC) rend le chemin de la
  sortie complète seulement une fois le fichier écrit ; il pouvait être lu vide
  ou absent juste après le retour (R1.2).
- Pied de page Prism : l'indicateur de compaction automatique lit les réglages de
  Prism (dossier de config et dossier du projet), plus ceux de pi (R1.15).

### Removed

- Workflows GitHub propres à upstream : `pr-gate`, `issue-gate`,
  `issue-triage-labels`, `approve-contributor`, `remove-inprogress-on-close`,
  `issue-analysis`, `publish-model-catalog`.
