# Packages Prism

Les packages Prism installent et distribuent ensemble des extensions, skills, modèles de prompt et thèmes. Utilisez-en un si vous voulez partager une personnalisation par npm ou git, ou regrouper plusieurs ressources.

Un package est un dossier ordinaire ou un package npm. Il peut fournir les dossiers de ressources habituels, déclarer des chemins explicites sous la clé `pi` de `package.json` et inclure ses propres dépendances d’exécution.

## Installer et gérer des packages

Installez un package depuis npm, git ou un chemin local :

```bash
prism install npm:@example/pi-tools@1.0.0
prism install git:github.com/example/pi-tools@v1
prism install ./local-package
```

`prism list` affiche les packages configurés. Utilisez `prism remove <source>` pour en supprimer un et `prism update --extensions` pour mettre les installations de packages en conformité. Consultez [Ligne de commande](cli.md#commandes-de-packages) pour toutes les commandes et options de packages.

Les installations personnelles sont déclarées dans `~/.prism/agent/settings.json`. Ajoutez `--local` ou `-l` pour déclarer le package dans `.prism/settings.json`. Prism ne lit ce fichier qu’après l’approbation du projet.

Les packages du projet ne sont installés et chargés qu’après la vérification de confiance. Ils peuvent exécuter du code d’extension et contenir des skills qui demandent au modèle de lancer des programmes. Examinez le code des packages tiers avant de les installer et les déclarations de packages du projet avant de l’approuver.

Utilisez `--extension` ou `-e` pour essayer un package lors d’une seule exécution, sans l’ajouter aux réglages :

```bash
prism -e npm:@example/pi-tools
```

## Choisir une source

| Source | Exemple | Fonctionnement |
|---|---|---|
| npm | `npm:@example/pi-tools@1.0.0` | Installé dans le dossier npm de Prism |
| git | `git:github.com/example/pi-tools@v1` | Cloné et mis en conformité avec la référence choisie |
| URL | `https://github.com/example/pi-tools` | Traité comme une source git |
| Local | `./pi-tools` | Chargé depuis le chemin résolu sans copie |

Les spécifications npm avec version sont épinglées. Les tags et commits git le sont aussi ; la mise à jour des packages ajuste la copie au dépôt sans déplacer la référence configurée.

Les chemins locaux relatifs sont résolus depuis le fichier de réglages qui les contient. Un chemin de fichier charge une extension. Un chemin de dossier suit les règles habituelles de découverte des packages.

## Créer un package

Le package le plus simple utilise des dossiers habituels :

```text
my-pi-package/
├── package.json
├── extensions/
├── skills/
├── prompts/
└── themes/
```

Sans manifeste `pi`, Prism recherche dans ces dossiers les extensions TypeScript et JavaScript, les dossiers de skills, les prompts Markdown et les thèmes JSON.

Utilisez un manifeste explicite si les ressources se trouvent ailleurs ou doivent être filtrées :

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"],
    "themes": ["./resources/themes/*.json"]
  }
}
```

Les chemins sont relatifs à la racine du package. Les tableaux acceptent les motifs glob et les exclusions. Indiquez directement les dossiers de ressources cachés ou symboliques si la recherche par motif ne peut pas les trouver.

Le mot-clé `pi-package` permet à un package npm d’être répertorié dans la [galerie de packages Pi](https://pi.dev/packages). Les champs facultatifs `pi.image` et `pi.video` ajoutent des aperçus à la galerie.

## Déclarer les dépendances

Ajoutez les packages nécessaires à l’exécution des extensions dans `dependencies`. Prism installe les dépendances d’un package lorsqu’il installe sa source npm ou git.

Prism fournit ces packages aux extensions et aux skills :

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

Déclarez les packages hôtes ci-dessus dans `peerDependencies` avec une plage `"*"` et ne les incluez pas dans votre package. Prism désactive l’installation automatique des dépendances peer pour les packages npm gérés et pour les packages git installés avec npm, pnpm ou Bun. Les packages locaux ne sont ni installés ni modifiés ; leur arbre de dépendances reste donc sous la responsabilité de leur auteur.

Ne placez pas les packages fournis par l’hôte dans `dependencies`. Une copie physique peut contourner la correspondance des modules d’extension de Prism dans ESM compilé et créer des classes et registres en double, ainsi que du travail d’initialisation inutile. Prism signale cette configuration dans le manifeste d’une extension. Les autres packages Prism utilisés comme dépendances doivent figurer dans l’archive publiée et être référencés avec leurs chemins de ressources `node_modules`.

Les packages installés sont chargés avec des racines de modules séparées. Ne partez pas du principe que deux packages partagent une instance de dépendance ou qu’un package peut résoudre une dépendance non déclarée d’un autre.

## Choisir les ressources d’un package

La forme objet des réglages limite les ressources chargées depuis un package :

```json
{
  "packages": [
    {
      "source": "npm:@example/pi-tools",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

Pour chaque type de ressource :

- Omettez la propriété pour charger toutes les ressources que le package autorise.
- Utilisez `[]` pour ne rien charger de ce type.
- Utilisez `!pattern` pour exclure les éléments qui correspondent au motif glob.
- Utilisez `+path` pour inclure un chemin autorisé précis.
- Utilisez `-path` pour exclure un chemin précis.

Les filtres restreignent le manifeste du package. Ils ne donnent pas accès à des ressources que le package n’a pas lui-même déclarées.

Exécutez `prism config` pour activer ou désactiver les ressources détectées et les extensions intégrées de Prism. La commande démarre avec la configuration personnelle ; appuyez sur Tab pour changer de portée ou exécutez `prism config --local` pour commencer avec les remplacements du projet.

## Comprendre la portée et l’identité

Le même package peut figurer dans les réglages personnels et ceux du projet. Normalement, l’entrée du projet remplace l’entrée personnelle. Avec `autoload: false`, l’entrée du projet sert plutôt de filtre appliqué au package personnel.

Prism identifie les packages npm par leur nom, les packages git par l’URL du dépôt sans la référence et les packages locaux par leur chemin absolu résolu. Cela évite de charger deux fois le même package à partir de déclarations équivalentes.

Consultez les pages [Extensions](../extensions.md), [Skills](skills.md), [Modèles de prompt](prompt-templates.md) et [Thèmes](themes.md) pour concevoir chaque ressource avant de la regrouper.
