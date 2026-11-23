# Fournisseurs

La plupart des fournisseurs hébergés proposent l’une de ces méthodes d’authentification, ou les deux :

- Se connecter par un navigateur ou un code d’appareil, avec OAuth.
- Fournir une clé API.

Lancez `/login [provider]` pour voir les méthodes d’un fournisseur. Amazon Bedrock et Google Vertex AI peuvent aussi utiliser les identifiants fournis par leur plateforme cloud.

## S’authentifier de façon interactive

Lancez `/login` et choisissez un fournisseur. Prism vous guide dans son parcours OAuth ou de clé API et enregistre l’identifiant obtenu dans le trousseau du système quand il fonctionne, sinon dans [`auth.json`](configuration.md#dossier-agent) ; consultez [Secrets](security.md#secrets). Sans session, par exemple sur un serveur par SSH, `prism auth login <provider>` fait de même depuis le shell ; consultez [Commandes d’identifiants](cli.md#credential-commands).

Sur une machine distante ou sans écran, le retour OAuth peut ne pas atteindre le processus local. Quand Prism vous le demande, collez l’URL de redirection finale ou le code d’autorisation.

Lancez `/logout` et choisissez un fournisseur pour supprimer son identifiant enregistré. Cela ne retire ni les variables d’environnement, ni l’authentification de `models.json`, et ne révoque pas l’identifiant chez le fournisseur.

`auth.json` peut contenir des clés API et des jetons OAuth. Gardez-le privé et ne le commitez pas.

**Sign in with ChatGPT** (la connexion par abonnement OpenAI) envoie à OpenAI un identifiant aléatoire de cette installation de Prism, gardé sous le nom `deviceId` dans le `settings.json` global. Consultez [Vie privée](security.md#vie-privée).

## Utiliser une clé API de l’environnement

Les variables d’environnement sont utiles en CI et partout où Prism ne doit pas enregistrer la clé. Définissez la variable avant de lancer Prism :

```bash
export ANTHROPIC_API_KEY=sk-ant-...
prism
```

Ce tableau couvre les fournisseurs qui ont une seule variable de clé API principale. Ceux qui demandent une configuration supplémentaire ou acceptent les identifiants de leur plateforme sont décrits dans [Configuration propre à certains fournisseurs](#configuration-propre-à-certains-fournisseurs).

| Fournisseur | Variable d’environnement |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan (international) | `ZAI_API_KEY` |
| ZAI Coding Plan (Chine) | `ZAI_CODING_CN_API_KEY` |
| OpenCode Zen et Go | `OPENCODE_API_KEY` |
| Radius | `RADIUS_API_KEY` |
| TypeSafe ([modèles de classification](models.md#utiliser-des-modèles-de-classification)) | `TYPESAFE_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Meta | `META_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| MiniMax (Chine) | `MINIMAX_CN_API_KEY` |
| Moonshot AI (international et Chine) | `MOONSHOT_API_KEY` |
| Qwen Token Plan et Individual | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan (Chine) | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan (Chine) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan (Singapour) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |

Anthropic reconnaît aussi `ANTHROPIC_OAUTH_TOKEN` comme identifiant d’API et `ANTHROPIC_AUTH_TOKEN` comme authentification par jeton porteur.

Sans clé ni jeton, Anthropic utilise la fédération d’identité de charge de travail quand `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID` et `ANTHROPIC_IDENTITY_TOKEN_FILE` sont définies : le SDK d’Anthropic échange le jeton d’identité contre un jeton d’accès de courte durée et le renouvelle lui-même (en relisant le fichier du jeton d’identité : gardez ce fichier à jour pour les longues sessions). `ANTHROPIC_SERVICE_ACCOUNT_ID` et `ANTHROPIC_WORKSPACE_ID` sont transmises quand elles sont définies.

## Charger une clé API depuis une commande

Pour utiliser un gestionnaire de secrets sans écrire la clé obtenue sur le disque, donnez comme `key` d’un fournisseur, dans `auth.json`, une commande précédée de `!` :

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "!security find-generic-password -ws 'anthropic'"
  }
}
```

Prism lance la commande la première fois que la clé est nécessaire et garde sa sortie standard en mémoire pendant toute la vie du processus. Une sortie vide, un délai dépassé ou un code de sortie non nul laissent la clé non résolue jusqu’au redémarrage de Prism.

## Configuration propre à certains fournisseurs

Les fournisseurs ci-dessous demandent une mise en place supplémentaire, des réglages en plus, ou peuvent utiliser les identifiants fournis par leur plateforme.

Un identifiant de clé API enregistré peut contenir un objet `env`. Pour ce fournisseur, ses valeurs passent avant l’environnement du processus :

```json
{
  "cloudflare-workers-ai": {
    "type": "api_key",
    "key": "...",
    "env": {
      "CLOUDFLARE_ACCOUNT_ID": "account-id"
    }
  }
}
```

### Radius

Radius est un service conçu pour pi, l’agent sur lequel Prism est construit, par ses auteurs, Earendil Works. Il fournit une passerelle d’IA personnalisable, avec des contrôles et des statistiques au niveau de l’organisation, et des artefacts pour partager ce que vous créez.

Radius est retiré des menus de `/login` de Prism : `/login radius` ne lance pas de connexion Radius. Le fournisseur reste disponible avec des identifiants existants ou `RADIUS_API_KEY`, et ses modèles apparaissent dans `/model` comme ceux des autres fournisseurs.

Radius a aussi un serveur MCP, pour que Prism gère Radius à votre place.

Radius est en alpha et évolue vite. Consultez [radius.earendil.com](https://radius.earendil.com).

L’authentification Radius utilise le catalogue de sa passerelle et garde en cache les métadonnées de modèles rafraîchies pour un démarrage hors ligne ultérieur. Une passerelle Radius personnalisée configurée dans `models.json` utilise son propre catalogue plutôt que le catalogue public de `radius.pi.dev`.

### Azure OpenAI

Définissez une clé API, plus une URL de base ou un nom de ressource :

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.ai.azure.com
# Ou :
export AZURE_OPENAI_RESOURCE_NAME=your-resource
```

Les URL racines de ressource sous `ai.azure.com`, `cognitiveservices.azure.com` et `openai.azure.com` sont ramenées au chemin de l’API OpenAI.

### Amazon Bedrock

Bedrock peut utiliser un jeton porteur ou une source d’identifiants AWS de l’environnement :

```bash
# Profil nommé
export AWS_PROFILE=your-profile

# Clés IAM
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
# Nécessaire pour des identifiants temporaires
export AWS_SESSION_TOKEN=...

# Jeton porteur Bedrock
export AWS_BEARER_TOKEN_BEDROCK=...

# Région, quand le profil ou la configuration du SDK AWS ne la donne pas
export AWS_REGION=us-west-2
# AWS_DEFAULT_REGION est aussi accepté
```

Prism prend aussi en charge les identifiants des tâches ECS et IRSA par les variables standard `AWS_CONTAINER_CREDENTIALS_*` et `AWS_WEB_IDENTITY_TOKEN_FILE`.

### Cloudflare AI Gateway

La passerelle demande un jeton, un identifiant de compte et un identifiant de passerelle :

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...
```

Les identifiants de compte et de passerelle peuvent venir de l’environnement du processus ou de l’objet `env` de l’identifiant dans `auth.json`.

`CLOUDFLARE_API_KEY` authentifie Prism auprès de la passerelle. L’accès au fournisseur en aval peut passer par la facturation unifiée de Cloudflare, par des identifiants enregistrés dans la passerelle, ou par un en-tête `Authorization` configuré pour le fournisseur dans `models.json`.

### Cloudflare Workers AI

Workers AI demande un jeton et un identifiant de compte :

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
```

L’identifiant de compte peut aussi être enregistré dans l’objet `env` de l’identifiant.

### Google Vertex AI

Utilisez une clé API Google Cloud :

```bash
export GOOGLE_CLOUD_API_KEY=...
```

Pour utiliser les Application Default Credentials, configurez un projet et une région :

```bash
export GOOGLE_CLOUD_PROJECT=your-project
# GCLOUD_PROJECT est aussi accepté
export GOOGLE_CLOUD_LOCATION=us-central1
```

Puis authentifiez-vous :

```bash
gcloud auth application-default login
```

Pour utiliser plutôt un fichier de clé de compte de service, définissez `GOOGLE_APPLICATION_CREDENTIALS` avec le projet et la région.
