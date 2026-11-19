# Variables d’environnement

Prism utilise les variables d’environnement de trois façons :

- Certaines, comme `PI_OFFLINE`, configurent le processus Prism.
- Prism définit des marqueurs de processus pour que les processus enfants puissent reconnaître Prism comme agent qui les a lancés.
- Les commandes exécutées par les outils shell accessibles au modèle reçoivent des variables `PI_*` décrivant la session actuelle.

Les variables de clés API des fournisseurs sont décrites séparément dans [Fournisseurs](../providers.md#use-an-api-key-from-the-environment).

## Marqueurs de processus

Les points d’entrée CLI et RPC définissent deux marqueurs de processus :

- `AI_AGENT=pi` est un marqueur générique qui permet aux outils de reconnaître Prism comme agent ayant lancé le processus.
- `PI_CODING_AGENT=true` est propre à Prism et permet aux processus enfants de détecter qu’ils s’exécutent à l’intérieur de Prism.

Les processus enfants héritent des deux marqueurs. Ils ne sont propres à aucune session et ne sont pas définis automatiquement si Prism est intégré avec le SDK.

## Variables de session pour les outils shell

Les commandes exécutées par les outils `bash` et `powershell` reçoivent l’état de la session Prism actuelle :

| Variable | Description |
|---|---|
| `PI_SESSION_ID` | Identifiant de la session actuelle |
| `PI_SESSION_FILE` | Chemin absolu du fichier JSONL actuel ; absent pour les sessions temporaires |
| `PI_PROVIDER` | Fournisseur du modèle sélectionné |
| `PI_MODEL` | Identifiant du modèle sélectionné |
| `PI_REASONING_LEVEL` | Niveau de réflexion effectif : `off`, `minimal`, `low`, `medium`, `high`, `xhigh` ou `max` |

Les valeurs sont déterminées au lancement de chaque commande. Changer de modèle ou de niveau de réflexion affecte donc la prochaine commande shell sans redémarrer Prism. `PI_PROVIDER` et `PI_MODEL` indiquent le modèle sélectionné dans Prism, et non un autre modèle éventuellement choisi en interne par un routeur.

Si on vous demande quel modèle ou fournisseur est en cours d’utilisation, examinez ces variables au lieu de déduire la réponse du prompt système :

```bash
printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"
printf 'reasoning=%s session=%s\n' "$PI_REASONING_LEVEL" "$PI_SESSION_ID"
```

Si la session est persistante, vous pouvez consulter directement son fichier :

```bash
if [ -n "$PI_SESSION_FILE" ]; then
  tail -n 1 "$PI_SESSION_FILE"
fi
```

Ces variables sont ajoutées aux outils `bash` et `powershell` accessibles au modèle. Elles ne sont pas ajoutées aux commandes `!` ou `!!` saisies par l’utilisateur.

### Outils shell personnalisés

Les outils créés avec `createBashTool()` ou `createPowerShellTool()` exposent par défaut l’environnement de session s’ils sont enregistrés auprès de Prism. L’injection a lieu avant `spawnHook`, qui reçoit donc les variables dans `ctx.env` :

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Désactivez les métadonnées de session indépendamment du hook de lancement :

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

Quand cette option est désactivée, Prism supprime les valeurs héritées de ces variables pour empêcher les processus Prism imbriqués d’exposer d’anciennes informations de session parente.

## Configuration du processus Prism

Prism lit lui-même les variables suivantes :

| Variable | Description |
|---|---|
| `PRISM_CODING_AGENT_DIR` | Remplace le dossier de configuration ; valeur par défaut : `~/.prism/agent` |
| `PRISM_CODING_AGENT_SESSION_DIR` | Remplace le dossier des sessions ; `--session-dir` est prioritaire |
| `PI_PACKAGE_DIR` | Remplace le dossier des packages, utile pour les chemins de stockage Nix/Guix |
| `PI_OFFLINE` | Désactive les activités réseau automatiques, notamment l’actualisation du catalogue de modèles |
| `PI_SKIP_VERSION_CHECK` | Désactive la demande de la dernière version à `pi.dev` |
| `PI_TELEMETRY` | Remplace les réglages de télémétrie d’installation et de mise à jour et les en-têtes d’attribution fournisseur : `1`/`true`/`yes` ou `0`/`false`/`no` |
| `PI_CACHE_RETENTION` | Définissez `long` pour une durée prolongée de mise en cache des prompts fournisseur si elle est prise en charge |
| `PI_SHARE_VIEWER_URL` | Remplace l’URL de base utilisée par `/share` |
| `PI_RADIUS_GATEWAY` | Remplace l’origine de la passerelle Radius utilisée par les envois `/bug` et les connexions de relais Radius |
| `PI_HARDWARE_CURSOR` | Définissez `1` pour afficher le curseur matériel ; consultez [Configuration du terminal](terminal-setup.md) |
| `PI_HYPERLINKS` | Remplace la détection des hyperliens OSC 8 avec `1`, `0` ou `auto` |
| `PI_IMAGE_PROTOCOL` | Remplace la détection des images intégrées avec `kitty`, `iterm2`, `none` ou `auto` |
| `PI_TRUE_COLOR` | Remplace la détection des couleurs vraies avec `1`, `0` ou `auto` |
| `PI_TUI_ESC_TIMEOUT` | Durée d’attente après ESC seul avant de le traiter comme Escape, en millisecondes ; valeur par défaut : `100` par SSH et `10` autrement. Augmentez-la si une touche Alt est interprétée comme Escape |
| `VISUAL`, `EDITOR` | Éditeur externe utilisé en remplacement si `externalEditor` n’est pas défini |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy des demandes HTTP sortantes |

Les identifiants des fournisseurs comme `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` et leur configuration particulière sont indiqués dans [Fournisseurs](../providers.md#use-an-api-key-from-the-environment).
