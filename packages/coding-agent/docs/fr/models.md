# Choisir un modèle

Pour utiliser un fournisseur intégré, commencez par `/login`, puis choisissez un modèle avec `/model`. Ne configurez un modèle personnalisé que si Prism n’inclut pas déjà le fournisseur ou le point de terminaison voulu.

## Choisir une connexion

| Ce que vous avez | Configuration conseillée |
|---|---|
| Un abonnement pris en charge | Connectez-vous avec `/login` |
| Une clé API de fournisseur | Enregistrez-la avec `/login` ou définissez sa variable d’environnement |
| Un modèle GGUF local | Connectez Prism au routeur llama.cpp |
| Un point de terminaison compatible avec OpenAI, Anthropic ou Google | Ajoutez-le à `models.json` |
| Un fournisseur avec un protocole ou une méthode d’authentification personnalisé | Créez ou installez une extension fournisseur |

Consultez le [catalogue de modèles](https://pi.dev/models) pour voir les fournisseurs actuels, les identifiants de modèle, les capacités, les limites de contexte et les tarifs. Prism utilise le catalogue fourni avec l’application et peut lui ajouter des données plus récentes de pi.dev. Les données en cache restent disponibles hors ligne ; exécutez `prism update --models` pour forcer leur actualisation.

## S’authentifier

Exécutez `/login` et choisissez un fournisseur. Prism enregistre les identifiants dans [`auth.json`](configuration.md#dossier-agent). Exécutez `/logout` pour supprimer les identifiants enregistrés d’un fournisseur.

Vous pouvez aussi fournir une clé API avec la variable d’environnement du fournisseur. Cette méthode convient à l’intégration continue et aux environnements où Prism ne doit pas écrire d’identifiants. La page [Fournisseurs](providers.md) indique les variables et les réglages propres à chaque fournisseur.

Si plusieurs sources d’identifiants sont configurées, Prism utilise d’abord la clé d’exécution `--api-key`, puis un identifiant enregistré dans `auth.json`, une valeur `apiKey` dans `models.json`, puis les variables d’environnement du fournisseur ou les identifiants cloud présents dans l’environnement. Les extensions de fournisseur peuvent définir leur propre méthode d’authentification.

Gardez `auth.json` et les commandes contenant des identifiants privés. Les réglages et extensions d’un projet peuvent s’exécuter dans le processus Prism une fois le projet approuvé. Lisez [Sécurité](security.md) avant de charger une configuration depuis un dossier auquel vous ne faites pas confiance.

## Sélectionner un modèle

Exécutez `/model` pour rechercher les modèles disponibles. Le sélecteur affiche ceux dont le fournisseur dispose d’une authentification utilisable. Appuyez sur `Ctrl+S` sur un modèle pour le définir par défaut pour les nouvelles sessions.

Exécutez `/thinking` pour choisir le niveau de réflexion du modèle actuel. Appuyez sur `Ctrl+S` pour enregistrer le niveau de démarrage. Prism ne propose que les niveaux pris en charge par le modèle choisi.

`Ctrl+P` parcourt les modèles disponibles. Utilisez `/scoped-models` pour régler et enregistrer cette sélection, ou configurez des motifs de modèles dans [Réglages](settings.md#model-cycling).

Après `/login`, quand un fournisseur propose des modèles sortis plus de six mois avant son plus récent, ou des modèles qu'il a déclarés obsolètes, Prism affiche la liste de ses modèles avec les récents cochés. Les modèles cochés sont enregistrés comme une sélection de `/scoped-models` ; échap les garde tous.

Une session enregistre les changements de modèle et de niveau de réflexion. Quand vous reprenez la session, ces choix sont rétablis sans modifier les valeurs par défaut des nouvelles sessions.

## Connecter des modèles locaux

Prism s’intègre directement au routeur llama.cpp. Le routeur détecte les fichiers GGUF et charge les modèles à la demande. La commande `/llama` de Prism gère le routeur ; `/model` sélectionne un de ses modèles chargés.

Suivez la page [Modèles locaux avec llama.cpp](llama-cpp.md) pour démarrer le serveur, organiser les modèles, les télécharger et résoudre les problèmes de connexion.

Pour Ollama, LM Studio, vLLM, SGLang et les autres serveurs compatibles, [configurez un point de terminaison compatible](#configurer-un-point-de-terminaison-compatible) dans `models.json`.

## Configurer un point de terminaison compatible

Utilisez [`models.json`](configuration.md#dossier-agent) si le point de terminaison utilise une API déjà prise en charge par Prism. C’est le cas de la plupart des installations Ollama, LM Studio, vLLM, SGLang et des proxys.

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

La clé factice rend le modèle disponible dans Prism ; Ollama l’ignore. Pour un point de terminaison authentifié, `apiKey` et les valeurs d’en-tête peuvent utiliser l’interpolation de variable d’environnement `$NAME` ou `${NAME}`, une valeur littérale ou une commande précédée de `!`. Les commandes de `models.json` s’exécutent au moment de la demande et Prism ne les met pas en cache.

L’ouverture de `/model` recharge le fichier. Une entrée `models` ajoute un modèle ou remplace un modèle portant le même identifiant chez ce fournisseur. Utilisez `modelOverrides` pour modifier les métadonnées d’un modèle intégré ou fourni par une extension sans remplacer la liste du fournisseur. Les identifiants inconnus de `modelOverrides` sont ignorés.

### Décrire les entrées des modèles et la mise en cache

Utilisez `inputLimits.images.resize` pour contrôler la façon dont Prism encode les nouvelles images jointes, les résultats de `read` et les images des résultats d’outils avant de les enregistrer dans l’historique de la conversation :

```json
{
  "id": "vision-model",
  "input": ["text", "image"],
  "inputLimits": {
    "images": {
      "resize": {
        "maxWidth": 1568,
        "maxHeight": 1568,
        "maxBytes": 524288,
        "jpegQuality": 75
      }
    }
  }
}
```

`maxBytes` limite la taille des données encodées en base64. Les paramètres de redimensionnement omis utilisent des valeurs prudentes : 2000 par 2000 pixels, 4,5 Mio encodés et une qualité JPEG de 80. Les images sont encodées une fois ; changer de modèle ne réécrit pas les images déjà dans l’historique. Le catalogue peut aussi indiquer des limites strictes de requête avec `inputLimits.maxRequestBytes`, `images.maxPerMessage` et `images.maxPerRequest`, mais Prism ne modifie ni ne rejette encore l’historique en fonction de ces limites.

<a id="prompt-cache-lifetimes"></a>

Utilisez `promptCache` pour indiquer, en secondes, la durée de vie de cache proposée par le fournisseur pour la rétention `short` ou `long` :

```json
{ "id": "claude-sonnet-5", "promptCache": { "short": 300, "long": 3600 } }
```

Choisissez la valeur prudente d’une plage publiée. Un modèle sans durée définie pour le niveau de rétention actif ne peut pas bénéficier du préchauffage du cache. Une entrée `modelOverrides` peut définir `inputLimits` ou `promptCache` pour un modèle intégré ou fourni par une extension, y compris un modèle accessible par un proxy validé. Consultez [`cacheWarming`](settings.md#model-cycling).

Les réglages de compatibilité doivent décrire des différences vérifiées dans le comportement des demandes ou des réponses du point de terminaison. Ne les activez pas au seul motif que le serveur annonce une compatibilité OpenAI ou Anthropic.

## Utiliser des modèles de classification

Les modèles de classification ne dialoguent pas. Ils répondent à des questions précises sur un état JSON : choisir parmi plusieurs options, répondre par oui ou non, ou donner une note, avec des probabilités. Prism inclut le modèle Jev de TypeSafe chez les fournisseurs suivants :

| Fournisseur | Identifiants de modèle | Authentification |
|---|---|---|
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter` | `typesafe/jev-1.13`, `~typesafe/jev-latest` | `OPENROUTER_API_KEY` ou `/login` |
| `cloudflare-workers-ai` | `typesafe/jev` | `CLOUDFLARE_API_KEY` et `CLOUDFLARE_ACCOUNT_ID` |
| `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `opencode` | `jev-1.13`, `jev-1.13-free` | `OPENCODE_API_KEY` |

Les modèles de dialogue du [routeur llama.cpp](llama-cpp.md#classification) figurent aussi parmi les modèles de classification.

Les modèles de classification ne figurent pas dans `/model`. Le modèle les utilise par l’intermédiaire de l’outil [`codemode`](cli.md#activer-codemode), désactivé sauf si un serveur MCP l’a activé. Activez-le avec `"defaultTools": ["+codemode"]` dans les [réglages](settings.md#outils). Les scripts listent ensuite les modèles de classification avec `models.getAvailableOfType("classifier")` et appellent `models.classify(model, { state, questions })` :

```js
const jev = await models.getModelOfType("classifier", "typesafe", "jev-latest");
const result = await models.classify(jev, {
  state: { message: "The change works, thanks." },
  questions: {
    approved: {
      type: "bool",
      instructions: "Does the user approve of the result?",
      criteria: { true: "Approval", false: "No approval" },
    },
  },
});
return result.answers;
```

[Codemode](../codemode.md#classify) décrit les types de questions et de réponses.

Quand le service indique le nombre de tokens, comme le font tous les services System One, `result.usage` contient ces données et leur coût. Prism ajoute l’utilisation des appels de classification d’un script au résultat de l’outil `codemode` : elle est donc comprise dans le coût de la session affiché en bas et par `/session`. Le coût utilise le tarif du modèle indiqué dans le catalogue ; les modèles sans tarif, comme `jev-latest` directement chez TypeSafe, indiquent les tokens sans coût.

Les extensions appellent les modèles de classification avec `ctx.modelRegistry.classify()`, sans codemode. Les [modèles virtuels](../virtual-models.md#route-requests) peuvent les utiliser pour acheminer des demandes ; consultez l’exemple `jev-router.ts`.

## Utiliser des modèles d’image

Les modèles d’image génèrent des images à partir d’un prompt et, en option, d’images d’entrée. Prism répertorie les modèles d’image d’OpenRouter, comme `google/gemini-2.5-flash-image` et `black-forest-labs/flux.2-pro`, sous le fournisseur `openrouter`. Ils utilisent les mêmes identifiants `OPENROUTER_API_KEY` ou `/login` que ses modèles de dialogue.

Comme les modèles de classification, les modèles d’image ne figurent pas dans `/model` ; le modèle les utilise par l’intermédiaire de l’outil [`codemode`](cli.md#activer-codemode). Les scripts les listent avec `models.getAvailableOfType("image")` et appellent `models.generateImages(model, { input })`. La propriété `output` du résultat contient des blocs d’image en base64 ; `image()` les ajoute au résultat de `codemode` pour que le modèle les voie :

```js
const painter = await models.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image");
const result = await models.generateImages(painter, {
  input: [{ type: "text", text: "A red fox in the snow, watercolor" }],
});
if (result.stopReason !== "stop") return result.errorMessage;
for (const block of result.output) if (block.type === "image") image(block);
```

`input` peut aussi contenir des blocs `{ type: "image", data, mimeType }` pour modifier des images ou les utiliser comme références. Comme pour les appels de classification, Prism ajoute l’utilisation des appels d’image d’un script au résultat de l’outil `codemode`. Les images générées ne sont pas enregistrées sur le disque. [Codemode](../codemode.md#generate-images) décrit toute l’API.

Les extensions génèrent des images avec `ctx.modelRegistry.generateImages()`, sans codemode.

## Ajouter un fournisseur personnalisé

Utilisez une extension si le fournisseur nécessite une gestion personnalisée du flux, de la découverte des modèles ou de l’authentification. Consultez [Fournisseurs personnalisés](../custom-provider.md) pour connaître la procédure.

## Résoudre les problèmes

### Un modèle n’apparaît pas

Vérifiez que son fournisseur dispose d’une authentification utilisable. Les modèles personnalisés peuvent être chargés depuis `models.json`, mais restent indisponibles dans `/model` tant que Prism ne peut pas obtenir d’identifiants. Pour llama.cpp, seuls les modèles actuellement chargés par le routeur apparaissent.

### La connexion fonctionne dans un seul terminal

Vérifiez si la clé vient d’une variable d’environnement plutôt que de `auth.json`. Les variables d’environnement doivent être présentes dans le processus qui démarre Prism.

### La connexion ouvre un navigateur sur une machine distante

Si elle est disponible, terminez la procédure d’authentification sans interface graphique du fournisseur. Certains fournisseurs permettent de coller l’URL de redirection finale ou le code d’autorisation dans Prism. Consultez [S’authentifier en mode interactif](providers.md#sauthentifier-de-façon-interactive).

### Un point de terminaison compatible refuse les demandes

Vérifiez le type d’API et les réglages de compatibilité dans `models.json`. Le serveur doit prendre en charge les champs et le comportement des demandes correspondants.
