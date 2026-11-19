# Fonctionnement de Prism

Prism coordonne les demandes au modèle, l’exécution des outils, la préparation du contexte et l’enregistrement des sessions. Une session est le relevé d’une conversation par Prism : elle comprend les messages, les appels d’outils et leurs résultats, les changements de modèle, les compactages et d’autres événements.

Les messages et événements d’une session forment un arbre. Chaque chemin dans cet arbre est une branche. La branche qui se termine à l’entrée actuelle est la branche active ; son historique sert à la prochaine demande au modèle.

## Boucle de l’agent

Un message envoyé est ajouté à la branche active. Prism prépare une demande au modèle à partir du prompt système, de la branche active, des outils disponibles et des réglages du modèle, puis l’envoie au fournisseur choisi.

Le fournisseur transmet la réponse de l’assistant au fil de sa génération. Elle peut contenir du texte et des appels d’outils. Prism enregistre la réponse, exécute chaque appel d’outil et enregistre les résultats. Le tour est alors terminé. Si les résultats des outils ou des messages mis en attente exigent une autre demande au modèle, Prism commence un nouveau tour. Sinon, l’exécution prend fin.

Les messages de guidage sont ajoutés après le tour actuel de l’assistant. Les messages de suivi sont ajoutés une fois que l’agent a fini le travail en attente. L’interruption arrête l’exécution en cours et renvoie les messages mis en attente dans l’éditeur.

## Contexte

La branche active fournit l’historique de la conversation. Prism convertit les entrées de session en messages utilisateur, assistant et résultats d’outils compatibles avec le modèle.

Prism construit le prompt système à partir de ses consignes de base et des fichiers de contexte trouvés. La demande contient aussi les définitions des outils et les descriptions des skills.

Les consignes complètes des skills sont chargées à la demande. Les extensions peuvent ajouter des consignes ou transformer le contexte.

Les modèles de prompt développent la saisie de l’éditeur avant sa conversion en message utilisateur. Les fichiers sélectionnés, images, textes collés et sorties du shell peuvent être ajoutés au contenu du message.

## Sessions

Les sessions persistantes sont des fichiers JSONL. Chaque entrée de l’arbre a un identifiant et indique son parent. L’entrée actuelle désigne la branche active.

Continuer depuis une ancienne entrée crée une autre branche dans le même fichier. Créer une branche indépendante ou cloner une session copie l’historique choisi dans un nouveau fichier de session.

Le contexte du modèle est reconstitué à partir de la branche active. Le compactage ajoute une entrée de résumé qui remplace les messages plus anciens dans les demandes suivantes au modèle. Les entrées d’origine restent dans l’arbre de session.

## Interfaces

Le mode interactif affiche les événements de session et d’agent dans le terminal. Le mode d’affichage exécute un prompt et écrit la réponse finale. Le mode JSON écrit les événements de l’agent au format JSONL.

Le mode RPC accepte des commandes JSONL sur stdin et écrit les réponses et événements sur stdout. Le SDK TypeScript crée et contrôle des sessions d’agent dans le processus.

Toutes les interfaces utilisent les mêmes mécanismes d’agent et de session.

## Extensions et ressources

Les extensions sont des modules TypeScript chargés dans le processus Prism. Leurs fonctions de création enregistrent des outils, commandes, raccourcis, fournisseurs, gestionnaires d’événements, moteurs de rendu et interfaces de terminal.

Les skills fournissent des consignes et des fichiers utiles chargés à la demande. Les modèles de prompt fournissent du texte réutilisable pour les messages. Les thèmes définissent les couleurs du terminal. Les packages Prism distribuent ces ressources avec npm ou git.

## Confiance et permissions

Prism vérifie la confiance accordée au projet avant de charger ses réglages et ressources. Après cette vérification et le chargement des ressources du projet, Prism charge les fichiers de contexte. Les outils activés utilisent les permissions du système d’exploitation accordées au processus Prism. Les extensions s’exécutent à l’intérieur de ce processus.
