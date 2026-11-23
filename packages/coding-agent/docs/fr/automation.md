# Automatisation

Prism peut fonctionner sans l’interface du terminal, pour des scripts et des intégrations. Choisissez un modèle et un fournisseur configurés avec les options habituelles de la CLI ; les exemples ci-dessous utilisent le modèle configuré par défaut.

## Mode d’affichage

`-p` exécute un prompt, affiche la réponse finale et se termine :

```bash
prism -p "Résume le projet actuel"
```

## Flux d’événements JSON

`--mode json` affiche un événement JSON par ligne, puis se termine :

```bash
prism --mode json "Résume le projet actuel" > events.jsonl
```

## RPC

`--mode rpc` lit des commandes JSONL sur l’entrée standard et écrit les réponses et les événements sur la sortie standard. Fermez l’entrée standard pour demander un arrêt propre :

```bash
printf '%s\n' '{"id":"prompt-1","type":"prompt","message":"Résume le projet actuel"}' \
  | prism --mode rpc --no-session
```

## SDK TypeScript

Utilisez le SDK quand l’application hôte est elle aussi écrite en TypeScript et doit exécuter Prism dans le même processus :

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();
try {
  await session.prompt("Summarize the current project");
  console.log(session.getLastAssistantText());
} finally {
  session.dispose();
}
```

## Permissions sans interface

Le mode de permissions par défaut est `ask`. En mode `-p` et JSON, une action qui ouvrirait une boîte de confirmation est bloquée aussitôt : le modèle reçoit la raison comme erreur d’outil et Prism l’écrit sur la sortie d’erreur. Prism n’attend pas un utilisateur qui ne peut pas répondre. Les actions sûres continuent de s’exécuter.

En mode RPC, la confirmation part vers le client sous forme d’`extension_ui_request` (`select`) et attend son `extension_ui_response` ; consultez [RPC extension UI](../rpc-extension-ui.md) (en anglais). Un client qui ne répond jamais laisse l’appel en attente.

Pour des scripts sans surveillance, choisissez l’accès minimal nécessaire. `--perm-mode broad` autorise les actions ordinaires qui demanderaient sinon une confirmation, y compris les écritures dans le projet :

```bash
prism --perm-mode broad -p "Mets à jour les fichiers du projet"
```

Les actions dangereuses demandent toujours une confirmation et restent bloquées sans interface interactive. Une règle ciblée dans le `permissions.json` de l’agent peut autoriser une action précise, par exemple `{"allow":["write(src/**)"]}`. Dans les modes `safe`, `ask` et `broad`, les commandes shell autorisées s’exécutent quand même dans la [sandbox](sandbox.md) : elles n’écrivent que dans le projet, et un hôte jamais autorisé est refusé, puisque personne ne peut répondre. Consultez [Permissions](permissions.md) pour les modes, la correspondance des règles et les chemins protégés.
