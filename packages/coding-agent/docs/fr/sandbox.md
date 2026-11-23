# La sandbox

Prism exécute les commandes shell de l’agent dans la sandbox (environnement isolé des commandes), construite avec [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`), un filtre seccomp et un proxy réseau qui lui est propre. Une commande dans la sandbox ne peut modifier que le projet, ne peut pas lire vos clés ni vos identifiants, et ne joint que les hôtes réseau que vous autorisez.

La sandbox fonctionne avec l’[étape de permissions](permissions.md) : celle-ci décide si un appel s’exécute, la sandbox limite ce qu’une commande peut faire une fois lancée.

## Quand les commandes passent par la sandbox

Par défaut, les commandes s’exécutent dans la sandbox dans les [modes de permissions](permissions.md#modes) `safe`, `ask` et `broad`, et hors d’elle en `unrestricted`. **/settings › Permissions et sandbox › Dans les modes** change cela pour chaque mode, y compris pour l’activer en `unrestricted`.

La sandbox couvre :

- l’outil `bash` et les commandes de fond lancées par l’agent ;
- vos propres commandes `!` seulement quand **Vos commandes ! dans la sandbox** est activé (désactivé par défaut : elles s’exécutent avec vos droits).

Elle ne couvre pas :

- les outils de fichiers (`read`, `write`, `edit`, `grep`, `find`, `ls`) : ils s’exécutent dans le processus de Prism, et l’étape de permissions juge chaque chemin (chemins protégés, écritures hors du projet) ;
- les commandes listées dans **Lancer hors sandbox** (`sandbox.excludedCommands`, comme `docker`), qui passent quand même par l’étape de permissions ;
- l’outil `sudo`, qui s’exécute en root hors de la sandbox après votre accord (voir [Sudo contrôlé](permissions.md#sudo-contrôlé)) ;
- les extensions, serveurs MCP, serveurs de langage et l’extension de navigateur : ils s’exécutent hors d’elle, avec les permissions de votre compte ;
- tout ce qui se passe en mode `unrestricted`, sauf si vous y avez activé la sandbox.

## Prérequis

La sandbox a besoin de `bwrap` sur le système :

```bash
sudo dnf install bubblewrap      # Fedora
sudo apt install bubblewrap      # Debian, Ubuntu
sudo pacman -S bubblewrap        # Arch
```

Les paquets `.deb` et `.rpm` l’installent avec Prism. Quand `bwrap` manque ou échoue, Prism dit pourquoi au démarrage et les commandes shell de l’agent **restent bloquées** : rien ne bascule hors de la sandbox. Installez-le, ou désactivez la sandbox pour le mode en cours dans **/settings › Permissions et sandbox**, avec le risque que cela implique.

Sous Ubuntu 24.04 et suivantes, AppArmor bloque les espaces de noms utilisateur dont bubblewrap a besoin, sauf si un profil les autorise. Le message d’erreur de Prism donne alors la commande qui écrit et charge ce profil.

## Ce qu’une commande peut faire dans la sandbox

| | Dans la sandbox |
|---|---|
| Écrire | Le dossier du projet, un `/tmp` privé à la session, les caches des gestionnaires de paquets (`~/.npm`, `~/.cache`, `~/.cargo/registry`, `~/go/pkg`) par une couche qui leur est propre, et les chemins que vous ajoutez dans **Chemins inscriptibles** (`sandbox.allowWrite`). La configuration de projet de Prism (`.prism/`), les hooks et la configuration de Git restent en lecture seule. En mode `safe`, le projet est aussi en lecture seule. |
| Lire | Avec **Ce que l'agent lit** réglé sur `project` (par défaut) : le projet, ce dont ses outils ont besoin et les chemins que vous ajoutez dans **Aussi lisible**. Le reste de votre dossier personnel, les autres comptes et les disques montés ne sont pas visibles. Avec `all` : tout, sauf les chemins masqués. |
| Masqué | Le dossier de Prism (`~/.prism`, avec ses identifiants et ses permissions), les clés du lien avec le téléphone, SSH, GnuPG, les identifiants cloud et Git, les jetons des registres de paquets, les profils de navigateur et de messagerie, les trousseaux et gestionnaires de mots de passe, le journal du système, les vidages de plantage et le courrier local, plus les chemins que vous ajoutez dans **Chemins masqués** (`sandbox.hide`). En mode `safe`, les fichiers secrets du projet (`.env`, clés) sont masqués aussi. |
| Processus et sockets | Un espace de processus séparé : Prism et vos autres programmes ne sont pas visibles. Le bus de session, le trousseau, le compositeur et le D-Bus système sont fermés ; le filtre seccomp refuse les sockets Unix. |
| Réseau | Pas de réseau direct. Les connexions passent par le proxy de Prism, qui ne laisse passer que les hôtes autorisés. Un hôte jamais vu vous est demandé (**Demander pour les nouveaux hôtes**) ; les **Hôtes bloqués** ne passent jamais. Un port de cette machine (`localhost:5432`) ou Git par SSH (`ssh://github.com`) ne s’ouvre que si vous l’autorisez. Sans interface interactive, un hôte qui demanderait est refusé. |
| Environnement | Les variables qui ressemblent à des clés, jetons ou mots de passe, les sockets d’agents d’identité comme `SSH_AUTH_SOCK`, et toute variable qui contient une clé gardée par Prism sont retirées des commandes de l’agent, dans la sandbox ou non. Consultez [Secrets](security.md#secrets). |

Chaque question réseau propose d’autoriser un hôte pour la commande, pour la session ou pour le projet ; consultez [Permissions](permissions.md#actions-contrôlées-en-mode-ask) pour la façon dont ces accords sont gardés et retirés.

## Accès à activer

Ces interrupteurs de **/settings › Permissions et sandbox › Commandes** sont désactivés par défaut :

| Interrupteur | Réglage | Ce qu’il permet |
|---|---|---|
| Git signe avec ma clé | `sandbox.gitSigning` | Git, dans la sandbox, signe les commits et les tags avec votre clé de signature. Prism signe hors de la sandbox ; la clé n’y entre jamais. |
| Les commandes voient mes conteneurs | `sandbox.containers` | Lister vos conteneurs et images Docker ou Podman (`docker ps`, `docker images`), en lecture seule. |
| Les commandes lisent l'état des services | `sandbox.serviceState` | Lire l’état des services par D-Bus (`systemctl status`, `is-active`, `list-units`), sans modifier les services ni lire leur configuration. |
| Commandes en root (sudo) | `sandbox.sudo` | L’outil `sudo` ; consultez [Sudo contrôlé](permissions.md#sudo-contrôlé). |

## Voir et modifier la sandbox

`/sandbox` ouvre **/settings › Permissions et sandbox** sur l’état de la sandbox : si elle fonctionne, les chemins inscriptibles et masqués, et les hôtes autorisés. Sans interface interactive, il affiche le même résumé.

Les réglages se trouvent dans l’objet `sandbox` du `settings.json` global (`~/.prism/agent/settings.json`). Les réglages d’un projet, le modèle et `configure_prism` ne peuvent pas les modifier. Si ce fichier ne peut pas être lu, aucun outil ne s’exécute avant que vous le corrigiez.

```json
{
  "sandbox": {
    "modes": { "safe": true, "ask": true, "broad": true, "unrestricted": false },
    "allowWrite": ["~/.local/share/pnpm"],
    "hide": ["~/Documents/private"],
    "network": { "askNewHosts": true, "allow": ["registry.npmjs.org", "*.github.com"], "deny": [] },
    "excludedCommands": ["docker"],
    "userCommands": false,
    "read": { "limit": "project", "allow": ["~/Documents/specs"] }
  }
}
```

## Limites

- La sandbox enferme les commandes, pas Prism lui-même. Les extensions, les serveurs MCP et de langage, et les outils de fichiers s’exécutent avec les permissions de votre compte ; les règles de chemins de l’étape de permissions cherchent des motifs, ce n’est pas une isolation.
- Un hôte autorisé l’est pour ce que la commande y envoie. Le proxy n’examine pas ce qu’un programme autorisé fait de sa connexion.
- La sandbox partage le noyau de votre système. Pour une frontière plus forte autour de tout le processus Prism, consultez [Conteneuriser Prism](containerization.md).
