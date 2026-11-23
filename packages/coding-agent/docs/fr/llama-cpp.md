# Modèles locaux avec llama.cpp

Prism prend en charge le serveur routeur [llama.cpp](https://github.com/ggml-org/llama.cpp). Le routeur détecte plusieurs modèles GGUF et les charge ou décharge à la demande.

Utilisez une version récente de llama.cpp qui prend en charge le mode routeur. Suivez les [instructions de compilation](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) ou installez une [version précompilée](https://github.com/ggml-org/llama.cpp/releases) pour votre plateforme.

## Démarrer le routeur

Démarrez `llama-server` sans `--model` ni `-m`. Si vous indiquez un modèle, le serveur démarre en mode modèle unique au lieu du mode routeur.

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 127.0.0.1 \
  --port 9931 \
  -ngl 999 \
  -c 32768
```

Options importantes :

- `--models-dir ~/models` détecte les fichiers GGUF locaux.
- `--no-models-autoload` oblige à charger les modèles avec `/llama`.
- `--jinja` active les modèles de dialogue compatibles et les appels d’outils.
- `-ngl 999` déplace autant de couches que possible vers le GPU.
- `-c 32768` définit la fenêtre de contexte de chaque modèle chargé. Omettez cette option pour utiliser le contexte natif du modèle, qui peut demander beaucoup plus de mémoire.

Un modèle composé d’un seul fichier peut se trouver directement dans le dossier des modèles. Placez les modèles multimodaux et répartis sur plusieurs fichiers dans des sous-dossiers distincts :

```text
~/models/
├── llama-3.2-1b-Q4_K_M.gguf
├── gemma-3-4b-it-Q4_K_M/
│   ├── gemma-3-4b-it-Q4_K_M.gguf
│   └── mmproj-F16.gguf
└── large-model-Q4_K_M/
    ├── large-model-Q4_K_M-00001-of-00003.gguf
    ├── large-model-Q4_K_M-00002-of-00003.gguf
    └── large-model-Q4_K_M-00003-of-00003.gguf
```

Redémarrez le routeur après avoir ajouté des fichiers manuellement. Pour définir la taille du contexte de chaque modèle et d’autres options, consultez les [préréglages de modèles llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets).

## Configurer Prism

Démarrez Prism et configurez le fournisseur :

```text
/login llama.cpp
```

Saisissez l’URL du routeur et, facultativement, sa clé API. L’URL par défaut est `http://127.0.0.1:9931`.

Si vous démarrez le routeur avec `--no-models-autoload`, `/login llama.cpp` n’enregistre que la connexion. Exécutez `/llama` pour charger un modèle, puis `/model` pour le choisir dans la session actuelle.

Vous pouvez configurer les mêmes valeurs avec des variables d’environnement, sans `/login` :

```bash
export LLAMA_BASE_URL=http://127.0.0.1:9931
export LLAMA_API_KEY=optional-secret
prism
```

Si le serveur utilise une clé API, démarrez `llama-server` avec la valeur correspondante de `--api-key`. Gardez `--host 127.0.0.1` pour limiter l’accès à la machine locale.

## Gérer les modèles

Exécutez :

```text
/llama
```

- Choisissez un modèle non chargé pour le charger.
- Choisissez un modèle chargé pour le décharger.
- Choisissez **Download model…**, recherchez sur Hugging Face, puis choisissez un dépôt et une quantification. Les valeurs exactes `owner/repository[:quant]` fonctionnent aussi.
- Pendant le chargement ou le téléchargement, appuyez sur Escape et confirmez l’annulation.

La recherche Hugging Face utilise `HF_TOKEN` s’il est défini, puis vérifie `$HF_TOKEN_PATH`, `$HF_HOME/token`, `$XDG_CACHE_HOME/huggingface/token` et `~/.cache/huggingface/token`. La recherche fonctionne aussi sans authentification, avec des limites de fréquence plus basses. Prism prévient avant de télécharger des dépôts à accès restreint et fournit un lien vers la page d’accès. Le serveur llama.cpp effectue le téléchargement ; son processus doit donc aussi disposer de `HF_TOKEN` si le dépôt choisi exige un accès.

Si d’autres modèles sont chargés, Prism demande s’il faut d’abord les décharger ou les garder. Prism ne décharge pas de modèles sans prévenir et ne supprime jamais de fichiers de modèles. Comme d’autres clients peuvent partager le routeur, `/llama` affiche toujours son état actuel.

Les modèles chargés et en veille apparaissent dans `/model`. Un modèle en veille se réactive automatiquement quand vous le choisissez. Si le chargement automatique du routeur est actif, les modèles prédéfinis non chargés apparaissent aussi et sont chargés quand vous les choisissez. Avec `--no-models-autoload`, chargez d’abord un modèle avec `/llama`.

Si la connexion au routeur est interrompue, `/llama` propose **Retry** et **Close**. Retry rétablit la connexion et actualise l’état des modèles sans répéter l’opération interrompue.

## Classification

Tous les modèles répertoriés pour le dialogue le sont aussi comme modèles de classification, avec le même identifiant et l’API `llama-cpp-classify`. Les modèles de classification répondent à des questions structurées `choice`, `bool` et `score` sur un état JSON, comme les modèles Jev de TypeSafe. Le modèle y accède depuis les scripts [`codemode`](cli.md#activer-codemode), et les extensions avec `ctx.modelRegistry.classify()` ; consultez [Modèles de classification](models.md).

Le modèle ne rédige pas de réponse. Chaque question devient un prompt de dialogue : l’état, chaque question de la demande, l’état de nouveau, puis la question accompagnée de ses réponses sous forme d’étiquettes d’un seul token. Les choix utilisent des lettres (jusqu’à 62 options), les booléens `Yes` et `No`, et les notes des chiffres (jusqu’à 10 niveaux). La seconde copie de l’état est examinée avec les questions, ce qui a amélioré la précision sur JevBench avec de petits modèles. Prism lit les probabilités des étiquettes comme token suivant et les normalise. Un choix renvoie la probabilité de chaque option et un niveau de confiance de `(n * peak - 1) / (n - 1)` ; une note renvoie le niveau attendu.

- Les probabilités brutes des étiquettes sont généralement trop élevées. L’option `temperature` de chaque demande divise les logits des étiquettes avant normalisation ; les valeurs supérieures à 1 adoucissent la distribution. Elle ne change aucune réponse.
- Les questions sont traitées l’une après l’autre. Tout ce qui précède la dernière question est identique pour toutes les questions d’une demande ; le cache de prompts du serveur ne l’évalue donc qu’une fois. L’état figure deux fois et nécessite donc deux fois sa taille dans le contexte.
- Les petits modèles peuvent suivre les consignes écrites dans l’état. Le prompt demande au modèle de juger l’état comme des données, mais cela ne garantit pas qu’il le fasse.
- Les modèles hybrides comme Qwen3.5 ne peuvent pas revenir en arrière dans un prompt partiellement mis en cache sans points de contrôle du contexte. Si chaque question traite de nouveau l’état complet, démarrez le routeur avec `--ctx-checkpoints 32 --checkpoint-min-step 0`.

## Résoudre les problèmes

Vérifiez que le routeur est accessible :

```bash
curl http://127.0.0.1:9931/health
curl http://127.0.0.1:9931/models
```

- **Aucun modèle dans `/llama` :** vérifiez `--models-dir`, l’organisation des dossiers et redémarrez le routeur.
- **Le modèle n’apparaît pas dans `/model` avec `--no-models-autoload` :** chargez-le d’abord avec `/llama`.
- **Le chargement échoue ou consomme trop de mémoire :** réduisez `-c` ou déchargez un autre modèle.
- **Le serveur n’est pas en mode routeur :** démarrez-le sans `--model`, `-m` ni `-hf`.

Pour supprimer le fournisseur `llama.cpp` et la commande `/llama`, désactivez `llama.cpp` sous Built-in dans `prism config`, ou définissez `"extensions": ["-builtin:llama.cpp"]` dans les [réglages](settings.md#ressources).
