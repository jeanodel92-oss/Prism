# Référence des raccourcis clavier

Prism expose des actions nommées, comme `app.session.new`, auxquelles vous pouvez associer des raccourcis clavier. Vous pouvez modifier les associations par défaut ou en définir pour des actions qui n’en ont pas dans la [configuration utilisateur](configuration.md#dossier-agent).

Exécutez `/help` pour voir les raccourcis actifs de l’éditeur principal et de l’application.

## Associer des raccourcis clavier

Créez `<agent-dir>/keybindings.json`. Par défaut, le dossier agent est `~/.prism/agent` ; il est décrit dans [Dossier agent](configuration.md#dossier-agent).

Associez chaque identifiant d’action à une touche ou à une liste de touches :

```json
{
  "app.session.new": "ctrl+shift+n",
  "app.session.tree": ["ctrl+shift+t", "alt+shift+t"]
}
```

Une valeur configurée remplace le raccourci par défaut de l’action. Utilisez une liste vide pour désactiver ses raccourcis :

```json
{
  "tui.altScreen.pageUp": []
}
```

Après avoir modifié le fichier, exécutez `/reload` pour appliquer les changements à la session active.

## Syntaxe des touches

Écrivez une touche sous la forme `modifier+touche`. Les modificateurs sont `ctrl`, `shift`, `alt` et `super`. Vous pouvez les combiner. Touches valides :

- **Lettres :** `a-z`
- **Chiffres :** `0-9`
- **Spéciales :** `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageUp`, `pageDown`, `up`, `down`, `left`, `right`
- **Fonction :** `f1`-`f12`
- **Symboles :** `` ` ``, `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`, `)`, `_`, `+`, `|`, `~`, `{`, `}`, `:`, `<`, `>`, `?`

Exemples : `ctrl+shift+x`, `alt+ctrl+x`, `ctrl+shift+alt+x`, `super+k`, `ctrl+super+k` et `ctrl+1`.

Les raccourcis utilisant `super` nécessitent un terminal qui signale séparément ce modificateur, généralement avec le protocole clavier Kitty. Ils peuvent ne pas fonctionner dans les terminaux qui ne le prennent pas en charge.

## Actions

### Interface du terminal

#### Déplacement du curseur

| Identifiant de raccourci | Valeur par défaut | Description |
|---|---|---|
| `tui.editor.cursorUp` | `up` | Déplace le curseur vers le haut ; en haut, parcourt l’historique vers les anciennes entrées |
| `tui.editor.cursorDown` | `down` | Déplace le curseur vers le bas ; en bas, parcourt l’historique vers les entrées récentes |
| `tui.editor.historyPrevious` | Aucun | Sélectionne l’entrée précédente de l’historique des prompts |
| `tui.editor.historyNext` | Aucun | Sélectionne l’entrée suivante de l’historique des prompts |
| `tui.editor.cursorLeft` | `left`, `ctrl+b` | Déplace le curseur à gauche |
| `tui.editor.cursorRight` | `right`, `ctrl+f` | Déplace le curseur à droite |
| `tui.editor.cursorWordLeft` | `alt+left`, `ctrl+left`, `alt+b` | Déplace le curseur d’un mot vers la gauche |
| `tui.editor.cursorWordRight` | `alt+right`, `ctrl+right`, `alt+f` | Déplace le curseur d’un mot vers la droite |
| `tui.editor.cursorLineStart` | `home`, `ctrl+home`, `ctrl+a` | Place le curseur au début de la ligne |
| `tui.editor.cursorLineEnd` | `end`, `ctrl+end`, `ctrl+e` | Place le curseur à la fin de la ligne |
| `tui.editor.jumpForward` | `ctrl+]` | Avance jusqu’au caractère indiqué |
| `tui.editor.jumpBackward` | `ctrl+alt+]` | Recule jusqu’au caractère indiqué |
| `tui.editor.pageUp` | `pageUp`, `ctrl+pageUp` | Remonte d’une page |
| `tui.editor.pageDown` | `pageDown`, `ctrl+pageDown` | Descend d’une page |

Les actions dédiées à l’historique parcourent les prompts quelle que soit la position du curseur et sont prioritaires sur les actions de l’application associées à la même touche.

#### Modification du texte

| Identifiant de raccourci | Valeur par défaut | Description |
|---|---|---|
| `tui.editor.deleteCharBackward` | `backspace` | Supprime le caractère précédent |
| `tui.editor.deleteCharForward` | `delete`, `ctrl+d` | Supprime le caractère suivant |
| `tui.editor.deleteWordBackward` | `ctrl+w`, `alt+backspace`, `ctrl+backspace` | Supprime le mot précédent |
| `tui.editor.deleteWordForward` | `alt+d`, `alt+delete`, `ctrl+delete` | Supprime le mot suivant |
| `tui.editor.deleteToLineStart` | `ctrl+u` | Supprime jusqu’au début de la ligne |
| `tui.editor.deleteToLineEnd` | `ctrl+k` | Supprime jusqu’à la fin de la ligne |
| `tui.editor.yank` | aucun | Colle le texte supprimé le plus récemment |
| `tui.editor.yankPop` | `alt+y` | Parcourt les textes supprimés après le collage |
| `tui.editor.undo` | `ctrl+z`, `ctrl+-` (`ctrl+z` sous Windows ; `alt+z` dans WSL) | Annule la dernière modification |
| `tui.editor.redo` | `ctrl+y`, `ctrl+shift+z` | Rétablit la dernière modification annulée |

#### Sélection du texte

| Identifiant de raccourci | Valeur par défaut | Description |
|---|---|---|
| `tui.editor.selectLeft` | `shift+left` | Sélectionne le caractère à gauche |
| `tui.editor.selectRight` | `shift+right` | Sélectionne le caractère à droite |
| `tui.editor.selectUp` | `shift+up` | Sélectionne jusqu’à la ligne du dessus (jusqu’au début de la ligne sur la première) |
| `tui.editor.selectDown` | `shift+down` | Sélectionne jusqu’à la ligne du dessous (jusqu’à la fin de la ligne sur la dernière) |
| `tui.editor.selectWordLeft` | `ctrl+shift+left`, `alt+shift+left` | Sélectionne le mot à gauche |
| `tui.editor.selectWordRight` | `ctrl+shift+right`, `alt+shift+right` | Sélectionne le mot à droite |
| `tui.editor.selectLineStart` | `shift+home` | Sélectionne jusqu’au début de la ligne |
| `tui.editor.selectLineEnd` | `shift+end` | Sélectionne jusqu’à la fin de la ligne |

La sélection s’affiche en vidéo inverse. Taper, coller ou passer à la ligne la remplace, et les touches de suppression l’effacent ; l’annulation la restitue. `left` et `right` placent le curseur au début ou à la fin de la sélection, les autres déplacements l’abandonnent. kitty utilise par défaut `ctrl+shift+left` et `ctrl+shift+right` pour ses onglets : y utiliser `alt+shift+left` et `alt+shift+right`. Il n’y a pas de touche « tout sélectionner » : `ctrl+a` va au début de la ligne. `ctrl+c` ne copie pas la sélection de la saisie ; il vide la saisie (l’annulation la restitue).

#### Saisie et sélection

| Identifiant de raccourci | Valeur par défaut | Description |
|---|---|---|
| `tui.input.newLine` | `shift+enter`, `ctrl+j` | Insère une nouvelle ligne |
| `tui.input.submit` | `enter` | Envoie la saisie |
| `tui.input.tab` | `tab` | Insère une tabulation ou complète le texte |
| `tui.input.copy` | `ctrl+c` | Copie la sélection |
| `tui.select.up` | `up` | Déplace la sélection vers le haut |
| `tui.select.down` | `down` | Déplace la sélection vers le bas |
| `tui.select.pageUp` | `pageUp` | Remonte d’une page dans la liste |
| `tui.select.pageDown` | `pageDown` | Descend d’une page dans la liste |
| `tui.select.confirm` | `enter` | Confirme la sélection |
| `tui.select.cancel` | `escape`, `ctrl+c` | Annule la sélection |

#### Plein écran

En plein écran, ces actions contrôlent la transcription et sont prioritaires sur les actions de l’éditeur associées à la même touche.

| Identifiant de raccourci | Valeur par défaut | Description |
|---|---|---|
| `tui.altScreen.pageUp` | `pageUp` | Remonte la transcription d’une page |
| `tui.altScreen.pageDown` | `pageDown` | Descend la transcription d’une page |
| `tui.altScreen.halfPageUp` | Aucun | Remonte la transcription d’une demi-page |
| `tui.altScreen.halfPageDown` | Aucun | Descend la transcription d’une demi-page |
| `tui.altScreen.lineUp` | Aucun | Remonte la transcription d’une ligne |
| `tui.altScreen.lineDown` | Aucun | Descend la transcription d’une ligne |
| `tui.altScreen.previousPrompt` | `ctrl+shift+up`, `ctrl+up` (`ctrl+up` uniquement sous Windows et WSL) | Va au message marqué précédent |
| `tui.altScreen.nextPrompt` | `ctrl+shift+down`, `ctrl+down` (`ctrl+down` uniquement sous Windows et WSL) | Va au message marqué suivant |
| `tui.altScreen.search` | `ctrl+f`, `ctrl+shift+f` (`ctrl+f` sous Windows et WSL) | Recherche dans la transcription affichée |
| `tui.altScreen.searchNext` | `enter`, `ctrl+g` | Sélectionne le résultat suivant pendant une recherche |
| `tui.altScreen.searchPrevious` | `shift+enter`, `ctrl+shift+g` | Sélectionne le résultat précédent pendant une recherche |
| `tui.altScreen.searchClose` | `escape` | Ferme la recherche dans la transcription |
| `tui.altScreen.top` | `home` | Va au début de la transcription |
| `tui.altScreen.bottom` | `end` | Va à la fin de la transcription et suit les nouvelles sorties |

### Application

| Identifiant de raccourci | Valeur par défaut | Description |
|--------|---------|-------------|
| `app.interrupt` | `escape` | Annule ou interrompt |
| `app.clear` | `ctrl+c` | Vide l’éditeur (première pression) ou quitte (deuxième pression) |
| `app.exit` | `ctrl+d` | Quitte si l’éditeur est vide |
| `app.suspend` | aucun (`ctrl+z` dans WSL) | Suspend en arrière-plan |
| `app.editor.external` | `ctrl+g` | Ouvre l’éditeur externe (`externalEditor`, `$VISUAL`, `$EDITOR`, Notepad sous Windows ou `nano` ailleurs) |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v` sous Windows et WSL) | Colle depuis le presse-papiers des fichiers sous macOS, des images ou du texte |

`app.suspend` n’a pas de raccourci par défaut hors de WSL : `ctrl+z` annule dans l’éditeur. Associez-lui une touche dans `keybindings.json` pour suspendre Prism et le reprendre avec `fg`. Sous Windows natif, les terminaux ne prennent pas en charge le contrôle des tâches Unix : si vous lui en associez un, Prism affiche un message d’état au lieu de se suspendre. WSL garde le comportement habituel de `ctrl+z` et `fg`.

L’extension intégrée `files` ajoute `alt+e` pour ouvrir l’explorateur de fichiers du projet (`/files`).

### Sessions

| Identifiant de raccourci | Valeur par défaut | Description |
|--------|---------|-------------|
| `app.session.new` | Aucun | Démarre une session (`/new`) |
| `app.session.tree` | Aucun | Ouvre l’arbre de session (`/tree`) |
| `app.session.fork` | Aucun | Crée une branche de la session actuelle (`/fork`) |
| `app.session.resume` | Aucun | Ouvre le sélecteur de reprise de session (`/resume`) |
| `app.session.togglePath` | `ctrl+p` | Affiche ou masque le chemin |
| `app.session.toggleSort` | `ctrl+s` | Change le mode de tri |
| `app.session.toggleNamedFilter` | `ctrl+n` | Active ou désactive le filtre des sessions nommées uniquement |
| `app.session.rename` | `ctrl+r` | Renomme la session |
| `app.session.delete` | `ctrl+d` | Supprime la session |
| `app.session.deleteNoninvasive` | `ctrl+backspace` | Supprime la session si la recherche est vide |

### Modèles et réflexion

| Identifiant de raccourci | Valeur par défaut | Description |
|--------|---------|-------------|
| `app.model.select` | `ctrl+l` | Ouvre le sélecteur de modèles |
| `app.model.cycleForward` | `ctrl+p` | Passe au modèle suivant |
| `app.model.cycleBackward` | `shift+ctrl+p` (`alt+p` sous Windows et WSL) | Passe au modèle précédent |
| `app.models.save` | `ctrl+s` | Enregistre dans les réglages le modèle par défaut ou la sélection de modèles limitée |
| `app.thinking.cycle` | `shift+tab` | Parcourt les niveaux de réflexion |
| `app.thinking.save` | `ctrl+s` | Enregistre dans les réglages le niveau de réflexion actuel |
| `app.thinking.toggle` | `ctrl+t` | Réduit ou développe les blocs de réflexion |

### Affichage et file des messages

| Identifiant de raccourci | Valeur par défaut | Description |
|--------|---------|-------------|
| `app.tools.expand` | `ctrl+o` | Force l’ouverture ou la fermeture de tous les blocs dépliables, y compris la réflexion, et réinitialise les choix par bloc |
| `app.message.copy` | `ctrl+x` | Copie le message sélectionné dans `/tree` ; en plein écran, copie la sélection si `fullscreenCopyOnSelect` est `false`, sinon copie le dernier message de l’assistant |
| `app.message.followUp` | `alt+enter` (`ctrl+q` sous Windows et WSL) | Met un message de suivi en attente |
| `app.message.dequeue` | `alt+up` (`alt+q` sous Windows et WSL) | Rétablit les messages en attente dans l’éditeur |

### Navigation dans l’arbre

| Identifiant de raccourci | Valeur par défaut | Description |
|--------|---------|-------------|
| `app.tree.foldOrUp` | `ctrl+left`, `alt+left` | Réduit le segment actuel de la branche ou va au début du segment précédent |
| `app.tree.unfoldOrDown` | `ctrl+right`, `alt+right` | Développe le segment actuel de la branche ou va au début du segment suivant ou à la fin de la branche |
| `app.tree.editLabel` | `shift+l` | Modifie l’étiquette du nœud sélectionné dans l’arbre |
| `app.tree.toggleLabelTimestamp` | `shift+t` | Affiche ou masque les horodatages des étiquettes dans l’arbre |
| `app.tree.filter.default` | `ctrl+d` | Rétablit le filtre par défaut de l’arbre |
| `app.tree.filter.noTools` | `ctrl+t` | Active ou désactive le filtre qui masque les résultats d’outils |
| `app.tree.filter.userOnly` | `ctrl+u` | Active ou désactive le filtre qui n’affiche que les messages utilisateur |
| `app.tree.filter.labeledOnly` | `ctrl+l` | Active ou désactive le filtre qui n’affiche que les entrées étiquetées |
| `app.tree.filter.all` | `ctrl+a` | Active ou désactive le filtre qui affiche toutes les entrées |
| `app.tree.filter.cycleForward` | `ctrl+o` | Passe au filtre suivant |
| `app.tree.filter.cycleBackward` | `shift+ctrl+o` | Passe au filtre précédent |

### Sélecteur de modèles limités

Utilisé dans le sélecteur de modèles limités, ouvert avec `/scoped-models`.

| Identifiant de raccourci | Valeur par défaut | Description |
|--------|---------|-------------|
| `app.models.enableAll` | `ctrl+a` | Active tous les modèles ou tous ceux correspondant à la recherche actuelle |
| `app.models.clearAll` | `ctrl+x` | Retire tous les modèles ou tous ceux correspondant à la recherche actuelle |
| `app.models.toggleProvider` | `ctrl+p` | Active ou désactive tous les modèles du fournisseur actuel |
| `app.models.reorderUp` | `alt+up` | Remonte le modèle sélectionné dans l’ordre de parcours |
| `app.models.reorderDown` | `alt+down` | Descend le modèle sélectionné dans l’ordre de parcours |
