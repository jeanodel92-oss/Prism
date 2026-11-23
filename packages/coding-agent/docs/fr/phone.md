# Prism sur votre téléphone

L’app Prism pour Android suit et pilote le Prism de votre ordinateur : vous voyez vos sessions, envoyez des messages, répondez aux questions de permissions et recevez des fichiers. L’agent continue de tourner sur l’ordinateur, avec ses modèles, ses permissions et sa sandbox ; le téléphone en est une fenêtre. Il n’existe pas d’app pour iOS.

Le téléphone parle directement à l’ordinateur, par votre réseau local ou par [Tailscale](https://tailscale.com), sans service en ligne entre les deux.

## Installer l’app

L’app est publiée sur la [page de téléchargement de Prism](https://prism.odelserver.space/fr/downloads/) :

- **F-Droid** : ajoutez le dépôt `https://prism.odelserver.space/fdroid/repo`, puis installez Prism. F-Droid vérifie la clé de signature du dépôt et propose les mises à jour.
- **Obtainium** : ajoutez la même adresse de dépôt avec la source « F-Droid Third Party Repo » et l’identifiant d’app `space.odelserver.prism.mobile`.
- **APK** (arm64) : téléchargez-le sur le téléphone et autorisez l’installation depuis votre navigateur. Les mises à jour ne vous seront pas proposées d’elles-mêmes.

## Lier un téléphone

Sur l’ordinateur, ouvrez **Lier un téléphone** dans la fenêtre, ou lancez `/phone` dans le terminal.

1. Démarrez le serveur du téléphone (`prism-remote`, installé avec Prism) :
   - **Actif pendant que ce Prism est ouvert** : le téléphone joint l’ordinateur seulement pendant que Prism tourne ;
   - **Toujours actif (service de votre session)** : un service utilisateur systemd (`prism-remote.service`) garde l’ordinateur joignable tant que votre session est ouverte, même Prism fermé.
2. Choisissez **Afficher un code d’appairage**. Scannez le code QR depuis l’app, ou collez le code affiché en dessous. Un code vaut 5 minutes et ne sert qu’une fois.
3. Le téléphone essaie les adresses de l’ordinateur : son adresse Tailscale d’abord, puis ses adresses du réseau local, sur le port 47392 par défaut. Sans Tailscale, le téléphone ne joint l’ordinateur que sur le même réseau.

`/phone` liste aussi les téléphones liés et en révoque un : un téléphone révoqué doit être associé de nouveau avec un nouveau code. **Arrêter le serveur du téléphone** coupe le lien pour tous les téléphones.

## Sécurité

- L’ordinateur et chaque téléphone ont leur propre certificat. Ils communiquent en TLS 1.3 et vérifient le certificat de l’autre par son empreinte, apprise lors de l’association ; un appareil non associé est refusé.
- Les clés d’association et la liste des téléphones liés sont gardées dans `~/.prism/remote` (`PRISM_REMOTE_DIR` les déplace). Les commandes de la [sandbox](sandbox.md) ne peuvent pas lire ce dossier.
- Ce que l’agent fait depuis le téléphone passe par les mêmes questions de permissions que sur l’ordinateur.

## Prérequis

- L’ordinateur : Linux x64 avec glibc 2.39 ou plus récente (Debian 13, Ubuntu 24.04, Fedora 40 et suivantes), comme pour la fenêtre.
- Le téléphone : Android 7 ou plus récent, sur arm64.
- Pour joindre l’ordinateur hors de chez vous : Tailscale sur les deux appareils, connecté (`tailscale up`).
