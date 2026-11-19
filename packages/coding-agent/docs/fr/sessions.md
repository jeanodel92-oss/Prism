# Sessions et contexte

Prism enregistre une conversation sous forme de session. Les sessions persistantes sont stockées au format JSONL, un fichier texte contenant un objet JSON par ligne. La branche active fournit l’historique de la conversation pour la prochaine demande au modèle. Utilisez les commandes de session pour continuer, explorer une autre branche ou réduire la quantité d’historique envoyée au modèle.

## Continuer ou changer de session

Prism enregistre automatiquement les sessions, sauf si vous le démarrez avec `--no-session`.

```bash
prism --continue
prism --resume
```

`--continue` ouvre la session la plus récente du dossier de travail actuel. `--resume` ouvre le sélecteur de session. En mode interactif, `/resume` ouvre le même sélecteur et `/new` démarre une session.

Utilisez `/name` ou `--name` pour donner un nom facile à reconnaître à une session. Exécutez `/session` pour vérifier le fichier, l’identifiant, le nombre de messages, l’utilisation de tokens et le coût de la session actuelle.

Le sélecteur de session permet de rechercher, renommer et supprimer des sessions. Il peut aussi afficher les chemins, modifier le tri et limiter les résultats aux sessions nommées. Consultez [Raccourcis clavier](keybindings.md#sessions) pour ses raccourcis.

## Choisir comment créer une branche

Prism enregistre les entrées sous forme d’arbre : revenir à un point antérieur n’efface pas la branche que vous quittez.

| Action | Résultat | À utiliser quand |
|---|---|---|
| `/tree` | Se déplacer dans le fichier de session actuel | Vous voulez garder ensemble des options liées |
| `/fork` | Créer une session à partir d’un ancien message utilisateur | Vous voulez traiter l’autre option dans un travail séparé |
| `/clone` | Copier la branche active dans une nouvelle session | Vous voulez une copie distincte de l’état actuel |

Dans `/tree`, choisissez un message utilisateur pour remettre son texte dans l’éditeur. Modifiez-le et envoyez-le pour créer une autre branche. Si vous choisissez une réponse de l’assistant ou une autre entrée, la session continue après cette entrée et l’éditeur est vide.

Quand vous quittez une branche, Prism peut en faire un résumé et l’ajouter à la branche que vous rejoignez. Le travail pertinent du chemin abandonné est ainsi conservé sans reprendre tous ses messages.

Pour connaître les entrées enregistrées et leurs types, consultez le [format des sessions](../session-format.md).

## Gérer le contexte de la conversation

Le modèle reçoit la branche active, et non toutes les branches du fichier de session. Prism combine cet historique au prompt système, aux fichiers de contexte trouvés, aux outils disponibles et aux descriptions des skills chargés. [Fonctionnement de Prism](how-pi-works.md#contexte) explique comment ces éléments sont assemblés.

La barre du bas affiche l’utilisation actuelle du contexte. Quand le contexte approche de la limite du modèle, Prism compacte normalement l’historique ancien automatiquement. Le compactage ajoute un résumé et conserve les messages récents. Il ne supprime pas les entrées d’origine de la session.

Exécutez `/compact` pour lancer le compactage manuellement. Vous pouvez préciser les sujets ou décisions que le résumé doit conserver. Configurez le compactage automatique et l’historique conservé dans [Réglages](settings.md#compactage).

Le compactage peut échouer si le fournisseur est indisponible ou ne peut pas accepter la demande de résumé. Corrigez le problème du fournisseur et exécutez de nouveau `/compact`. Désactiver le compactage automatique ne désactive pas la commande manuelle.

Consultez la [référence du compactage](../compaction.md) pour connaître les seuils, les limites de conservation, le résumé des branches et les hooks d’extension.

## Contrôler l’emplacement des sessions

Par défaut, Prism stocke les sessions dans `~/.prism/agent/sessions/`, en les regroupant par dossier de travail. Utilisez `--session-dir`, `PRISM_CODING_AGENT_SESSION_DIR` ou le réglage `sessionDir` pour choisir un autre emplacement. L’option CLI est prioritaire.

Utilisez `--no-session` pour une exécution temporaire. Vous ne pourrez pas reprendre la session temporaire après avoir quitté Prism.

Utilisez `--session` si vous connaissez déjà le chemin ou l’identifiant de la session. Utilisez `--fork` pour créer une session à partir d’une session existante avant le démarrage du mode interactif.

## Exporter ou partager une session

Utilisez `/export` pour enregistrer la session actuelle au format HTML ou JSONL. Utilisez `/share` pour la téléverser et obtenir un lien de consultation. Prism utilise un élément Radius si l’authentification Radius est configurée ; sinon, il utilise un gist GitHub privé.

Examinez les sessions exportées ou partagées. Elles peuvent contenir des prompts, des réponses de modèles, des arguments d’outils, des sorties de commandes, le contenu de fichiers et des messages d’extensions.

## Signaler un bogue

Exécutez `/bug [description]` pour préparer un signalement privé à l’équipe Prism. Vous pouvez inclure la transcription de la session, l’omettre ou demander au modèle actuel de résumer le problème. Examinez la transcription ou le résumé généré : il peut contenir des informations sensibles de la conversation.

Le signalement contient des informations sur l’environnement et la configuration du fournisseur, mais pas les valeurs des identifiants, ainsi que les diagnostics d’erreur enregistrés. Téléversez-le avec `radius.pi.dev` ou exportez le même rapport dans une archive zip pour l’examiner et le partager vous-même. Aucun compte n’est nécessaire pour le téléversement ; l’authentification Radius associe le rapport à votre compte pour que l’équipe puisse vous répondre. Si le téléversement échoue, Prism propose d’exporter l’archive zip.
