# Utiliser Prism en toute sécurité

Considérez les commandes et le code générés par un modèle comme non fiables. Prism peut lire, modifier et exécuter des fichiers avec les permissions du compte qui l’a lancé. Dans le [mode de permission](permissions.md#modes) par défaut, `broad`, il travaille dans le projet sans demander, et demande avant de sortir du projet, avant `sudo` et avant les appels qu’il juge dangereux. À moins qu’une limite du système d’exploitation ou de virtualisation ne les restreigne, les extensions, installateurs de packages, serveurs de langage et autres processus enfants disposent des mêmes permissions.

Les fichiers, commentaires, consignes, résultats de commandes et réponses du modèle peuvent orienter celui-ci par injection de prompt. La confiance accordée au projet détermine quelles ressources de projet sont chargées au démarrage ; elle ne rend ni leur contenu ni les actions qui en découlent sûrs.

La sécurité repose sur la limitation des fichiers, identifiants, processus et services réseau que Prism peut consulter et affecter si une action générée est erronée ou hostile. Surveiller la transcription, faire confiance au projet et examiner les modifications ne créent pas de frontière de sécurité.

## Choisir comment exécuter Prism

Les différentes façons d’exécuter Prism limitent différemment l’accès des commandes générées :

| Exécution de Prism | Éléments qui restent protégés |
|---|---|
| Directement, avec les permissions de son utilisateur dans le système d’exploitation | Tout ce à quoi cet utilisateur n’a pas accès. Un compte réservé à Prism peut réduire ces permissions, mais Prism partage toujours le système d’exploitation et le réseau avec les autres utilisateurs. |
| Entièrement dans un conteneur, une machine virtuelle ou un environnement isolé | Les fichiers et processus de l’hôte que vous n’exposez pas à l’environnement. Les identifiants et services réseau restent accessibles si vous les y rendez disponibles. C’est généralement l’option pratique la plus sûre. |
| À l’extérieur de l’environnement isolé, avec seulement ses outils intégrés qui s’y exécutent | Les ressources de l’hôte sont protégées contre les actions réalisées par ces outils. Prism et les autres extensions restent hors de la frontière ; l’isolation est donc plus limitée. |

Le dossier de travail détermine où Prism trouve les ressources et où les outils travaillent par défaut. Il n’empêche pas les commandes d’accéder aux autres chemins auxquels le processus Prism a accès.

Quelle que soit l’option choisie, ne fournissez que les fichiers et services nécessaires à la tâche. Dans la mesure du possible, gardez les identifiants à l’extérieur de l’environnement ou utilisez des identifiants temporaires aux permissions limitées. Restreignez le réseau si les commandes n’en ont pas besoin.

Pour savoir comment configurer les méthodes d’isolation et quelles sont leurs limites, consultez [Exécuter Prism dans un environnement isolé](containerization.md).

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

Suivez la [politique de sécurité](https://github.com/earendil-works/pi/blob/main/SECURITY.md) du dépôt. Ne publiez pas de problème de sécurité dans une issue publique.

Le comportement attendu d’un agent local, l’injection de prompt depuis du contenu non fiable, l’absence d’environnement isolé intégré et le comportement d’extensions ou de skills installés par l’utilisateur ne font généralement pas partie de la frontière de sécurité, sauf si le signalement démontre un contournement de limite de privilège ou un accès que l’utilisateur local n’avait pas déjà.
