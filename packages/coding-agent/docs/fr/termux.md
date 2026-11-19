# Exécuter Pi sur Android avec Termux

> Prism publie uniquement des versions pour Linux x64 et n’est pas testé sous Android. Cette page décrit pi upstream, installé avec npm, dans Termux.

Pi fonctionne sur Android grâce à [Termux](https://termux.dev/), un émulateur de terminal et un environnement Linux. La saisie de texte, les outils de fichiers et les commandes shell sont pris en charge. Pi peut copier et coller du texte avec le presse-papiers Android au moyen de Termux:API. Le collage d’images du presse-papiers n’est pas pris en charge.

## Avant de commencer

Installez Termux depuis [GitHub ou F-Droid](https://github.com/termux/termux-app#installation). N’utilisez pas l’ancienne version publiée sur Google Play.

[Termux:API](https://github.com/termux/termux-api#installation) est facultatif. Installez-le uniquement si vous voulez que Pi copie ou colle du texte du presse-papiers Android, ou si les commandes shell ont besoin des API de l’appareil Android.

## Installer Pi

1. Mettez à jour les packages Termux :

   ```bash
   pkg update && pkg upgrade
   ```

2. Installez Node.js et Git :

   ```bash
   pkg install nodejs git
   ```

3. Installez Pi :

   ```bash
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   ```

4. Vérifiez l’installation :

   ```bash
   pi --version
   ```

5. Ouvrez le dossier de travail et démarrez Pi :

   ```bash
   cd /path/to/working-folder
   pi
   ```

Suivez ensuite le [guide de démarrage rapide](quickstart.md) pour connecter un modèle et exécuter votre première tâche.

## Accéder au stockage partagé d’Android

Termux ne peut pas accéder au stockage partagé d’Android tant que vous ne l’y autorisez pas. Exécutez cette commande une fois :

```bash
termux-setup-storage
```

Après avoir accordé l’autorisation, le stockage partagé d’Android est accessible dans `/storage/emulated/0` et par les liens créés par Termux dans `~/storage/`.

N’accordez cette permission que si Pi doit accéder à ces fichiers. Les commandes et outils lancés dans Termux disposent des mêmes permissions de stockage que le processus Termux.

## Utiliser les commandes du presse-papiers

Pi utilise `termux-clipboard-set` pour copier du texte et `termux-clipboard-get` pour son raccourci de collage. Les commandes shell peuvent utiliser directement les deux commandes. Installez l’application Termux:API et son package en ligne de commande :

```bash
pkg install termux-api
```

Vérifiez l’intégration :

```bash
printf 'Pi clipboard test' | termux-clipboard-set
termux-clipboard-get
```

La deuxième commande doit afficher `Pi clipboard test`.

L’API du presse-papiers Termux ne gère que le texte. Le raccourci de collage de Pi insère ce texte dans l’éditeur, mais ne peut pas joindre les images du presse-papiers.

## Ajouter des consignes propres à Termux

Pi détecte qu’il s’exécute dans Termux, mais ne peut pas deviner comment vous voulez qu’il interagisse avec Android. Ajoutez uniquement les détails utiles à votre travail dans `~/.pi/agent/AGENTS.md` :

````markdown
# Termux environment

- Pi runs in Termux on Android.
- Shared Android storage is under `/storage/emulated/0`.
- Open URLs with `termux-open-url "https://example.com"`.
- Open files with `termux-open <path>`.
- Do not access shared storage unless the task requires it.
````

Exécutez `/reload` après avoir modifié le fichier pendant une session active.

## Résoudre les problèmes

### Le presse-papiers ne fonctionne pas

Vérifiez que les deux composants sont installés :

1. l’application Android Termux:API, de la même source que Termux ;
2. le package en ligne de commande `termux-api`.

Exécutez ensuite les commandes de vérification du presse-papiers ci-dessus en dehors de Pi. Si elles échouent aussi, corrigez l’installation de Termux:API avant de réessayer la commande de copie de Pi.

### Le stockage partagé affiche une erreur d’autorisation

Exécutez `termux-setup-storage`, acceptez la demande d’autorisation d’Android, puis réessayez le chemin sous `~/storage/` ou `/storage/emulated/0`.

### Pi est introuvable après l’installation

Ouvrez un nouveau shell Termux et exécutez :

```bash
npm prefix -g
command -v pi
```

Vérifiez que le dossier des exécutables globaux npm figure dans `PATH`, puis réinstallez Pi si le package est absent.
