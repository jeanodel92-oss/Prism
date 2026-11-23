# Diagnostic

## /doctor et prism doctor

`/doctor` vérifie l’installation locale et indique pour chaque vérification si elle est correcte, pose problème ou n’a pas été testée, avec ce qui a été observé, la cause probable et quoi faire :

- les réglages globaux et du projet, `models.json`, et les fichiers de permissions globaux et du projet : présents et lisibles ;
- le dossier agent et le dossier des sessions ;
- le trousseau : si les identifiants vont dans le trousseau du système ou dans `auth.json` ;
- les extensions qui n’ont pas pu se charger, les plantages récents, les capacités de modèles enregistrées ;
- le modèle actuel, son serveur et la dernière requête au modèle.

```text
/doctor                    le rapport
/doctor details            le rapport avec le détail technique de chaque vérification
/doctor export <fichier>   enregistrer le rapport en JSON
```

Quand Prism ne démarre plus, lancez les mêmes vérifications depuis un shell. `prism doctor` ne fait que lire des fichiers : il ne charge pas les extensions, ne lance pas les migrations et n’ouvre pas l’interface.

```bash
prism doctor
prism doctor details
prism doctor export rapport.json
```

`prism doctor` se termine avec le code 1 quand il trouve un problème. Un rapport exporté masque les secrets reconnus et votre dossier personnel, et il est écrit avec le mode `0600` ; relisez-le avant de le partager.

## Quand Prism ne démarre pas ou se comporte mal

- `prism --safe` démarre sans les extensions, skills, modèles de prompt, thèmes ni fichiers de contexte découverts, quand l’un d’eux empêche le démarrage. L’étape de permissions reste active.
- `prism --offline` coupe les accès réseau du démarrage.
- `prism update --rollback` revient à la version précédente après une mise à jour qui pose problème ; consultez [Mises à jour](updates.md).
- La fenêtre ne s’ouvre pas : ses messages sont dans `~/.prism/agent/gui.log` ; `prism --tui` ouvre le terminal. Consultez [La fenêtre de Prism](window.md).
- Un modèle manque dans `/model` : son fournisseur n’a pas d’identifiants utilisables. Relancez `/login`.
- Un problème d’affichage dans le terminal : `/debug` écrit l’écran et les messages de la session dans `~/.prism/agent/prism-debug.log`. Relisez ce fichier avant de le partager.

<a id="report-a-problem"></a>

## Signaler un problème

Ouvrez une issue dans le dépôt de Prism, avec le modèle de signalement de bogue. La page [Code source](https://prism.odelserver.space/fr/source/) du site de Prism mène au dépôt. Indiquez ce que vous avez fait, ce qui s’est passé et ce que vous attendiez, la sortie de `prism --version` et, si cela aide, un rapport de `prism doctor export <fichier>` après l’avoir relu.

Les problèmes de sécurité ne se signalent pas dans les issues : consultez [Signaler un problème de sécurité](security.md#signaler-un-problème-de-sécurité).
