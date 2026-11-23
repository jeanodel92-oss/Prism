# Exécuter Prism dans un environnement isolé

La [sandbox](sandbox.md) de Prism enferme déjà les commandes shell de l’agent dans les modes `safe`, `ask` et `broad`. Utilisez un conteneur ou une machine virtuelle si vous voulez aussi enfermer le processus de Prism lui-même, ses extensions et ses outils de fichiers, ou tenir toute la session à l’écart de votre machine. Sur cette page, « environnement isolé » désigne ce conteneur ou cette machine virtuelle.

Vous pouvez isoler tout le processus Prism, ou garder Prism sur l’hôte et rediriger certains outils vers un environnement isolé.

## Choisir une méthode d’isolation

| Méthode | Où Prism s’exécute | Éléments isolés | Gestion des identifiants | Idéal pour |
|---|---|---|---|---|
| Docker standard | Conteneur | Prism, outils intégrés, commandes `!` et extensions | Identifiants transmis au conteneur | Une limite d’isolation simple sur la machine locale |
| Docker Sandboxes | Environnement isolé géré | pi upstream (pas d’image Prism), ses outils et extensions | Les identifiants fournisseur restent sur l’hôte ; le proxy les remplace | Une isolation locale gérée sans exposer la véritable clé fournisseur |
| OpenShell | Environnement isolé local ou distant | pi upstream (pas d’image Prism), ses outils et extensions | Identifiants et routage des requêtes soumis à des règles | Des règles sur les fichiers, processus, réseau et identifiants |
| Extension Gondolin | Hôte | Outils intégrés et commandes `!` | Les identifiants Prism enregistrés restent sur l’hôte, mais les commandes héritent des variables d’environnement de l’hôte | Une micro-machine virtuelle locale pour exécuter les outils tout en gardant l’interface sur l’hôte |

La méthode choisie détermine où les extensions s’exécutent. Si tout le processus Prism fonctionne dans un environnement isolé, ses extensions y fonctionnent aussi. Si Prism sur l’hôte redirige ses outils intégrés par Gondolin, les autres outils des extensions restent sur l’hôte, sauf s’ils redirigent aussi leur travail.

## Déterminer ce à quoi Prism peut accéder

Un processus isolé peut tout de même affecter les ressources que vous lui exposez :

- Un montage en lecture et écriture de l’hôte permet à Prism de modifier ces fichiers.
- Le montage de `~/.prism/agent` expose les identifiants, réglages, extensions et sessions Prism.
- Les variables d’environnement transmises à un conteneur sont accessibles aux processus qui s’y exécutent.
- L’accès au réseau peut permettre à du code ou aux résultats d’outils de quitter l’environnement.
- L’isolation limitée aux outils ne restreint ni le processus Prism sur l’hôte ni les outils d’extension qui n’utilisent pas le système isolé.

N’exposez que le dossier de travail, les identifiants et les destinations réseau nécessaires à la tâche. Utilisez des montages en lecture seule ou copiez les fichiers vers l’environnement puis hors de celui-ci si vous ne voulez pas que les écritures affectent l’hôte.

## Exécuter Prism dans Docker standard

Docker standard fournit la limite de conteneurisation la plus simple pour tout le processus.

### Construire l’image

Créez un fichier `Dockerfile` :

```dockerfile
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash bubblewrap ca-certificates curl git openssl ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://prism.odelserver.space/install.sh | sh \
  && ln -s /root/.local/bin/prism /usr/local/bin/prism

WORKDIR /workspace
ENTRYPOINT ["prism"]
```

Construisez l’image depuis le dossier qui contient le fichier :

```bash
docker build -t prism .
```

Podman accepte les mêmes commandes (`podman build`, `podman run`).

### Démarrer Prism

Depuis le dossier de travail auquel vous voulez donner accès à Prism, exécutez :

```bash
docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace:Z" \
  -v prism-agent-home:/root/.prism/agent \
  prism
```

Remplacez `ANTHROPIC_API_KEY` par l’identifiant requis par votre fournisseur. Le volume nommé `prism-agent-home` conserve les réglages, identifiants et sessions du conteneur entre les exécutions.

Le suffixe `:Z` réétiquette le dossier pour SELinux (Fedora, RHEL et les autres systèmes où SELinux est appliqué). Sans lui, le dossier est monté, mais Prism ne peut pas y écrire. Il est sans effet sur les systèmes sans SELinux.

Pour une seule tâche sans interface, comme en CI, passez le prompt avec `-p` :

```bash
docker run --rm -e ANTHROPIC_API_KEY -v "$PWD:/workspace:Z" prism -p "Run the tests and summarize the failures"
```

Consultez [Automatisation](automation.md) pour ce que font les permissions sans interface.

### La sandbox de Prism dans le conteneur

L’image installe `bubblewrap` : la sandbox de Prism peut donc fonctionner dans le conteneur, quand l’environnement d’exécution des conteneurs permet les espaces de noms utilisateur dont elle a besoin. Beaucoup les refusent par défaut (le profil seccomp par défaut de Docker, par exemple). Prism dit alors au démarrage que la sandbox ne fonctionne pas, et les commandes shell de l’agent restent bloquées. Dans ce cas, le conteneur sert de frontière : désactivez la sandbox de Prism pour le conteneur dans `/settings` › Permissions et sandbox › Dans les modes. Le réglage est gardé dans le volume `prism-agent-home`, pas sur votre machine.

Ne montez pas le dossier `~/.prism/agent` de l’hôte, sauf si vous voulez que le conteneur accède à la configuration et aux identifiants Prism de l’hôte.

### Vérifier l’espace de travail

Dans Prism, exécutez :

```text
!pwd
```

La commande doit afficher `/workspace`. Les changements dans `/workspace` sont écrits dans le dossier de l’hôte monté. Supprimez le montage lié ou utilisez un montage en lecture seule (`:ro`) si cela ne vous convient pas.

## Exécuter Prism avec Docker Sandboxes

[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) exécute tout le processus Prism dans un environnement isolé géré. Son proxy peut garder le véritable identifiant fournisseur sur l’hôte et le remplacer lorsque les demandes quittent l’environnement.

Le kit Pi installe pi upstream, pas Prism ; les commandes ci-dessous démarrent `pi`. Il n’existe pas de kit Prism : utilisez [Docker standard](#executer-prism-dans-docker-standard) pour isoler Prism lui-même.

Configurez les identifiants avant de créer l’environnement isolé. N’exécutez pas `/login` dans cet environnement, car cela y écrirait un véritable identifiant.

### Utiliser un jeton Claude Pro ou Max

Générez le jeton avec `claude setup-token` sur un ordinateur doté de Claude Code. Si un secret `anthropic` est déjà configuré, supprimez-le d’abord pour éviter que le proxy ajoute un en-tête de clé API en plus du jeton bearer :

```bash
sbx secret rm anthropic

sbx secret set-custom \
  --host api.anthropic.com \
  --env ANTHROPIC_OAUTH_TOKEN \
  --placeholder 'sk-ant-oat01-{rand}'
```

`sbx secret set-custom` lit le véritable jeton depuis l’entrée standard. L’environnement isolé reçoit un jeton factice au format OAuth que le proxy remplace uniquement pour les demandes vers l’hôte configuré.

Pour une clé API Anthropic, utilisez plutôt `sbx secret set anthropic`.

### Démarrer Prism

Exécutez cette commande depuis le dossier de travail que vous voulez monter :

```bash
sbx run --kit "docker.io/sbx/pi-kit:latest" pi
```

Pour un environnement isolé existant, exécutez Prism sans interface avec :

```bash
sbx exec <sandbox-name> -- pi -p "list the failing tests"
```

Consultez la [documentation du kit Pi](https://github.com/docker/sbx-kits-contrib/tree/main/pi) pour les autres fournisseurs, le dépannage et l’épinglage d’image.

## Exécuter Prism avec OpenShell

[NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) fournit des environnements isolés locaux ou distants avec des règles sur les fichiers, processus, réseaux, identifiants et requêtes.

### Sélectionner une passerelle

Chaque environnement isolé nécessite une passerelle active :

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

### Créer l’environnement isolé

L’image communautaire `pi` exécute pi upstream, pas Prism. Il n’existe pas d’image Prism ; utilisez [Docker standard](#executer-prism-dans-docker-standard) pour isoler Prism lui-même.

```bash
openshell sandbox create --name pi-sandbox --from pi -- pi
```

Prism, ses outils intégrés, les commandes `!` et les outils d’extension s’exécutent à l’intérieur de la limite OpenShell.

### Transférer des fichiers vers un environnement distant

Une passerelle distante ne monte pas le dossier de travail de l’hôte. Clonez le dépôt dans l’environnement isolé ou transférez les fichiers explicitement :

```bash
openshell sandbox upload pi-sandbox ./working-folder /workspace
openshell sandbox download pi-sandbox /workspace/working-folder ./working-folder-out
```

Le routage des requêtes OpenShell peut garder les identifiants bruts du modèle en dehors de l’environnement. Une fois ce routage configuré, indiquez à Prism le point de terminaison compatible OpenAI ou Anthropic correspondant, exposé par la passerelle.

## Rediriger les outils par Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) est une micro-machine virtuelle Linux locale. Son extension d’exemple garde le processus Prism et les identifiants fournisseur dans des fichiers sur l’hôte, tout en redirigeant les outils intégrés et les commandes `!` de l’utilisateur vers la machine virtuelle.

Les commandes de la machine virtuelle héritent de l’environnement du processus hôte. Les clés fournisseur fournies par des variables d’environnement peuvent donc y être visibles. N’utilisez pas cette méthode pour isoler les identifiants, sauf si vous supprimez les variables sensibles ou modifiez la gestion de l’environnement de l’extension.

Gondolin nécessite Node.js 23.6 ou une version ultérieure et QEMU installé par le gestionnaire de paquets de votre système d’exploitation.

### Installer l’extension

Depuis une copie du code source de Prism :

```bash
mkdir -p ~/.prism/agent/extensions
cp -R packages/coding-agent/examples/extensions/gondolin ~/.prism/agent/extensions/gondolin
cd ~/.prism/agent/extensions/gondolin
npm install --ignore-scripts
```

### Démarrer Prism

Lancez Prism depuis le dossier de travail que vous voulez monter :

```bash
cd /path/to/working-folder
prism -e ~/.prism/agent/extensions/gondolin
```

L’extension monte le dossier de travail de l’hôte à `/workspace` dans la machine virtuelle et remplace `read`, `write`, `edit`, `bash`, `grep`, `find` et `ls`. Les changements dans `/workspace` sont écrits dans les fichiers de l’hôte.

Les autres outils d’extension restent sur l’hôte, sauf s’ils redirigent explicitement leurs opérations. Consultez l’[exemple Gondolin](../../examples/extensions/gondolin/) avant d’ajouter des outils qui pourraient contourner la limite de la machine virtuelle.
