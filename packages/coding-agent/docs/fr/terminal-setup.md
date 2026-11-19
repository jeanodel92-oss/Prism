# Configurer votre terminal

La plupart des terminaux récents fonctionnent avec Prism sans configuration supplémentaire. Consultez cette page si les touches modifiées, le défilement, les liens, les images, les couleurs ou la position du sélecteur de méthode de saisie (IME) ne fonctionnent pas comme prévu.

Prism utilise des protocoles de touches étendus pour distinguer des combinaisons comme `Shift+Enter` et `Alt+Enter` de la touche `Enter` seule. Les proxys de terminal, multiplexeurs et terminaux intégrés aux environnements de développement peuvent modifier ou supprimer ces informations.

## Résoudre les problèmes

| Symptôme | Première vérification |
|---|---|
| `Shift+Enter` envoie le message au lieu d’ajouter une ligne | La section de votre terminal ci-dessous ; pour tmux, consultez [Exécuter Prism dans tmux](tmux.md) |
| `Alt+Enter` ne met pas un message de suivi en attente | [WezTerm](#wezterm), [Alacritty](#alacritty) ou [Windows Terminal](#windows-terminal) |
| Le défilement est particulièrement lent en plein écran | [iTerm2](#iterm2) |
| Les liens fonctionnent, mais aucun aperçu ne s’affiche au survol | [Ghostty](#ghostty) |
| Les images intégrées ou les couleurs ne sont pas détectées | [Remplacer les capacités détectées](#remplacer-les-capacites-detectees) |
| Le sélecteur IME apparaît au mauvais endroit | [WezTerm](#wezterm) ou [Terminal intégré IntelliJ IDEA](#terminal-integre-intellij-idea) |
| Les touches modifiées ne fonctionnent que dans tmux | [Exécuter Prism dans tmux](tmux.md) |

Utilisez `/help` pour voir les raccourcis actifs de Prism. Consultez [Raccourcis clavier](keybindings.md) pour les modifier.

## Kitty

Kitty prend en charge le protocole clavier nécessaire sans configuration supplémentaire.

## iTerm2

Le mode de terminal normal fonctionne sans configuration supplémentaire.

### Corriger le défilement lent en plein écran

En mode plein écran, Prism contrôle la zone d’affichage ; iTerm2 envoie donc les mouvements de la molette plutôt que de faire défiler l’historique natif du terminal. Un mouvement rapide du pavé tactile peut alors ne déplacer l’affichage que d’une ligne à la fois.

Pour modifier ce comportement :

1. Ouvrez **iTerm2 > Settings > Advanced**.
2. Recherchez **Trackpad scrolls fast?**.
3. Réglez cette option sur **No**.

Ce réglage s’applique à tout iTerm2 et peut aussi modifier le défilement natif au pavé tactile. Le comportement est suivi dans le [problème 9619 d’iTerm2](https://gitlab.com/gnachman/iterm2/-/work_items/9619).

## Apple Terminal

Prism active le signalement amélioré des touches quand il est disponible. Si Terminal.app envoie toujours un simple Return pour `Shift+Enter`, Prism utilise un mécanisme de remplacement local pour macOS et l’interprète comme `Shift+Enter`.

Ce mécanisme ne fonctionne que si Prism tourne sur le même Mac que Terminal.app. Il ne peut pas examiner l’état des touches modificatrices locales lorsque Prism s’exécute sur une autre machine par SSH.

## Ghostty

Si `Alt+Backspace` ne fonctionne pas, ajoutez cette association à la configuration de Ghostty :

```text
keybind = alt+backspace=text:\x1b\x7f
```

Sous macOS, le fichier de configuration se trouve dans `~/Library/Application Support/com.mitchellh.ghostty/config` ; sous Linux, dans `~/.config/ghostty/config`.

Les anciennes configurations de Claude Code peuvent contenir :

```text
keybind = shift+enter=text:\n
```

Cette association envoie un saut de ligne brut que Prism ne peut pas distinguer de `Ctrl+J`. Supprimez-la si vous l’aviez ajoutée uniquement pour une ancienne installation de Claude Code. Prism associe déjà `Ctrl+J` à un saut de ligne de remplacement ; l’association peut donc sembler fonctionner tout en empêchant Prism et tmux de recevoir un véritable événement `Shift+Enter`.

### Ouvrir des liens en plein écran

Les liens restent cliquables en plein écran, mais Ghostty n’affiche pas son soulignement habituel au survol ni l’aperçu de l’URL lorsque Prism capte les mouvements de la souris. Maintenez `Shift+Command` sous macOS ou `Shift+Ctrl` sous Linux pour utiliser la gestion native des liens de Ghostty.

## WezTerm

Normalement, WezTerm signale `Shift+Enter` avec les touches étendues xterm. Pour activer explicitement le protocole clavier Kitty, créez `~/.wezterm.lua` :

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

### Transmettre Alt+Enter sous macOS

Sous macOS, WezTerm associe `Option+Enter` au plein écran par défaut. Pour l’utiliser dans la file des messages de suivi de Prism, ajoutez cette entrée au tableau `config.keys` :

```lua
{
  key = 'Enter',
  mods = 'ALT',
  action = wezterm.action.SendString('\x1b[13;3u'),
}
```

Voici une configuration minimale complète :

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.keys = {
  {
    key = 'Enter',
    mods = 'ALT',
    action = wezterm.action.SendString('\x1b[13;3u'),
  },
}
return config
```

### Positionner le sélecteur IME dans WSL

Si les caractères CJK proposés par l’IME ne suivent pas le curseur de texte de Prism dans WSL, affichez le curseur matériel :

```bash
export PI_HARDWARE_CURSOR=1
prism
```

Vous pouvez aussi régler `showHardwareCursor` sur `true` dans les réglages de Prism.

## Alacritty

Alacritty signale normalement `Shift+Enter`. Sous macOS, `Option+Enter` peut être reçu comme un simple `Enter`. Ajoutez ceci à `~/.config/alacritty/alacritty.toml` pour transmettre la touche à Prism :

```toml
[[keyboard.bindings]]
key = "Enter"
mods = "Alt"
chars = "\u001b[13;3u"
```

Redémarrez Alacritty après avoir modifié le fichier.

## Terminal intégré de VS Code

VS Code 1.109.5 et les versions plus récentes activent par défaut le protocole clavier Kitty dans le terminal intégré.

Pour une version antérieure, ajoutez une association de terminal `Shift+Enter` à `keybindings.json` :

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

Le fichier utilisateur `keybindings.json` se trouve normalement ici :

- macOS : `~/Library/Application Support/Code/User/keybindings.json`
- Linux : `~/.config/Code/User/keybindings.json`
- Windows : `%APPDATA%\\Code\\User\\keybindings.json`

## Terminal intégré de Zed

Ajoutez ces associations au fichier `keymap.json` de Zed :

```json
{
  "context": "Terminal",
  "bindings": {
    "shift-enter": ["terminal::SendText", "\u001b[13;2u"],
    "ctrl--": ["terminal::SendText", "\u001b[45;5u"],
    "ctrl-alt-]": ["terminal::SendText", "\u001b[93;7u"]
  }
}
```

## Windows Terminal

Windows Terminal utilise les raccourcis par défaut de Prism pour Windows et WSL. Consultez [Raccourcis clavier](keybindings.md) pour la liste complète.

### Transmettre Shift+Enter

Ouvrez le fichier `settings.json` de Windows Terminal avec `Ctrl+Shift+,` ou **Settings > Open JSON file**. Ajoutez cet objet à son tableau `actions` :

```json
{
  "command": { "action": "sendInput", "input": "\u001b[13;2u" },
  "keys": "shift+enter"
}
```

Fermez complètement Windows Terminal et rouvrez-le, puis vérifiez que `Shift+Enter` ajoute une ligne dans Prism.

### Utiliser Alt+Enter pour les messages de suivi

Par défaut, Windows Terminal associe `Alt+Enter` au plein écran. Prism utilise donc `Ctrl+Q` pour les messages de suivi sous Windows et WSL.

Pour utiliser `Alt+Enter`, configurez Windows Terminal pour transmettre la touche et associez `app.message.followUp` à `alt+enter` dans le fichier `keybindings.json` de Prism. Consultez [Associer les raccourcis clavier](keybindings.md).

## xfce4-terminal et Terminator

Ces terminaux ne peuvent pas distinguer de façon fiable les touches Enter modifiées de la touche `Enter` seule. Les associations personnalisées comme `Ctrl+Enter` ou `Shift+Enter` peuvent donc ne pas fonctionner.

Si vous avez besoin de ces raccourcis, utilisez un terminal prenant en charge les touches étendues récentes, comme Kitty, Ghostty, WezTerm, iTerm2, Windows Terminal ou une version compatible d’Alacritty.

## Terminal intégré d’IntelliJ IDEA

Le terminal intégré d’IntelliJ IDEA ne peut pas distinguer de façon fiable `Shift+Enter` de la touche `Enter` seule. Utilisez `Ctrl+J` pour insérer une nouvelle ligne ou lancez Prism dans un terminal prenant en charge les touches étendues récentes.

Si le sélecteur IME ne suit pas le curseur de texte, affichez le curseur matériel :

```bash
export PI_HARDWARE_CURSOR=1
prism
```

## Remplacer les capacités détectées

Prism détecte automatiquement les hyperliens OSC 8, les protocoles d’images intégrées et la prise en charge des couleurs vraies. Un proxy de terminal ou un multiplexeur peut rendre cette détection inexacte.

| Capacité | Variable d’environnement | Réglage |
|---|---|---|
| Hyperliens | `PI_HYPERLINKS=1\|0\|auto` | `terminal.hyperlinks: true\|false\|"auto"` |
| Images intégrées | `PI_IMAGE_PROTOCOL=kitty\|iterm2\|none\|auto` | `terminal.images: "kitty"\|"iterm2"\|false\|"auto"` |
| Couleurs vraies | `PI_TRUE_COLOR=1\|0\|auto` | `terminal.trueColor: true\|false\|"auto"` |

Les réglages sont prioritaires sur les variables d’environnement. Une valeur absente ou `auto` conserve la détection automatique.

Forcez uniquement une capacité prise en charge par l’ensemble du chemin du terminal. Les séquences d’échappement non prises en charge peuvent détériorer l’affichage. Consultez [Variables d’environnement](environment-variables.md) et [Réglages](settings.md) pour connaître les valeurs de référence.
