# Laisser l’agent utiliser votre navigateur

Avec le module `browser`, l’agent ouvre et utilise des pages web dans votre propre navigateur, par l’extension de navigateur Prism : il lit les pages, clique, saisit du texte, fait défiler et prend des captures d’écran. Il ne travaille que dans les onglets qu’il a ouverts lui-même ; vos autres onglets restent hors de sa portée. Vous êtes connecté à vos propres sites dans ce navigateur : ne lui demandez que ce que vous feriez vous-même.

## L’activer

1. Activez le module : **/settings › Modules › Votre navigateur (extension Prism)**, ou `"+builtin:browser"` dans le réglage `extensions`. Il est désactivé par défaut.
2. Lancez `/browser setup`. La configuration guidée :
   - demande quel navigateur installé utiliser : Firefox et les navigateurs construits sur lui (Zen, LibreWolf, Waterfox), ou Chrome et les navigateurs construits sur Chromium (Chromium, Brave, Vivaldi, Edge, Opera) ;
   - déclare l’hôte natif de Prism à ce navigateur, pour que l’extension puisse joindre Prism (et, pour un navigateur Flatpak, demande avant de l’autoriser à lancer Prism hors de son bac à sable) ;
   - ouvre la page de l’extension dans la boutique : [addons.mozilla.org](https://addons.mozilla.org) pour la famille Firefox, le Chrome Web Store pour la famille Chromium, ou explique comment la charger depuis un dossier pour un navigateur sans boutique ;
   - attend que l’extension se connecte, puis ouvre, lit et ferme un onglet à elle pour vérifier le lien.

La première utilisation du navigateur par l’agent vous pose la question, même en mode `broad`.

## Commandes

| Commande | Ce qu’elle fait |
|---|---|
| `/browser` | Les navigateurs liés et leur état |
| `/browser setup` | La configuration guidée ; aussi pour lier un autre navigateur |
| `/browser resume` | Rendre le contrôle après l’avoir arrêté depuis le navigateur |
| `/browser firefox` | Relancer Firefox avec le contrôle à distance, pour de vrais clics et de vraies touches plutôt que des clics par script |

## Contrôle et limites

- **L’arrêter depuis le navigateur.** Dans la famille Chromium, fermer la barre qui signale le débogage du navigateur arrête aussitôt le contrôle de l’agent, y compris une action en cours ; `/browser resume` le lui rend.
- **Réseau.** Chaque page que l’agent ouvre passe par les questions réseau de Prism : un site jamais autorisé vous est demandé, et une redirection vers un autre site est vérifiée de nouveau.
- **Le contenu des pages est une donnée.** Le texte d’une page peut tenter d’orienter le modèle. L’[avertissement d’injection](permissions.md#avertissement-dinjection-de-prompt) de Prism vérifie ce que l’outil renvoie ; il réduit le risque sans le supprimer.
- **Hors de la sandbox.** Le navigateur tourne sous votre nom, avec vos sessions et vos cookies. La [sandbox](sandbox.md) ne le couvre pas.
- **Version.** Prism vous prévient quand l’extension installée n’est pas la version qu’il attend.
