# Utiliser Prism en toute sécurité

Traitez les commandes et le code générés par le modèle comme non fiables. Prism lit, modifie et exécute des fichiers pour le compte qui l’a lancé. Deux protections limitent ce qu’une action générée peut faire :

- L’[étape de permissions](permissions.md) décide si chaque appel d’outil s’exécute. Dans le [mode](permissions.md#modes) par défaut, `broad`, l’agent travaille dans le projet sans demander, et demande avant de sortir du projet, avant `sudo` et avant les appels qu’il détecte comme dangereux.
- La [sandbox](sandbox.md) (environnement isolé des commandes) enferme les commandes shell de l’agent dans les modes `safe`, `ask` et `broad` : elles ne peuvent modifier que le projet, ne voient ni les identifiants de Prism ni vos clés, et ne joignent que les hôtes réseau que vous autorisez.

Les fichiers, commentaires, consignes, sorties de commandes, pages web et réponses du modèle peuvent orienter le modèle par injection de prompt. L’[avertissement d’injection](permissions.md#avertissement-dinjection-de-prompt) de Prism met l’agent en pause sur un résultat d’outil suspect ; il réduit le risque sans le supprimer. La confiance accordée au projet détermine quelles ressources du projet se chargent au démarrage, mais elle ne rend ni ce contenu ni les actions qui en découlent sûrs.

## Ce que les protections ne couvrent pas

- **Le processus de Prism lui-même.** Les extensions, les serveurs MCP, les serveurs de langage et les outils de fichiers s’exécutent avec les permissions de votre compte, hors de la sandbox. Les règles de chemins de l’étape de permissions cherchent des motifs : ce n’est pas une isolation.
- **Le mode `unrestricted`.** Il ne demande rien, et ses commandes s’exécutent hors de la sandbox, sauf si vous l’activez pour ce mode.
- **Ce que vous autorisez.** Une commande que vous excluez de la sandbox, l’outil `sudo`, un hôte que vous autorisez ou une action que vous approuvez fait ce qu’il fait.

## Choisir comment exécuter Prism

| Comment Prism s’exécute | Ce qui reste protégé |
|---|---|
| Directement, avec la sandbox (par défaut en `safe`, `ask` et `broad`) | Les commandes shell de l’agent ne peuvent ni modifier des fichiers hors du projet et de ses caches, ni lire les chemins masqués, et ne joignent que les hôtes autorisés. Prism lui-même, ses extensions et les outils de fichiers gardent les permissions de votre compte. |
| Directement, sans la sandbox | Seulement ce à quoi votre utilisateur système n’a pas accès. Un compte dédié peut réduire ces permissions. |
| Entièrement dans un conteneur ou une machine virtuelle | Les fichiers et processus de l’hôte que vous n’exposez pas. Les identifiants et services réseau restent accessibles si vous les y rendez disponibles. Cela enferme aussi le processus de Prism et ses extensions. |

Le dossier de travail détermine la découverte des ressources et l’emplacement par défaut des outils. Sans la sandbox, il n’empêche pas les commandes d’atteindre d’autres chemins accessibles au processus Prism.

Quelle que soit l’option, ne fournissez que les fichiers et services nécessaires à la tâche, préférez des identifiants à portée réduite et de courte durée, et n’autorisez que les hôtes réseau dont une tâche a besoin. Pour les conteneurs et machines virtuelles, consultez [Conteneuriser Prism](containerization.md).

<a id="secrets"></a>

## Secrets

- **Où sont gardés les identifiants.** Un identifiant que vous ajoutez avec `/login` va dans le trousseau du système (Secret Service, par l’outil `secret-tool` de libsecret) quand il fonctionne ; `auth.json` n’en garde alors qu’un repère. Sans trousseau, il va dans `~/.prism/agent/auth.json` (mode `0600`), avec un avertissement, et `/doctor` le signale. Un trousseau verrouillé n’est pas traité comme absent : rien n’est écrit, et Prism vous demande de le déverrouiller. `PRISM_SECRET_SERVICE=off` désactive le trousseau. Les clés déjà en clair dans `auth.json` y restent jusqu’à ce que vous les déplaciez avec **Déplacer les identifiants vers le trousseau** dans `/settings`.
- **Ce que voient les commandes de l’agent.** Les variables d’environnement qui ressemblent à des clés, jetons ou mots de passe, les sockets d’agents d’identité comme `SSH_AUTH_SOCK`, et toute variable qui contient une clé gardée par Prism sont retirées des commandes de l’agent, dans la sandbox ou non ; leurs valeurs ne sont jamais affichées. Vos propres commandes `!` gardent votre environnement. Pour transmettre une variable à une commande, ajoutez une règle dans **Variables cachées aux commandes** de `/settings` (`"secrets": { "passEnv": { "GITHUB_TOKEN": ["bash(gh *)"] } }` dans le `settings.json` global). Le réglage `secrets.envAllowlist` va plus loin : les commandes ne reçoivent alors que les variables connues et sans risque, et celles que vous listez dans `secrets.allowEnv`.
- **Ce qui sort de Prism.** Les clés gardées par Prism sont masquées sous la forme `[secret hidden: …]` dans ce qu’il envoie au modèle, dans les sessions, exports, partages, traces et `/doctor export`.
- **Ce que la sandbox masque.** Les commandes de la sandbox ne peuvent lire ni `~/.prism` (identifiants, permissions, confiance), ni les emplacements habituels des identifiants ; consultez [La sandbox](sandbox.md#ce-quune-commande-peut-faire-dans-la-sandbox).

Le modèle ne peut jamais modifier le mode de permissions, les règles de permissions, les décisions de confiance, les réglages `sandbox` et `secrets` ni les identifiants enregistrés, quel que soit le mode.

<a id="privacy"></a>

## Vie privée

Prism n’envoie aucune télémétrie : ni rapport d’installation, de mise à jour ou d’usage, ni mesure d’audience. De lui-même, il ne se connecte qu’à :

- les fournisseurs et serveurs de modèles que vous configurez, pour chaque requête ;
- `https://pi.dev`, pour rafraîchir le catalogue des modèles cloud des fournisseurs auxquels vous êtes connecté, au plus toutes les 4 heures (désactivez-le avec **Mettre à jour le catalogue des modèles** dans `/settings`, ou `"modelCatalogRefresh": false`) ;
- `https://prism.odelserver.space`, seulement quand vous lancez `/update` ou `prism update`, ou quand le réglage `updateMode` lui demande de vérifier au démarrage (désactivé par défaut) ;
- GitHub, pour télécharger `fd` ou `rg` la première fois qu’un outil en a besoin et qu’ils ne sont pas installés.

Les autres connexions suivent une action de votre part : `/login`, outils web, serveurs MCP, installation de paquets, `/share`, lien avec le téléphone. `--offline` (ou `PI_OFFLINE=1`) coupe les connexions automatiques.

**Sign in with ChatGPT** (la connexion par abonnement ChatGPT) envoie à OpenAI un identifiant aléatoire de cette installation (`deviceId`, un UUID gardé dans le `settings.json` global et créé à la première connexion de ce type), comme paramètre `ext_agent_host_id` de l’adresse d’autorisation. Il relie les connexions ChatGPT faites depuis la même installation. Il n’est envoyé ni avec les requêtes au modèle ni au renouvellement des jetons. Supprimer `deviceId` de `settings.json` fait créer un nouvel identifiant à la connexion suivante.

<a id="project-trust"></a>

## Comprendre la confiance accordée au projet

La confiance accordée au projet détermine si Prism charge la plupart des réglages et ressources fournis par un dossier de travail. Elle empêche un dossier de charger discrètement des extensions exécutables avant votre approbation.

La confiance accordée au projet ne constitue pas une frontière complète au démarrage. Prism lit le réglage de projet `sessionDir` lorsqu’il sélectionne ou crée une session, avant de vérifier la confiance accordée au projet. Refuser cette confiance empêche ensuite le chargement des autres réglages de projet et des ressources protégées, mais n’annule pas cette consultation initiale du dossier de session.

La confiance accordée au projet ne limite pas les éléments auxquels les appels d’outils peuvent accéder ou qu’ils peuvent affecter. Une fois Prism démarré, les outils activés disposent toujours des permissions du système d’exploitation accordées au processus Prism. Le contenu et les consignes du dossier peuvent aussi influencer le modèle.

### Ressources protégées par la confiance accordée au projet

Prism demande une décision de confiance quand il trouve l’une de ces ressources dans le dossier de travail actuel :

- `.prism/settings.json`
- `.prism/mcp.json`
- `.prism/extensions`, `.prism/skills`, `.prism/prompts` ou `.prism/themes`
- `.prism/SYSTEM.md` ou `.prism/APPEND_SYSTEM.md`
- `.agents/skills` du projet, dans le dossier actuel ou l’un de ses dossiers parents

La présence d’un dossier `.prism` vide ne nécessite pas de décision de confiance.

Accorder sa confiance au projet permet à Prism de charger :

- les réglages du projet
- les serveurs MCP du projet indiqués dans `.prism/mcp.json`
- les extensions, skills, modèles de prompt, thèmes et fichiers de prompt système du dossier `.prism`
- les packages manquants configurés dans les réglages du projet
- les extensions locales au projet et à ses packages

Refuser cette confiance ignore ces ressources protégées, à l’exception de la consultation initiale de `sessionDir` décrite plus haut.

Les fichiers de contexte comme `AGENTS.override.md`, `AGENTS.md` et `CLAUDE.md` sont chargés même si le projet n’est pas approuvé, sauf si vous désactivez le chargement du contexte. Considérez les consignes d’un dossier comme des données non fiables, même si vous refusez d’accorder votre confiance au projet.

### Comment Prism prend une décision de confiance

Les options de ligne de commande `--approve` ou `--no-approve` sont prioritaires. Si des ressources protégées existent et qu’aucune de ces options n’est définie :

1. Les extensions de niveau utilisateur ou de ligne de commande peuvent gérer l’événement `project_trust`. La première extension qui renvoie yes ou no prend la décision.
2. Si aucune extension ne décide, Prism cherche une décision enregistrée pour le dossier actuel ou l’un de ses dossiers parents. La décision du dossier le plus proche s’applique.
3. Si aucune décision enregistrée ne s’applique, Prism suit le réglage global `defaultProjectTrust`, défini par défaut à `"ask"`.

Les décisions enregistrées utilisent des chemins de dossier canoniques et se trouvent dans :

```text
~/.prism/agent/trust.json
```

Utilisez `/trust` pour enregistrer une décision pour les prochains processus Prism.

### Confiance dans un projet sans demande interactive

Les modes d’affichage, JSON et RPC ne peuvent pas afficher la demande de confiance intégrée. Si aucune option de ligne de commande, extension ou décision enregistrée ne s’applique :

- `defaultProjectTrust: "always"` charge les ressources protégées du projet.
- `defaultProjectTrust: "ask"` ou `"never"` les ignore.

Utilisez `--approve` ou `--no-approve` si une exécution automatisée nécessite une décision explicite pour une seule fois.

## Réduire les conséquences et faciliter le rétablissement

Ces pratiques ne remplacent pas l’isolation, mais elles réduisent les risques ou facilitent le rétablissement :

- Donnez à Prism accès uniquement aux fichiers et services nécessaires à la tâche.
- Prenez des instantanés ou des sauvegardes, ou utilisez un système de gestion de versions avant les modifications importantes.
- Examinez les extensions et les packages avant leur chargement. Les extensions s’exécutent dans le processus Prism.
- Privilégiez les identifiants temporaires aux permissions limitées.
- Examinez les différences et les résultats générés avant de les appliquer à un autre système.
- Examinez les sessions avant de les exporter ou de les partager. Elles peuvent contenir des prompts, des arguments d’outils, les résultats de commandes, le contenu de fichiers et des identifiants révélés pendant la conversation.

## Signaler un problème de sécurité

Signalez une faille en privé, avec le bouton **Report a vulnerability** de l’onglet Security du dépôt de Prism, comme le dit sa [politique de sécurité](../../../../SECURITY.md) (`SECURITY.md` à la racine du dépôt, en anglais). La page [Code source](https://prism.odelserver.space/fr/source/) du site de Prism mène au dépôt. Ne publiez pas de problème de sécurité dans une issue publique.

La politique liste ce que Prism garantit (sandbox, permissions, secrets, règles réseau, rendu, confiance des dossiers, lien avec le téléphone, extension de navigateur et bureau, mises à jour signées) et ce qui est hors périmètre : le mode `unrestricted` et les actions que vous avez approuvées, l’injection de prompt qui reste dans ce que le mode en cours permet, les extensions et paquets que vous installez, et le comportement des fournisseurs de modèles.

Pour les autres défauts, consultez [Signaler un problème](doctor.md#signaler-un-problème).
