# Skills

Un skill (module de consignes) est un ensemble d’instructions spécialisées et de fichiers utiles pour un type de travail précis. Prism présente chaque skill disponible avec son nom et sa description, puis ne charge ses consignes complètes que lorsque la tâche le nécessite.

Utilisez un skill si une méthode de travail a besoin de plus de contexte qu’un modèle de prompt, mais pas d’un nouveau point d’intégration exécutable. Un skill peut rassembler des scripts, références et ressources avec ses consignes.

Prism applique la [spécification Agent Skills](https://agentskills.io/specification). La plupart des champs non valides provoquent un avertissement plutôt que d’interrompre le démarrage.

## Créer un skill

Un skill est un dossier contenant `SKILL.md` :

```text
pdf-tools/
├── SKILL.md
├── scripts/
│   └── extract.sh
├── references/
│   └── formats.md
└── assets/
    └── template.json
```

Commencez `SKILL.md` par des métadonnées, puis des consignes directes :

```markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when reading, converting, or inspecting PDFs.
---

# PDF tools

Read `references/formats.md` before converting a document. Run scripts relative to this skill directory.
```

La description détermine quand le modèle envisage de charger le skill. Indiquez à la fois ce qu’il fait et quand il s’applique. Évitez les descriptions comme « Aide avec les PDF », qui ne donnent pas assez d’informations pour l’orienter.

Utilisez des chemins relatifs au dossier du skill pour désigner les fichiers qu’il contient. Prism indique au modèle où se trouve le skill afin qu’il puisse résoudre ces chemins.

## Comprendre le chargement des skills

Au démarrage, Prism parcourt les emplacements de skills configurés et ajoute au prompt système le nom, la description et le chemin de chaque skill. Il n’ajoute pas les consignes complètes.

Quand une tâche correspond à un skill, le modèle lit `SKILL.md` et suit ses consignes. Les détails restent ainsi hors du contexte jusqu’à ce qu’ils soient nécessaires. Le modèle peut ne pas charger un skill pertinent ; utilisez alors `/skill:name` pour le lui imposer.

Les arguments après `/skill:name` sont ajoutés aux consignes chargées sous forme de demande utilisateur :

```text
/skill:pdf-tools extract report.pdf
```

Définissez `disable-model-invocation: true` dans les métadonnées si un skill ne doit être disponible que par sa commande explicite. Le réglage [enableSkillCommands](settings.md) détermine si les commandes de skills apparaissent dans la recherche interactive ; les commandes `/skill:name` saisies manuellement restent disponibles.

<a id="choose-where-it-loads"></a>

## Ajouter un skill à Prism

Placez le skill dans votre dossier de skills ou celui du projet. Prism recherche récursivement les dossiers contenant `SKILL.md`.

Dans une session, `/skills` (aussi `/settings` > Conversation > Skills) liste les skills trouvés, leur provenance et s’ils sont activés. Il active ou désactive un skill (les mêmes motifs `+`/`-` que `prism config`), installe un paquet de skills depuis npm, git, une URL ou un dossier local (comme `prism install`), met à jour les paquets de skills et en retire un. Avant d’installer ou de mettre à jour un paquet, il montre la source, s’il vaut pour ce projet ou pour tous les projets, et prévient qu’un paquet peut exécuter du code ; rien ne se fait sans votre confirmation. Les changements s’appliquent à sa fermeture.

Prism prend aussi en charge les emplacements Agent Skills `~/.agents/skills/` et `.agents/skills/`. Les dossiers `.agents/skills/` du projet sont recherchés depuis le dossier de travail et ses dossiers parents, jusqu’à la racine du dépôt s’il y en a une.

Prism accepte certains skills Markdown autonomes, mais un dossier contenant `SKILL.md` est plus portable et doit être privilégié. Consultez [Réglages](settings.md#ressources) et [Packages Prism](packages.md) pour d’autres emplacements.

Les skills d’un projet peuvent demander au modèle d’exécuter des scripts ou de modifier des fichiers. Examinez les skills inconnus et les fichiers qui les accompagnent avant d’approuver le projet.

## Écrire des métadonnées portables

La spécification Agent Skills définit les champs suivants :

| Champ | Rôle |
|---|---|
| `name` | Nom de commande et nom affiché |
| `description` | Description qui oriente le modèle |
| `license` | Nom de licence ou fichier de licence inclus |
| `compatibility` | Prérequis de l’environnement |
| `metadata` | Métadonnées supplémentaires sous forme de paires clé-valeur |
| `allowed-tools` | Liste expérimentale des outils préautorisés |
| `disable-model-invocation` | Masque le skill à la sélection automatique par le modèle |

Les noms utilisent des minuscules, des chiffres et des traits d’union ; ils ne peuvent pas commencer, se terminer ni contenir deux traits d’union consécutifs. Ils comportent au maximum 64 caractères et les descriptions 1024 caractères.

Prism n’exige pas que le nom déclaré corresponde au dossier parent et ne donne pas d’avertissement en cas de différence. D’autres implémentations d’Agent Skills peuvent l’exiger ; pour assurer la portabilité, gardez des noms identiques.

Les fichiers `SKILL.md` mal formés et les skills déclarés sans description ne sont pas chargés. En cas de noms identiques, Prism conserve le premier skill trouvé et affiche un avertissement.

## Valider et partager un skill

Lancez Prism depuis un emplacement où le skill peut être détecté, puis examinez les diagnostics de démarrage et la commande `/skill:name`. Exécutez `/reload` après avoir modifié un skill pendant une session active.

Utilisez un [package Prism](packages.md) pour distribuer un ou plusieurs skills par npm ou git. Gérez la préparation de l’environnement dans le skill et déclarez les dépendances nécessaires à l’exécution dans le package.

Pour des exemples, consultez la [collection de skills d’Anthropic](https://github.com/anthropics/skills) et la [collection de skills de Pi](https://github.com/badlogic/pi-skills).
