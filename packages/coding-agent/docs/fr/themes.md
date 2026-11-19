# Personnaliser Prism avec des thèmes

Les thèmes définissent les couleurs utilisées par Prism en mode interactif et dans les exports HTML. Prism comprend les thèmes `prism`, `prism-light`, `system`, `dark` et `light`. Par défaut, le duo automatique `prism-light/prism` suit l’apparence claire ou sombre de votre terminal. Vous pouvez choisir un thème ou créer votre propre palette.

## Utiliser les couleurs de votre terminal

Choisissez le thème `system` pour que Prism crée ses couleurs à partir du thème de votre terminal. Prism s’accorde ainsi à celui-ci au lieu d’utiliser sa propre palette :

- Prism demande au terminal ses couleurs de premier plan et d’arrière-plan par défaut, ainsi que ses 16 couleurs ANSI.
- Chaque couleur de Prism reprend la teinte d’une couleur ANSI ; par exemple, les erreurs utilisent le rouge et les liens le bleu.
- Prism règle la luminosité de chaque couleur pour lui donner un contraste minimal avec l’arrière-plan. Le texte courant garde un rapport de contraste WCAG d’au moins 4,5:1 avec l’arrière-plan et chaque panneau.
- Quand le terminal passe du mode clair au mode sombre, Prism demande de nouveau les couleurs et reconstruit le thème.

Le thème s’adapte aux informations envoyées par le terminal :

| Informations envoyées par le terminal | Résultat |
|---|---|
| Arrière-plan et couleurs ANSI | Couleurs de la palette du terminal adaptées à son arrière-plan réel. |
| Arrière-plan seulement | Teintes propres à Prism adaptées à l’arrière-plan réel. |
| Aucune | Indices de couleurs ANSI et couleurs par défaut du terminal, que celui-ci affiche lui-même. Le texte secondaire est peu visible et les panneaux n’ont pas de couleur d’arrière-plan. |

Prism demande les couleurs au terminal à son démarrage. Les terminaux répondent généralement en quelques millisecondes, et Prism attend au plus 100 ms avant d’afficher l’en-tête de démarrage. Si le terminal ne répond pas à temps, Prism utilise les couleurs ANSI de remplacement, puis applique tout de même les couleurs quand elles arrivent, par exemple avec une connexion SSH lente. `system` est un nom réservé ; un thème personnalisé qui porte ce nom est ignoré.

<a id="selecting-a-theme"></a>

## Choisir un thème

Ouvrez `/settings` et choisissez **Theme**. Vous pouvez utiliser un seul thème quelle que soit l’apparence du terminal, ou choisir un thème différent pour les terminaux clairs et sombres.

Le choix est enregistré dans le réglage `theme` :

```json
{
  "theme": "dark"
}
```

Si le réglage `theme` est absent, Prism utilise le duo automatique `prism-light/prism` : `prism-light` pour les terminaux clairs et `prism` pour les terminaux sombres.

Le mode automatique enregistre d’abord le thème clair, puis le thème sombre :

```json
{
  "theme": "light/dark"
}
```

Prism détermine si le terminal est clair ou sombre à partir des couleurs d’arrière-plan et de premier plan qu’il signale. Si le terminal ne signale pas son arrière-plan, Prism utilise d’abord sa notification de mode clair ou sombre, puis la variable d’environnement `COLORFGBG`, et enfin le mode sombre. Ce choix détermine le thème d’un duo clair/sombre et l’apparence de `system`. Quand le mode automatique est actif, Prism change de thème si le terminal signale un changement d’apparence. Les noms de thème ne peuvent pas contenir `/`, réservé à ce format de réglage.

Utilisez `--use-theme` pour choisir le thème initial d’une exécution sans modifier le réglage enregistré :

```bash
prism --use-theme light
prism --use-theme light/dark
```

Consultez [Ressources CLI](../cli.md#resources) pour l’option de ligne de commande.

## Créer un thème personnalisé

Pour changer quelques couleurs, ouvrez `/settings` > Apparence > Personnaliser le thème. Il modifie une copie du thème utilisé : choisissez une couleur de la palette ou de l’interface, tapez une nouvelle valeur (une couleur hexadécimale comme `#3a7bd5`, un nom de la palette, un indice de 256 couleurs, ou rien pour la couleur du terminal) et toute l’interface l’affiche pendant la saisie. Entrée enregistre la copie dans `<agent-dir>/themes/<nom>-custom.json` et en fait votre thème ; Échap revient aux couleurs enregistrées. Un thème déjà présent dans `<agent-dir>/themes/` est modifié sur place.

Pour écrire un thème à la main :

Copiez l’un des [thèmes intégrés](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/modes/interactive/theme) ou créez un fichier JSON conforme au [schéma](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json). Les thèmes intégrés utilisent les couleurs OKHSL et des variables communes à plusieurs rôles ; vous pouvez donc ajuster directement une teinte, sa saturation ou sa luminosité.

1. Enregistrez le fichier dans `<agent-dir>/themes/my-theme.json`. Par défaut, le dossier agent est `~/.prism/agent`.
2. Définissez son `name` sur `my-theme`.
3. Modifiez les valeurs dans `vars` et `colors`.
4. Choisissez `my-theme` dans `/settings`.

Utilisez le nom du thème comme nom de fichier. Prism recharge automatiquement le thème utilisateur actif uniquement depuis `<agent-dir>/themes/<name>.json`. Exécutez `/reload` après avoir ajouté ou modifié un thème provenant d’un autre emplacement.

## Comprendre le fichier de thème

| Propriété | Obligatoire | Rôle |
|---|---|---|
| `$schema` | Non | Active la validation et l’autocomplétion de l’éditeur à partir du schéma publié par Prism. |
| `name` | Oui | Identifie le thème dans les sélecteurs et réglages. Il doit être unique, ne peut pas contenir `/` ni être `system`. |
| `appearance` | Non | `"dark"` ou `"light"` : arrière-plan pour lequel le thème est conçu. Prism le détecte à partir des couleurs du thème si cette propriété est absente. |
| `vars` | Non | Définit des couleurs réutilisables. Les variables peuvent en référencer d’autres. |
| `colors` | Oui | Attribue les couleurs aux rôles de l’interface du terminal. Le schéma précise les rôles obligatoires et facultatifs. |
| `export` | Non | Remplace les arrière-plans de page et de panneau dans les exports HTML. |

Une couleur peut s’écrire de six façons :

| Format | Exemple | Signification |
|---|---|---|
| Hexadécimal RGB | `"#0af"` ou `"#00aaff"` | Couleur sRGB à trois ou six chiffres. |
| OKLCH | `"oklch(62% 0.1 200)"` | Luminosité perceptuelle, chroma et teinte. |
| OKHSL | `"okhsl(250 60% 55%)"` | Teinte, saturation et luminosité. La saturation est relative au maximum permis par la gamme sRGB pour cette teinte et cette luminosité ; toutes les valeurs restent dans la gamme et une saturation égale donne un aspect aussi coloré. |
| Indice 256 couleurs | `39` | Indice de palette ANSI entre `0` et `255`. |
| Référence à une variable | `"primary"` | Valeur d’une entrée de `vars`. |
| Couleur par défaut du terminal | `""` | Couleur de premier plan ou d’arrière-plan par défaut du terminal. |

Les couleurs par défaut du terminal sont affichées par le terminal lui-même. Si Prism a besoin d’une valeur concrète, par exemple pour un export HTML ou les calculs de couleur d’une extension, il utilise les couleurs par défaut signalées par le terminal ou devine le noir ou le blanc selon l’apparence du thème.

Prism résout les références de variables en chaîne. Une variable manquante ou une référence circulaire invalide le thème. Prism utilise les couleurs vraies si elles sont disponibles, convertit les valeurs OKLCH en sRGB et approxime les couleurs pour les terminaux à 256 couleurs. Les exports HTML convertissent OKHSL en hexadécimal, car CSS ne le prend pas en charge. Si des couleurs diffèrent de leurs valeurs source, vérifiez la détection des couleurs vraies et les réglages de contraste de votre terminal. Consultez [Configurer votre terminal](terminal-setup.md#remplacer-les-capacités-détectées).

Consultez le [schéma JSON des thèmes](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json) pour connaître les propriétés exactes, les couleurs obligatoires et les types de valeurs acceptés.

Prism signale les fichiers de thème invalides au démarrage et lors de `/reload`.

## Trouver la couleur à modifier

Les couleurs de thème décrivent des rôles de l’interface plutôt que des composants individuels. Utilisez ces groupes pour trouver la partie correspondante du schéma :

| Zone | Noms de couleur |
|---|---|
| Interface générale | `accent`, `border*`, `text`, `muted`, `dim`, `success`, `error`, `warning` |
| Sélection et plein écran | `selectedBg`, `searchMatch*`, `scrollbar*` |
| Messages | `userMessage*`, `customMessage*`, `thinkingText` |
| Exécution des outils | `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `toolTitle`, `toolOutput` |
| Markdown | `md*` |
| Différences des outils | `toolDiff*` |
| Coloration syntaxique | `syntax*` |
| Modes de l’éditeur | `thinking*`, `bashMode` |
| Export HTML | `export.pageBg`, `export.cardBg`, `export.infoBg` |

Le schéma décrit le format. Les thèmes intégrés fournissent toutes les valeurs à copier et à ajuster.

Cinq couleurs facultatives reprennent une autre couleur si elles sont omises :

| Couleur facultative | Valeur de remplacement |
|---|---|
| `scrollbarTrack` | `muted` |
| `scrollbarThumb` | `text` |
| `searchMatchBg` | `selectedBg` |
| `searchMatchText` | `text` |
| `thinkingMax` | `thinkingXhigh` |

Si les couleurs `export` sont omises, Prism déduit les arrière-plans de page et de panneau HTML à partir de `userMessageBg`.

## Charger un thème depuis un projet ou un package

Placez le thème du projet dans `.prism/themes/`. Il n’est chargé qu’après [l’approbation du projet](security.md#comprendre-la-confiance-accordée-au-projet).

Vous pouvez aussi charger des fichiers et dossiers de thèmes avec le réglage `themes` ou les distribuer dans un package Prism. Consultez [Configuration](configuration.md), [Réglages](settings.md#ressources) et [Packages Prism](packages.md).

Chaque thème chargé doit avoir un nom unique. Prism signale les noms identiques comme des conflits de ressources.
