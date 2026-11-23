# Tâches planifiées

Une tâche planifiée exécute un prompt dans un dossier à heures fixes, sans personne au clavier : tests chaque nuit, vérification hebdomadaire des dépendances, résumé quotidien. `/schedule` crée, met en pause, reprend et supprime les tâches. La fenêtre les liste sous **Tâches planifiées** dans son menu latéral.

## Comment une tâche s’exécute

Chaque tâche est un minuteur utilisateur systemd qui lance `prism --scheduled <nom>`. Il n’y a pas de démon Prism.

- **Seulement quand vous êtes connecté.** Le minuteur appartient à votre session utilisateur. Prism n’active pas la persistance de session (`loginctl enable-linger`) : une tâche ne s’exécute pas quand vous êtes déconnecté, et une exécution prévue pendant que l’ordinateur est éteint ou votre session fermée ne part pas à l’heure.
- **Une exécution manquée.** À la création de la tâche, vous choisissez si une exécution manquée pendant que l’ordinateur était éteint est seulement signalée (recommandé) ou exécutée en retard, au démarrage suivant.
- **Personne à qui demander.** Une exécution ne peut pas poser de questions. Ce que couvre le périmètre de la tâche passe ; tout le reste est refusé, et les refus sont signalés. Une exécution n’obtient jamais d’appel dangereux.
- **Identifiants.** Une exécution lit la clé du fournisseur comme une session interactive. Un trousseau verrouillé fait échouer l’exécution : aucune clé n’est enregistrée en clair pour elle.
- **Résultats.** La conversation de chaque exécution est gardée dans son fichier de session. Les erreurs vont dans le journal du système (`journalctl --user -u <unité>`). Quand une exécution échoue ou a eu des actions refusées, une notification de bureau le signale, sauf si les notifications de bureau sont désactivées. Au démarrage interactif suivant, Prism liste les exécutions depuis votre dernière consultation ; `/schedule` montre les dernières exécutions de chaque tâche.

## Créer une tâche

`/schedule` › **Nouvelle tâche planifiée** demande, dans l’ordre :

1. ce que doit faire la tâche : le prompt que reçoit chaque exécution ;
2. son nom : lettres minuscules, chiffres et tirets, 40 au plus ;
3. quand : chaque jour, du lundi au vendredi ou chaque lundi à l’heure que vous donnez, chaque heure, ou n’importe quelle expression de calendrier systemd (`Mon..Fri 09:00`, `daily`, `*-*-* 06:30`) ;
4. si elle peut modifier les fichiers du projet ;
5. si elle peut lancer des commandes dans la [sandbox](sandbox.md), sauf les dangereuses ;
6. les hôtes auxquels elle peut se connecter (aucun par défaut) ;
7. une limite de durée et une limite d’appels d’outils par exécution ;
8. que faire d’une exécution manquée.

Prism montre alors tout ce que la tâche peut faire, le dossier, la prochaine exécution, le modèle et les fichiers d’unités systemd qu’il va écrire (dans `~/.config/systemd/user`). Rien n’est écrit avant que vous choisissiez **Créer la tâche**. La définition de la tâche est gardée dans `~/.prism/agent/scheduled/`.

Le modèle peut proposer une tâche (`propose_scheduled_task`), mais vous seul la créez, sur le même écran de confirmation.

## Prérequis et limites

- systemd avec les minuteurs utilisateur.
- Un Prism installé (version publiée ou paquet). Un Prism lancé depuis ses sources TypeScript ne peut pas planifier de tâches : un agent pourrait modifier ces sources avant que le minuteur les exécute.
- Le périmètre d’une tâche est fixé à sa création. Pour le changer, supprimez la tâche et créez-la de nouveau.
