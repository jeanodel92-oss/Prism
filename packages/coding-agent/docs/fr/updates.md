# Mises à jour et canaux

## Mettre Prism à jour

```bash
prism update              # installer la dernière version
prism update --check      # dire seulement si une version plus récente existe
prism update --rollback   # revenir à la version précédente (de nouveau : annuler)
```

Chaque mise à jour télécharge la version depuis `https://prism.odelserver.space`, vérifie la signature minisign de sa liste `SHA256SUMS`, puis l’archive, passe à la nouvelle version en une seule étape et garde la précédente. Elle affiche ensuite les notes de version.

Dans Prism, `/update` fait la même chose depuis le terminal ou la fenêtre : il vérifie, puis propose d’installer la version plus récente, de changer de canal ou de revenir à la version précédente. La version en cours continue de tourner ; la nouvelle s’ouvre au démarrage suivant.

`prism update --models` rafraîchit seulement le catalogue des modèles cloud, `prism update --extensions` seulement les packages installés, `prism update --all` Prism et les packages installés. Consultez [Ligne de commande](cli.md#mettre-prism-ou-des-packages-à-jour).

### Installé par un gestionnaire de paquets

`prism update` ne met à jour qu’une installation faite par l’installeur du site (`install.sh`). Un Prism installé par le gestionnaire de paquets de votre système (`.deb`, `.rpm`) est mis à jour par lui, avec le reste ; `prism update` le dit et le lui laisse. Une AppImage se met à jour en téléchargeant le nouveau fichier depuis la [page de téléchargement](https://prism.odelserver.space/fr/downloads/), ou par un gestionnaire d’AppImage.

## Quand Prism vérifie de lui-même

Par défaut, Prism ne cherche jamais de mise à jour de lui-même. Le réglage `updateMode` (**/settings › Autres › Mises à jour**) change cela :

| Valeur | Au démarrage |
|---|---|
| `manual` (par défaut) | Rien ; lancez `/update` ou `prism update` |
| `notify` | Signale qu’une version plus récente existe |
| `auto` | L’installe ; la nouvelle version s’ouvre au démarrage suivant |

`notify` et `auto` vérifient au plus une fois par heure, seulement pour une installation faite par l’installeur du site, et jamais avec `--offline` ou `PI_OFFLINE`.

## Canaux stable et canary

- **Stable** (par défaut) : les versions validées.
- **Canary** : une version par commit qui passe les vérifications de la construction. Elle peut casser. Les versions canary sont signées avec une clé qui leur est propre et qui ne peut pas signer une version stable ; leur numéro de version nomme le canal (`…-fork.<n>.canary.<m>`), et chaque démarrage affiche un avertissement tant que vous êtes sur ce canal.

```bash
prism update --channel canary   # passer à canary et mettre à jour
prism update --channel stable   # revenir à stable, en gardant votre configuration
```

Pour installer sur le canal canary dès le départ :

```bash
curl -fsSL https://prism.odelserver.space/install.sh | sh -s -- --channel canary
```

Sur canary, Prism installe la plus récente entre la dernière version canary et la dernière version stable.

## Désinstaller

```bash
curl -fsSL https://prism.odelserver.space/install.sh | sh -s -- --uninstall
```

Cela supprime les versions installées (`~/.local/share/prism`) et la commande `prism`. Votre configuration, vos sessions et vos identifiants enregistrés, dans `~/.prism`, sont gardés.
