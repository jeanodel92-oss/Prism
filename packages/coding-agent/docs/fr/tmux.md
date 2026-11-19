# Exécuter Prism dans tmux

Prism fonctionne dans tmux, mais tmux peut signaler `Shift+Enter`, `Ctrl+Enter` et `Enter` seule comme la même touche. Activez les touches étendues pour que Prism puisse les distinguer.

## Vérifier la version de tmux

```bash
tmux -V
```

Pour tmux 3.5 ou une version plus récente, utilisez la configuration CSI-u recommandée ci-dessous. Pour tmux 3.2 à 3.4, utilisez la configuration des anciennes versions.

## Activer les touches étendues dans tmux 3.5 ou ultérieur

Ajoutez ces lignes à `~/.tmux.conf` :

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

Prism demande le signalement des touches étendues si le terminal ne fournit pas directement le protocole clavier Kitty. Le format CSI-u est le plus fiable pour transmettre les touches modifiées dans tmux.

## Redémarrer tmux

La configuration s’applique au serveur tmux. Pour être sûr qu’elle est active, fermez vos sessions tmux et démarrez un nouveau serveur.

Si vous arrêtez le serveur en ligne de commande, enregistrez d’abord votre travail. Cette commande met fin à toutes les sessions gérées par ce serveur :

```bash
tmux kill-server
tmux
```

## Vérifier les touches modifiées

Démarrez Prism dans la nouvelle session tmux et vérifiez que :

1. `Shift+Enter` ajoute une ligne dans l’éditeur.
2. `Enter` envoie le prompt.
3. `Alt+Enter` met un message de suivi en attente sous macOS et Linux. Sous Windows et WSL, le raccourci par défaut est `Ctrl+Q`.

Si ces touches se comportent toujours comme `Enter`, vérifiez que le terminal à l’extérieur de tmux sait signaler les touches modifiées. Consultez [Configurer votre terminal](terminal-setup.md).

## Utiliser tmux 3.2 à 3.4

Ces versions prennent en charge les touches étendues, mais pas `extended-keys-format csi-u`. Ajoutez uniquement :

```tmux
set -g extended-keys on
```

Prism prend en charge le format xterm `modifyOtherKeys` utilisé par ces versions. Redémarrez tmux et répétez les vérifications.

Pour les versions plus anciennes, mettez tmux à niveau ou utilisez Prism en dehors de tmux au lieu de compter sur les touches Enter modifiées.
