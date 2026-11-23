# La fenêtre de Prism

Prism s’ouvre dans le terminal ou dans une fenêtre qui lui est propre. Les deux font tourner le même moteur : sessions, réglages, commandes, permissions et sandbox sont partagés, et une session commencée dans l’un peut être reprise dans l’autre.

## Ouvrir la fenêtre

```bash
prism --gui     # ouvrir la fenêtre pour ce lancement
prism --tui     # ouvrir l’interface du terminal pour ce lancement
prism           # suivre le réglage « Ouvrir Prism dans »
```

Le premier lancement où la fenêtre peut s’ouvrir pose la question une fois : **Dans sa fenêtre** ou **Dans le terminal**. Choisir la fenêtre ajoute Prism au menu des applications. **/settings › Interface › Ouvrir Prism dans** change ce choix ensuite (réglage `openIn`, `"terminal"` ou `"window"`, réservé au niveau global).

La fenêtre s’ouvre sur le dossier depuis lequel Prism a été lancé. Lancée depuis le menu des applications, elle reçoit le `PATH` de votre shell de connexion : l’agent trouve les mêmes programmes que dans un terminal.

## Prérequis

- Linux x64 avec une session graphique (Wayland ou X11) et glibc 2.39 ou plus récente (Debian 13, Ubuntu 24.04, Fedora 40 et suivantes).
- WebKitGTK 4.1 avec GTK 3 : `libwebkit2gtk-4.1-0` sous Debian et Ubuntu, `webkit2gtk4.1` sous Fedora, `webkit2gtk-4.1` sous Arch. Les paquets `.deb` et `.rpm` l’installent.

Sans affichage, sans WebKitGTK, ou quand la fenêtre ne peut pas démarrer, Prism dit pourquoi et s’ouvre dans le terminal. Quand WebKitGTK manque, il affiche la commande qui l’installe sur votre distribution.

## Ce que la fenêtre ajoute

La fenêtre propose les fonctions du terminal avec sa propre disposition :

- un menu latéral avec vos conversations, une recherche dans les sessions passées, les tâches planifiées, les sous-agents, la mémoire, les journaux et la trace des opérations ;
- des boîtes de dialogue pour les permissions, les réglages et les connexions, à la place des menus du terminal ;
- un explorateur de fichiers, des lecteurs pour les documents et `/docs`, et des fichiers joints avec un bouton ou déposés sur la fenêtre ;
- **Lier un téléphone**, pour associer l’[app Android](phone.md).
- un zoom par `ctrl+plus`, `ctrl+moins` et `ctrl+0`, ou **Réglages › Fenêtre › Taille du texte** ; la fenêtre retient le zoom, sa taille, sa position (hors Wayland) et si elle était agrandie.

Les commandes slash fonctionnent comme dans le terminal.

## Dépannage

- La fenêtre ne s’ouvre pas : ses messages sont dans `~/.prism/agent/gui.log`. `prism --tui` ouvre le terminal, qui n’a besoin ni d’affichage ni de WebKitGTK.
- `PRISM_GUI_BINARY` indique à Prism un autre programme de fenêtre, pour les versions de développement.
- Consultez [Diagnostic](doctor.md) pour `/doctor` et la façon de signaler un problème.
