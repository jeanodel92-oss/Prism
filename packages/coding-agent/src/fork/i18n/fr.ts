// fork: the French interface texts, keyed by the English text shown today
//. Plain French for users who are not developers, "vous".
// Kept as they are: commands, key names, file names, setting keys, product and provider names.

/** Exact texts. */
export const FR: Record<string, string> = {
	// fork: possible prompt injection in tool results.
	"Hidden instructions alert": "Alerte sur les instructions cachées",
	"Desktop take-back shortcut": "Raccourci de reprise du bureau",
	"In the address bar of {1}, paste {0} (the buttons below open {1} and copy the address).":
		"Dans la barre d’adresse de {1}, collez {0} (les boutons ci-dessous ouvrent {1} et copient l’adresse).",
	"Open {0}": "Ouvrir {0}",
	"Copy the address": "Copier l’adresse",
	"{0} opened.": "{0} ouvert.",
	"{0} copied: paste it in the address bar of {1}.": "{0} copié : collez-le dans la barre d’adresse de {1}.",
	"Prism did not find {0}'s program: open it yourself.":
		"Prism n’a pas trouvé le programme de {0} : ouvrez-le vous-même.",
	"Start programs on its desktop without asking": "Lancer des programmes sur son bureau sans demander",
	"The agent starts any program on its own desktop without a question. These programs run outside the sandbox, with your rights. Saved as the rule desktop(*) in permissions.json; your deny rules still apply.":
		"L'agent lance n'importe quel programme sur son propre bureau sans poser de question. Ces programmes tournent hors de la sandbox, avec vos droits. Enregistré comme la règle desktop(*) dans permissions.json ; vos règles de refus s'appliquent toujours.",
	'"{0}" needs a letter, a digit or F1 to F12 as its key.':
		"« {0} » doit finir par une lettre, un chiffre ou F1 à F12.",
	'Unknown modifier "{0}" in "{1}".': "Modificateur inconnu « {0} » dans « {1} ».",
	'"{0}" needs a modifier (ctrl, shift, alt or super).':
		"« {0} » doit avoir un modificateur (ctrl, shift, alt ou super).",
	"The keys that take your desktop back from the agent under Hyprland; moving the mouse for about 2 seconds also does. Applies the next time the agent takes your desktop.":
		"Les touches qui reprennent votre bureau à l'agent sous Hyprland ; bouger la souris environ 2 secondes le fait aussi. S'applique la prochaine fois que l'agent prend votre bureau.",
	"{0} A modifier (ctrl, shift, alt or super) and a letter, a digit or F1 to F12, such as ctrl+shift+q. Empty: back to the default.":
		"{0} Un modificateur (ctrl, shift, alt ou super) et une lettre, un chiffre ou F1 à F12, par exemple ctrl+shift+q. Vide : retour au défaut.",
	"Stops the agent when something it reads holds instructions that seem meant for it, and asks whether to continue. A safety net, not the main protection.":
		"Arrête l’agent quand ce qu’il lit contient des instructions qui semblent lui être adressées, et demande s’il faut continuer. Un filet de sécurité, pas la protection principale.",
	"Stops the agent when something it reads (a page, a file, a command's output) holds instructions that seem meant for it, and asks whether to continue. A risk reduction, not a guarantee; the content is never changed.":
		"Arrête l’agent quand ce qu’il lit (une page, un fichier, la sortie d’une commande) contient des instructions qui semblent lui être adressées, et demande s’il faut continuer. Une réduction du risque, sans garantie ; le contenu reste inchangé.",
	WARNING: "AVERTISSEMENT",
	"The content was not changed.": "Le contenu n’a pas été modifié.",
	"Continue, and don't ask again for this source in this session":
		"Continuer sans redemander pour cette source pendant cette session",
	"Agent stopped because a tool result may contain a prompt injection. The content was not changed.":
		"L’agent s’est arrêté : un résultat d’outil peut contenir une injection de prompt. Le contenu n’a pas été modifié.",
	"Hidden Unicode tags": "Texte Unicode masqué",
	"Chat role switch": "Changement de rôle de conversation",
	"Instruction override": "Remplacement des instructions",
	"Reader-directed instruction": "Ordre adressé au lecteur",
	"Agent-directed action": "Action demandée à l’agent",
	"Zero-width run": "Suite de caractères sans largeur",
	"Bidirectional control": "Contrôle du sens d’écriture",
	"Role-like line": "Ligne imitant un rôle",
	"Encoded instruction": "Instruction encodée",
	// the /llama manager.
	"load/unload/download": "charger/décharger/télécharger",
	stop: "arrêter",
	"Could not connect to the server.": "Impossible de se connecter au serveur.",
	"Model catalog refresh timed out.": "Le délai d’actualisation du catalogue de modèles est dépassé.",
	"Unload all and load": "Tout décharger et charger",
	"Keep loaded and load": "Garder les modèles chargés et charger",
	"Restoring previously loaded models": "Restauration des modèles précédemment chargés",
	"Loading model": "Chargement du modèle",
	"Starting…": "Démarrage…",
	"Stop loading?": "Arrêter le chargement ?",
	"Unload model?": "Décharger le modèle ?",
	"Loading model details": "Chargement des détails du modèle",
	"Manual approval is required": "Une autorisation manuelle est nécessaire",
	"Accept the access terms": "Acceptez les conditions d’accès",
	recommended: "recommandé",
	"Downloading model": "Téléchargement du modèle",
	"Stop download?": "Arrêter le téléchargement ?",
	"/llama is available in interactive mode": "/llama est disponible en mode interactif",
	loaded: "chargé",
	"Type at least 2 characters": "Saisissez au moins 2 caractères",
	"Model name or owner/repository[:quant]": "Nom du modèle ou propriétaire/dépôt[:quant]",
	"No GGUF models found": "Aucun modèle GGUF trouvé",
	"Searching Hugging Face…": "Recherche sur Hugging Face…",
	"Download model…": "Télécharger un modèle…",
	"Hugging Face owner/repository[:quant]": "Hugging Face propriétaire/dépôt[:quant]",
	Retry: "Réessayer",
	"Download model": "Télécharger un modèle",
	"Download failed": "Échec du téléchargement",
	"Model failed to load": "Échec du chargement du modèle",
	Cancelled: "Annulé",
	"Server URL must use http or https": "L’URL du serveur doit utiliser http ou https",
	"llama.cpp returned an invalid model catalog": "llama.cpp a renvoyé un catalogue de modèles invalide",
	"Server is not running in llama.cpp router mode": "Le serveur n’utilise pas le mode routeur de llama.cpp",
	"Hugging Face rate limit reached": "La limite de requêtes de Hugging Face est atteinte",
	"Hugging Face returned invalid search results": "Hugging Face a renvoyé des résultats de recherche invalides",
	"Hugging Face returned invalid model details": "Hugging Face a renvoyé des détails de modèle invalides",
	// Chrome DevTools plug-in.
	" cancel": " annuler",
	evaluate: "exécution JavaScript",
	screenshot: "capture d’écran",
	"Running...": "En cours…",
	"Run JavaScript": "Exécuter du JavaScript",
	"not saved": "non enregistré",
	'HTTP origin with an explicit port; enter "default" to restore 127.0.0.1:9222.':
		'Origine HTTP avec un port explicite ; saisissez "default" pour rétablir 127.0.0.1:9222.',
	'Absolute executable path; enter "automatic" to restore browser discovery.':
		'Chemin absolu de l’exécutable ; saisissez "automatic" pour rétablir la détection du navigateur.',
	'Enter an HTTP origin with an explicit port, or "default".':
		'Saisissez une origine HTTP avec un port explicite, ou "default".',
	'Enter an absolute path, or "automatic".': 'Saisissez un chemin absolu, ou "automatic".',
	'Enter an absolute path or "automatic".': 'Saisissez un chemin absolu ou "automatic".',
	partial: "partiel",
	eager: "chargement immédiat",
	inactive: "inactif",
	environment: "environnement",
	endpoint: "adresse de connexion",
	"/trace: keeps a local timeline of the tools run, the permissions asked and their results, when you turn it on.":
		"/trace : garde une chronologie locale des outils lancés, des permissions demandées et de leurs résultats, quand vous l'activez.",
	"/budget: limits on time, tool calls, tokens and cost for a session; 80% gives a warning.":
		"/budget : limites de temps, d'appels d'outils, de tokens et de coût pour une session ; un avertissement à 80 %.",
	"On resume, shows what a session was doing when it stopped and what to do about a tool left unfinished; /state shows the same.":
		"À la reprise, montre ce que faisait une session quand elle s'est arrêtée et que faire d'un outil resté inachevé ; /state montre la même chose.",
	"/schedule: tasks that run by themselves at set times, created only after you read and confirm what they may do.":
		"/schedule : des tâches qui s'exécutent seules à heures fixes, créées seulement après que vous avez lu et confirmé ce qu'elles peuvent faire.",
	"/export-zip: an archive of the sessions and files you pick, to continue with a model in another tool. Known secrets are masked.":
		"/export-zip : une archive des sessions et fichiers choisis, pour continuer avec un modèle dans un autre outil. Les secrets connus sont masqués.",
	"Lets the model show tables, charts, choices and forms from a fixed catalogue, instead of plain text.":
		"Permet au modèle d'afficher des tableaux, graphiques, choix et formulaires d'un catalogue fixe, plutôt que du texte.",
	"Lets the model change Prism's settings with the configure_prism tool, each change only after your answer. Security settings stay yours.":
		"Permet au modèle de changer les réglages de Prism avec l'outil configure_prism, chaque changement seulement après votre réponse. Les réglages de sécurité restent les vôtres.",
	"Follows what the model can do: without tool calls Prism replies without tools, without images an attachment is not sent, and it tells you why.":
		"Suit ce que le modèle sait faire : sans appels d'outils, Prism répond sans outils ; sans images, une pièce jointe n'est pas envoyée, et il vous dit pourquoi.",
	// fork.9 QA.
	"Minutes, such as time 30": "Minutes, par exemple time 30",
	"Tool calls, such as tools 200": "Appels d'outils, par exemple tools 200",
	"Tokens, such as tokens 2000000": "Tokens, par exemple tokens 2000000",
	"Dollars, such as cost 5": "Dollars, par exemple cost 5",
	"Turn all limits off, or one: off time": "Désactive toutes les limites, ou une seule : off time",
	"Show the budgets as a notice": "Affiche les budgets dans une notification",
	"Turn all limits off": "Désactiver toutes les limites",
	"{0}: {1} Empty turns it off.": "{0} : {1} Vide pour la désactiver.",
	"Every day": "Tous les jours",
	"Monday to Friday": "Du lundi au vendredi",
	"Every Monday": "Tous les lundis",
	"Every hour": "Toutes les heures",
	"Other: a systemd calendar expression": "Autre : une expression de calendrier systemd",
	"When should the task run?": "Quand la tâche doit-elle s'exécuter ?",
	"A systemd calendar expression": "Une expression de calendrier systemd",
	"At what time? (HH:MM)": "À quelle heure ? (HH:MM)",
	"From the plan {0}": "À partir du plan {0}",
	"Longest task scope": "Durée maximale d'une portée",
	"How long a task scope may last at most, for you and for what the agent proposes.":
		"Combien de temps une portée peut durer au plus, pour vous comme pour ce que propose l'agent.",
	"Type a whole number of minutes, 5 or more.": "Saisissez un nombre entier de minutes, 5 ou plus.",
	"Safe mode changes no file, whatever a scope allows. Change the mode first.":
		"Le mode sûr ne change aucun fichier, quoi qu'une portée autorise. Changez d'abord de mode.",
	// fork.9 QA: animation presets and the simplified theme editor.
	Original: "D’origine",
	Wipe: "Balayage",
	Dissolve: "Dissolution",
	Dots: "Points",
	Meter: "Jauge",
	Pulse: "Pulsation",
	Spinner: "Rotation",
	Slide: "Glissement",
	Calm: "Calme",
	Lively: "Vif",
	Custom: "Personnalisé",
	"Animation preset": "Préréglage d’animations",
	Surface: "Surface",
	Selection: "Sélection",
	"Muted text": "Texte discret",
	Border: "Bordure",
	Success: "Réussite",
	"Choose a style per category, or apply a preset to all.":
		"Choisir un style par catégorie, ou un préréglage pour toutes.",
	"Enter: next style.": "Entrée : style suivant.",
	"Enter applies the next preset to every category: Default, Calm, Lively, off.":
		"Entrée applique le préréglage suivant à toutes les catégories : par défaut, calme, vif, désactivé.",
	"Styles: {0}.": "Styles : {0}.",
	"Changing a core colour carries to the colours that follow it, keeping the original lightness steps. Advanced edits individual tokens.":
		"Modifier une couleur de base se reporte sur les couleurs qui la suivent, en gardant les écarts de luminosité d’origine. Avancé permet de modifier chaque token.",
	"Edit every palette entry and token individually. Escape returns to core colours.":
		"Modifier chaque entrée de palette et chaque token séparément. Échap revient aux couleurs de base.",
	"Core colours need a concrete colour.": "Les couleurs de base demandent une couleur explicite.",
	"Low contrast: {0}:1 for {1} on {2} (minimum 4.5:1).": "Contraste faible : {0}:1 pour {1} sur {2} (minimum 4,5:1).",
	"Saved with low contrast: {0}:1 for {1} on {2} (minimum 4.5:1).":
		"Enregistré avec un contraste faible : {0}:1 pour {1} sur {2} (minimum 4,5:1).",
	// fork.9 QA: core/auth-guidance.ts, shown without a model; t() translates it sentence by sentence.
	"Use /login to connect a model service or server with an account, an API key (an access key), or a server address. /docs providers explains how.":
		"Utilisez /login pour connecter un service ou un serveur de modèles : avec un compte, une clé d'API (une clé d'accès) ou l'adresse d'un serveur. /docs providers explique comment.",
	"No model selected.": "Aucun modèle choisi.",
	// fork.9 QA: interactive-mode cycleModel (ctrl+p, a click on the model name).
	"Only one model available": "Un seul modèle disponible",
	"Only one model in scope": "Un seul modèle dans la sélection",
	"Then use /model to select a model.": "Choisissez ensuite un modèle avec /model.",
	"the selected model": "le modèle choisi",
	// npm install heuristics.
	"Registry configuration could not be parsed.": "La configuration du registre n'a pas pu être analysée.",
	"Registry configuration is unsupported or invalid.":
		"La configuration du registre est invalide ou non prise en charge.",
	"Package does not exist in the configured registry (HTTP 404).":
		"Le paquet n'existe pas dans le registre configuré (HTTP 404).",
	"Package could not be verified: invalid registry metadata or creation date.":
		"Le paquet n'a pas pu être vérifié : métadonnées ou date de création invalides.",
	"Package was created less than 30 days ago.": "Le paquet a été créé il y a moins de 30 jours.",
	"Package could not be verified: request failed, timed out or returned invalid JSON.":
		"Le paquet n'a pas pu être vérifié : échec de la requête, délai dépassé ou JSON invalide.",
	"Package could not be verified: the registry's metadata is larger than 64 MiB.":
		"Le paquet n'a pas pu être vérifié : les métadonnées du registre dépassent 64 Mio.",
	"Weekly downloads unavailable; the download check was omitted.":
		"Téléchargements hebdomadaires indisponibles ; ce contrôle a été omis.",
	"Weekly downloads are not queried for private registries.":
		"Les téléchargements hebdomadaires ne sont pas demandés pour les registres privés.",
	"Command changes the package configuration; registry could not be determined.":
		"La commande modifie la configuration des paquets ; le registre n'a pas pu être déterminé.",
	"A parent folder's .npmrc may choose the registry; it could not be determined.":
		"Le .npmrc d'un dossier parent peut choisir le registre ; il n'a pas pu être déterminé.",
	"Project or registry configuration could not be read or parsed.":
		"La configuration du projet ou du registre n'a pas pu être lue ou analysée.",
	"These are heuristics, not proof of malice. You can confirm once. The sandbox remains the real boundary for install scripts.":
		"Ces indices ne prouvent pas une intention malveillante. Vous pouvez confirmer une fois. La sandbox reste la véritable frontière pour les scripts d'installation.",
	"Confirm npm install once (this call only)": "Confirmer l'installation npm une fois (cet appel seulement)",
	"Refuse npm install": "Refuser l'installation npm",
	"Review suspicious npm packages before installing?": "Vérifier les paquets npm suspects avant l'installation ?",
	"npm install blocked: suspicious or unverifiable packages were refused or could not be confirmed. Do not retry through another command; ask the user to review this install.":
		"Installation npm bloquée : les paquets suspects ou invérifiables ont été refusés ou n'ont pas pu être confirmés. Ne réessayez pas avec une autre commande ; demandez à l'utilisateur d'examiner cette installation.",
	"use /perm help for commands": "consultez /perm help pour les commandes",
	"Cleared session permission rules": "Règles de permission de la session effacées",
	Allow: "Autoriser",
	Deny: "Refuser",
	"(missing)": "(absent)",
	"Usage:": "Utilisation :",
	"key in models.json": "clé dans models.json",
	"command in models.json": "commande dans models.json",
	"Automatic follows the terminal: its light theme on a light terminal, its dark theme on a dark one.":
		"Le mode automatique suit le terminal : son thème clair sur un terminal clair, son thème sombre sur un terminal sombre.",
	"A fixed theme made for the other background also sets the terminal's background while Prism runs, and restores it on exit.":
		"Un thème fixe conçu pour l’autre fond change aussi le fond du terminal pendant que Prism fonctionne, puis le rétablit à la sortie.",
	"Terminals that cannot change their background keep it: then pick a theme made for it, or automatic.":
		"Les terminaux qui ne peuvent pas changer de fond le conservent : choisissez alors un thème adapté, ou le mode automatique.",
	removed: "retirée",
	saved: "enregistrée",
	"Theme created from your terminal's colors": "Thème créé à partir des couleurs de votre terminal",
	"  automatic": "  automatique",
	"Use separate themes for light and dark terminal appearance":
		"Utiliser des thèmes distincts pour le terminal clair et sombre",
	"Automatic Theme": "Thème automatique",
	"Choose themes for terminal light and dark appearance.": "Choisissez les thèmes pour le terminal clair et sombre.",
	"Light/dark detection requires terminal support.": "La détection clair/sombre demande un terminal compatible.",
	"Light theme": "Thème clair",
	"Dark theme": "Thème sombre",
	"Light Theme": "Thème clair",
	"Dark Theme": "Thème sombre",
	"Theme to use in automatic mode when the terminal is light":
		"Thème à utiliser en mode automatique quand le terminal est clair",
	"Theme to use in automatic mode when the terminal is dark":
		"Thème à utiliser en mode automatique quand le terminal est sombre",
	"Select the theme to use for light terminal appearance": "Choisissez le thème pour le terminal clair",
	"Select the theme to use for dark terminal appearance": "Choisissez le thème pour le terminal sombre",
	Apply: "Appliquer",
	"Save and go back": "Enregistrer et revenir",
	"save and go back": "enregistrer et revenir",
	"Change mode": "Changer de mode",
	"Switch to one theme for light and dark": "Utiliser le même thème pour le clair et le sombre",
	"switch to single theme": "utiliser un seul thème",
	"Per-Model Thinking Level": "Niveau de réflexion par modèle",
	"Select a model to configure": "Choisissez le modèle à configurer",
	"No models available": "Aucun modèle disponible",
	"Log in to a provider or configure an API key first": "Connectez d’abord un fournisseur ou configurez une clé d’API",
	"Select default thinking level for this model": "Choisissez le niveau de réflexion par défaut de ce modèle",
	"  (clear override)": "  (retirer la correction)",
	"  No matching commands": "  Aucune commande correspondante",
	"Notifications are working.": "Les notifications fonctionnent.",
	"notify-send is not installed": "notify-send n’est pas installé",
	"Test notification sent to the desktop (id {0}). No pop-up? Your notification server may be in do-not-disturb mode: the notification is then in its list.":
		"Notification de test envoyée au bureau (id {0}). Pas de fenêtre ? Votre serveur de notifications est peut-être en mode « Ne pas déranger » : la notification est alors dans sa liste.",
	"Desktop notification failed: {0}.": "Échec de la notification de bureau : {0}.",
	"The terminal's own notification was sent instead.": "La notification du terminal a été envoyée à la place.",
	d: "j",
	w: "sem",
	mo: "mois",
	y: "an",
	navigate: "parcourir",
	newline: "nouvelle ligne",
	"external editor": "éditeur externe",
	"(on)": "(activé)",
	"(off)": "(désactivé)",
	"(cleared)": "(retirée)",
	// fork: selectors, built-in notices and startup warnings.
	"Only showing models from configured providers. Use /login to add providers.":
		"Seuls les modèles des fournisseurs configurés sont affichés. Utilisez /login pour ajouter des fournisseurs.",
	"Scope: ": "Liste : ",
	scoped: "sélection",
	" (all/scoped)": " (tous/sélection)",
	" · default": " · par défaut",
	"  No matching models": "  Aucun modèle correspondant",
	"Model catalogs refreshed.": "Catalogues de modèles actualisés.",
	"Model refresh timed out; showing cached models.": "Actualisation trop longue ; modèles en cache affichés.",
	"Thinking Level": "Niveau de réflexion",
	"No reasoning": "Sans réflexion",
	"Very brief reasoning (~1k tokens)": "Réflexion très brève (~1k tokens)",
	"Light reasoning (~2k tokens)": "Réflexion légère (~2k tokens)",
	"Moderate reasoning (~8k tokens)": "Réflexion modérée (~8k tokens)",
	"Deep reasoning (~16k tokens)": "Réflexion approfondie (~16k tokens)",
	"Extra-high reasoning (~32k tokens)": "Réflexion très approfondie (~32k tokens)",
	"Maximum reasoning": "Réflexion maximale",
	"(current)": "(actuel)",
	"Choose a model service to connect to:": "Choisissez un service de modèles auquel vous connecter :",
	"Select provider to logout:": "Choisissez le fournisseur à déconnecter :",
	"API key": "Clé d’API",
	account: "compte",
	subscription: "abonnement",
	" • not configured": " • non configuré",
	" ✓ configured": " ✓ configuré",
	"No providers available": "Aucun fournisseur disponible",
	"No providers logged in. Use /login first.": "Aucun fournisseur connecté. Utilisez d’abord /login.",
	"No matching providers": "Aucun fournisseur correspondant",
	"Cmd+click to open": "Cmd+clic pour ouvrir",
	"Ctrl+click to open": "Ctrl+clic pour ouvrir",
	"Resume Session (Current Folder)": "Reprendre une session (dossier actuel)",
	"Resume Session (All)": "Reprendre une session (toutes)",
	"Sort: ": "Tri : ",
	"Name: ": "Nom : ",
	Threaded: "Par branche",
	Recent: "Récent",
	Fuzzy: "Pertinence",
	All: "Tous",
	Named: "Nommées",
	"○ Current Folder | ": "○ Dossier actuel | ",
	"◉ Current Folder": "◉ Dossier actuel",
	" | ○ All": " | ○ Tous",
	"◉ All": "◉ Tous",
	"Delete session?": "Supprimer cette session ?",
	're:<pattern> regex · "phrase" exact': 're:<motif> expression régulière · "phrase" exacte',
	"Rename Session": "Renommer la session",
	now: "maintenant",
	"Cannot delete the currently active session": "Impossible de supprimer la session active",
	"Session moved to trash": "Session mise à la corbeille",
	"Session deleted": "Session supprimée",
	"  No sessions found": "  Aucune session trouvée",
	"  No sessions in current folder. Press Tab to view all.":
		"  Aucune session dans ce dossier. Tab affiche toutes les sessions.",
	" [no-tools]": " [sans outils]",
	" [user]": " [utilisateur]",
	" [labeled]": " [étiquetés]",
	" [all]": " [tous]",
	" [+label time]": " [+heure d’étiquette]",
	"  No entries found": "  Aucun élément trouvé",
	"Type to search:": "Tapez pour rechercher :",
	"Label (empty to remove):": "Étiquette (vide pour retirer) :",
	"  Session Tree": "  Arbre de session",
	"user: ": "vous : ",
	"assistant: ": "assistant : ",
	"(aborted)": "(interrompu)",
	"(no content)": "(sans contenu)",
	"[branch summary]: ": "[résumé de branche] : ",
	"[title: ": "[titre : ",
	empty: "vide",
	move: "déplacer",
	page: "page",
	branch: "branche",
	copy: "copier",
	label: "étiquette",
	"label time": "heure d’étiquette",
	filters: "filtres",
	cycle: "parcourir",
	scope: "liste",
	sort: "tri",
	named: "nommées",
	delete: "supprimer",
	rename: "renommer",
	save: "enregistrer",
	submit: "valider",
	confirm: "confirmer",
	cancel: "annuler",
	"to cancel": "pour annuler",
	"to cancel,": "pour annuler,",
	"to submit": "pour valider",
	"to close": "pour fermer",
	Enter: "Entrée",
	enter: "Entrée",
	Esc: "Échap",
	esc: "Échap",
	Escape: "Échap",
	escape: "Échap",
	// fork: arrow keys in /help.
	Up: "Haut",
	up: "haut",
	Down: "Bas",
	down: "bas",
	"No checkpoints to undo.": "Aucun point de restauration à annuler.",
	"No checkpoints in this session.": "Aucun point de restauration dans cette session.",
	"Rewind to before which turn?": "Revenir avant quel tour ?",
	"Not restored (no checkpoint):": "Non restaurés (sans copie) :",
	"Changes made by bash commands are not tracked.": "Les changements faits par les commandes bash ne sont pas suivis.",
	"The file browser needs the interactive terminal.": "L’explorateur de fichiers demande le terminal interactif.",
	"Project is not trusted — project language server settings are disabled.":
		"Le projet n’est pas approuvé — ses réglages de serveurs de langage sont désactivés.",
	"You have your own pi-lsp.json: pi-lsp uses only the servers listed there.":
		"Vous avez votre propre pi-lsp.json : pi-lsp utilise seulement les serveurs qui y figurent.",
	"Language servers for this project": "Serveurs de langage pour ce projet",
	"not in your pi-lsp.json": "absent de votre pi-lsp.json",
	ready: "prêt",
	"to install": "à installer",
	"turned off": "désactivé",
	"Turn on": "Activer",
	"Turn off": "Désactiver",
	"Turned off: lsp_diagnostics and lsp_fix do not start it.":
		"Désactivé : lsp_diagnostics et lsp_fix ne le lancent pas.",
	"Installed: the model checks its code with it through lsp_diagnostics and lsp_fix.":
		"Installé : le modèle vérifie son code avec lui, par lsp_diagnostics et lsp_fix.",
	"Not installed: pi-lsp cannot start it.": "Non installé : pi-lsp ne peut pas le lancer.",
	"The install command is in the input box: nothing runs until you press Enter.":
		"La commande d’installation est dans la saisie : rien ne s’exécute avant que vous appuyiez sur Entrée.",
	"Every language server…": "Tous les serveurs de langage…",
	"No source code in this project: every language server":
		"Pas de code source dans ce projet : tous les serveurs de langage",
	"pi-lsp starts the ready ones. Choose one to install it or turn it off.":
		"pi-lsp lance ceux qui sont prêts. Choisissez-en un pour l’installer ou le désactiver.",
	"No language server is ready.": "Aucun serveur de langage n’est prêt.",
	"/lsp all lists each server's command.": "/lsp all liste la commande de chaque serveur.",
	" or ": " ou ",
	"Project is not trusted — project memory is disabled.": "Le projet n’est pas approuvé — sa mémoire est désactivée.",
	"Global memory saved.": "Mémoire globale enregistrée.",
	global: "globale",
	"The sandbox works.": "La sandbox fonctionne.",
	"Permission rules": "Règles de permission",
	"settings.json has an unsupported webSearchProvider: choose one in /settings > Web search, or name it: /web-key exa":
		"La valeur de webSearchProvider dans settings.json n’est pas prise en charge : choisissez-en une dans /settings > Recherche web, ou indiquez-la : /web-key exa",
	"SearXNG instance base URL": "URL de base de l’instance SearXNG",
	"Could not save SearXNG URL in settings.json. Check the file and try again.":
		"Impossible d’enregistrer l’URL SearXNG dans settings.json. Vérifiez le fichier et réessayez.",
	"No key saved.": "Aucune clé enregistrée.",
	"SearXNG URL removed.": "URL SearXNG retirée.",
	"SearXNG URL saved.": "URL SearXNG enregistrée.",
	"notifications on": "notifications activées",
	"notifications off": "notifications désactivées",
	" (file search)": " (recherche de fichiers)",
	" (text search)": " (recherche de texte)",
	"tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.":
		"L’option extended-keys de tmux est désactivée. Les combinaisons avec Entrée peuvent ne pas fonctionner. Ajoutez `set -g extended-keys on` dans ~/.tmux.conf et redémarrez tmux.",
	// fork: the dedicated configuration tool and its always-on guard.
	"Configure Prism": "Configurer Prism",
	"Works in the project without asking. Still asks for what leaves the project, sudo and the first use of a browser or a desktop.":
		"Travaille dans le projet sans demander. Demande encore pour ce qui sort du projet, sudo et la première utilisation d'un navigateur ou d'un bureau.",
	"Skips ordinary questions. Configuration uses configure_prism; security settings are user-only. Keep it for a throwaway machine or container.":
		"Saute les questions ordinaires. La configuration passe par configure_prism ; la sécurité reste réservée à l'utilisateur. À réserver à une machine ou un conteneur jetable.",
	"works in the project without asking; asks for what leaves the project, sudo and the first use of a browser or a desktop; configuration uses configure_prism (default)":
		"travaille dans le projet sans demander ; demande pour ce qui sort du projet, sudo et la première utilisation d'un navigateur ou d'un bureau ; la configuration passe par configure_prism (par défaut)",
	"skips ordinary questions; configuration uses configure_prism; security settings are user-only":
		"saute les questions ordinaires ; la configuration passe par configure_prism ; la sécurité reste réservée à l'utilisateur",
	"reads freely; asks before changing a file, running a command or going online":
		"lit librement ; demande avant de modifier un fichier, de lancer une commande ou d’aller en ligne",
	"reads and runs only safe commands; blocks other changes; asks before going online":
		"lit et lance seulement les commandes sûres ; bloque les autres changements ; demande avant d’aller en ligne",
	"Only the user can change Prism's security settings.":
		"Seul l'utilisateur peut modifier les réglages de sécurité de Prism.",
	"Use configure_prism to change Prism's configuration. Enable the config-tool module in /settings if needed.":
		"Utilisez configure_prism pour modifier la configuration de Prism. Activez le module config-tool dans /settings si nécessaire.",
	"Configuration changes are refused in safe mode.": "Les changements de configuration sont refusés en mode safe.",
	"Configuration changes are refused in read-only mode.":
		"Les changements de configuration sont refusés en lecture seule.",
	"Configuration changes need the user at the terminal or the Prism window. Print, scheduled runs and RPC clients without dialogs are refused.":
		"Les changements de configuration demandent l'utilisateur au terminal ou dans la fenêtre Prism. Le mode texte, les tâches planifiées et les clients RPC sans dialogues sont refusés.",
	"Invalid configuration change.": "Changement de configuration invalide.",
	"Unsupported setting or invalid value. See docs/permissions.md.":
		"Réglage non pris en charge ou valeur invalide. Consultez docs/fr/permissions.md.",
	"Unknown optional module.": "Module facultatif inconnu.",
	// fork (audit DOC-25): the last texts of the terminal without a French entry.
	'"mode" must be one of {0}': "« mode » doit valoir l'une de ces valeurs : {0}",
	"it cannot be read ({0})": "il ne peut pas être lu ({0})",
	"it is not valid JSON ({0})": "ce n'est pas du JSON valide ({0})",
	"{0}. Until it is fixed, every tool call is refused, so that the rules refused for projects cannot be lost. Fix the file, or remove it to drop the rules given for projects.":
		"{0}. Tant qu'il n'est pas corrigé, tout appel d'outil est refusé, pour que les règles refusées aux projets ne se perdent pas. Corrigez le fichier, ou supprimez-le pour abandonner les règles données aux projets.",
	"/settings opens in the terminal or the Prism window.":
		"/settings s'ouvre dans le terminal ou dans la fenêtre de Prism.",
	cache: "cache",
	"Run {0} --help to see the options.": "Lancez {0} --help pour voir les options.",
	"Error: The current working directory no longer exists. Change to an existing directory and try again.":
		"Erreur : le dossier de travail n'existe plus. Placez-vous dans un dossier existant et réessayez.",
	"Configuration links are refused. Change the file directly as the user.":
		"Les liens de configuration sont refusés. Modifiez le fichier vous-même.",
	"Invalid configuration file.": "Fichier de configuration invalide.",
	"Change Prism configuration?": "Modifier la configuration de Prism ?",
	"(unset)": "(non défini)",
	"Risk: this can run code through extensions, hooks, shell commands or agent tools. Review it before allowing.":
		"Risque : cela peut exécuter du code via des extensions, des hooks, des commandes shell ou les outils d'un agent. Vérifiez avant d'autoriser.",
	"Settings and modules apply after /reload or restart. Agents apply on their next use.":
		"Les réglages et modules s'appliquent après /reload ou redémarrage. Les agents s'appliquent à leur prochaine utilisation.",
	"Allow this change once": "Autoriser ce changement une fois",
	"Refuse this change": "Refuser ce changement",
	"Configuration change refused or unanswered. Nothing changed. Do not retry through another tool.":
		"Changement refusé ou sans réponse. Rien n'a changé. Ne réessayez pas avec un autre outil.",
	"Configuration changed while waiting. Nothing saved.":
		"La configuration a changé pendant l'attente. Rien n'a été enregistré.",
	"Configuration saved. Settings and modules apply after /reload or restart; agents apply on their next use.":
		"Configuration enregistrée. Les réglages et modules s'appliquent après /reload ou redémarrage ; les agents à leur prochaine utilisation.",
	"Create and manage custom agents": "Créer et gérer des agents personnalisés",
	Agents: "Agents",
	Skills: "Skills",
	"Install, turn on or off, update and remove skills":
		"Installer, activer ou désactiver, mettre à jour et retirer des skills",
	"Install, turn on or off, update and remove skills (also /skills).":
		"Installer, activer ou désactiver, mettre à jour et retirer des skills (aussi /skills).",
	"/skills: install, turn on or off, update and remove skills. Off, the skills already set up still load.":
		"/skills : installer, activer ou désactiver, mettre à jour et retirer des skills. Désactivé, les skills déjà en place se chargent toujours.",
	"A skill is a set of instructions for one kind of task. The model sees the name and description of each skill that is on, and reads the rest only when a task calls for it.":
		"Un skill est un ensemble d’instructions pour un type de tâche. Le modèle voit le nom et la description de chaque skill activé, et ne lit le reste que quand une tâche le demande.",
	"No skill yet: install one, or add a folder with a SKILL.md file to {0}.":
		"Aucun skill pour l’instant : installez-en un, ou ajoutez un dossier contenant un fichier SKILL.md dans {0}.",
	"{0}, package {1}": "{0}, paquet {1}",
	"{0}, folder": "{0}, dossier",
	"all projects": "tous les projets",
	"Install a skill…": "Installer un skill…",
	"Update skill packages": "Mettre à jour les paquets de skills",
	"Install for": "Installer pour",
	"All projects (global)": "Tous les projets (global)",
	"This project only": "Ce projet seulement",
	"Source of the skill package": "Source du paquet de skills",
	"npm:name, git:github.com/user/repo, a URL or a local folder":
		"npm:nom, git:github.com/utilisateur/depot, une URL ou un dossier local",
	"Installing {0}…": "Installation de {0}…",
	"Installed {0}.": "{0} installé.",
	"This package brings no skill": "Ce paquet n’apporte aucune skill",
	"{0} is installed, but Prism found no skill in it: skills go in its skills folder, or where the pi key of its package.json says. Remove it?":
		"{0} est installé, mais Prism n’y a trouvé aucune skill : elles se trouvent dans son dossier skills, ou là où l’indique la clé pi de son package.json. Le retirer ?",
	"Removed {0}.": "{0} retiré.",
	"Installed {0}, without skills.": "{0} installé, sans skill.",
	"Skill packages are up to date.": "Les paquets de skills sont à jour.",
	"Some skill packages were not updated.": "Certains paquets de skills n'ont pas été mis à jour.",
	"Turn it off": "Le désactiver",
	"Turn it on": "L’activer",
	"Remove its package": "Retirer son paquet",
	"Remove this package?": "Retirer ce paquet ?",
	"Install this skill package?": "Installer ce paquet de skills ?",
	"Update these skill packages?": "Mettre à jour ces paquets de skills ?",
	"Source: {0}": "Source : {0}",
	"For: {0}": "Pour : {0}",
	"Nothing was installed.": "Rien n'a été installé.",
	"Nothing was updated.": "Rien n'a été mis à jour.",
	"A package can run extension code on your machine, and bring skills that ask the model to run programs. Install or update only a source you have reviewed and trust.":
		"Un paquet peut exécuter du code d'extension sur votre machine et apporter des skills qui demandent au modèle de lancer des programmes. N'installez ou ne mettez à jour qu'une source que vous avez examinée et en laquelle vous avez confiance.",
	"This removes {0} and every skill it brings.": "Cela retire {0} et tous les skills qu’il apporte.",
	"New agent": "Nouvel agent",
	Close: "Fermer",
	Delete: "Supprimer",
	Back: "Retour",
	"← Back": "← Retour",
	"Delete agent?": "Supprimer cet agent ?",
	"This removes {0}.": "Cela supprimera {0}.",
	"Agent created: {0}": "Agent créé : {0}",
	"Agent created: {0}. Ask the model to use it, e.g. « use the {0} agent to … ».":
		"Agent créé : {0}. Demandez au modèle de l’utiliser, par exemple « utilise l’agent {0} pour … ».",
	"An agent is your own helper: its instructions, model and tools. When a task fits its purpose, the model runs it, or ask for it by name.":
		"Un agent est votre propre assistant : ses instructions, son modèle et ses outils. Le modèle le lance quand une tâche correspond à son rôle, ou demandez-le par son nom.",
	"When the model may run an agent…": "Quand le modèle peut lancer un agent…",
	"When the model may run an agent": "Quand le modèle peut lancer un agent",
	"Turn agents off": "Désactiver les agents",
	// the advanced agent mode.
	"Wait for agents": "Attendre les agents",
	answered: "a répondu",
	Tool: "Outil",
	"{0} agents are already running, the most you allow at once.":
		"{0} agents tournent déjà, le maximum que vous autorisez en même temps.",
	"No finished agent run {0} in this session.": "Aucun agent terminé {0} dans cette session.",
	"with this transcript": "avec ce transcript",
	"{0} ({1}) kept no context to continue.": "{0} ({1}) n'a pas gardé de contexte à reprendre.",
	"{0} ({1}) is already running again: wait for its answer.":
		"{0} ({1}) tourne déjà de nouveau : attendez sa réponse.",
	"{0} is no longer offered: it was removed or turned off.":
		"{0} n'est plus proposé : il a été supprimé ou désactivé.",
	"Write the agent's task.": "Écrivez la tâche de l'agent.",
	"Write your message to the agent.": "Écrivez votre message à l'agent.",
	"Agent runs of this session": "Agents lancés dans cette session",
	"Agent runs of this session ({0})…": "Agents lancés dans cette session ({0})…",
	"Run an agent…": "Lancer un agent…",
	"Run which agent?": "Quel agent lancer ?",
	"Task for the agent that takes this conversation": "Tâche pour l'agent qui reprend cette conversation",
	"Run an agent on a copy of this conversation": "Lancer un agent sur une copie de cette conversation",
	"Run an agent on a copy of this conversation…": "Lancer un agent sur une copie de cette conversation…",
	"Turn the advanced agent mode on first (/agents).": "Activez d'abord le mode avancé des agents (/agents).",
	"Wait for the end of the current turn: the agent starts from the conversation as it is.":
		"Attendez la fin du tour en cours : l'agent part de la conversation telle qu'elle est.",
	"This conversation is not saved yet: send a first message, or open a saved session.":
		"Cette conversation n'est pas encore enregistrée : envoyez un premier message, ou ouvrez une session enregistrée.",
	"A copy of this session, with its conversation so far, for one task.":
		"Une copie de cette session, avec sa conversation jusqu'ici, pour une tâche.",
	"Task for {0}": "Tâche pour {0}",
	"{0} started ({1}): its answer will follow.": "{0} est lancé ({1}) : sa réponse suivra.",
	"Stop it": "L'arrêter",
	"Send it a message…": "Lui envoyer un message…",
	"Message to {0}": "Message pour {0}",
	"{0} continues ({1}): its answer will follow.": "{0} reprend ({1}) : sa réponse suivra.",
	"… {0} earlier lines": "… {0} lignes plus haut",
	"Nothing written yet.": "Rien d'écrit pour l'instant.",
	"This run kept no transcript.": "Ce lancement n'a pas gardé de transcript.",
	"Preconfigured agents ({0} on)…": "Agents préconfigurés (actifs : {0})…",
	"Preconfigured agents": "Agents préconfigurés",
	"Enter turns each one on or off. They run on the session's model unless a call chooses another.":
		"Entrée active ou désactive chacun. Ils tournent sur le modèle de la session, sauf si un appel en choisit un autre.",
	"A general-purpose agent for any task: research, reading code, edits and commands.":
		"Un agent généraliste pour toute tâche : recherche, lecture de code, modifications et commandes.",
	"Explores the project to answer a question: finds files, reads code, explains how it works. Read only.":
		"Explore le projet pour répondre à une question : trouve les fichiers, lit le code, explique son fonctionnement. Lecture seule.",
	"Designs a plan for a change: the steps, the files to touch, the risks. Read only.":
		"Conçoit le plan d'un changement : les étapes, les fichiers à toucher, les risques. Lecture seule.",
	"Reviews a change (a diff, files or a commit) and reports its defects and risks. Read only.":
		"Relit un changement (un diff, des fichiers ou un commit) et signale ses défauts et ses risques. Lecture seule.",
	"Carries out a well-defined change: edits files and runs commands, within the session's permissions.":
		"Réalise un changement bien défini : modifie des fichiers et lance des commandes, dans les permissions de la session.",
	"Advanced mode: on (turn it off)": "Mode avancé : activé (le désactiver)",
	"Advanced mode on: the general agent and the preconfigured agents you turned on are added to yours. When the model may run an agent applies to them too.":
		"Mode avancé activé : l'agent généraliste et les agents préconfigurés activés s'ajoutent aux vôtres. « Quand le modèle peut lancer un agent » s'applique aussi à eux.",
	"built-in": "intégré",
	Effort: "Effort",
	"The model's default": "Par défaut du modèle",
	"Advanced mode: off (turn it on)…": "Mode avancé : désactivé (l'activer)…",
	"Agents at once: {0}": "Agents en même temps : {0}",
	"Turn the advanced agent mode on?": "Activer le mode avancé des agents ?",
	"Adds a general agent you do not need to create, a model chosen for each call from your selected list, agent_wait, and a limit on agents at once. Your own agents stay as they are.":
		"Ajoute un agent généraliste à ne pas créer, un modèle choisi à chaque appel dans votre liste de modèles sélectionnés, agent_wait, et une limite d'agents en même temps. Vos propres agents restent tels quels.",
	"The model can start agents without you creating them, on another model of your selected list (Ctrl+P), and give them a summary of this conversation or files you name. What an agent receives goes to the provider of its model: with a cloud model, parts of this conversation leave your machine even when this session uses a local model. Several agents can run at once, each a full Prism process.":
		"Le modèle peut lancer des agents sans que vous les créiez, sur un autre modèle de votre liste de modèles sélectionnés (Ctrl+P), et leur donner un résumé de cette conversation ou des fichiers que vous nommez. Ce qu'un agent reçoit part chez le fournisseur de son modèle : avec un modèle cloud, des parties de cette conversation quittent votre machine même quand cette session utilise un modèle local. Plusieurs agents peuvent tourner en même temps, chacun étant un processus Prism complet.",
	"Agents at once (1 to {0})": "Agents en même temps (de 1 à {0})",
	"Type a whole number from 1 to {0}.": "Tapez un nombre entier de 1 à {0}.",
	"Turn agents off?": "Désactiver les agents ?",
	"The agent tool and /agents stop until you turn them back on in /settings › Modules. Your agents are kept.":
		"L’outil agent et /agents s’arrêtent jusqu’à leur réactivation dans /settings › Modules. Vos agents sont conservés.",
	"On its own, when a task fits (default)": "De lui-même, quand une tâche s’y prête (par défaut)",
	"When you ask for an agent in your message": "Quand votre message demande un agent",
	"When your message contains {0}": "Quand votre message contient {0}",
	"Change the keyword ({0})": "Changer le mot-clé ({0})",
	Keyword: "Mot-clé",
	"A keyword is one word of up to 32 characters, without spaces.":
		"Un mot-clé est un seul mot de 32 caractères au plus, sans espace.",
	"Prism checks the keyword. A request in your own words is a rule the model follows, not a check.":
		"Prism vérifie le mot-clé. Une demande formulée librement est une règle que le modèle suit, pas une vérification.",
	"Either way, what an agent does still goes through your permissions.":
		"Dans tous les cas, ce que fait un agent reste soumis à vos permissions.",
	"Runs agents: on its own, when a task fits.": "Lancement des agents : de lui-même, quand une tâche s’y prête.",
	"Runs agents: when you ask for one or write {0}.":
		"Lancement des agents : quand vous en demandez un ou écrivez {0}.",
	"Runs agents: only when you write {0}.": "Lancement des agents : seulement quand vous écrivez {0}.",
	"Runs agents: when you ask for one.": "Lancement des agents : quand vous en demandez un.",
	Name: "Nom",
	"e.g. file-reader": "ex. lecteur-fichiers",
	"What is this agent for?": "À quoi sert cet agent ?",
	"One short sentence": "Une phrase courte",
	"Same as the current session": "Comme la session actuelle",
	"Choose tools": "Choisir les outils",
	"Measure module cost": "Mesurer le coût des modules",
	"All modules": "Tous les modules",
	"Measure every built-in module": "Mesurer chaque module intégré",
	"Measure prompt, startup, memory and child processes on demand.":
		"Mesurer à la demande le prompt, le démarrage, la mémoire et les processus enfants.",
	"Currently on": "Actuellement activé",
	"Currently off": "Actuellement désactivé",
	"Module cost results": "Résultats du coût des modules",
	"Baseline prompt": "Prompt de référence",
	"Baseline startup": "Démarrage de référence",
	"Baseline memory": "Mémoire de référence",
	"Baseline processes": "Processus de référence",
	"ms, measured": "ms, mesurés",
	"MiB, measured": "Mio, mesurés",
	"tokens, estimate": "tokens, estimation",
	"Prompt per turn": "Prompt par tour",
	"Cache on toggle": "Cache lors du basculement",
	"tokens once, estimate": "tokens une fois, estimation",
	"no change": "aucun changement",
	measured: "mesuré",
	Startup: "Démarrage",
	Processes: "Processus",
	Method: "Méthode",
	"Esc cancels and stops the probe process.": "Échap annule et arrête le processus de mesure.",
	"No result.": "Aucun résultat.",
	"Esc close": "Échap fermer",
	"↑↓ scroll · Esc close": "↑↓ défiler · Échap fermer",
	"Each module is compared on and off in the same isolated print-mode child; 3 sequential runs per state are interleaved and medians are reported.":
		"Chaque module est comparé activé puis désactivé dans un processus isolé en mode texte ; 3 mesures successives par état sont alternées et les médianes sont affichées.",
	"The child uses PI_OFFLINE=1 and a local probe provider; no external request is made. Only global extensions are copied to temporary settings.json; auth, sessions and other user files are not read.":
		"Le processus utilise PI_OFFLINE=1 et un fournisseur local de mesure ; aucun appel externe n’est fait. Seules les extensions globales sont copiées dans un settings.json temporaire ; les identifiants, sessions et autres fichiers personnels ne sont pas lus.",
	"Prompt and cache token counts use estimateTextTokens. Startup is process uptime at first request; RSS and child count are read at that point.":
		"Les nombres de tokens du prompt et du cache viennent d’estimateTextTokens. Le démarrage correspond au temps écoulé du processus à la première requête ; la mémoire RSS et le nombre de processus enfants sont lus au même moment.",
	"Prompt changes diff the base text, named sections and tool definitions across system messages; unchanged shared items are not attributed. Cache on toggle estimates the changed prompt written once. The child starts from an empty profile: what a module adds only from your files (memories, context files) is not counted.":
		"Les changements de prompt comparent le texte de base, les sections nommées et les définitions d’outils de tous les messages système ; les éléments partagés inchangés ne sont attribués à aucun module. Le cache estime le prompt modifié écrit une fois au basculement. Le processus part d’un profil vide : ce qu’un module n’ajoute qu’à partir de vos fichiers (mémoires, fichiers de contexte) n’est pas compté.",
	"A delta below either side's run spread is shown as below noise. Child process count uses /proc and is unknown if /proc is unavailable; cancellation sends SIGTERM to the probe process group.":
		"Un écart inférieur à la dispersion des mesures d’un des deux états est indiqué comme inférieur au bruit. Le nombre de processus enfants vient de /proc et est inconnu si /proc n’est pas disponible ; l’annulation envoie SIGTERM au groupe du processus de mesure.",
	"A delta below either side's run spread is shown as below noise. Child process count is unknown off Linux; cancelled children receive SIGTERM.":
		"Un écart inférieur à la dispersion des mesures d’un des deux états est indiqué comme inférieur au bruit. Le nombre de processus enfants est inconnu hors Linux ; les processus annulés reçoivent SIGTERM.",
	Done: "Terminé",
	Instructions: "Consignes",
	"Use lowercase letters, numbers, and dashes.": "Utilisez des minuscules, des chiffres et des tirets.",
	"An agent with this name already exists.": "Un agent porte déjà ce nom.",
	"Purpose cannot be empty.": "La raison d’être ne peut pas être vide.",
	"Choose at least one available tool.": "Choisissez au moins un outil disponible.",
	"Run a custom agent on a task.": "Confier une tâche à un agent personnalisé.",
	"Run a custom agent on a task": "Confier une tâche à un agent personnalisé",
	"Agent name": "Nom de l’agent",
	"Task for the agent": "Tâche à confier à l’agent",
	Agent: "Agent",
	working: "en cours",
	"waiting for its background tasks": "attend ses tâches de fond",
	"{0} is working": "{0} travaille",
	"{0} is using {1}": "{0} utilise {1}",
	"{0} finished": "{0} a terminé",
	"{0}: {1}": "{0} : {1}",
	"Agent permission": "Autorisation de l’agent",
	"The agent returned no text.": "L’agent n’a renvoyé aucun texte.",
	"Agent stopped.": "Agent arrêté.",
	"Agent exited with code {0}": "L’agent s’est arrêté avec le code {0}",
	"Unknown agent: {0}": "Agent inconnu : {0}",
	"Choose a model before running an agent.": "Choisissez un modèle avant de lancer un agent.",
	"Answer truncated.": "Réponse tronquée.",
	"Show background tasks": "Afficher les tâches en arrière-plan",
	"Background tasks": "Tâches en arrière-plan",
	"No background tasks.": "Aucune tâche en arrière-plan.",
	"bg: {0} running": "bg : {0} en cours",
	cwd: "dossier",
	"↑↓ select · Enter view · Esc close": "↑↓ choisir · Entrée voir · Échap fermer",
	"↑↓ scroll · Enter stop · Esc back": "↑↓ défiler · Entrée arrêter · Échap retour",
	"↑↓ scroll · Esc back": "↑↓ défiler · Échap retour",
	"The background tasks panel is available in the interactive terminal.":
		"Le panneau des tâches est disponible dans le terminal interactif.",
	"Stop this task? Enter: stop · Esc: keep it running":
		"Arrêter cette tâche ? Entrée : arrêter · Échap : la laisser tourner",
	running: "en cours",
	"finished (code {0})": "terminée (code {0})",
	"Background task {0}: {1}": "Tâche de fond {0} : {1}",
	"Log: {0}": "Log : {0}",
	// Notices (interactive-mode.ts)
	"Error: ": "Erreur : ",
	"Warning: ": "Avertissement : ",
	"Local diagnostic report": "Rapport de diagnostic local",
	Action: "Action",
	"Observed:": "Observation :",
	"Cause:": "Cause :",
	"Action:": "Action :",
	"Technical detail:": "Détail technique :",
	"Global settings": "Réglages globaux",
	"Project settings": "Réglages du projet",
	"models.json": "models.json",
	"Stored capabilities": "Capacités enregistrées",
	"Current model": "Modèle actuel",
	"Model server": "Serveur du modèle",
	"Global permissions": "Permissions globales",
	"Project permissions": "Permissions du projet",
	"Agent directory": "Dossier de l'agent",
	"Session directory": "Dossier de session",
	Crashes: "Plantages",
	"The check itself failed.": "La vérification elle-même a échoué.",
	"Possible cause:": "Cause possible :",
	"Possibly:": "Peut-être :",
	"No usable model: the selected model has no key or sign-in.":
		"Aucun modèle utilisable : le modèle choisi n'a ni clé ni connexion.",
	"Confirmed: no credentials were found for the selected model's provider.":
		"Confirmé : aucun identifiant n'a été trouvé pour le fournisseur du modèle choisi.",
	"Confirmed: reading this item threw an error.": "Cause confirmée : la lecture de cet élément a levé une erreur.",
	"Inspect the technical detail.": "Consultez le détail technique.",
	"No crash recorded in the last 7 days.": "Aucun plantage enregistré ces 7 derniers jours.",
	"Confirmed: the crash log holds no recent record.":
		"Cause confirmée : le journal des plantages n'a aucune entrée récente.",
	"Confirmed: Prism recorded these crashes in its crash log.":
		"Cause confirmée : Prism a noté ces plantages dans son journal des plantages.",
	"If Prism no longer starts, start it with --safe; attach the exported report when you report the crash.":
		"Si Prism ne démarre plus, lancez-le avec --safe ; joignez le rapport exporté quand vous signalez le plantage.",
	"Extensions are not loaded by this report.": "Ce rapport ne charge pas les extensions.",
	"Confirmed: this report runs before extensions load.":
		"Cause confirmée : ce rapport s'exécute avant le chargement des extensions.",
	"When an extension fails to load, Prism names it at startup; start with --safe to run without extensions.":
		"Quand une extension ne se charge pas, Prism la nomme au démarrage ; lancez-le avec --safe pour démarrer sans extensions.",
	"everything checked is fine": "tout ce qui a été vérifié est correct",
	"check the local setup without starting the interface": "vérifie l'installation locale sans démarrer l'interface",
	"Report on settings, models, permissions, crashes and folders":
		"Rapport sur les réglages, modèles, permissions, plantages et dossiers",
	"Add the technical detail of each check": "Ajoute le détail technique de chaque vérification",
	"Save the report as JSON (recognized sensitive information and home folder masked, mode 0600)":
		"Enregistre le rapport en JSON (informations sensibles reconnues et dossier personnel masqués, mode 0600)",
	"The exit code is 1 when a problem is found.": "Le code de sortie vaut 1 quand un problème est trouvé.",
	"Give the file to write: doctor export <file>": "Indiquez le fichier à écrire : doctor export <fichier>",
	file: "fichier",
	"Check the local setup without starting the interface": "Vérifier l'installation locale sans démarrer l'interface",
	ok: "correct",
	problem: "problème",
	"not tested": "non testé",
	present: "présents",
	absent: "absents",
	"File is missing.": "Le fichier est absent.",
	"File is not present; defaults apply.": "Le fichier est absent ; les valeurs par défaut s'appliquent.",
	"Confirmed: required file is missing.": "Cause confirmée : le fichier requis est absent.",
	"Confirmed: the file is optional and absent.": "Cause confirmée : le fichier facultatif est absent.",
	"Create the file or remove the reference to it.": "Créez le fichier ou retirez sa référence.",
	"No action required.": "Aucune action nécessaire.",
	"File parses as JSON.": "Le fichier est un JSON valide.",
	"Confirmed: JSON parsing succeeded.": "Cause confirmée : le JSON a été lu sans erreur.",
	"Fix the JSON syntax, then run /doctor again.": "Corrigez la syntaxe JSON, puis relancez /doctor.",
	"File could not be parsed.": "Le fichier n'a pas pu être lu.",
	"Confirmed: JSON parsing failed.": "Cause confirmée : la lecture du JSON a échoué.",
	"Directory exists and is writable.": "Le dossier existe et est accessible en écriture.",
	"Confirmed: filesystem access succeeded.": "Cause confirmée : l'accès au système de fichiers a réussi.",
	"Directory is missing or not writable.": "Le dossier est absent ou non accessible en écriture.",
	"Confirmed: filesystem access failed.": "Cause confirmée : l'accès au système de fichiers a échoué.",
	"Create the directory or grant write access.": "Créez le dossier ou accordez le droit d'écriture.",
	"models.json could not be loaded or validated.": "models.json n'a pas pu être chargé ou validé.",
	"load error": "erreur de chargement",
	"parse error": "erreur d'analyse",
	"provider schema error": "erreur de schéma fournisseur",
	"No configured base URL": "Aucune URL de base configurée",
	"Reachability was not tested because /doctor makes no network call.":
		"L'accessibilité n'a pas été testée : /doctor ne fait aucun appel réseau.",
	"Unknown model request error": "Erreur inconnue de requête au modèle",
	"Confirmed: the existing provider validator reported an error.":
		"Cause confirmée : le validateur des fournisseurs a signalé une erreur.",
	"Fix the provider configuration required by pi, then run /doctor again.":
		"Corrigez la configuration requise des fournisseurs, puis relancez /doctor.",
	"models.json parses and configured providers pass pi's validation.":
		"models.json est valide et ses fournisseurs passent la validation de pi.",
	"Confirmed: the existing provider validator accepted the file.":
		"Cause confirmée : le validateur des fournisseurs a accepté le fichier.",
	"An extension failed to load.": "Une extension n'a pas pu être chargée.",
	"Confirmed: pi recorded a load error.": "Cause confirmée : pi a enregistré une erreur de chargement.",
	"Start with --safe to isolate extensions, then inspect the technical detail.":
		"Démarrez avec --safe pour isoler les extensions, puis consultez le détail technique.",
	"No extension load errors were recorded at startup.":
		"Aucune erreur de chargement d'extension n'a été enregistrée au démarrage.",
	"Confirmed: pi recorded no load errors.": "Cause confirmée : pi n'a enregistré aucune erreur de chargement.",
	"No model is selected.": "Aucun modèle n'est sélectionné.",
	"Confirmed: the session has no current model.": "Cause confirmée : la session n'a pas de modèle actuel.",
	"Select a model with /model.": "Sélectionnez un modèle avec /model.",
	"Credential availability and model capabilities require a selected model.":
		"La présence des identifiants et les capacités du modèle nécessitent un modèle sélectionné.",
	"Confirmed: model selection, credential presence, and stored capability values were read locally.":
		"Cause confirmée : le modèle, la présence des identifiants et les capacités enregistrées ont été lus localement.",
	"For unknown capabilities, consult the provider documentation or run capability detection separately.":
		"Pour les capacités inconnues, consultez la documentation du fournisseur ou lancez la détection séparément.",
	"Hypothesis: location is inferred from the configured base URL only.":
		"Hypothèse : l'emplacement est déduit uniquement de l'URL configurée.",
	"Check the provider configuration if this classification is unexpected.":
		"Vérifiez la configuration du fournisseur si ce classement est inattendu.",
	"Check local configuration and runtime paths; /doctor details includes technical details":
		"Vérifie la configuration locale et les chemins ; /doctor details affiche les détails techniques",
	"The last model request returned an error.": "La dernière requête au modèle a renvoyé une erreur.",
	"Confirmed: the request ended with an error. Hypothesis: a provider or connection problem caused it.":
		"Cause confirmée : la requête s'est terminée en erreur. Hypothèse : un problème de fournisseur ou de connexion en est la cause.",
	"Check the provider status and model configuration; retry only when ready.":
		"Vérifiez l'état du fournisseur et la configuration du modèle ; réessayez quand le service est prêt.",
	"Sign-in to {0} is no longer accepted. Sign in again with /login.":
		"La connexion à {0} n'est plus acceptée. Reconnectez-vous avec /login.",
	"Diagnostic report exported. Recognized sensitive information is masked; read the report before sharing it.":
		"Rapport de diagnostic exporté. Les informations sensibles reconnues sont masquées ; relisez le rapport avant de le partager.",
	"Sessions are not saved (--no-session).": "Les sessions ne sont pas enregistrées (--no-session).",
	"Confirmed: this session is kept in memory only.": "Confirmé : cette session n'est gardée qu'en mémoire.",
	"none recorded": "aucune",

	// /settings: view, hints, interface switch (settings-view.ts)
	Simple: "Simple",
	Advanced: "Avancé",
	"Advanced.": "Avancé.",
	"Advanced settings only.": "Réglages avancés seulement.",
	"Last model request": "Dernière requête au modèle",
	"Inspect the last model request: /sent, /sent export <path>":
		"Inspecter la dernière requête au modèle : /sent, /sent export <chemin>",
	"Usage: /sent export <path>": "Usage : /sent export <chemin>",
	"Usage: /sent [export <path>]": "Usage : /sent [export <chemin>]",
	unknown: "inconnu",
	"No model request has been captured in this session.":
		"Aucune requête au modèle n’a été capturée dans cette session.",
	"Request #{0}": "Requête nº {0}",
	Endpoint: "Adresse du service",
	"Session entries (session context; not sent as-is)":
		"Entrées de session (contexte de session ; non envoyées telles quelles)",
	"Prepared prompt (reconstruction)": "Prompt préparé (reconstitution)",
	"Provider payload at onPayload (captured exactly before transport serialization)":
		"Données remises au fournisseur par onPayload (capturées avant leur mise en forme pour le transport)",
	"Provider response": "Réponse du fournisseur",
	received: "reçue",
	"not received yet": "pas encore reçue",
	"No onPayload callback was reached.": "Le callback onPayload n’a pas été appelé.",
	"The provider may serialize, rewrite, truncate, cache, or otherwise transform this payload; server-side behavior and OAuth/subscription rewriting cannot be verified here.":
		"Le fournisseur peut mettre en forme, réécrire, tronquer, mettre en cache ou transformer ces données. Le comportement du serveur et les réécritures OAuth ou d’abonnement ne sont pas vérifiables ici.",
	"This request will be sent to a cloud model.": "Cette requête sera envoyée à un modèle cloud.",
	"Redacted request exported to": "Requête expurgée exportée vers",
	"Could not export request": "Impossible d’exporter la requête",
	"Local to cloud warning": "Avertissement local vers cloud",
	"Show the current session's operation trace": "Afficher la trace des opérations de la session actuelle",
	"Tracing is off. Turn it on in /settings > Privacy > Operation trace, then run /reload.":
		"La trace est désactivée. Activez-la dans /settings > Confidentialité > Trace des opérations, puis lancez /reload.",
	"Could not write operation trace; tracing stopped for this session.":
		"Impossible d'écrire la trace ; l'enregistrement est arrêté pour cette session.",
	"No operations traced yet.": "Aucune opération enregistrée pour le moment.",
	"Trace file": "Fichier de trace",
	"Show or change execution budgets for this session": "Afficher ou modifier les budgets d'exécution de cette session",
	"Session wall-clock budget in minutes": "Durée maximale de session en minutes réelles",
	"Session tool-call budget": "Nombre maximal d'appels d'outils dans la session",
	"Session token budget": "Nombre maximal de tokens dans la session",
	"Session cost budget in USD (requires known model pricing)":
		"Coût maximal de session en USD (tarif du modèle requis)",
	"Execution budget exhausted: {0} consumed of {1}. No new model turn or tool call will start. Raise or clear it with /budget; detached tasks are still running: {2}.":
		"Budget d'exécution épuisé : {0} consommé sur {1}. Aucun nouveau tour du modèle ni appel d'outil ne démarrera. Augmentez ou supprimez la limite avec /budget ; les tâches détachées suivantes tournent toujours : {2}.",
	"Execution budget exhausted: {0} consumed of {1}. No new model turn or tool call will start. An active tool call, if any, received an abort signal; external process exit is not confirmed here. Raise or clear it with /budget; detached tasks are still running: {2}.":
		"Budget d'exécution épuisé : {0} consommé sur {1}. Aucun nouveau tour du modèle ni appel d'outil ne démarrera. Un appel d'outil actif, s'il y en a un, a reçu un signal d'annulation ; l'arrêt du processus externe n'est pas confirmé ici. Augmentez ou supprimez la limite avec /budget ; les tâches détachées suivantes tournent toujours : {2}.",
	"Execution budget exhausted ({0}): the message was not sent. Raise or clear it with /budget.":
		"Budget d'exécution épuisé ({0}) : le message n'a pas été envoyé. Augmentez ou supprimez la limite avec /budget.",
	"Execution budget warning: {0} of {1} used.": "Avertissement de budget : {0} sur {1} consommé.",
	"Execution budget exhausted. Stop and wait for the user to resume with /budget.":
		"Budget d'exécution épuisé. Arrêtez et attendez que l'utilisateur reprenne avec /budget.",
	"Cost budget refused: the current model has no non-zero price metadata.":
		"Budget de coût refusé : les métadonnées du modèle actuel n'indiquent aucun tarif non nul.",
	"Cost budget refused: earlier cost usage is unknown for this session.":
		"Budget de coût refusé : le coût antérieur de cette session est inconnu.",
	"Cost budget cannot be enforced because model pricing or reported usage is unknown. Choose a priced model or clear the limit with /budget off cost.":
		"Le budget de coût ne peut pas être appliqué : le tarif du modèle ou le coût rapporté est inconnu. Choisissez un modèle tarifé ou supprimez la limite avec /budget off cost.",
	"Usage: /budget [time|tools|tokens|cost <value>|off [kind]]":
		"Usage : /budget [time|tools|tokens|cost <valeur>|off [type]]",
	"Tokens count input, output, cache read, and cache write.":
		"Les tokens comptent l'entrée, la sortie, la lecture du cache et l'écriture du cache.",
	"Warning threshold: 80%.": "Seuil d'avertissement : 80 %.",
	consumed: "consommé",
	min: "min",
	Cost: "Coût",
	State: "État",
	"paused at {0}": "en pause à {0}",
	active: "actif",
	off: "désactivé",
	time: "durée",
	tools: "outils",
	tokens: "tokens",
	"Operation trace": "Trace des opérations",
	"Trace retention (days)": "Conservation des traces (jours)",
	"Keep a local timeline of tool calls, permission decisions and results. Parameters are saved with known secrets masked. Off by default; changing this setting takes effect after /reload.":
		"Conserver localement les appels d'outils, les décisions de permission et les résultats. Les paramètres sont enregistrés après masquage des secrets connus. Désactivé par défaut ; le changement s'applique après /reload.",
	"Delete operation trace files older than this many days at startup.":
		"Au démarrage, supprimer les traces d'opérations plus anciennes que ce nombre de jours.",
	called: "appelé",
	"allowed by a rule": "autorisé par une règle",
	"allowed once when asked": "autorisé une fois sur demande",
	"allowed for the session when asked": "autorisé pour la session sur demande",
	"always allowed when asked": "toujours autorisé sur demande",
	denied: "refusé",
	blocked: "bloqué",
	succeeded: "réussi",
	"Show one quiet line when a request switches from a local model to a cloud model.":
		"Afficher une ligne discrète quand une requête passe d’un modèle local à un modèle cloud.",
	"  ↑↓ move · Enter change · ← or Esc back": "  ↑↓ bouger · Entrée changer · ← ou Échap retour",
	"  ↑↓ move · → or Enter open · Esc close": "  ↑↓ bouger · → ou Entrée ouvrir · Échap fermer",
	"  Enter/Space to change · Esc to cancel": "  Entrée/Espace pour changer · Échap pour annuler",
	"  Type to search · Enter/Space to change · Esc to cancel":
		"  Tapez pour chercher · Entrée/Espace pour changer · Échap pour annuler",
	"  No matching settings": "  Aucun réglage ne correspond",
	"  No settings available": "  Aucun réglage disponible",

	// /settings: domains (settings-domains.ts)
	Appearance: "Apparence",
	"Colors, thinking text, diagrams, startup messages and spacing":
		"Couleurs, texte de réflexion, diagrammes, messages au démarrage et marges",
	"Thinking text, diagrams and suggestions": "Texte de réflexion, diagrammes et suggestions",
	Conversation: "Conversation",
	"Auto-compact conversation (summaries of older messages), queued messages (sent while or after working), thinking levels, Escape and /tree history":
		"Résumé automatique (des anciens messages), messages en attente (envoyés pendant ou après le travail), niveaux de réflexion, Échap et historique /tree",
	Terminal: "Terminal",
	"Fullscreen or regular mode, scrolling, selection and terminal integration":
		"Mode plein écran ou normal, défilement, sélection et intégration au terminal",
	"Images & privacy": "Images et confidentialité",
	"Images sent to model services or servers, and trust for project folders":
		"Images envoyées aux services ou serveurs de modèles, et confiance dans les dossiers de projet",
	Network: "Réseau",
	"Connection method, response wait limits and keeping sent text cached for reuse":
		"Mode de connexion, délais d'attente des réponses et mise en cache du texte envoyé",
	"Warnings & notices": "Avertissements et notes",
	"Warnings, cache notices and the changelog": "Avertissements, notes sur le cache et nouveautés",
	Other: "Autres",
	"Settings without a domain yet": "Réglages sans catégorie pour l'instant",
	Extensions: "Extensions",
	"Turn bundled add-ons on or off. The permission system stays loaded; use /perm to choose its mode.":
		"Activer ou désactiver les modules inclus. Le système de permissions reste chargé ; /perm choisit son mode.",
	"Web search": "Recherche web",
	"Search provider, API key or instance URL": "Service de recherche, clé d'API ou URL de l'instance",
	Tools: "Outils",
	"Permissions, models, language servers and remote access":
		"Permissions, modèles, serveurs de langage et accès à distance",
	"All settings": "Tous les réglages",
	"Read a file": "Lecture d'un fichier",
	"Edit a file": "Modification d'un fichier",
	"Write a file": "Écriture d'un fichier",
	"Run a command": "Commande lancée",
	"Search the files": "Recherche dans les fichiers",
	"Find files": "Recherche de fichiers",
	"Every setting in one searchable list": "Tous les réglages dans une seule liste, avec recherche",
	Interface: "Interface",
	"Simple shows each action on one line and hides technical settings. Advanced shows every setting, and each action's command and output.":
		"Simple montre chaque action sur une ligne et cache les réglages techniques. Avancé montre tous les réglages, et la commande et la sortie de chaque action.",
	Language: "Langue",
	"The language of Prism's menus and messages. Auto follows the system language.":
		"La langue des menus et messages de Prism. Auto suit la langue du système.",
	Animations: "Animations",
	"Reply language": "Langue des réponses",
	Provider: "Service",
	"SearXNG URL": "URL SearXNG",
	"Changes take effect after /reload.": "Le changement s'applique après /reload.",
	"Applies when you close Settings.": "S'applique à la fermeture des réglages.",
	"Module changes saved. Run /reload after the current response to apply them.":
		"Modules enregistrés. Lancez /reload après la réponse en cours pour les appliquer.",
	"Takes effect at the next start.": "S'applique au prochain démarrage.",

	// /settings > Tools (settings-descriptions.ts)
	Permissions: "Permissions",
	"What the model may do without asking: modes, default mode and rules (also /perm, alt+m).":
		"Ce que le modèle peut faire sans demander : modes, mode par défaut et règles (aussi /perm, alt+m).",
	"Models to cycle": "Modèles à faire défiler",
	"Language servers": "Serveurs de langage",

	// /settings: values (drawn by settings-view.ts; the saved value does not change)
	auto: "auto",
	simple: "simple",
	advanced: "avancé",
	window: "fenêtre",
	terminal: "terminal",
	"one-at-a-time": "un par un",
	all: "tous",
	header: "en-tête seul",
	final: "à la fin",
	streaming: "en direct",
	idle: "au repos",
	none: "rien",
	default: "par défaut",
	"no-tools": "sans outils",
	"user-only": "vos messages",
	"labeled-only": "marqués",
	regular: "normal",
	fullscreen: "plein écran",
	transcript: "conversation",
	"resume-hint": "commande de reprise",
	always: "toujours",
	hidden: "cachée",
	select: "choisir",
	open: "ouvrir",
	"saved key": "clé enregistrée",
	missing: "manquante",
	"set a key": "saisir une clé",
	"set a URL": "saisir une URL",
	remove: "retirer",
	"none (public endpoint)": "aucune (service public)",
	"unsupported value": "valeur non prise en charge",
	Ask: "Demander",
	"Always trust": "Toujours faire confiance",
	"Never trust": "Ne jamais faire confiance",

	// /settings: labels (settings-selector.ts)
	Theme: "Thème",
	"Anthropic extra usage": "Usage supplémentaire Anthropic",
	"Auto-compact conversation": "Résumé automatique",
	"Messages sent while working": "Messages envoyés pendant le travail",
	"Steering (messages while working)": "Messages pendant le travail",
	"Messages sent after the task": "Messages envoyés après la tâche",
	"Follow-up (messages after working)": "Messages après le travail",
	"Connection method": "Mode de connexion",
	"HTTP response wait limit": "Délai d'attente HTTP",
	"Cache warming": "Maintien du cache",
	"Hide thinking": "Cacher la réflexion",
	"Mermaid diagrams": "Diagrammes Mermaid",
	"Cache miss notices": "Notes sur le cache manqué",
	"Collapse changelog": "Nouveautés résumées",
	"Quiet startup": "Démarrage discret",
	"Trust for new project folders": "Confiance pour les nouveaux dossiers",
	"Double-escape action": "Double Échap",
	"Tree filter mode": "Filtre de /tree",
	Warnings: "Avertissements",
	"Thinking level for each model": "Niveau de réflexion par modèle",
	"Screen layout": "Affichage",
	"Fullscreen exit output": "En quittant le plein écran",
	"Fullscreen scrollbar": "Barre de défilement",
	"Fullscreen copy on select": "Copier à la sélection",
	"Fullscreen wheel scrolling": "Défilement à la molette",
	"Show images": "Afficher les images",
	"Image width": "Largeur des images",
	"Auto-resize images": "Réduire les images",
	"Block images": "Bloquer les images",
	"Skill commands": "Commandes de skills",
	"Show hardware cursor": "Curseur du terminal",
	"Editor padding": "Marge de la saisie",
	"Output padding": "Marge de la conversation",
	"Autocomplete max items": "Suggestions affichées",
	"Clear on shrink": "Effacer en rétrécissant",
	"Terminal progress": "Progression dans le terminal",

	// /settings: descriptions (settings-descriptions.ts, settings-selector.ts)
	"Where the model's searches go: Exa works without a key; Brave, Tavily and Firecrawl need a key; SearXNG uses your own instance. Changing this closes Settings and reloads the tools.":
		"Où vont les recherches du modèle : Exa fonctionne sans clé ; Brave, Tavily et Firecrawl demandent une clé ; SearXNG utilise votre propre instance. Changer ce choix ferme les réglages et recharge les outils.",
	"Without an API key (an access key from Exa), web_search uses Exa's public service with request limits. A key uses your Exa account's limits. Saved keys are stored in auth.json.":
		"Sans clé d'API (une clé d'accès fournie par Exa), web_search utilise le service public d'Exa, avec un nombre de requêtes limité. Avec une clé, ce sont les limites de votre compte Exa. Les clés enregistrées sont dans auth.json.",
	"Save or remove this provider's API key. Searches need a key for this provider. Environment keys take precedence; remove them from your environment to stop using them.":
		"Enregistrer ou retirer la clé d'API de ce service. Les recherches demandent une clé pour ce service. Une clé dans l'environnement passe en premier ; retirez-la de l'environnement pour ne plus l'utiliser.",
	"The http(s) base URL of your SearXNG instance, for example http://localhost:8080. No key is needed. Enable JSON search results on the instance. Save or remove the URL here.":
		"L'adresse http(s) de votre instance SearXNG, par exemple http://localhost:8080. Aucune clé n'est nécessaire. Activez les résultats au format JSON sur l'instance. Enregistrez ou retirez l'adresse ici.",
	"Colours of the interface. Automatic picks the light or the dark theme to match your terminal's background.":
		"Les couleurs de l'interface. Automatique choisit le thème clair ou sombre selon le fond de votre terminal.",
	"Color theme. Automatic follows the terminal's light or dark background":
		"Les couleurs de l'interface. Automatique suit le fond clair ou sombre du terminal",
	"Moving effects: the logo drawing in at startup, the working line, shines, breathing dots and opening menus. Each has its styles, and presets set them all; off keeps it still.":
		"Les effets animés : le logo qui se dessine au démarrage, la ligne d'attente, les reflets, les points qui respirent et l'ouverture des menus. Chacun a ses styles, et les préréglages les règlent tous ; désactivé, il reste immobile.",
	"no model": "aucun modèle",
	"(default)": "(par défaut)",
	Turns: "Tours",
	// fork: /settings > Appearance > Customize theme (theme-editor.ts).
	"Customize theme": "Personnaliser le thème",
	"Change the colours of the theme in use, with a preview. A copy is saved in the themes folder and becomes your theme; the original stays as it was.":
		"Modifier les couleurs du thème utilisé, avec un aperçu. Une copie est enregistrée dans le dossier des thèmes et devient votre thème ; l'original reste tel quel.",
	Palette: "Palette",
	Colours: "Couleurs",
	"terminal's own": "celle du terminal",
	"A palette entry: every colour that names it changes with it.":
		"Une couleur de la palette : toutes les couleurs qui la nomment changent avec elle.",
	"Highlights: the selected item, the cursor, titles.": "Mises en avant : l'élément choisi, le curseur, les titres.",
	"The main text.": "Le texte principal.",
	"Secondary text, and the model's thinking.": "Le texte secondaire, et la réflexion du modèle.",
	"Labels and hints.": "Les libellés et les indications.",
	"The faintest text.": "Le texte le plus pâle.",
	"Lines and borders.": "Les lignes et les bordures.",
	"Strong lines.": "Les lignes marquées.",
	"Faint lines.": "Les lignes discrètes.",
	"Success: a tool that worked, added lines.": "Réussite : un outil qui a marché, les lignes ajoutées.",
	"Errors and removed lines.": "Les erreurs et les lignes retirées.",
	"Warnings.": "Les avertissements.",
	"The background of the selected row.": "Le fond de la ligne choisie.",
	"The background of your messages and the input.": "Le fond de vos messages et de la zone de saisie.",
	"Markdown in replies.": "Le Markdown des réponses.",
	"Code highlighting.": "La coloration du code.",
	"Tool calls and their output.": "Les appels d'outils et leur sortie.",
	"The thinking level's colour.": "La couleur du niveau de réflexion.",
	"A colour of the interface.": "Une couleur de l'interface.",
	"Not a colour yet.": "Pas encore une couleur.",
	Text: "Texte",
	Secondary: "Secondaire",
	Muted: "Discret",
	Accent: "Accent",
	done: "fait",
	warning: "avertissement",
	"Your message": "Votre message",
	"Selected row": "Ligne choisie",
	Heading: "Titre",
	link: "lien",
	// fork: /settings > Appearance > Animations (settings-animations.ts, animations.ts).
	"All animations": "Toutes les animations",
	"off (all)": "désactivé (toutes)",
	Preview: "Aperçu",
	"Preview: the working line": "Aperçu : la ligne d'attente",
	"Turns every animation on or off. Off, nothing moves and each animation shows its last frame.":
		"Active ou désactive toutes les animations. Désactivées, rien ne bouge et chacune montre sa dernière image.",
	"Startup logo": "Logo au démarrage",
	"The logo draws itself in at start, and the setup's beam.":
		"Le logo se dessine au démarrage, ainsi que le faisceau de la configuration.",
	"Working line": "Ligne d'attente",
	"The glint, the shine and the input's pulse while Prism works.":
		"Le reflet, la brillance et la pulsation de la zone de saisie pendant que Prism travaille.",
	"Thinking label": "Libellé de réflexion",
	"A shine across “Thinking…” while the model thinks; a thinking block unfolds when clicked or shown from the keyboard.":
		"Un reflet traverse « Réflexion… » pendant que le modèle réfléchit ; un bloc de réflexion se déplie au clic ou au clavier.",
	"Running tool": "Outil en cours",
	"The dot of a tool that is running breathes; its details unfold when clicked or shown from the keyboard.":
		"Le point d'un outil en cours respire ; ses détails se déplient au clic ou au clavier.",
	"Opening menus": "Ouverture des menus",
	"Menus and panels unfold when they open, and panels fold when they close.":
		"Les menus et panneaux se déploient à l'ouverture, et les panneaux se replient à la fermeture.",
	"Terminal title": "Titre du terminal",
	"A spinner in the terminal's title while Prism works.":
		"Un indicateur tourne dans le titre du terminal pendant que Prism travaille.",
	Example: "Exemple",
	"Another choice": "Autre choix",
	"Hide thinking blocks in replies. This changes the display, not how much the model thinks.":
		"Cacher les blocs de réflexion dans les réponses. Cela change l'affichage, pas la quantité de réflexion du modèle.",
	"When the model writes a diagram in Mermaid (a text format for flowcharts and sequence diagrams), draw it with text characters instead of showing its source.":
		"Quand le modèle écrit un diagramme en Mermaid (un format texte pour les organigrammes et les diagrammes de séquence), le dessiner avec des caractères au lieu d'afficher son code.",
	"Show images (screenshots, pictures the model reads) inside the terminal, when the terminal can.":
		"Afficher les images (captures d'écran, images que lit le modèle) dans le terminal, quand il le permet.",
	"How wide images appear in the conversation, in character columns.":
		"La largeur des images dans la conversation, en colonnes de caractères.",
	"What Prism prints at startup.": "Ce que Prism affiche au démarrage.",
	"Empty columns on each side of the text you type.": "Colonnes vides de chaque côté du texte que vous tapez.",
	"Empty columns on each side of the messages in the conversation.":
		"Colonnes vides de chaque côté des messages de la conversation.",
	"How many suggestions the list shows at once while you type a / command or a file path.":
		"Le nombre de suggestions affichées à la fois quand vous tapez une commande / ou un chemin de fichier.",
	"Show the terminal's own cursor in the input box. Useful with input methods for Chinese, Japanese or Korean.":
		"Afficher le curseur du terminal dans la zone de saisie. Utile avec les méthodes de saisie du chinois, du japonais ou du coréen.",
	"Automatically summarize older messages when the conversation nears the model's limit. Recent messages stay in full; older details may be lost in the summary.":
		"Résumer automatiquement les anciens messages quand la conversation approche de la limite du modèle. Les messages récents restent complets ; des détails anciens peuvent se perdre dans le résumé.",
	"How full the model's context can get before Auto-compact summarizes old messages. Lower percentages summarize earlier. High values are capped to leave room for the summary request and reply. Default uses the existing token reserve. Applies when Auto-compact is on.":
		"Jusqu'où le contexte du modèle peut se remplir avant que le résumé automatique résume les anciens messages. Un pourcentage plus bas résume plus tôt. Les valeurs hautes sont plafonnées pour laisser la place à la demande de résumé et à sa réponse. Par défaut, la réserve de tokens existante est utilisée. S'applique quand le résumé automatique est activé.",
	"The language the model answers in. Prism's own instructions stay in English. Another language can be written in settings.json (replyLanguage). Code, commands and file names are never translated.":
		"La langue dans laquelle le modèle répond. Les instructions de Prism restent en anglais. Une autre langue peut être écrite dans settings.json (replyLanguage). Le code, les commandes et les noms de fichiers ne sont jamais traduits.",
	"Press Enter while the agent is working to guide its next steps.":
		"Appuyez sur Entrée pendant que l'agent travaille pour guider ses prochaines étapes.",
	"What pressing Escape twice does when the input box is empty.":
		"Ce que fait un double appui sur Échap quand la zone de saisie est vide.",
	"Which messages /tree (the map of the session's branches) shows when it opens.":
		"Les messages que /tree (le plan des branches de la session) montre à l'ouverture.",
	"Add /skill:name commands to open skills: saved instructions for specific tasks.":
		"Ajouter les commandes /skill:nom pour ouvrir les skills : des consignes enregistrées pour des tâches précises.",
	"How Prism uses the terminal.": "Comment Prism occupe le terminal.",
	"When the scrollbar on the right of the conversation is visible (fullscreen mode only).":
		"Quand la barre de défilement à droite de la conversation est visible (mode plein écran seulement).",
	"Copy text to the clipboard as soon as you select it with the mouse. Off: select, then press Ctrl+X to copy.":
		"Copier le texte dès que vous le sélectionnez à la souris. Désactivé : sélectionnez, puis appuyez sur Ctrl+X pour copier.",
	"Lines scrolled per mouse-wheel notch.": "Lignes défilées par cran de molette.",
	"What is printed in the terminal on leaving full-screen mode.":
		"Ce qui s'affiche dans le terminal en quittant le plein écran.",
	"Erase leftover empty lines when the screen content gets shorter. Can make the screen flicker.":
		"Effacer les lignes vides restantes quand le contenu de l'écran raccourcit. Peut faire scintiller l'écran.",
	"Show progress in the terminal's tab bar while the model works, in terminals that support it.":
		"Afficher la progression dans la barre d'onglets du terminal pendant que le modèle travaille, si le terminal le permet.",
	"Do not send images to the model's service or server.":
		"Ne pas envoyer d'images au service ou au serveur du modèle.",
	"Shrink large images to at most 2000×2000 pixels before sending them; models accept them more reliably.":
		"Réduire les grandes images à 2000×2000 pixels au plus avant de les envoyer ; les modèles les acceptent mieux.",
	"When no saved choice or extension decides, choose whether to trust the folder. Trust allows its settings to load, missing project packages to be installed, and its extensions to run code.":
		"Quand aucun choix enregistré ni aucune extension ne décide, choisir s'il faut faire confiance au dossier. La confiance permet de charger ses réglages, d'installer les paquets manquants du projet et d'exécuter le code de ses extensions.",
	"Choose how to connect when the service offers a choice.":
		"Choisir comment se connecter quand le service propose un choix.",
	"How long an HTTP request can wait without receiving data. This is not a limit on the whole reply. Disable it if your local model pauses longer than the selected limit.":
		"Combien de temps une requête HTTP peut attendre sans recevoir de données. Ce n'est pas une limite sur toute la réponse. Désactivez-la si votre modèle local fait des pauses plus longues que la limite choisie.",
	"Send extra requests to keep previously sent text cached for reuse. These requests may cost money.":
		"Envoyer des requêtes en plus pour garder en cache le texte déjà envoyé. Ces requêtes peuvent coûter de l'argent.",
	"Choose which warnings Prism shows.": "Choisir les avertissements que Prism affiche.",
	"Note in the conversation when the provider's prompt cache was missed (which costs more) and how it recovered.":
		"Signaler dans la conversation quand le cache du service a été manqué (ce qui coûte plus cher) et comment il s'est rétabli.",
	"After an update, show a short summary of the changes instead of the full notes.":
		"Après une mise à jour, afficher un court résumé des changements au lieu des notes complètes.",
	"Warn when using an Anthropic subscription may incur extra charges. This warning does not block extra charges.":
		"Avertir quand l'utilisation d'un abonnement Anthropic peut entraîner des frais en plus. Cet avertissement ne bloque pas ces frais.",

	// /settings > Extensions (settings-descriptions.ts)
	"Manages the models of a llama.cpp server in router mode: list, download from Hugging Face, load.":
		"Gère les modèles d'un serveur llama.cpp en mode routeur : lister, télécharger depuis Hugging Face, charger.",
	"A tool that runs a short script calling other tools; off until activated, MCP uses it for script-only tools.":
		"Un outil qui exécute un court script appelant d'autres outils ; inactif tant qu'il n'est pas activé, MCP s'en sert pour les outils utilisables seulement par script.",
	"A tool to search the available tools, for when there are many; off until activated.":
		"Un outil pour chercher parmi les outils disponibles, quand il y en a beaucoup ; inactif tant qu'il n'est pas activé.",
	"Connects the MCP servers (external tool providers) listed in mcp.json.":
		"Connecte les serveurs MCP (fournisseurs d'outils externes) listés dans mcp.json.",
	"Prism's look: header, composer, status bar, conversation and menus. Off shows the plain interface.":
		"L'apparence de Prism : en-tête, zone de saisie, barre d'état, conversation et menus. Désactivé, l'interface est simple.",
	"Saves file snapshots before the model edits them, so you can roll back.":
		"Enregistre une copie des fichiers avant que le modèle les modifie, pour pouvoir revenir en arrière.",
	"Lets the model run long commands in the background and check on them later.":
		"Permet au modèle de lancer de longues commandes en arrière-plan et de les suivre ensuite.",
	"Keeps notes across sessions that the model can read and update.":
		"Garde d'une session à l'autre des notes que le modèle peut lire et mettre à jour.",
	// the module's description, translated sentence by sentence as /settings shows it.
	"Lets the model search your other sessions.": "Permet au modèle de chercher dans vos autres sessions.",
	"Privacy: a cloud model then reads excerpts of them, perhaps private work held with a local model; Prism asks you first.":
		"Confidentialité : un modèle cloud en lit alors des extraits, peut-être un travail privé mené avec un modèle local ; Prism vous demande d'abord.",
	"Desktop notification when the model finishes, or waits for your approval.":
		"Notification sur le bureau quand le modèle a fini, ou attend votre accord.",
	"Web search and page reading for the model.": "Recherche web et lecture de pages pour le modèle.",
	'In a project with a project/handoff.md file, tells the model what each continuity document (spec, roadmap, journal, handoff, questions) is for and how to keep it current. Elsewhere, adds nothing to the prompt and shows an "init" button that runs /init.':
		"Dans un projet qui a un fichier project/handoff.md, indique au modèle à quoi sert chaque document de continuité (spécification, feuille de route, journal, passation, questions) et comment le tenir à jour. Ailleurs, n'ajoute rien au prompt et affiche un bouton « init » qui lance /init.",
	"Set up the project's continuity documents, from a plan or from the existing repository":
		"Met en place les documents de continuité du projet, à partir d'un plan ou du dépôt existant",
	"Project is not trusted — project continuity is disabled.":
		"Ce dossier n'est pas approuvé : la continuité de projet y est coupée.",
	"/init needs the interactive interface, to show what it will create and ask you.":
		"/init a besoin de l'interface interactive, pour montrer ce qu'il va créer et vous demander.",
	"From the existing repository": "À partir du dépôt existant",
	"From a plan": "À partir d'un plan",
	"No plan yet: write one first in plan mode": "Pas encore de plan : l'écrire d'abord en mode plan",
	"Describe the project to plan it. Once the plan is complete, export it (PLAN.md) and run /init again: it offers that plan.":
		"Décrivez le projet pour le planifier. Une fois le plan terminé, exportez-le (PLAN.md) et relancez /init : il propose ce plan.",
	"Start from": "Point de départ",
	"Paste the plan, or the path of a plan file": "Collez le plan, ou le chemin d'un fichier de plan",
	adapt: "adapter",
	create: "créer",
	"Project: {0}": "Projet : {0}",
	"Starting point: the existing repository": "Point de départ : le dépôt existant",
	"Starting point: your plan": "Point de départ : votre plan",
	"Already present, reused rather than copied: {0}": "Déjà présents, repris plutôt que copiés : {0}",
	"The model writes these files with its usual tools; your permission rules apply.":
		"Le modèle écrit ces fichiers avec ses outils habituels ; vos règles de permission s'appliquent.",
	// the handoff reminder in /settings > Conversation.
	"Handoff reminder": "Rappel de handoff",
	"Handoff reminder interval": "Intervalle du rappel de handoff",
	"In a project with project/handoff.md, reminds the model at the interval below to offer a handoff update in its final answer, without stopping it.":
		"Dans un projet avec project/handoff.md, rappelle au modèle, à l'intervalle ci-dessous, de proposer une mise à jour du handoff dans sa réponse finale, sans l'arrêter.",
	"Tool calls between two handoff reminders.": "Appels d'outils entre deux rappels de handoff.",
	"Set up project continuity?": "Mettre en place la continuité de projet ?",
	"Nothing was written.": "Rien n'a été écrit.",
	"Set up": "Mettre en place",
	File: "Fichier",
	"Have the model update project/handoff.md, with the Git state and running tasks measured by Prism":
		"Fait mettre à jour project/handoff.md par le modèle, avec l'état Git et les tâches en cours relevés par Prism",
	"This project has no project/handoff.md: /init sets up the continuity documents.":
		"Ce projet n'a pas de project/handoff.md : /init met en place les documents de continuité.",
	"it describes commit {0}, HEAD is now {1}": "elle décrit le commit {0}, HEAD est maintenant {1}",
	"{0} uncommitted files changed after it ({1})": "{0} fichiers non commités modifiés après elle ({1})",
	"project/handoff.md may be out of date: {0}. /handoff updates it.":
		"project/handoff.md n'est peut-être plus à jour : {0}. /handoff la met à jour.",
	"In a project with source code, says once which language servers to install, and /lsp-setup gives the command. Never installs anything by itself.":
		"Dans un projet avec du code source, indique une fois quels serveurs de langage installer, et /lsp-setup donne la commande. N'installe jamais rien tout seul.",
	"Tells the model your system, desktop, processor, memory, free disk space and shell, so its commands fit your computer.":
		"Indique au modèle votre système, votre bureau, votre processeur, votre mémoire, l'espace disque libre et votre shell, pour que ses commandes conviennent à votre ordinateur.",
	"Your computer, for the model": "Votre ordinateur, pour le modèle",
	"Tells the model which language to answer in (Settings > Conversation > Reply language).":
		"Indique au modèle dans quelle langue répondre (Réglages > Conversation > Langue des réponses).",
	"A side panel to browse the project's files and add them to your message (alt+e, /files).":
		"Un panneau latéral pour parcourir les fichiers du projet et les ajouter à votre message (alt+e, /files).",
	"Adds your APPEND_SYSTEM.md file to the model's instructions.":
		"Ajoute votre fichier APPEND_SYSTEM.md aux instructions du modèle.",
	"Custom agents created with /agents, which the model runs with the agent tool.":
		"Agents personnalisés créés avec /agents, que le modèle lance avec l'outil agent.",
	"Checks code for errors with language servers (TypeScript, Python, …) when they are installed.":
		"Vérifie les erreurs du code avec les serveurs de langage (TypeScript, Python…) quand ils sont installés.",
	"/context: shows what fills the model's context.": "/context : montre ce qui remplit le contexte du modèle.",
	"Plan mode: the model plans first and only reads files until you approve.":
		"Mode plan : le modèle planifie d'abord et ne fait que lire les fichiers jusqu'à votre accord.",
	"Goal mode: give the model a goal it keeps working towards across turns.":
		"Mode objectif : donnez au modèle un objectif qu'il poursuit d'un tour à l'autre.",
	"Lets the model ask you multiple-choice questions in a small form.":
		"Permet au modèle de vous poser des questions à choix multiples dans un petit formulaire.",

	// Slash commands (core/slash-commands.ts)
	"Open settings menu": "Ouvrir les réglages",
	"Select model (opens selector UI)": "Choisir le modèle",
	"Navigate session tree (switch branches)": "Parcourir l'arbre de la session (changer de branche)",
	"Set thinking level": "Régler le niveau de réflexion",
	"Enable/disable models for Ctrl+P cycling": "Choisir les modèles parcourus avec Ctrl+P",
	"Export session (HTML default, or specify path: .html/.jsonl)":
		"Exporter la session (HTML par défaut, ou indiquez un chemin : .html/.jsonl)",
	"Import and resume a session from a JSONL file": "Importer et reprendre une session depuis un fichier JSONL",
	"Share session as a secret GitHub gist": "Partager la session dans un gist GitHub secret",
	"Copy last agent message to clipboard": "Copier la dernière réponse de l'agent",
	"Set session display name": "Nommer la session",
	"Show session info and stats": "Informations et statistiques de la session",
	"Show changelog entries": "Afficher les nouveautés",
	"Shortcuts and common actions, most frequent first": "Raccourcis et actions courantes, les plus utilisés d'abord",
	"Expand thinking and tool output together (again: collapse both)":
		"Déplier ensemble la réflexion et les sorties d'outils (une 2e fois : tout replier)",
	"Show all keyboard shortcuts": "Afficher tous les raccourcis clavier",
	"Create a new fork from a previous user message": "Créer une nouvelle branche depuis un de vos messages",
	"Duplicate the current session at the current position": "Dupliquer la session à l'endroit actuel",
	"Save project trust decision for future sessions":
		"Enregistrer la confiance dans ce projet pour les prochaines sessions",
	"Configure provider authentication": "Se connecter à un service de modèles",
	"Remove provider authentication": "Se déconnecter d'un service de modèles",
	"Start a new session": "Commencer une nouvelle session",
	"Compact context (summarize older messages)": "Résumer les anciens messages",
	"Resume a different session": "Reprendre une autre session",
	"Reload keybindings, extensions, skills, prompts, themes, and context files":
		"Recharger raccourcis, extensions, skills, prompts, thèmes et fichiers de contexte",

	// /help (help.ts)
	"Send the message": "Envoyer le message",
	"New line in the message": "Nouvelle ligne dans le message",
	"Stop the agent": "Arrêter l'agent",
	"also closes menus and autocomplete": "ferme aussi les menus et les suggestions",
	Commands: "Commandes",
	"type / to list them": "tapez / pour les lister",
	"Complete a path or a command": "Compléter un chemin ou une commande",
	"Previous messages": "Messages précédents",
	"in an empty editor": "dans une saisie vide",
	"Select text in the message": "Sélectionner du texte dans le message",
	"typing replaces it": "la frappe la remplace",
	"Choose the model": "Choisir le modèle",
	"Change the thinking level": "Changer le niveau de réflexion",
	"or click the level under the editor": "ou cliquez sur le niveau sous la saisie",
	"Show or hide thinking": "Afficher ou cacher la réflexion",
	"Show or hide tool output": "Afficher ou cacher les sorties d'outils",
	"Expand thinking and tool output together": "Déplier ensemble la réflexion et les sorties d'outils",
	"Copy the selection or the last answer": "Copier la sélection ou la dernière réponse",
	"Paste an image or files from the clipboard": "Coller une image ou des fichiers du presse-papiers",
	"Run a shell command": "Lancer une commande shell",
	"its output goes to the agent; !! keeps it out": "sa sortie va à l'agent ; !! la garde pour vous",
	"Queue a message for when the agent is done": "Mettre un message en attente pour la fin du travail",
	"Undo the last turn's file changes": "Annuler les modifications de fichiers du dernier tour",
	"Settings, by domain; Tools opens permissions, models, language servers":
		"Réglages, par catégorie ; Outils ouvre permissions, modèles, serveurs de langage",
	"Read the documentation": "Lire la documentation",
	"Choose when actions need your permission: ask, safe, broad or unrestricted":
		"Choisir quand les actions demandent votre accord : ask, safe, broad ou unrestricted",
	"checks action patterns; does not isolate files or commands":
		"vérifie des motifs d'actions ; n'isole ni fichiers ni commandes",
	"Plan mode on or off: explore and plan without changing files":
		"Mode plan : explorer et planifier sans modifier les fichiers",
	"or click plan under the editor": "ou cliquez sur plan sous la saisie",
	"Goal: let the agent work until a goal is done": "Objectif : laisser l'agent travailler jusqu'à l'objectif atteint",
	"or click goal under the editor": "ou cliquez sur Objectif sous la saisie",
	"Browse the project's files and add them to your message":
		"Parcourir les fichiers du projet et les ajouter à votre message",
	"or click files under the editor": "ou cliquez sur Fichiers sous la saisie",
	"Reopen a previous session": "Rouvrir une session précédente",
	"Connect a model service or a local server": "Connecter un service de modèles ou un serveur local",
	"Bottom bar: tokens sent to the model and received from it in this session":
		"Barre du bas : tokens envoyés au modèle et reçus de lui dans cette session",
	"Bottom bar: tokens read from and written to the provider's cache":
		"Barre du bas : tokens lus dans le cache du fournisseur et écrits dedans",
	"advanced interface": "interface avancée",
	"Bottom bar: share of the last request read from the cache":
		"Barre du bas : part de la dernière requête lue dans le cache",
	"cheaper and faster when high": "plus elle est haute, moins c'est cher et lent",
	"Bottom bar: how full the model's context is, out of its size":
		"Barre du bas : remplissage du contexte du modèle, sur sa taille",
	"the tick on the gauge is where older messages get summarized":
		"le repère sur la jauge marque le début du résumé des anciens messages",
	"Bottom bar: older messages are summarized automatically":
		"Barre du bas : les anciens messages sont résumés automatiquement",
	"Write the message in your editor": "Écrire le message dans votre éditeur",
	"Next or previous model": "Modèle suivant ou précédent",
	"Take back queued messages": "Reprendre les messages en attente",
	"Go back to an earlier point of the session": "Revenir à un point antérieur de la session",
	"Summarize older messages to make room within the model's limit":
		"Résumer les anciens messages pour faire de la place dans la limite du modèle",
	"Export the session (HTML)": "Exporter la session (HTML)",
	"Clear the editor": "Vider la saisie",
	"twice: exit": "deux fois : quitter",
	Exit: "Quitter",
	"with an empty editor": "avec une saisie vide",
	"Suspend to the shell": "Mettre en pause et revenir au shell",
	"Move by word": "Avancer d'un mot",
	"Start of line": "Début de ligne",
	"End of line": "Fin de ligne",
	"Delete the previous word": "Effacer le mot précédent",
	"Delete the next word": "Effacer le mot suivant",
	"Delete to the start of the line": "Effacer jusqu'au début de la ligne",
	"Delete to the end of the line": "Effacer jusqu'à la fin de la ligne",
	"Undo in the editor": "Annuler dans la saisie",
	"Redo in the editor": "Rétablir dans la saisie",
	"Paste the last deleted text": "Coller le dernier texte effacé",
	"Cycle through deleted text after pasting": "Parcourir les textes effacés après un collage",
	"Jump forward to a character": "Sauter en avant jusqu'à un caractère",
	"Jump backward to a character": "Sauter en arrière jusqu'à un caractère",
	"Scroll by page": "Défiler d'une page",

	// Header and its full key list (prism/header.ts)
	commands: "commandes",
	more: "plus",
	twice: "deux fois",
	"drop files": "glisser des fichiers",
	"to interrupt": "pour interrompre",
	"to clear": "pour vider",
	"to exit": "pour quitter",
	"to exit (empty)": "pour quitter (saisie vide)",
	"to suspend": "pour mettre en pause",
	"to delete to end": "pour effacer jusqu'à la fin",
	"to change thinking level": "pour changer le niveau de réflexion",
	"to cycle models": "pour passer d'un modèle à l'autre",
	"to select model": "pour choisir le modèle",
	"to show or hide action details": "pour afficher ou cacher le détail des actions",
	"to expand thinking": "pour déplier la réflexion",
	"for external editor": "pour l'éditeur externe",
	"for commands": "pour les commandes",
	"to run a terminal command and share its output with the agent":
		"pour lancer une commande et partager sa sortie avec l'agent",
	"to run a terminal command without sharing its output with the agent":
		"pour lancer une commande sans partager sa sortie avec l'agent",
	"to queue follow-up": "pour mettre un message en attente",
	"to edit all queued messages": "pour modifier les messages en attente",
	"to paste": "pour coller",
	"images or text": "des images ou du texte",
	"files on macOS, images, or text": "des fichiers sur macOS, des images ou du texte",
	"to attach": "pour joindre",
	// fork.9 QA: the safe-mode startup help (interactive-mode.ts).
	"to save a message for after the current task": "pour garder un message pour après la tâche en cours",
	"to edit waiting messages": "pour modifier les messages en attente",
	"to paste images or text": "pour coller des images ou du texte",
	"to paste files on macOS, images, or text": "pour coller des fichiers sur macOS, des images ou du texte",

	// Menu titles (prism/dialogs.ts)
	Settings: "Réglages",
	Models: "Modèles",
	Model: "Modèle",
	Thinking: "Réflexion",
	"Resume session": "Reprendre une session",
	"Session tree": "Arbre de la session",
	Fork: "Nouvelle branche",
	Login: "Connexion",
	Images: "Images",
	"Images from tools": "Images des outils",
	Select: "Choisir",
	Input: "Saisie",
	Edit: "Modifier",
	Menu: "Menu",

	// Model settings (model-settings.ts)
	Context: "Contexte",
	"Max output": "Sortie max.",
	Temperature: "Température",
	"Top P": "Top P",
	"Top K": "Top K",
	"Min P": "Min P",
	"Presence penalty": "Pénalité de présence",
	"Frequency penalty": "Pénalité de fréquence",
	"Repeat penalty": "Pénalité de répétition",
	"Other parameters": "Autres paramètres",
	"Thinking budget": "Budget de réflexion",
	"not set": "non réglé",
	"Budget saved, but Prism does not know which request field this server reads it from, so it is not sent. Set compat.thinkingTokenBudgetField in models.json.":
		"Budget enregistré, mais Prism ne sait pas dans quel champ de requête ce serveur le lit : il n'est donc pas envoyé. Réglez compat.thinkingTokenBudgetField dans models.json.",
	"Type a name.": "Tapez un nom.",
	"Response cut off by an output limit: Max output in /model-settings, the server's own limit, or the room left in the context (/compact frees some). Raise it, then ask the model to continue.":
		"Réponse coupée par une limite de sortie : Sortie max. dans /model-settings, la limite du serveur, ou la place restante dans le contexte (/compact en libère). Augmentez-la, puis demandez au modèle de continuer.",
	'Type a JSON object, for example {"seed": 42}.': 'Tapez un objet JSON, par exemple {"seed": 42}.',
	"it has its own row.": "il a sa propre ligne.",
	yes: "oui",
	no: "non",
	unlimited: "illimitée",
	"not sent": "non envoyé",
	"not reported": "non indiqué",
	server: "serveur",
	"your correction": "votre correction",
	"new value for Prism": "nouvelle valeur pour Prism",
	"empty: remove your correction": "vide : retirer votre correction",
	"Type yes or no.": "Tapez oui ou non.",
	"Type a number.": "Tapez un nombre.",
	"Type a whole number.": "Tapez un nombre entier.",
	"Type a number above 0.": "Tapez un nombre supérieur à 0.",
	"No model selected. Choose one with /model.": "Aucun modèle choisi. Choisissez-en un avec /model.",
	"{0} is configured. Prism has not contacted it yet: your first message shows whether it answers. You can connect another model now or later with /login.":
		"{0} est configuré. Prism ne l’a pas encore contacté : votre premier message montrera s’il répond. Vous pouvez connecter un autre modèle maintenant ou plus tard avec /login.",
	Automatic: "Automatique",
	Broad: "Large",
	Browser: "Navigateur",
	"Colours of the interface. You see each one as you move.":
		"Couleurs de l'interface. Chacune s'affiche quand vous passez dessus.",
	"Connect a model now": "Connecter un modèle maintenant",
	"Connect a model with /login.": "Connectez un modèle avec /login.",
	"Connect another model now": "Connecter un autre modèle maintenant",
	Continue: "Continuer",
	Dark: "Sombre",
	Display: "Affichage",
	"Enter turns a module on or off. Changes apply when onboarding finishes, or at the next start during first-run setup. Every module is in /settings › Modules.":
		"Entrée active ou coupe un module. Les changements s'appliquent à la fin de l'onboarding ou au prochain démarrage lors de la première configuration. Tous les modules sont dans /settings › Modules.",
	"Go through the first-start choices again: language, theme, permissions, modules, model":
		"Refaire les choix du premier démarrage : langue, thème, permissions, modules, modèle",
	"How much technical detail Prism shows. You can switch at any time in /settings.":
		"Quantité de détails techniques affichés. Modifiable à tout moment dans /settings.",
	"Keep this model": "Garder ce modèle",
	Later: "Plus tard",
	Light: "Clair",
	Memory: "Mémoire",
	"Module changes apply at the next start.": "Les changements de modules s'appliqueront au prochain démarrage.",
	"Optional modules": "Modules facultatifs",
	"Prism needs a model: a server on this computer or your network, a subscription or an API key.":
		"Prism a besoin d'un modèle : un serveur sur cet ordinateur ou votre réseau, un abonnement ou une clé d'API.",
	"Read only": "Lecture seule",
	"Run /onboarding to go through these choices again.": "/onboarding permet de refaire ces choix.",
	"Step {0} of {1}": "Étape {0} sur {1}",
	"{0}–{1} of {2}": "{0}–{1} sur {2}",
	"Terminal colours": "Couleurs du terminal",
	"The language of Prism's own interface. The model answers in the language you write in.":
		"La langue de l'interface de Prism. Le modèle répond dans la langue où vous écrivez.",
	"The onboarding needs the interactive interface.": "L'accueil guidé demande l'interface interactive.",
	"Welcome to Prism": "Bienvenue dans Prism",
	"What the model may do without asking you first. Except in Unrestricted, the commands it runs are shut in a sandbox, an enclosure that keeps them in the project and away from your other files. Change it later with /perm or alt+m.":
		"Ce que le modèle peut faire sans vous demander. Sauf en mode Sans limite, les commandes qu'il lance sont enfermées dans une sandbox, un enclos qui les garde dans le projet, loin de vos autres fichiers. Modifiable ensuite avec /perm ou alt+m.",
	back: "retour",
	"code diagnostics from the servers installed for a project":
		"diagnostics du code par les serveurs installés pour un projet",
	"use your own browser, in tabs of its own (Prism extension)":
		"utilise votre propre navigateur, dans ses propres onglets (extension Prism)",
	"enter: choose": "entrée : choisir",
	"esc: skip the rest": "échap : passer la suite",
	// Login model checklist
	"Models from {0}": "Modèles proposés par {0}",
	"Checked models appear in /model; recent ones are checked. Change this later with /scoped-models.":
		"Les modèles cochés apparaissent dans /model ; les récents sont cochés. Modifiable plus tard avec /scoped-models.",
	"{0} of {1} models": "{0} modèles sur {1}",
	// fork: a model's corrections in /settings > Models (settings-model-page.ts).
	"current · {0} changes": "actuel · {0} modifications",
	"{0} changes": "{0} modifications",
	Save: "Enregistrer",
	"enter: check or save": "entrée : cocher ou enregistrer",
	"esc: keep all": "échap : tout garder",
	deprecated: "obsolète",
	"nothing asks, not even dangerous actions": "rien ne demande, même les actions dangereuses",
	"No confirmation for anything, including deleting files, sudo and writes outside the project. After this setup, a warning says what it allows, and the mode applies only if you accept it there.":
		"Aucune confirmation, y compris pour supprimer des fichiers, sudo et les écritures hors du projet. Après cette configuration, un avertissement dit ce qu’il permet, et le mode ne s’applique que si vous l’y acceptez.",
	"MCP servers": "Serveurs MCP",
	"tools from the servers listed in mcp.json": "outils des serveurs listés dans mcp.json",
	"the model plans and only reads until you approve": "le modèle planifie et ne fait que lire jusqu’à votre accord",
	"Goal mode": "Mode Objectif",
	"a goal the model keeps working towards across turns": "un objectif que le modèle poursuit d’un tour à l’autre",
	"A language server is a program that knows one programming language, such as Python or TypeScript. When one is installed for the project, the model sees the errors it finds while editing the code.":
		"Un serveur de langage est un programme qui connaît un langage de programmation, comme Python ou TypeScript. Quand il y en a un d'installé pour le projet, le modèle voit les erreurs qu'il trouve pendant qu'il modifie le code.",
	"MCP is a common way of giving an AI more tools: a server can connect it to a service such as GitHub or a database. Prism uses only the servers you add, with /mcp add or in mcp.json; with none, the model gets no extra tool.":
		"MCP est une façon courante de donner plus d'outils à une IA : un serveur peut la relier à un service comme GitHub ou une base de données. Prism n'utilise que les serveurs que vous ajoutez, avec /mcp add ou dans mcp.json ; sans eux, le modèle n'a aucun outil en plus.",
	"Give a goal with /goal followed by what you want: the model keeps working on it, turn after turn, without you writing again, until it is reached. /goal pause stops it.":
		"Donnez un objectif avec /goal suivi de ce que vous voulez : le modèle y travaille tour après tour, sans que vous ayez à réécrire, jusqu'à ce qu'il soit atteint. /goal pause l'arrête.",
	Checkpoints: "Points de restauration",
	"file snapshots before edits, to roll back": "copies des fichiers avant modification, pour revenir en arrière",
	"when the model finishes or waits for you": "quand le modèle a fini ou vous attend",
	"from the system language": "d'après la langue du système",
	"light or dark, like the terminal": "clair ou sombre, comme le terminal",
	"notes the model keeps between sessions": "notes que le modèle garde d'une session à l'autre",
	"opens /login": "ouvre /login",
	"ordinary actions run without asking; dangerous ones still ask":
		"les actions ordinaires passent sans demander ; les dangereuses demandent toujours",
	"plain words, fewer technical messages": "mots simples, moins de messages techniques",
	"reading and safe commands run; edits and other commands ask":
		"lectures et commandes sûres passent ; modifications et autres commandes demandent",
	"search and read pages; works without a key (Exa)": "chercher et lire des pages ; fonctionne sans clé (Exa)",
	"the model reads and searches; anything else is blocked": "le modèle lit et cherche ; tout le reste est bloqué",
	"token counts, raw statuses and full details": "nombres de tokens, états bruts et détails complets",
	"uses the terminal's own palette": "reprend la palette du terminal",
	"with /login": "avec /login",
	"Tool calls": "Appels d'outils",
	"Last turn": "Dernier tour",
	interrupted: "interrompu",
	error: "erreur",
	completed: "terminé",
	"Interrupted tool calls": "Appels d'outils interrompus",
	"interrupted; no result recorded": "interrompu ; aucun résultat enregistré",
	"Running background tasks": "Tâches en arrière-plan en cours",
	"Available checkpoints": "Points de restauration disponibles",
	"module off": "module coupé",
	"turn {0}": "tour {0}",
	"Ask the model to re-run a tool, or use /undo if this turn has checkpoints.":
		"Demandez au modèle de relancer un outil, ou utilisez /undo si ce tour a des points de restauration.",
	"tool calls are turned off in /model-settings": "les appels d'outils sont coupés dans /model-settings",
	"its server says it does not support tool calls": "son serveur indique qu'il ne gère pas les appels d'outils",
	"Prism replies without tools (no reading, editing or commands) while this model is selected.":
		"Prism répond sans outils (ni lecture, ni modification, ni commande) tant que ce modèle est choisi.",
	"images are turned off for this model in /model-settings":
		"les images sont coupées pour ce modèle dans /model-settings",
	"this model's server says it does not accept images":
		"le serveur de ce modèle indique qu'il n'accepte pas les images",
	"The image is not sent; the model gets a note that it was left out.":
		"L'image n'est pas envoyée ; le modèle reçoit une note qui le signale.",
	images: "les images",
	"tool calls": "les appels d'outils",
	thinking: "la réflexion",
	"This provider does not report its settings: only Prism's values are shown.":
		"Ce fournisseur n'indique pas ses réglages : seules les valeurs de Prism sont affichées.",

	// Tool state and setting descriptions (prism/transcript.ts, settings-view.ts)
	failed: "échec",
	stopped: "arrêté",
	"timed out": "délai dépassé",
	stopping: "arrêt en cours",
	Why: "Pourquoi",

	// Startup notes and notices (prism/header.ts, prism/notices.ts, prism/editor.ts)
	Warning: "Avertissement",
	Error: "Erreur",
	"for details": "pour les détails",
	"context file": "fichier de contexte",
	"context files": "fichiers de contexte",
	skill: "skill",
	skills: "skills",
	prompt: "prompt",
	prompts: "prompts",
	extension: "extension",
	extensions: "extensions",
	Help: "Aide",
	"Most frequent first. Type to filter; Enter on a command puts it in the editor.":
		"Les plus utilisés d'abord. Tapez pour filtrer ; Entrée sur une commande la met dans la saisie.",
	"  Type to filter · Enter to select · Esc to go back":
		"  Tapez pour filtrer · Entrée pour choisir · Échap pour revenir",
	"Auto-compact threshold": "Seuil du résumé automatique",
	Default: "Par défaut",

	// Menu key hints, as the default key bindings show them (prism/dialogs.ts)
	"↑↓ navigate  enter select  escape/ctrl+c cancel": "↑↓ bouger  Entrée choisir  Échap/ctrl+c annuler",
	"Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel":
		"Entrée pour choisir · Ctrl+S par défaut · Échap/Ctrl+C pour annuler",

	// Permission dialog (permissions.ts); the reason sent to the model stays in English
	"Allow once": "Autoriser une fois",
	"Block this action once": "Bloquer cette action une fois",
	"change the project's files": "modifier les fichiers du projet",
	"Allowed or blocked in this project": "Autorisé ou bloqué dans ce projet",
	"Allow this action in this session": "Autoriser cette action dans cette session",
	"Nothing was allowed. Choose again.": "Rien n'a été autorisé. Choisissez à nouveau.",
	"What you allowed or blocked for this project when asked. It comes back in every session on this folder; it is kept in Prism's folder, not in the project. Enter on one takes it back.":
		"Ce que vous avez autorisé ou bloqué pour ce projet quand Prism vous l'a demandé. Cela vaut pour chaque session dans ce dossier ; c'est gardé dans le dossier de Prism, pas dans le projet. Entrée sur une ligne la retire.",
	"Enter on one takes it back. Hosts for every project are in Allowed hosts.":
		"Entrée sur une ligne la retire. Les hôtes autorisés pour tous les projets sont dans Hôtes autorisés.",
	"Block for this command": "Bloquer pour cette commande",
	"No hooks there yet.": "Aucun hook pour l'instant.",
	"Risk: Git outside Prism (your terminal, your editor) runs these hooks without the sandbox, with your rights.":
		"Risque : Git hors de Prism (votre terminal, votre éditeur) exécute ces hooks sans la sandbox, avec vos droits.",
	"What the hooks call (npm scripts, node_modules, other project files) stays writable by sandboxed commands.":
		"Ce que les hooks appellent (scripts npm, node_modules, autres fichiers du projet) reste modifiable par les commandes de la sandbox.",
	"Apply this hooks folder": "Appliquer ce dossier de hooks",
	"Do not apply it": "Ne pas l'appliquer",
	"A command changed the Git configuration of {0}:": "Une commande a modifié la configuration Git de {0} :",
	"Risk: Git outside Prism (your terminal, your editor) uses these remotes with your credentials, without the sandbox: a later git push sends your code there, and a forced or deleting refspec overwrites or removes branches on the server.":
		"Risque : Git hors de Prism (votre terminal, votre éditeur) utilise ces remotes avec vos identifiants, sans la sandbox : un git push ultérieur y envoie votre code, et une refspec forcée ou de suppression écrase ou supprime des branches sur le serveur.",
	"Your next commits outside Prism will carry this name or e-mail address.":
		"Vos prochains commits hors de Prism porteront ce nom ou cette adresse e-mail.",
	"Apply these Git changes": "Appliquer ces changements Git",
	"Do not apply them": "Ne pas les appliquer",
	"Show the whole command first": "Voir d'abord la commande entière",
	"A rule for this session allows or blocks; it cannot ask.":
		"Une règle de session autorise ou bloque ; elle ne peut pas demander.",
	"This project is not trusted: its permission rules are not read.":
		"Ce projet n'est pas approuvé : ses règles de permissions ne sont pas lues.",
	"This permission has already ended.": "Cette autorisation a déjà pris fin.",
	"Background tasks are off.": "Les tâches de fond sont désactivées.",
	"Only the project's files and the files Prism produced can be opened here.":
		"Seuls les fichiers du projet et ceux produits par Prism peuvent être ouverts ici.",
	"No such task: {0}": "Aucune tâche {0}.",
	"The whole command, as it would run (changes here are ignored)":
		"La commande entière, telle qu'elle s'exécuterait (les modifications ici sont ignorées)",
	"{0} is not a valid permissions file: {1}. Until it is fixed, every tool call is refused, so that its deny rules cannot be lost. Fix the file, or remove it to start from the defaults.":
		"{0} n'est pas un fichier de permissions valide : {1}. Tant qu'il n'est pas corrigé, tout appel d'outil est refusé, pour que ses règles de refus ne soient pas perdues. Corrigez le fichier, ou supprimez-le pour repartir des valeurs par défaut.",
	"{0} is not a valid permissions file any more. Its last valid version still applies; a rule saved from a question is refused until the file is fixed.":
		"{0} n'est plus un fichier de permissions valide. Sa dernière version valide s'applique toujours ; une règle enregistrée depuis une question est refusée tant que le fichier n'est pas corrigé.",
	"{0} is not a valid permissions file ({1}). Fix it, then retry.":
		"{0} n'est pas un fichier de permissions valide ({1}). Corrigez-le, puis réessayez.",
	"Allowing it lets this run connect to them; other hosts are asked about.":
		"L'autoriser lui permet de s'y connecter pendant cette exécution ; les autres hôtes sont demandés.",
	"(no target)": "(pas de cible)",
	"This action needs your permission.": "Cette action demande votre accord.",
	"write inside project": "écriture dans le projet",
	"write outside project": "écriture hors du projet",
	"write in the session's /tmp": "écriture dans le /tmp de la session",
	"no path provided": "aucun chemin indiqué",
	"custom/extension tool": "outil d'une extension",
	"Prism config or credential file": "fichier de configuration ou d'identifiants de Prism",
	"rm with -r/-f flags": "rm avec -r/-f",
	// what a tool declares it does, in the permission question
	"network access": "accès à internet",
	"uses a browser or a desktop": "utilise un navigateur ou un bureau",
	"runs a program": "lance un programme",
	"writes files": "écrit des fichiers",
	"administrator rights": "droits administrateur",
	"changes Prism's security settings": "modifie les réglages de sécurité de Prism",
	"tool that declares no permissions": "outil qui ne déclare pas ses permissions",

	// /perm window
	"what the model may do without asking you": "ce que le modèle peut faire sans vous demander",
	Mode: "Mode",
	Safe: "Prudent",
	Unrestricted: "Sans limite",
	"Read the project's files": "Lire les fichiers du projet",
	"Read files outside the project": "Lire hors du projet",
	"read {0}": "lire {0}",
	"read outside the project": "lecture hors du projet",
	"Change the project's files": "Modifier les fichiers du projet",
	"Change files outside the project": "Modifier hors du projet",
	"Prism's security settings": "Réglages de sécurité de Prism",
	"Safe commands (ls, git status…)": "Commandes sûres (ls, git status…)",
	"Other commands": "Autres commandes",
	Internet: "Internet",
	"Use a browser or a desktop": "Utiliser un navigateur ou un bureau",
	"Administrator rights (sudo)": "Droits administrateur (sudo)",
	"Add-on tools that declare nothing": "Outils de modules non déclarés",
	"without asking": "sans demander",
	asks: "demande",
	"asks, flagged dangerous, never “always”": "demande, signalé dangereux, jamais « toujours »",
	refused: "refusé",
	"Reads and searches freely. Changes no file and runs only safe commands (ls, git status…). Internet: it asks.":
		"Lit et cherche librement. Ne modifie aucun fichier et ne lance que des commandes sûres (ls, git status…). Internet : il demande.",
	"Reads freely. Asks before changing a file, running a command or going on the internet.":
		"Lit librement. Demande avant de modifier un fichier, de lancer une commande ou d'aller sur internet.",
	"Works in the project without asking. Still asks for what leaves the project, sudo and the security settings.":
		"Travaille dans le projet sans demander. Demande encore pour ce qui sort du projet, sudo et les réglages de sécurité.",
	"Asks nothing. Only your block rules apply. Keep it for a throwaway machine or container.":
		"Ne demande rien. Seules vos règles « refuser » s'appliquent. À réserver à une machine ou un conteneur jetable.",
	"Current permissions": "Autorisations en cours",
	"None. They appear when you answer “15 minutes” or “this session” to a question.":
		"Aucune. Elles apparaissent quand vous répondez « 15 minutes » ou « cette session » à une question.",
	Revoke: "Révoquer",
	"this session": "cette session",
	"15 minutes": "15 minutes",
	"Keep this mode as default": "Garder ce mode par défaut",
	"These are not walls: see Help": "Ce ne sont pas des murs : voir Aide",
	"←→ or click: change mode · ↓ permissions · alt+m from the editor · Esc or click outside: close":
		"←→ ou clic : changer de mode · ↓ autorisations · alt+m depuis l'éditeur · Échap ou clic dehors : fermer",
	"↑↓ move · Enter or click: revoke · Esc close": "↑↓ bouger · Entrée ou clic : révoquer · Échap fermer",
	"←→ move · Enter open · ↑ back · Esc close": "←→ bouger · Entrée ouvrir · ↑ revenir · Échap fermer",
	"Permission system — help": "Permissions — aide",
	"Unrestricted mode not enabled.": "Mode sans limite non activé.",
	"Unrestricted mode: no confirmation for anything, including rm -rf, sudo, writes outside the project. Configuration uses configure_prism; security settings are user-only. This is not a sandbox: the agent can do anything your user account can, including reading auth.json and your other files. Only explicit deny rules still apply.":
		"Mode sans limite : aucune confirmation pour quoi que ce soit, y compris rm -rf, sudo et les écritures hors du projet. La configuration passe par configure_prism ; les réglages de sécurité restent réservés à l’utilisateur. Ce n’est pas une sandbox : l’agent peut faire tout ce que votre compte utilisateur peut faire, y compris lire auth.json et vos autres fichiers. Seules les règles de blocage explicites s’appliquent encore.",
	"Enable unrestricted mode": "Activer le mode sans limite",
	"Mode: {0}": "Mode : {0}",
	"This session, allowed: {0}": "Cette session, autorisé : {0}",
	"This session, blocked: {0}": "Cette session, bloqué : {0}",
	"For {0} minutes: {1}": "Pendant {0} minutes : {1}",
	"Saved, allowed: {0}": "Enregistré, autorisé : {0}",
	"Saved, asks: {0}": "Enregistré, demande : {0}",
	"Saved, blocked: {0}": "Enregistré, bloqué : {0}",
	"Protected paths: {0}": "Chemins protégés : {0}",
	"Default mode: {0}": "Mode par défaut : {0}",
	"Every project: {0}": "Tous les projets : {0}",
	"This project: {0}": "Ce projet : {0}",
	"This project: {0} (not read: the project is not trusted)":
		"Ce projet : {0} (non lu : le projet n’est pas approuvé)",
	"Permissions & sandbox in /settings: mode, rules, protected paths, sandbox":
		"Permissions et sandbox dans /settings : mode, règles, chemins protégés, sandbox",
	"window: modes, what each allows, current permissions, rules, help (alt+m cycles the mode)":
		"fenêtre : modes, ce que chacun permet, permissions en vigueur, règles, aide (alt+m change de mode)",
	status: "état",
	"task scope: set one for the next task, or end the one in effect":
		"périmètre de tâche : en fixer un pour la prochaine tâche, ou terminer celui en vigueur",
	"set mode for this session": "choisir le mode de cette session",
	"set the default mode (global config)": "choisir le mode par défaut (configuration globale)",
	"session-only allow rule": "règle d’autorisation pour cette session seulement",
	"session-only deny rule": "règle de blocage pour cette session seulement",
	"save permission for matching actions in this trusted project, otherwise globally; -g always saves globally":
		"enregistrer une autorisation pour les actions correspondantes dans ce projet approuvé, sinon pour tous les projets ; -g enregistre toujours pour tous les projets",
	"save a block rule for matching actions in this trusted project, otherwise globally; -g always saves globally":
		"enregistrer une règle de blocage pour les actions correspondantes dans ce projet approuvé, sinon pour tous les projets ; -g enregistre toujours pour tous les projets",
	"saved rules, in /settings": "règles enregistrées, dans /settings",
	"clear session and 15-minute permissions": "effacer les permissions de la session et celles de 15 minutes",
	Modes: "Modes",
	'"yolo" is accepted as the former name of broad.': "« yolo » est accepté comme ancien nom de broad.",
	"Rule syntax: `tool` or `tool(glob)`. A glob is a matching pattern: `*` matches text; in file paths it stays in one folder, while `**` includes subfolders. Examples: `bash(npm run test*)`, `write(src/**)`.":
		"Syntaxe d’une règle : `outil` ou `outil(motif)`. Un motif (glob) décrit des noms : `*` remplace du texte ; dans un chemin de fichier, il reste dans un seul dossier, tandis que `**` inclut les sous-dossiers. Exemples : `bash(npm run test*)`, `write(src/**)`.",
	"Saved in `{0}` for every project, and in `{1}` for a project.":
		"Enregistrées dans `{0}` pour tous les projets, et dans `{1}` pour un projet.",
	"These rules check action patterns. They are not a sandbox (an isolated environment that limits access to your computer).":
		"Ces règles vérifient des modèles d’action. Elles ne sont pas une sandbox (un environnement isolé qui limite l’accès à votre ordinateur).",
	"A command you allow can access anything your user account can access, including auth.json, which stores sign-in details. These rules do not isolate your secrets from the agent.":
		"Une commande que vous autorisez peut accéder à tout ce que votre compte utilisateur peut atteindre, y compris auth.json, qui contient vos identifiants de connexion. Ces règles n’isolent pas vos secrets de l’agent.",

	// /docs (docs-command.ts)
	"Read Prism's documentation: /docs, or /docs <topic>": "Lire la documentation de Prism : /docs, ou /docs <sujet>",
	Documentation: "Documentation",
	"↑↓ scroll · PgUp/PgDn page · Home/End top/bottom · Esc back":
		"↑↓ défiler · PgUp/PgDn page · Début/Fin haut/bas · Échap revenir",
	"  Type to search titles and pages · Enter to open · Esc to close":
		"  Tapez pour chercher dans les titres et les pages · Entrée pour ouvrir · Échap pour fermer",
	"↑↓ scroll · PgUp/PgDn page · Home/End top/bottom · Esc close":
		"↑↓ défiler · PgUp/PgDn page · Début/Fin haut/bas · Échap fermer",
	"Type to search this page": "Tapez pour chercher dans cette page",
	"Enter next · Shift+Enter previous · Esc clear": "Entrée suivant · Maj+Entrée précédent · Échap effacer",
	"Enter next · Shift+Enter previous · Esc back": "Entrée suivant · Maj+Entrée précédent · Échap retour",
	"Enter next · Shift+Enter previous · Esc close": "Entrée suivant · Maj+Entrée précédent · Échap fermer",
	"The documentation is not installed with this build.": "La documentation n'est pas installée avec cette version.",

	// Status messages (interactive-mode.ts)
	"Already at this point": "Vous êtes déjà à ce point",
	"Branch summarization cancelled": "Résumé de la branche annulé",
	"Cloned to new session": "Copiée dans une nouvelle session",
	"Close active overlays before changing TUI mode": "Fermez les fenêtres ouvertes avant de changer d'affichage",
	"Copied last agent message to clipboard": "Dernière réponse de l'agent copiée",
	"Copied selected message to clipboard": "Message choisi copié",
	"Current model does not support thinking": "Ce modèle ne prend pas en charge la réflexion",
	"If it does, set Thinking to yes in /model-settings.":
		"S'il la prend en charge, mettez Réflexion à oui dans /model-settings.",
	"Forked to new session": "Nouvelle branche dans une nouvelle session",
	"Import cancelled": "Import annulé",
	"Model selection saved to settings": "Choix du modèle enregistré dans les réglages",
	"Navigated to selected point": "Retour au point choisi",
	"Navigation cancelled": "Déplacement annulé",
	"No entries in session": "Session vide",
	"No login methods available.": "Aucune méthode de connexion disponible.",
	"How would you like to connect?": "Comment voulez-vous vous connecter ?",
	// fork: /scoped-models; slots are filled at the call site.
	"Model Configuration": "Modèles parcourus",
	"Session-only. {0} to save to settings.": "Pour cette session seulement. {0} pour l'enregistrer dans les réglages.",
	"all enabled": "tous activés",
	"{0}/{1} enabled": "{0} sur {1} activés",
	" · {0} unavailable": " · {0} indisponibles",
	"{0} toggle": "{0} activer/désactiver",
	"{0} all": "{0} tous",
	"{0} clear": "{0} aucun",
	"{0} provider": "{0} fournisseur",
	"{0} reorder": "{0} déplacer",
	"{0} save": "{0} enregistrer",
	"(unsaved)": "(non enregistré)",
	"  Model Name: {0}": "  Nom du modèle : {0}",
	"  Model unavailable": "  Modèle indisponible",
	// /settings in the Prism window.
	Open: "Ouvrir",
	"Type a value.": "Tapez une valeur.",
	// /scoped-models in the Prism window.
	"Checked models are the ones Ctrl+P cycles through, in this order. Each change applies to this session; Save keeps it.":
		"Ctrl+P parcourt les modèles cochés, dans cet ordre. Chaque changement vaut pour cette session ; Enregistrer le garde.",
	"Enable all": "Tout activer",
	"Clear all": "Tout désactiver",
	"All of {0} on or off": "Tous les modèles de {0} activés ou non",
	"Change the order": "Changer l'ordre",
	"The order Ctrl+P cycles through the checked models.": "L'ordre dans lequel Ctrl+P parcourt les modèles cochés.",
	"Save to settings": "Enregistrer dans les réglages",
	"/scoped-models opens in the terminal or the Prism window.":
		"/scoped-models s'ouvre dans le terminal ou la fenêtre Prism.",
	// /login and /logout in the Prism window (login-native.ts).
	"/login opens in the terminal or the Prism window.": "/login s'ouvre dans le terminal ou la fenêtre Prism.",
	"/logout opens in the terminal or the Prism window.": "/logout s'ouvre dans le terminal ou la fenêtre Prism.",
	"Waiting for authentication...": "En attente de l'authentification…",
	"This sign-in goes through a web browser on the computer. Run /login there; an API key can be saved from here.":
		"Cette connexion passe par un navigateur web sur l'ordinateur. Lancez /login là-bas ; une clé d'API peut être enregistrée d'ici.",
	"Keep all models": "Garder tous les modèles",
	Logout: "Déconnexion",
	// fork: /doctor, compaction and /sent strings found by the French walkthrough.
	"Configured server URL appears local.": "L'URL du serveur configurée semble locale.",
	"Configured server URL appears to be cloud-hosted.": "L'URL du serveur configurée semble hébergée dans le cloud.",
	"Server location could not be determined from a configured base URL.":
		"L'emplacement du serveur n'a pas pu être déduit d'une URL configurée.",
	"The conversation is too short to summarize yet.": "La conversation est encore trop courte pour être résumée.",
	"↑↓ scroll · PgUp/PgDn page · Esc close": "↑↓ défiler · PgUp/PgDn page · Échap fermer",
	// fork: /hotkeys.
	"Keyboard Shortcuts": "Raccourcis clavier",
	Navigation: "Navigation",
	Editing: "Édition",
	Key: "Touche",
	"Move cursor / browse history": "Déplacer le curseur / parcourir l'historique",
	"Jump forward to character": "Aller au caractère suivant tapé",
	"Jump backward to character": "Revenir au caractère précédent tapé",
	"Send message": "Envoyer le message",
	"New line": "Nouvelle ligne",
	"Delete word backwards": "Effacer le mot précédent",
	"Delete word forwards": "Effacer le mot suivant",
	"Delete to start of line": "Effacer jusqu'au début de la ligne",
	"Delete to end of line": "Effacer jusqu'à la fin de la ligne",
	"Cycle through the deleted text after pasting": "Après un collage, parcourir les textes effacés",
	Undo: "Annuler",
	"Path completion / accept autocomplete": "Compléter un chemin / accepter la suggestion",
	"Cancel autocomplete / abort streaming": "Fermer les suggestions / interrompre la réponse",
	"Clear editor (first) / exit (second)": "Vider la saisie (1re fois) / quitter (2e fois)",
	"Exit (when editor is empty)": "Quitter (saisie vide)",
	"Suspend to background": "Mettre en pause et revenir au shell",
	"Cycle thinking level": "Changer de niveau de réflexion",
	"Cycle models": "Passer d'un modèle à l'autre",
	"Open model selector": "Choisir le modèle",
	"Toggle tool output expansion": "Déplier ou replier les sorties d'outils",
	"Toggle thinking block visibility": "Afficher ou masquer la réflexion",
	"Edit message in external editor": "Écrire le message dans un éditeur externe",
	"Copy selection or last assistant message": "Copier la sélection ou la dernière réponse",
	"Queue follow-up message": "Mettre un message en attente",
	"Restore queued messages": "Reprendre les messages en attente",
	"Paste {0} from clipboard": "Coller {0} depuis le presse-papiers",
	"Slash commands": "Commandes",
	"Run bash command": "Lancer une commande bash",
	"Run bash command (excluded from context)": "Lancer une commande bash (hors du contexte)",
	"Toggle Plan mode": "Activer ou couper le mode plan",
	"Cycle the permission mode": "Changer de mode de permissions",
	"Connect a compatible server (URL)": "Connecter un serveur compatible (URL)",
	"Connect a compatible server": "Connecter un serveur compatible",
	"Sign in with an account": "Se connecter avec un compte",
	"Use an API key (an access key from the service)": "Utiliser une clé d’API (une clé d’accès fournie par le service)",
	"No messages to fork from": "Aucun message depuis lequel créer une branche",
	"No queued messages to restore": "Aucun message en attente à reprendre",
	"Nothing to clone yet": "Rien à dupliquer pour l'instant",
	"Queued message for after compaction": "Message en attente jusqu'à la fin du résumé",
	"Refreshing model catalogs…": "Mise à jour des listes de modèles…",
	"Resume cancelled": "Reprise annulée",
	"Resumed session": "Session reprise",
	"Resumed session in current cwd": "Session reprise dans le dossier actuel",
	"Startup is still in progress": "Le démarrage n'est pas fini",
	"Suspend to background is not supported on Windows": "La mise en pause n'est pas possible sous Windows",
	"Compaction cancelled": "Résumé annulé",
	"No agent messages to copy yet.": "Aucune réponse de l'agent à copier pour l'instant.",
	"Selected entry has no text to copy": "Cet élément n'a pas de texte à copier",
	"Usage: /import <path.jsonl>": "Utilisation : /import <chemin.jsonl>",
	"A bash command is already running. Press Esc to cancel it first.":
		"Une commande bash tourne déjà. Appuyez sur Échap pour l'annuler d'abord.",
	"Model refresh timed out; searching cached models.":
		"La mise à jour des modèles a pris trop de temps ; recherche dans les modèles en cache.",
	"Usage: /name <name>": "Utilisation : /name <nom>",
	"Wait for compaction to finish before reloading.": "Attendez la fin du résumé avant de recharger.",
	"Wait for the current response to finish before reloading.": "Attendez la fin de la réponse avant de recharger.",
	"1 configured": "1 configuré",
	// fork: the editor's bar, the footer and the thinking label.
	plan: "plan",
	goal: "objectif",
	files: "fichiers",
	safe: "prudent",
	ask: "demander",
	broad: "large",
	unrestricted: "sans limite",
	"safe (read-only)": "prudent (lecture seule)",
	sub: "abo",
	"Thinking…": "Réflexion…",
	"Thinking...": "Réflexion…",
	Thought: "Réflexion",
	disabled: "désactivé",
	tree: "arbre",
	fork: "bifurcation",
	configure: "configurer",
	// fork: the /settings window, and what each choice of a setting does (settings-descriptions.ts).
	on: "activé",
	true: "oui",
	false: "non",
	French: "Français",
	"Search a setting…": "Chercher un réglage…",
	"{0} settings": "{0} réglages",
	"{0} of {1} settings": "{0} réglages sur {1}",
	"Search: {0}": "Recherche : {0}",
	"{0} settings found": "{0} réglages trouvés",
	"No setting matches.": "Aucun réglage ne correspond.",
	"No MCP servers yet.": "Aucun serveur MCP pour l'instant.",
	Task: "Tâche",
	"{0}: background task ended": "{0} : tâche de fond terminée",
	"in the background": "en arrière-plan",
	"Started in the background ({0}): its answer will follow.": "Lancé en arrière-plan ({0}) : sa réponse suivra.",
	"{0} answered ({1})": "{0} a répondu ({1})",
	"{0} failed ({1})": "{0} a échoué ({1})",
	"{0} stopped ({1})": "{0} arrêté ({1})",
	"The user stopped this agent before it answered.": "Arrêté par l'utilisateur avant sa réponse.",
	"This agent has already ended.": "Cet agent a déjà fini.",
	"■ Stop {0} ({1}) · {2}": "■ Arrêter {0} ({1}) · {2}",
	"Stop {0}?": "Arrêter {0} ?",
	"It stops before it answers. What it already did stays, and the model is told it was stopped.":
		"Il s'arrête avant de répondre. Ce qu'il a déjà fait reste, et le modèle apprend qu'il a été arrêté.",
	"{0} step": "{0} étape",
	"{0} steps": "{0} étapes",
	"… {0} earlier steps": "… {0} étapes précédentes",
	"Uses the Claude Code program installed on this computer, with your Claude subscription, as a model provider.":
		"Utilise le programme Claude Code installé sur cet ordinateur, avec votre abonnement Claude, comme fournisseur de modèles.",
	"Module: {0}.": "Module : {0}.",
	"Claude Code subscription": "Abonnement Claude Code",
	"Tool scripts (codemode)": "Scripts d'outils (codemode)",
	"Tool search": "Recherche d'outils",
	"Session limits (budgets)": "Limites de session (budgets)",
	"Files panel": "Panneau des fichiers",
	"Language server suggestions": "Suggestions de serveurs de langage",
	"Project documents (/init)": "Documents du projet (/init)",
	"Undo file changes (checkpoints)": "Points de restauration (annuler)",
	"Background commands": "Commandes en arrière-plan",
	"Memory across sessions": "Mémoire entre les sessions",
	"Where a session stopped": "Où une session s'est arrêtée",
	"Extra instructions (APPEND_SYSTEM.md)": "Instructions supplémentaires (APPEND_SYSTEM.md)",
	"Custom agents": "Agents personnalisés",
	"Export as a zip": "Export en zip",
	"Tables, charts and forms": "Tableaux, graphiques et formulaires",
	"Settings changed by the model": "Réglages modifiés par le modèle",
	"Code checks (language servers)": "Vérification du code (serveurs de langage)",
	"Context inspector": "Inspecteur de contexte",
	"Questions from the model": "Questions du modèle",
	"Model capability checks": "Vérification des capacités du modèle",
	"Prism's look": "Apparence de Prism",
	"from the {0} mcp.json": "du mcp.json {0}",
	"Add a server": "Ajouter un serveur",
	"a command or an address, without editing mcp.json": "une commande ou une adresse, sans modifier mcp.json",
	"A program on this computer (a command)": "Un programme sur cet ordinateur (une commande)",
	"A web address (URL)": "Une adresse web (URL)",
	"Add an MCP server: how is it reached?": "Ajouter un serveur MCP : comment le joindre ?",
	"Server name (letters, digits, - and _)": "Nom du serveur (lettres, chiffres, - et _)",
	"Use only letters, digits, - and _ in the name.": "N'utilisez que des lettres, des chiffres, - et _ dans le nom.",
	"Command that starts the server": "Commande qui démarre le serveur",
	"Type the command, with its arguments.": "Tapez la commande, avec ses arguments.",
	"Environment variables it needs, as NAME=value (optional: leave empty for none)":
		"Variables d'environnement nécessaires, en NOM=valeur (facultatif : laissez vide s'il n'y en a pas)",
	"Write each variable as NAME=value.": "Écrivez chaque variable en NOM=valeur.",
	"Server address": "Adresse du serveur",
	"Type an address that starts with https:// or http://.": "Tapez une adresse qui commence par https:// ou http://.",
	"No key: sign in in the browser if the server asks":
		"Pas de clé : se connecter dans le navigateur si le serveur le demande",
	"A key read from an environment variable": "Une clé lue dans une variable d'environnement",
	"How does Prism prove who you are?": "Comment Prism prouve-t-il qui vous êtes ?",
	"Name of the environment variable that holds the key": "Nom de la variable d'environnement qui contient la clé",
	"Use the variable's name, such as DOCS_TOKEN.": "Indiquez le nom de la variable, par exemple DOCS_TOKEN.",
	"Every project": "Tous les projets",
	"Use this server in": "Utiliser ce serveur dans",
	"Replace this server?": "Remplacer ce serveur ?",
	'"{0}" is already configured there.': "« {0} » y est déjà configuré.",
	'MCP server "{0}" added to {1}. Prism reloads to connect it.':
		"Serveur MCP « {0} » ajouté à {1}. Prism recharge pour le connecter.",
	"Remove this MCP server?": "Retirer ce serveur MCP ?",
	'"{0}" is taken out of {1}.': "« {0} » est retiré de {1}.",
	'MCP server "{0}" removed.': "Serveur MCP « {0} » retiré.",
	"Search results": "Résultats de la recherche",
	"Nothing to set here.": "Rien à régler ici.",
	"↑↓ choose · Enter pick · Esc back": "↑↓ choisir · Entrée valider · Échap retour",
	"↑↓ move · Enter change · Esc back": "↑↓ bouger · Entrée modifier · Échap retour",
	"Type to search · ↓ results · Esc clear": "Tapez pour chercher · ↓ résultats · Échap effacer",
	"↑↓ move · Enter open · / search · Esc close": "↑↓ bouger · Entrée ouvrir · / chercher · Échap fermer",
	"↑↓ move · Enter change · ← back · Esc close": "↑↓ bouger · Entrée modifier · ← retour · Échap fermer",
	"↑↓ move · → or Enter open · / search · Esc or click outside: close":
		"↑↓ bouger · → ou Entrée ouvrir · / chercher · Échap ou clic dehors : fermer",
	"↑↓ move · Enter or click: change · ← domains · / search · Esc: close":
		"↑↓ bouger · Entrée ou clic : modifier · ← domaines · / chercher · Échap : fermer",
	"The language of Prism's menus and messages.": "La langue des menus et des messages de Prism.",
	"Bundled add-ons, each can be turned off, and the web search service. The permission system stays loaded; use /perm to choose its mode.":
		"Les modules fournis, chacun désactivable, et le service de recherche web. Le système de permissions reste chargé ; choisissez son mode avec /perm.",
	"Drawn as soon as they arrive": "Dessinés dès qu'ils arrivent",
	"Drawn once the reply is finished": "Dessinés une fois la réponse terminée",
	"Left as source text": "Laissés en texte",
	"Header, loaded add-ons and tips": "En-tête, modules chargés et astuces",
	"Header only": "L'en-tête seulement",
	Nothing: "Rien",
	"Each message waits for the previous one to be handled": "Chaque message attend que le précédent soit traité",
	"Waiting messages are sent together": "Les messages en attente partent ensemble",
	"Open /tree, the map of the session's branches": "Ouvre /tree, la carte des branches de la session",
	"Pick an earlier message to start a new session from":
		"Choisir un message antérieur d'où repartir dans une nouvelle session",
	"Messages and tool calls": "Messages et appels d'outils",
	"Messages, without tool results": "Messages, sans les résultats d'outils",
	"Only your messages": "Vos messages seulement",
	"Only entries you labelled": "Seulement les entrées que vous avez étiquetées",
	"Everything, settings changes included": "Tout, changements de réglages compris",
	"Its own screen: mouse, scrollbar, menus on top": "Son propre écran : souris, barre de défilement, menus par-dessus",
	"Text in the terminal's own history": "Du texte dans l'historique du terminal",
	"Shown while scrolling": "Affichée pendant le défilement",
	"Always shown": "Toujours affichée",
	"Never shown": "Jamais affichée",
	"Prints the conversation in the terminal": "Affiche la conversation dans le terminal",
	"Prints only how to reopen the session": "Affiche seulement comment rouvrir la session",
	"Further when you spin the wheel quickly": "Plus loin quand la molette tourne vite",
	"Ask the first time a folder is opened": "Demander à la première ouverture d'un dossier",
	"Load its settings and add-ons without asking": "Charger ses réglages et modules sans demander",
	"Ignore its settings and add-ons": "Ignorer ses réglages et modules",
	"The best the service offers": "Le meilleur que le service propose",
	"Updates over plain HTTP": "Mises à jour par simple HTTP",
	"A two-way connection": "Une connexion dans les deux sens",
	"A two-way connection that reuses sent context": "Une connexion dans les deux sens qui réutilise le contexte envoyé",
	"Never cut a silent reply": "Ne jamais couper une réponse silencieuse",
	"No extra requests": "Aucune requête en plus",
	"While the model works": "Pendant que le modèle travaille",
	"Also between tasks, while it saves more than it costs":
		"Aussi entre deux tâches, tant que ça économise plus que ça ne coûte",
	"The language of your latest message": "La langue de votre dernier message",
	"Always English": "Toujours en anglais",
	"Always French": "Toujours en français",
	"The system language": "La langue du système",
	"One line per action, essential settings": "Une ligne par action, les réglages essentiels",
	"Commands, output and every setting": "Commandes, sorties et tous les réglages",
	// Built as `label: value` (the test finds them by their two parts).
	"Thinking blocks: hidden": "Réflexion : cachée",
	"Thinking blocks: visible": "Réflexion : visible",
	"Tool output: expanded": "Sorties d'outils : dépliées",
	"Tool output: collapsed": "Sorties d'outils : repliées",
	// fork: the end-of-turn line (fork/prism/turn-summary.ts).
	"1 tool": "1 outil",
	"1 failure": "1 échec",
	// fork: /tutorial (tutorial.ts) and the onboarding's offer.
	Tutorial: "Tutoriel",
	"First steps": "Premiers pas",
	"Asking well": "Bien demander",
	"Following the work": "Suivre le travail",
	"Plan and goal": "Plan et objectif",
	Sessions: "Sessions",
	"Models and settings": "Modèles et réglages",
	"Working on a project": "Travailler sur un projet",
	"Going further": "Aller plus loin",
	"Write what you want in the box at the bottom and press Enter. The model answers in the chat above; to do it, it may read files and run commands.":
		"Écrivez ce que vous voulez dans la zone du bas, puis appuyez sur Entrée. Le modèle répond dans la conversation au-dessus ; pour cela, il peut lire des fichiers et lancer des commandes.",
	"Each of its actions shows as a line in the chat, so you can follow what it does.":
		"Chacune de ses actions apparaît sur une ligne de la conversation : vous suivez ce qu'il fait.",
	"Press {0} to stop the model at any time. What it already did stays.":
		"Appuyez sur {0} pour arrêter le modèle à tout moment. Ce qu'il a déjà fait reste.",
	"While it works you can still write: {0} adds an instruction it reads at its next step, and {1} takes the last one back to change it.":
		"Pendant qu'il travaille, vous pouvez encore écrire : {0} ajoute une consigne qu'il lit à sa prochaine étape, et {1} reprend la dernière pour la modifier.",
	"Send a request, then stop the answer with {0}.": "Envoyez une demande, puis arrêtez la réponse avec {0}.",
	"A good request says three things: the goal, the context, and how you will know it is done.":
		"Une bonne demande dit trois choses : le but, le contexte, et à quoi vous verrez que c'est fini.",
	"For example: “Add a --verbose flag to src/cli.ts that prints each step; the existing tests must still pass.”":
		"Par exemple : « Ajoute une option --verbose à src/cli.ts qui affiche chaque étape ; les tests existants doivent toujours passer. »",
	"Type @ and a file name to attach that file: the model reads it before answering, instead of searching for it.":
		"Tapez @ suivi d'un nom de fichier pour joindre ce fichier : le modèle le lit avant de répondre, au lieu de le chercher.",
	"For a large change, ask for a plan first, then the code. Split big work into steps, and say what must not be touched.":
		"Pour un gros changement, demandez d'abord un plan, puis le code. Découpez un gros travail en étapes, et dites ce qu'il ne faut pas toucher.",
	"Send a request that attaches a file with @, for example: explain @README.md":
		"Envoyez une demande qui joint un fichier avec @, par exemple : explique @README.md",
	"Each tool the model uses is one line in the chat: the files it reads, the commands it runs, the changes it makes. {0} shows or hides their full output.":
		"Chaque outil utilisé par le modèle tient sur une ligne de la conversation : les fichiers qu'il lit, les commandes qu'il lance, les modifications qu'il fait. {0} affiche ou masque leur sortie complète.",
	"Some models think before they answer. {0} shows or hides that thinking, and {1} changes how much the model thinks.":
		"Certains modèles réfléchissent avant de répondre. {0} affiche ou masque cette réflexion, et {1} change son niveau.",
	"The bar at the bottom shows the model, how full its context is, and what the session has cost so far.":
		"La barre du bas montre le modèle, le remplissage de son contexte et ce que la session a coûté jusqu'ici.",
	"Show this tool's output with {0}.": "Affichez la sortie de cet outil avec {0}.",
	"Before an action that matters, Prism asks you: changing a file, running a command, going on the internet. You allow it once, for 15 minutes, for the session, or save a rule.":
		"Avant une action qui compte, Prism vous demande : modifier un fichier, lancer une commande, aller sur internet. Vous l'autorisez une fois, pour 15 minutes, pour la session, ou vous enregistrez une règle.",
	"Four modes decide what is asked. Safe only reads, Ask asks before changes, Broad works in the project without asking, Unrestricted asks nothing. /perm shows them and changes the mode.":
		"Quatre modes décident de ce qui est demandé. Prudent ne fait que lire, Demander demande avant les modifications, Large travaille dans le projet sans demander, Sans limite ne demande rien. /perm les montre et change le mode.",
	"These rules check what an action looks like; they do not isolate files or commands.":
		"Ces règles vérifient à quoi ressemble une action ; elles n'isolent ni les fichiers ni les commandes.",
	"Type {0} and press Enter.": "Tapez {0} puis appuyez sur Entrée.",
	"In Plan mode the model reads and proposes, but changes nothing. {0} turns it on and off: ask for the plan, then turn it off to carry it out.":
		"En mode Plan, le modèle lit et propose, mais ne modifie rien. {0} l'active et le coupe : demandez le plan, puis coupez-le pour le réaliser.",
	"A goal is a target the model keeps working on over several turns, until it is reached. {0} opens the Goal menu: start, pause or clear a goal.":
		"Un objectif est un but sur lequel le modèle continue de travailler pendant plusieurs tours, jusqu'à l'atteindre. {0} ouvre le menu Objectif : lancer, mettre en pause ou effacer un objectif.",
	"Turn Plan mode on, then off, with {0}.": "Activez puis coupez le mode Plan avec {0}.",
	"Each conversation is a session, saved as you go. /new starts a new one, /resume reopens an earlier one, /name gives the current one a name.":
		"Chaque conversation est une session, enregistrée au fur et à mesure. /new en commence une nouvelle, /resume en rouvre une ancienne, /name donne un nom à celle en cours.",
	"/tree shows the conversation as a tree: pick an earlier point to continue from there, and the rest is kept. /compact summarizes older messages when the context is full; /export saves the session as a page.":
		"/tree montre la conversation sous forme d'arbre : choisissez un point antérieur pour repartir de là, le reste est gardé. /compact résume les anciens messages quand le contexte est plein ; /export enregistre la session sous forme de page.",
	"/model, or {0}, chooses the model. {1} switches to the next of the models you use.":
		"/model, ou {0}, choisit le modèle. {1} passe au suivant parmi ceux que vous utilisez.",
	"/login connects a model service: a subscription, an API key, or a server on your computer.":
		"/login connecte un service de modèles : un abonnement, une clé d'API ou un serveur sur votre ordinateur.",
	"/settings holds the settings by domain: appearance, language, behaviour, tools. /model-settings adjusts the current model, such as its thinking level.":
		"/settings regroupe les réglages par domaine : apparence, langue, comportement, outils. /model-settings règle le modèle en cours, par exemple son niveau de réflexion.",
	"An AGENTS.md file at the root of a project gives the model its rules: how to build, how to test, what to avoid. /init writes a first one, with the continuity documents.":
		"Un fichier AGENTS.md à la racine d'un projet donne ses règles au modèle : comment compiler, comment tester, quoi éviter. /init en écrit un premier, avec les documents de continuité.",
	"/handoff writes down where the work stands, so that a new session can pick it up. {0} opens the file browser, to look through the project and add files to your message.":
		"/handoff note où en est le travail, pour qu'une nouvelle session le reprenne. {0} ouvre l'explorateur de fichiers, pour parcourir le projet et joindre des fichiers à votre message.",
	"Open the file browser with {0}.": "Ouvrez l'explorateur de fichiers avec {0}.",
	"Prism grows with modules (/settings, then Modules), MCP servers, skills, prompt templates and extensions.":
		"Prism s'enrichit avec des modules (/settings, puis Modules), des serveurs MCP, des skills, des modèles de prompt et des extensions.",
	"/docs has a page on each of them, and /help lists the keys and commands.":
		"/docs a une page sur chacun, et /help liste les touches et les commandes.",
	"That is the whole tutorial. /tutorial opens it again at any time.":
		"C'est tout pour le tutoriel. /tutorial le rouvre à tout moment.",
	"Here is how I would go about it. First I read the files that matter for your request, then I make the change in small steps and check each one before the next. When I am done, I tell you what changed and what to look at.":
		"Voici comment je m'y prendrais. D'abord je lis les fichiers utiles à votre demande, puis je fais la modification par petites étapes et je vérifie chacune avant la suivante. À la fin, je vous dis ce qui a changé et ce qu'il faut regarder.",
	Next: "Suivant",
	Previous: "Précédent",
	"Next module": "Module suivant",
	"Try it now": "Essayer pour de vrai",
	Skip: "Passer",
	Restart: "Recommencer",
	Docs: "Doc",
	"The answer is complete. Send another request and press {0} before it ends.":
		"La réponse est finie. Envoyez une autre demande et appuyez sur {0} avant la fin.",
	"Type a request in the box, then press Enter.": "Écrivez une demande dans le champ, puis appuyez sur Entrée.",
	"Press {0} to do this exercise.": "Appuyez sur {0} pour faire cet exercice.",
	"No file attached: add one with @, for example @README.md":
		"Aucun fichier joint : ajoutez-en un avec @, par exemple @README.md",
	"I read {0} before answering. With the file attached I do not have to search for it, and I answer about the file you meant.":
		"J'ai lu {0} avant de répondre. Avec le fichier joint, je n'ai pas à le chercher, et je réponds sur le fichier que vous vouliez.",
	"Done: the file came with the request.": "Réussi : le fichier est venu avec la demande.",
	"Type {0} exactly, then Enter.": "Tapez exactement {0}, puis Entrée.",
	"Done. « Try it now » opens it for real.": "Réussi. « Essayer pour de vrai » l'ouvre.",
	"Done.": "Réussi.",
	"Plan mode is on. Press {0} again to turn it off.":
		"Le mode Plan est activé. Appuyez encore sur {0} pour le couper.",
	"Hidden again. {0} shows it.": "Masquée de nouveau. {0} l'affiche.",
	"Done: Plan mode is off again.": "Réussi : le mode Plan est de nouveau coupé.",
	"Done: {0} again hides it.": "Réussi : {0} la masque de nouveau.",
	"Done. « Try it now » opens the real file browser.":
		"Réussi. « Essayer pour de vrai » ouvre le véritable explorateur.",
	"Stopped. What was already written stays.": "Arrêtée. Ce qui était déjà écrit reste.",
	"{0} of {1} modules done": "modules faits : {0} sur {1}",
	"Module done": "Module fait",
	"Demo: Prism writes this answer itself; no model is called.":
		"Démo : Prism écrit lui-même cette réponse ; aucun modèle n'est appelé.",
	"Plan mode": "Mode Plan",
	"The file browser opens here, on the right of the chat.":
		"L'explorateur de fichiers s'ouvre ici, à droite de la conversation.",
	"{0} stops the answer": "{0} arrête la réponse",
	"←→ move · Enter: press · Tab: back to the page · Esc: close":
		"←→ choisir · Entrée : appuyer · Tab : retour à la page · Échap : fermer",
	"↑↓ module · ←→ page · Tab: buttons · Esc or ✕: close": "↑↓ module · ←→ page · Tab : boutons · Échap ou ✕ : fermer",
	"↑↓ choose · Enter: pick · Tab: buttons · Esc: close":
		"↑↓ choisir · Entrée : prendre · Tab : boutons · Échap : fermer",
	"Demo: this is what {0} shows. Pick a line with ↑↓ and Enter; nothing changes for real.":
		"Démo : voici ce qu’affiche {0}. Prenez une ligne avec ↑↓ et Entrée ; rien ne change pour de vrai.",
	"« Try it now » opens it for real.": "« Essayer pour de vrai » l'ouvre.",
	"Demo: the permission mode would now be {0}. Your real mode has not changed.":
		"Démo : le mode de permission serait maintenant {0}. Votre vrai mode n’a pas changé.",
	"Demo: the conversation would go on from « {0} »; what came after stays in the tree. Your sessions have not changed.":
		"Démo : la conversation reprendrait à « {0} » ; la suite reste dans l’arbre. Vos sessions n’ont pas changé.",
	"Demo: /settings would open « {0} ». No setting has changed.":
		"Démo : /settings ouvrirait « {0} ». Aucun réglage n’a changé.",
	"Add a --verbose flag to src/cli.ts": "Ajoute une option --verbose à src/cli.ts",
	"Added the flag; the tests pass.": "Option ajoutée ; les tests passent.",
	"Also print how long each step takes": "Affiche aussi la durée de chaque étape",
	"Done: each step prints its time.": "Fait : chaque étape affiche sa durée.",
	"Instead, write the steps to a log file": "Écris plutôt les étapes dans un fichier de log",
	"The tutorial needs the interactive interface.": "Le tutoriel a besoin de l'interface interactive.",
	"Learn Prism in nine short modules, with exercises": "Apprendre Prism en neuf modules courts, avec des exercices",
	"Nine short modules show how to work with Prism, each with an exercise. Open it later with /tutorial or from « more… ».":
		"Neuf modules courts montrent comment travailler avec Prism, chacun avec un exercice. Ouvrez-le plus tard avec /tutorial ou depuis « plus… ».",
	"Start the tutorial": "Commencer le tutoriel",
	"with /tutorial": "avec /tutorial",
	"Start the tutorial with /tutorial.": "Lancez le tutoriel avec /tutorial.",
	// fork: all the settings in /settings (settings-domains.ts, settings-models.ts).
	"The model used by default, the Ctrl+P cycle and each model's settings":
		"Le modèle par défaut, le cycle Ctrl+P et les réglages de chaque modèle",
	"Permissions & sandbox": "Permissions et sandbox",
	"What the agent may do without asking, and where its commands run":
		"Ce que l'agent peut faire sans demander, et où ses commandes s'exécutent",
	"Network & web": "Réseau et web",
	"Connection method, response wait limits, keeping sent text cached for reuse, and the web search service":
		"Mode de connexion, délais d'attente des réponses, mise en cache du texte envoyé, et service de recherche web",
	Notifications: "Notifications",
	"Warnings, notices, the changelog and desktop notifications":
		"Avertissements, notes, nouveautés et notifications de bureau",
	Servers: "Serveurs",
	"Language servers and MCP servers, and whether each one is used":
		"Serveurs de langage et serveurs MCP, et si chacun est utilisé",
	"Auto-compact conversation (summaries of older messages), reply language, queued messages (sent while or after working), Escape and /tree history":
		"Résumé automatique (des anciens messages), langue des réponses, messages en attente (envoyés pendant ou après le travail), Échap et historique /tree",
	"Bundled add-ons, each can be turned off. The permission system stays loaded; its settings are in Permissions & sandbox.":
		"Modules inclus, chacun désactivable. Le système de permissions reste chargé ; ses réglages sont dans Permissions et sandbox.",
	"Settings without a domain yet, then the commands that act rather than set something":
		"Réglages sans catégorie pour l'instant, puis les commandes qui agissent au lieu de régler",
	"Default model": "Modèle par défaut",
	"Type to filter. Enter saves it as the default.": "Tapez pour filtrer. Entrée l'enregistre comme modèle par défaut.",
	"Models in the cycle": "Modèles du cycle",
	"The model new sessions start with. /model changes the model of the current session.":
		"Le modèle avec lequel démarrent les nouvelles sessions. /model change le modèle de la session en cours.",
	"How much the model thinks before answering, for new sessions and this one. Higher levels may take longer and cost more. A model's own level, below, wins.":
		"Combien le modèle réfléchit avant de répondre, pour les nouvelles sessions et celle-ci. Les niveaux élevés peuvent prendre plus de temps et coûter plus. Le niveau propre à un modèle, plus bas, l'emporte.",
	"Which models Ctrl+P cycles through (also /scoped-models).":
		"Les modèles que Ctrl+P fait défiler (aussi /scoped-models).",
	low: "bas",
	medium: "moyen",
	high: "élevé",
	xhigh: "très élevé",
	max: "maximal",
	"Sign in": "Se connecter",
	"Sign in to a model service or add a server (also /login).":
		"Se connecter à un service de modèles ou ajouter un serveur (aussi /login).",
	"First-run setup": "Réglages du premier lancement",
	"Go through the first-run choices again: theme, permissions, models (also /onboarding).":
		"Refaire les choix du premier lancement : thème, permissions, modèles (aussi /onboarding).",
	"Trust this folder": "Confiance dans ce dossier",
	"Choose whether this project's settings, extensions and instructions apply (also /trust).":
		"Choisir si les réglages, extensions et instructions de ce projet s'appliquent (aussi /trust).",
	"Budgets of this session": "Budgets de cette session",
	"Limits on time, tool calls, tokens and cost for the current session only; defaults are in Conversation (also /budget).":
		"Limites de durée, d'appels d'outils, de tokens et de coût pour la session en cours seulement ; les valeurs par défaut sont dans Conversation (aussi /budget).",
	"llama.cpp models": "Modèles llama.cpp",
	"Load, unload and download the models of a llama.cpp server in router mode (also /llama).":
		"Charger, décharger et télécharger les modèles d'un serveur llama.cpp en mode routeur (aussi /llama).",
	// fork: each model's page in /settings > Models (settings-model-page.ts).
	current: "actuel",
	"1 model": "1 modèle",
	"1 change": "1 modification",
	"current · 1 change": "actuel · 1 modification",
	"Enter opens the model's page. /model-settings opens the current one.":
		"Entrée ouvre la page du modèle. /model-settings ouvre celle du modèle actuel.",
	"Reading the server's values…": "Lecture des valeurs du serveur…",
	Server: "Serveur",
	"reading…": "lecture…",
	"Advanced interface: sampling and the other request parameters":
		"Interface avancée : échantillonnage et autres paramètres de requête",
	"Remove my changes for this model": "Retirer mes modifications pour ce modèle",
	"Remove this model from Prism": "Retirer ce modèle de Prism",
	"Update the model list of the server {0}": "Mettre à jour la liste des modèles du serveur {0}",
	"Reading the server's model list…": "Lecture de la liste des modèles du serveur…",
	"The server's model list has not changed.": "La liste des modèles du serveur n'a pas changé.",
	"Added: {0}.": "Ajoutés : {0}.",
	"Removed: {0}.": "Retirés : {0}.",
	"Updated from the server: {0}.": "Mis à jour depuis le serveur : {0}.",
	// fork: a server's model list read again at start or when the model is not found.
	"{0}: added {1}; removed {2}.": "{0} : ajouté {1} ; retiré {2}.",
	"{0}: added {1}.": "{0} : ajouté {1}.",
	"{0}: removed {1}.": "{0} : retiré {1}.",
	// fork: what the server says about a model it still serves, read again.
	"{0}: {1} updated from the server (thinking levels, context, images).":
		"{0} : {1} mis à jour depuis le serveur (niveaux de raisonnement, contexte, images).",
	"{0} updated from the server (thinking levels, context, images).":
		"{0} mis à jour depuis le serveur (niveaux de raisonnement, contexte, images).",
	"{0}, the current model, is no longer on the server: choose another with /model.":
		"{0}, le modèle en cours, n’est plus sur le serveur : choisissez-en un autre avec /model.",
	"{0}, the default model, is no longer on the server.": "{0}, le modèle par défaut, n’est plus sur le serveur.",
	"{0}, the current and default model, is no longer on the server: choose another with /model.":
		"{0}, le modèle en cours et par défaut, n’est plus sur le serveur : choisissez-en un autre avec /model.",
	"{0} is not a server added to models.json.": "{0} n'est pas un serveur ajouté à models.json.",
	"Enter again removes this model from Prism, Esc keeps it":
		"Entrée à nouveau retire ce modèle de Prism, Échap le garde",
	"Remove the server {0} and its {1} model(s)": "Retirer le serveur {0} et ses {1} modèle(s)",
	"Enter again removes the server and its models, Esc keeps them":
		"Entrée à nouveau retire le serveur et ses modèles, Échap les garde",
	"Removed the server {0} and its models.": "Serveur {0} et ses modèles retirés.",
	"Removed {0}, the server's last model: the server {1} is removed too.":
		"{0} retiré ; c'était le dernier modèle du serveur, {1} est retiré aussi.",
	"This conversation keeps it until you choose another model.":
		"Cette conversation le garde jusqu'à ce que vous choisissiez un autre modèle.",
	// fork: the removed model was the default (settings-model-page.ts), and the start's notice
	// (default-model-fallback.ts).
	"It was the default model for new conversations.": "C'était le modèle par défaut des nouvelles conversations.",
	"It was the default model for new conversations; no other model is available to replace it.":
		"C'était le modèle par défaut des nouvelles conversations ; aucun autre modèle n'est disponible pour le remplacer.",
	"Choose another default model": "Choisir un autre modèle par défaut",
	"Enter makes the chosen model the default; Esc leaves the default as it is.":
		"Entrée en fait le modèle par défaut ; Échap laisse le modèle par défaut tel quel.",
	"Default model {0} not found; using {1}. Choose another in /settings › Models.":
		"Modèle par défaut {0} introuvable ; j'utilise {1}. Choisissez-en un autre dans /settings › Modèles.",
	"No key for the default model {0}; using {1}. Sign in with /login, or choose another default in /settings › Models.":
		"Aucune clé pour le modèle par défaut {0} ; j'utilise {1}. Connectez-vous avec /login, ou choisissez un autre modèle par défaut dans /settings › Modèles.",
	"Enter again removes your changes, Esc keeps them": "Entrée à nouveau les retire, Échap les garde",
	"✎ = your value.": "✎ = votre valeur.",
	"The name Prism shows for this model.": "Le nom que Prism affiche pour ce modèle.",
	"How many tokens the model reads at once; the conversation is compacted before it is full. The server keeps its own limit.":
		"Combien de tokens le modèle lit à la fois ; la conversation est résumée avant d'être pleine. Le serveur garde sa propre limite.",
	"The longest answer the model may write, in tokens.":
		"La réponse la plus longue que le modèle peut écrire, en tokens.",
	"Whether Prism sends images to this model.": "Si Prism envoie des images à ce modèle.",
	"Keeps the images a tool returns (a screenshot) in the tool's result, instead of a separate message the model may take for one from you. Recommended for the Qwen family. The server must accept it: llama.cpp does, OpenAI does not.":
		"Garde les images qu'un outil renvoie (une capture d'écran) dans le résultat de l'outil, au lieu d'un message à part que le modèle peut prendre pour un message de vous. Recommandé pour la famille Qwen. Le serveur doit l'accepter : llama.cpp oui, OpenAI non.",
	"Whether the model can think before it answers. Off, Prism refuses a thinking level for it.":
		"Si le modèle peut réfléchir avant de répondre. Désactivé, Prism refuse un niveau de réflexion pour lui.",
	"Tokens the model may spend thinking, at every level, when the server reads a budget.":
		"Tokens que le modèle peut dépenser à réfléchir, à chaque niveau, quand le serveur lit un budget.",
	"Whether Prism gives this model its tools. Off for a model that cannot call them.":
		"Si Prism donne ses outils à ce modèle. Désactivé pour un modèle qui ne sait pas les appeler.",
	"Sampling parameter sent with each request. Not sent: the server's default applies.":
		"Paramètre d'échantillonnage envoyé avec chaque requête. Non envoyé : la valeur par défaut du serveur s'applique.",
	'Other request fields, as a JSON object, for example {"seed": 42}.':
		'Autres champs de requête, en objet JSON, par exemple {"seed": 42}.',
	// fork: /settings > Permissions & sandbox (settings-permissions.ts, settings-list-editor.ts).
	"Default mode": "Mode par défaut",
	"What the agent may do without asking, in this session. alt+m cycles it; new sessions start in the default mode.":
		"Ce que l'agent peut faire sans demander, dans cette session. alt+m le fait tourner ; les nouvelles sessions démarrent dans le mode par défaut.",
	"The mode new sessions start in (permissions.json in Prism's folder).":
		"Le mode dans lequel démarrent les nouvelles sessions (permissions.json dans le dossier de Prism).",
	"Modes and permissions in effect": "Modes et permissions en vigueur",
	"What each mode allows, the permissions given for a while or for this session (each can be revoked), and unrestricted mode the first time (also /perm window).":
		"Ce que permet chaque mode, les permissions données pour un temps ou pour cette session (chacune peut être retirée), et le mode unrestricted la première fois (aussi /perm window).",
	Rules: "Règles",
	"Saved rules: allow, ask or block actions that match, such as bash(npm run test*) or write(src/**). Rules given for this session are in Modes and permissions in effect.":
		"Règles enregistrées : autoriser, demander ou bloquer les actions qui correspondent, comme bash(npm run test*) ou write(src/**). Les règles données pour cette session sont dans Modes et permissions en vigueur.",
	"tool or tool(glob): * matches text within one folder, ** across folders. Enter on a rule removes it.":
		"outil ou outil(glob) : * correspond à du texte dans un dossier, ** à travers les dossiers. Entrée sur une règle la retire.",
	"A rule, such as bash(npm run test*) or write(src/**)": "Une règle, comme bash(npm run test*) ou write(src/**)",
	"What it does": "Ce qu'elle fait",
	"allow: done without asking": "autoriser : fait sans demander",
	"ask: always asks": "demander : demande toujours",
	"deny: blocked": "bloquer : bloqué",
	"Where to save it": "Où l'enregistrer",
	"This project (.pi/permissions.json)": "Ce projet (.pi/permissions.json)",
	"Every project (permissions.json in Prism's folder)": "Tous les projets (permissions.json dans le dossier de Prism)",
	allow: "autoriser",
	deny: "bloquer",
	project: "projet",
	"Type a rule: tool or tool(glob).": "Tapez une règle : outil ou outil(glob).",
	"Protected paths": "Chemins protégés",
	"Files the agent must ask for, whatever the mode: keys, .env files, Git hooks. Yours are added to Prism's.":
		"Fichiers pour lesquels l'agent doit demander, quel que soit le mode : clés, fichiers .env, hooks Git. Les vôtres s'ajoutent à ceux de Prism.",
	"A path or a glob, relative to the project: * within one folder, ** across folders.":
		"Un chemin ou un glob, relatif au projet : * dans un dossier, ** à travers les dossiers.",
	"A path or a glob, such as secrets/** or *.sqlite": "Un chemin ou un glob, comme secrets/** ou *.sqlite",
	Sandbox: "Sandbox",
	"Where commands run: in the sandbox, they write only to the project and caches, see no keys or credentials, and reach only the sites you allow (also /sandbox).":
		"Où tournent les commandes : dans la sandbox, elles n'écrivent que dans le projet et les caches, ne voient ni clés ni identifiants, et ne joignent que les sites que vous autorisez (aussi /sandbox).",
	"on in this mode": "active dans ce mode",
	"off in this mode": "inactive dans ce mode",
	"not working": "ne fonctionne pas",
	// fork: /settings > Permissions & sandbox, variables hidden from commands (secrets/extension.ts).
	"Variables hidden from commands": "Variables cachées aux commandes",
	"Variables that look like keys, tokens or passwords, and identity agents such as SSH_AUTH_SOCK, are removed from the agent's commands; their values are never shown. You can pass one to a given command, as GITHUB_TOKEN bash(gh *).":
		"Les variables qui ressemblent à des clés, jetons ou mots de passe, et les agents d'identification comme SSH_AUTH_SOCK, sont retirés des commandes de l'agent ; leurs valeurs ne sont jamais affichées. Vous pouvez en passer une à une commande précise, comme GITHUB_TOKEN bash(gh *).",
	"Hidden from the agent's commands (bash, background). Add a variable and the command it is passed to; Enter on a rule removes it.":
		"Cachées aux commandes de l'agent (bash, tâches de fond). Ajoutez une variable et la commande à qui la passer ; Entrée sur une règle la retire.",
	"A variable and a rule, such as GITHUB_TOKEN bash(gh *)": "Une variable et une règle, comme GITHUB_TOKEN bash(gh *)",
	"Type a variable, then a rule: GITHUB_TOKEN bash(gh *).":
		"Tapez une variable, puis une règle : GITHUB_TOKEN bash(gh *).",
	passed: "passée",
	"hidden · its name": "cachée · son nom",
	"hidden · identity agent": "cachée · agent d'identification",
	"hidden · holds a stored key": "cachée · contient une clé enregistrée",
	"hidden · its address holds a password": "cachée · son adresse contient un mot de passe",
	// fork: the allowlist of the advanced settings (secrets/extension.ts).
	"hidden · not a known variable": "cachée · pas une variable connue",
	"Pass only known variables": "Ne passer que les variables connues",
	"off: the agent's commands get your environment without the variables that look like secrets. on: they get only common variables (PATH, HOME, LANG and the like), those you add below and those a rule passes, so a secret under an unusual name does not reach them. A build tool may then need its own variables added, such as JAVA_HOME.":
		"off : les commandes de l’agent reçoivent votre environnement sans les variables qui ressemblent à des secrets. on : elles ne reçoivent que les variables courantes (PATH, HOME, LANG et semblables), celles que vous ajoutez ci-dessous et celles qu’une règle passe ; un secret sous un nom inhabituel ne leur parvient donc pas. Un outil de build peut alors demander qu’on ajoute ses propres variables, comme JAVA_HOME.",
	"Variables passed to commands": "Variables passées aux commandes",
	"Variables the agent's commands get besides the common ones, when only known variables are passed. A name, or a pattern such as CARGO_*.":
		"Variables que les commandes de l’agent reçoivent en plus des variables courantes, quand seules les variables connues sont passées. Un nom, ou un motif comme CARGO_*.",
	"Passed to the agent's commands besides the common variables. A variable that looks like a secret stays hidden; pass it to one command with a rule instead. Enter on a name removes it.":
		"Passées aux commandes de l’agent en plus des variables courantes. Une variable qui ressemble à un secret reste cachée ; passez-la à une commande par une règle. Entrée sur un nom le retire.",
	"A variable, or a pattern such as CARGO_*": "Une variable, ou un motif comme CARGO_*",
	"Type a variable name, or a pattern such as CARGO_*.": "Saisissez un nom de variable, ou un motif comme CARGO_*.",
	"Check the sandbox again": "Revérifier la sandbox",
	"This session no longer exists.": "Cette session n'existe plus.",
	"This session is open: it cannot be deleted.": "Cette session est ouverte : elle ne peut pas être supprimée.",
	"No scheduled task named {0}.": "Aucune tâche planifiée nommée {0}.",
	"Once bubblewrap is installed or allowed (see Sandbox for how), checks again; shell commands run as soon as it works.":
		"Une fois bubblewrap installé ou autorisé (voir Sandbox pour la marche à suivre), vérifie de nouveau ; les commandes shell tournent dès que la sandbox fonctionne.",
	check: "vérifier",
	"In modes": "Dans les modes",
	"The permission modes whose shell commands run in the sandbox.":
		"Les modes de permission dont les commandes shell tournent dans la sandbox.",
	"Shell commands of these modes run in the sandbox.": "Les commandes shell de ces modes tournent dans la sandbox.",
	"Ask for new hosts": "Demander pour les nouveaux hôtes",
	"A sandboxed command reaching a host not listed asks you; off, such a host passes without a question, except a port of this machine or Git over SSH, which open only when allowed. Blocked hosts stay blocked.":
		"Une commande dans la sandbox qui joint un hôte non listé vous demande ; désactivé, cet hôte passe sans question, sauf un port de cette machine ou Git par SSH, qui ne s'ouvrent que si vous les autorisez. Les hôtes bloqués le restent.",
	"Allowed hosts": "Hôtes autorisés",
	"Hosts sandboxed commands reach without asking. *.example.com covers its subdomains; localhost:5432 a single port of this machine, whose other ports stay closed; ssh://github.com Git over SSH to that host, with your SSH keys; nas.lan@192.168.1.10 lets that name lead to that address of your local network (asked otherwise).":
		"Hôtes que les commandes dans la sandbox joignent sans demander. *.example.com couvre ses sous-domaines ; localhost:5432 un seul port de cette machine, dont les autres ports restent fermés ; ssh://github.com Git par SSH vers cet hôte, avec vos clés SSH ; nas.lan@192.168.1.10 laisse ce nom mener à cette adresse de votre réseau local (demandé sinon).",
	"A host, such as registry.npmjs.org, *.github.com, localhost:5432 or ssh://github.com":
		"Un hôte, comme registry.npmjs.org, *.github.com, localhost:5432 ou ssh://github.com",
	"Blocked hosts": "Hôtes bloqués",
	"Hosts sandboxed commands never reach, even when asked.":
		"Hôtes que les commandes dans la sandbox ne joignent jamais, même sur demande.",
	"A host, such as example.com or *.example.com": "Un hôte, comme example.com ou *.example.com",
	"Your ! commands in the sandbox": "Vos commandes ! dans la sandbox",
	"Run the commands you type with ! in the sandbox too; off, they run as you.":
		"Lancer aussi dans la sandbox les commandes que vous tapez avec ! ; désactivé, elles tournent en votre nom.",
	"Prism is open in your home folder, and reading is limited to the project: here, the project would be the whole home folder.":
		"Prism est ouvert dans votre dossier personnel et la lecture est limitée au projet : ici, le projet serait tout le dossier personnel.",
	"Commands do not run until you choose where to work.":
		"Les commandes ne tournent pas tant que vous n'avez pas choisi où travailler.",
	"Work in ~/Prism, the window's folder (created if missing)":
		"Travailler dans ~/Prism, le dossier de la fenêtre (créé s'il manque)",
	"Work in a new folder in /tmp (kept after the session)":
		"Travailler dans un nouveau dossier de /tmp (gardé après la session)",
	"Stay here and let the agent read the whole home folder until Prism exits (keys and credentials stay hidden)":
		"Rester ici et laisser l'agent lire tout le dossier personnel jusqu'à la sortie de Prism (clés et identifiants restent masqués)",
	"Stay here and read nothing: commands are refused": "Rester ici sans rien lire : les commandes sont refusées",
	"Git signs with my key": "Git signe avec ma clé",
	"Let Git in the sandbox sign commits and tags with the signing key of your Git configuration. Prism signs them outside the sandbox; the key never enters it, and nothing else is signed.":
		"Laisser Git, dans la sandbox, signer les commits et les tags avec la clé de signature de votre configuration Git. Prism les signe hors de la sandbox ; la clé n'y entre jamais, et rien d'autre n'est signé.",
	"Commands see my containers": "Les commandes voient mes conteneurs",
	"Let sandboxed commands list your Docker or Podman containers and images (docker ps, docker images), without changing them, inspecting them or reading their logs.":
		"Laisser les commandes dans la sandbox lister vos conteneurs et images Docker ou Podman (docker ps, docker images), sans les modifier, les inspecter ni lire leurs journaux.",
	"Commands read the state of services": "Les commandes lisent l'état des services",
	"Let sandboxed commands read only service state fields over D-Bus (systemctl status, is-active, list-units, show -p ActiveState), without reading configuration or environment, or starting, stopping or changing services.":
		"Laisser les commandes dans la sandbox lire uniquement les champs d'état des services par D-Bus (systemctl status, is-active, list-units, show -p ActiveState), sans lire leur configuration ni leur environnement, ni démarrer, arrêter ou modifier les services.",
	"Create this scheduled task?": "Créer cette tâche planifiée ?",
	"Task:": "Tâche :",
	"When:": "Quand :",
	"next run:": "prochain passage :",
	"What it may do without asking (nobody is there to answer):":
		"Ce qu'elle peut faire sans demander (personne ne sera là pour répondre) :",
	"Read the project and run safe commands only": "Lire le projet et lancer des commandes sûres seulement",
	"Everything else is refused and reported: no sudo, no unrestricted mode, no command outside the sandbox, no new network host, not your allow rules.":
		"Tout le reste est refusé et consigné : pas de sudo, pas de mode unrestricted, aucune commande hors de la sandbox, aucun nouvel hôte réseau, pas vos règles d'autorisation.",
	"Limits per run: {0} min, {1} tool calls.": "Limites par passage : {0} min, {1} appels d'outils.",
	"Model:": "Modèle :",
	"the default model": "le modèle par défaut",
	"A run missed while the computer was off is reported, not run late.":
		"Un passage manqué pendant que l'ordinateur était éteint est signalé, pas rattrapé.",
	"A run missed while the computer was off runs at the next start.":
		"Un passage manqué pendant que l'ordinateur était éteint a lieu au démarrage suivant.",
	"Runs only while you are logged in: Prism does not enable lingering. A locked keyring makes the run fail; no key is stored in clear for it.":
		"Ne tourne que pendant que votre session est ouverte : Prism n'active pas le « lingering ». Un trousseau verrouillé fait échouer le passage ; aucune clé n'est enregistrée en clair pour lui.",
	"Files written:": "Fichiers écrits :",
	"What should the task do? (its prompt)": "Que doit faire la tâche ? (son prompt)",
	Prompt: "Prompt",
	"Name: lower case letters, digits and dashes": "Nom : minuscules, chiffres et tirets",
	"No name given: the task was not created.": "Aucun nom donné : la tâche n'a pas été créée.",
	"Invalid name: lower case letters, digits and dashes, 40 at most.":
		"Nom invalide : minuscules, chiffres et tirets, 40 au plus.",
	"A task named {0} already exists.": "Une tâche nommée {0} existe déjà.",
	"When? A systemd calendar expression": "Quand ? Une expression de calendrier systemd",
	"Invalid schedule:": "Horaire invalide :",
	"May the task change the project's files?": "La tâche peut-elle modifier les fichiers du projet ?",
	"May the task run commands in the sandbox, except dangerous ones?":
		"La tâche peut-elle lancer des commandes dans la sandbox, sauf les dangereuses ?",
	"Time limit per run, in minutes": "Durée maximale par passage, en minutes",
	"Tool call limit per run": "Nombre maximal d'appels d'outils par passage",
	"Invalid limit: a whole number above zero.": "Limite invalide : un nombre entier supérieur à zéro.",
	"Hosts the task may connect to, separated by commas (empty: no network)":
		"Hôtes que la tâche peut joindre, séparés par des virgules (vide : pas de réseau)",
	"Invalid host: {0}. Give names such as api.github.com or *.example.com.":
		"Hôte invalide : {0}. Donnez des noms comme api.github.com ou *.example.com.",
	"Connect to these hosts (commands it may run, web_fetch, web_search)":
		"Joindre ces hôtes (commandes qu'elle peut lancer, web_fetch, web_search)",
	"Report it only (recommended)": "Le signaler seulement (recommandé)",
	"A run missed while the computer was off:": "Un passage manqué pendant que l'ordinateur était éteint :",
	"Run it late": "Le lancer en retard",
	"Create the task": "Créer la tâche",
	"Scheduled task {0} created.": "Tâche planifiée {0} créée.",
	"Last runs:": "Derniers passages :",
	"No run yet.": "Aucun passage pour l'instant.",
	"Scheduled task {0} paused.": "Tâche planifiée {0} mise en pause.",
	"Scheduled task {0} resumed.": "Tâche planifiée {0} reprise.",
	"Remove the task and its units": "Supprimer la tâche et ses unités",
	"Remove scheduled task {0}?": "Supprimer la tâche planifiée {0} ?",
	"Scheduled task {0} removed.": "Tâche planifiée {0} supprimée.",
	"Scheduled tasks: create, pause or remove": "Tâches planifiées : créer, mettre en pause ou supprimer",
	"/schedule needs the interactive terminal.": "/schedule a besoin du terminal interactif.",
	"New scheduled task": "Nouvelle tâche planifiée",
	"Scheduled tasks": "Tâches planifiées",
	started: "démarré",
	finished: "terminé",
	missed: "manqué",
	"skipped-running": "sauté (passage précédent en cours)",
	"no end recorded": "aucune fin consignée",
	"nothing refused": "rien refusé",
	"started late (computer off or asleep); not run": "démarré en retard (ordinateur éteint ou en veille) ; non exécuté",
	"--scheduled takes no other argument.": "--scheduled ne prend aucun autre argument.",
	"the sandbox is off in ask mode, and a scheduled run needs it.":
		"la sandbox est désactivée en mode ask, et un passage planifié en a besoin.",
	"Scheduled task {0} failed": "La tâche planifiée {0} a échoué",
	"Scheduled task {0}: actions refused": "Tâche planifiée {0} : actions refusées",
	"/schedule shows what happened.": "/schedule montre ce qui s'est passé.",
	"Scheduled runs since you last looked:": "Passages planifiés depuis votre dernière visite :",
	"/schedule shows each task's runs.": "/schedule montre les passages de chaque tâche.",
	"The agent proposes a scheduled task.": "L'agent propose une tâche planifiée.",
	"Propose a scheduled task": "Proposer une tâche planifiée",
	"This Prism cannot schedule tasks:": "Ce Prism ne peut pas planifier de tâches :",
	"Prism runs here from its TypeScript sources, which an agent could change before the timer runs them outside the sandbox. Schedule tasks from an installed Prism (release or npm).":
		"Prism tourne ici depuis ses sources TypeScript, qu'un agent pourrait modifier avant que le timer ne les lance hors de la sandbox. Planifiez les tâches depuis un Prism installé (release ou npm).",
	Pause: "Mettre en pause",
	Resume: "Reprendre",
	Remove: "Supprimer",
	"Commands as root (sudo)": "Commandes en root (sudo)",
	"Give the agent a sudo tool: commands run as root outside the sandbox after your approval and password. You may allow sudo for this session and optionally remember the password for five minutes. Applies after /reload.":
		"Donner à l'agent un outil sudo : les commandes tournent en root hors de la sandbox après votre accord et votre mot de passe. Vous pouvez autoriser sudo pour cette session et choisir de garder le mot de passe cinq minutes en mémoire. S'applique après /reload.",
	"Remember sudo password for 5 minutes": "Garder le mot de passe sudo en mémoire 5 minutes",
	"Keep the password in Prism's memory for 5 minutes after you type it, so the next sudo commands do not ask for it again. Never written anywhere. Only applies when sudo is on.":
		"Garder le mot de passe dans la mémoire de Prism pendant 5 minutes après sa saisie, pour ne pas le redemander aux prochaines commandes sudo. Jamais écrit où que ce soit. Ne s'applique que si sudo est activé.",
	"Allow sudo for this session": "Autoriser sudo pour cette session",
	"Root command: remembered password and session approval.":
		"Commande en root : mot de passe en mémoire et accord pour la session.",
	"Root command: remembered password and approval for this call.":
		"Commande en root : mot de passe en mémoire et accord pour cet appel.",
	"Run as root, outside the sandbox?": "Lancer en root, hors de la sandbox ?",
	"Folder:": "Dossier :",
	"Warning: your account or the project can change {0}; root uses it as it is when the command runs.":
		"Attention : votre compte ou le projet peut modifier {0} ; root l'utilise tel qu'il est au moment de la commande.",
	"Type your password to allow this command once, or press Escape to refuse.":
		"Tapez votre mot de passe pour autoriser cette commande une fois, ou Échap pour refuser.",
	Password: "Mot de passe",
	"Run outside the sandbox": "Lancer hors sandbox",
	"Commands that run outside the sandbox, such as docker: a single command starting with one of these. They still get the permission check.":
		"Commandes qui tournent hors de la sandbox, comme docker : une commande seule qui commence par l'une d'elles. Elles passent quand même la vérification des permissions.",
	"A command, such as docker or docker compose": "Une commande, comme docker ou docker compose",
	"Writable paths": "Chemins inscriptibles",
	"Paths sandboxed commands may write besides the project, /tmp and the package caches. ~ is your home folder.":
		"Chemins où les commandes dans la sandbox peuvent écrire en plus du projet, de /tmp et des caches de paquets. ~ est votre dossier personnel.",
	"A path, such as ~/.local/share/pnpm": "Un chemin, comme ~/.local/share/pnpm",
	"Hidden paths": "Chemins masqués",
	"Paths hidden from sandboxed commands besides keys, credentials and browser profiles. ~ is your home folder.":
		"Chemins cachés aux commandes dans la sandbox en plus des clés, des identifiants et des profils de navigateur. ~ est votre dossier personnel.",
	"A path, such as ~/Documents/private": "Un chemin, comme ~/Documents/private",
	"What the agent reads": "Ce que l'agent lit",
	"Prism: nsenter (util-linux) was not found, so the commands of this session do not share localhost: a server a command or a background task starts is not reachable from the next command. Install nsenter to share it.":
		"Prism : nsenter (util-linux) est introuvable, donc les commandes de cette session ne partagent pas localhost : un serveur lancé par une commande ou une tâche de fond n'est pas joignable par la commande suivante. Installez nsenter pour le partager.",
	"Prism: this system refused the session's network namespace, so the commands of this session do not share localhost: a server a command or a background task starts is not reachable from the next command.":
		"Prism : ce système a refusé l'espace réseau de la session, donc les commandes de cette session ne partagent pas localhost : un serveur lancé par une commande ou une tâche de fond n'est pas joignable par la commande suivante.",
	"project: the project, what its tools need and the paths you allow; commands do not see the rest of the home folder, other accounts or mounted disks, and file tools ask before reading them. all: everything but the hidden paths. MCP and LSP servers and your browser are not limited either way.":
		"projet : le projet, ce dont ses outils ont besoin et les chemins que vous autorisez ; les commandes ne voient pas le reste du dossier personnel, les autres comptes ni les disques montés, et les outils de fichiers demandent avant de les lire. tous : tout, sauf les chemins masqués. Les serveurs MCP et LSP et votre navigateur ne sont limités dans aucun cas.",
	"Tools' resources": "Ressources des outils",
	"What the tools found in your home folder need, readable by the agent: one line per tool, without its credentials.":
		"Ce dont ont besoin les outils trouvés dans votre dossier personnel, lisible par l'agent : une ligne par outil, sans ses identifiants.",
	"Each tool's folders, readable by the agent; its credentials stay hidden.":
		"Les dossiers de chaque outil, lisibles par l'agent ; ses identifiants restent masqués.",
	"Also readable": "Aussi lisible",
	"Files and folders the agent may read besides the project and the tools' resources, with file tools and commands. Hidden paths do not open this way.":
		"Fichiers et dossiers que l'agent peut lire en plus du projet et des ressources des outils, avec les outils de fichiers et les commandes. Les chemins masqués ne s'ouvrent pas par ici.",
	"A file or a folder, such as ~/Documents/specs": "Un fichier ou un dossier, comme ~/Documents/specs",
	"Where it applies": "Où cela s'applique",
	"This project (kept in Prism's folder)": "Ce projet (gardé dans le dossier de Prism)",
	"Every project (settings.json in Prism's folder)": "Tous les projets (settings.json dans le dossier de Prism)",
	"every project": "tous les projets",
	"this project": "ce projet",
	"{0} does not exist.": "{0} n'existe pas.",
	"{0} cannot be opened here: it is a hidden path (keys, credentials), holds one, or is too wide (the home folder, ~/.config, ~/.local, ~/.cache). Remove a path you hid yourself from Hidden paths first; to read everything, set What the agent reads to all.":
		"{0} ne peut pas être ouvert ici : c'est un chemin masqué (clés, identifiants), il en contient un, ou il est trop large (le dossier personnel, ~/.config, ~/.local, ~/.cache). Retirez d'abord des Chemins masqués un chemin que vous avez masqué vous-même ; pour tout lire, réglez Ce que l'agent lit sur tous.",
	"Add…": "Ajouter…",
	"always applied": "toujours appliqué",
	"Enter again removes it, Esc keeps it": "Entrée à nouveau le retire, Échap le garde",
	"Prism always applies this one; it cannot be removed here.":
		"Prism applique toujours celui-ci ; il ne peut pas être retiré ici.",
	"The permissions window needs the interactive mode.": "La fenêtre des permissions demande le mode interactif.",
	// fork: default budgets (settings-budgets.ts, settings-value-input.ts).
	"Default time budget": "Budget de durée par défaut",
	"Default tool-call budget": "Budget d'appels d'outils par défaut",
	"Default token budget": "Budget de tokens par défaut",
	"Default cost budget": "Budget de coût par défaut",
	"Minutes a new session may work, counted while the agent runs; 80% gives a warning. /budget changes the current session's.":
		"Minutes de travail d'une nouvelle session, comptées pendant que l'agent tourne ; un avertissement à 80 %. /budget change ceux de la session en cours.",
	"Tool calls a new session may make; 80% gives a warning. /budget changes the current session's.":
		"Appels d'outils permis à une nouvelle session ; un avertissement à 80 %. /budget change ceux de la session en cours.",
	"Tokens a new session may use (input, output and cache); 80% gives a warning. /budget changes the current session's.":
		"Tokens permis à une nouvelle session (entrée, sortie et cache) ; un avertissement à 80 %. /budget change ceux de la session en cours.",
	"Dollars a new session may spend, only with a model whose price is known (not applied otherwise); 80% gives a warning. /budget changes the current session's.":
		"Dollars qu'une nouvelle session peut dépenser, seulement avec un modèle dont le prix est connu (sinon non appliqué) ; un avertissement à 80 %. /budget change ceux de la session en cours.",
	"Type a number of minutes, such as 30.": "Tapez un nombre de minutes, comme 30.",
	"Type a whole number, such as 200.": "Tapez un nombre entier, comme 200.",
	"Type a whole number, such as 2000000.": "Tapez un nombre entier, comme 2000000.",
	"Type an amount in dollars, such as 5 or 0.50.": "Tapez un montant en dollars, comme 5 ou 0.50.",
	Now: "Actuellement",
	"Enter saves, an empty field removes it, Esc keeps it.":
		"Entrée enregistre, un champ vide le retire, Échap le garde.",
	// fork: /settings > Notifications (notify.ts).
	"Desktop notifications": "Notifications de bureau",
	"Approval notifications": "Notifications d'approbation",
	"Test notification": "Notification de test",
	"Sends a desktop notification now.": "Envoie une notification de bureau maintenant.",
	send: "envoyer",
	// fork: /settings > Servers (settings-servers.ts, settings-descriptions.ts).
	"This project's language servers: install them, turn them on or off (also /lsp-setup; /lsp sums up their state).":
		"Les serveurs de langage de ce projet : les installer, les activer ou les désactiver (aussi /lsp-setup ; /lsp résume leur état).",
	"MCP connections": "Connexions MCP",
	installed: "installé",
	"not installed, /lsp-setup shows how": "non installé, /lsp-setup dit comment l'installer",
	"registered by an extension, for this session": "ajouté par une extension, pour cette session",
	"Sign in to an MCP server, sign out, reconnect, and see each server's tools (also /mcp).":
		"Se connecter à un serveur MCP, se déconnecter, reconnecter, et voir les outils de chaque serveur (aussi /mcp).",
	"How its tools reach the model: codemode, called from scripts that find them with searchTools(); deferred, loaded by tool_search then called directly; direct, declared like built-in tools.":
		"Comment ses outils arrivent au modèle : codemode, appelés depuis des scripts qui les trouvent avec searchTools() ; deferred, chargés par tool_search puis appelés directement ; direct, déclarés comme les outils intégrés.",

	// fork: why a module's feature is missing (src/fork/feature-state.ts).
	"no language server for this project's languages is installed; /lsp-setup shows how":
		"aucun serveur de langage n’est installé pour les langages de ce projet ; /lsp-setup indique comment faire",
	unavailable: "indisponible",
	"not for this model": "pas avec ce modèle",
	"turn it on in /settings › Modules": "activez son module dans /settings › Modules",
	"/settings › Modules says why": "/settings › Modules dit pourquoi",

	// fork: the task scope (src/fork/task-scope.ts, permissions.ts).
	"Task scope": "Périmètre de tâche",
	"Task scope proposed by the agent": "Périmètre de tâche proposé par l'agent",
	"Set a task scope": "Fixer un périmètre de tâche",
	"Within it, the agent works without asking. Leave out a line with Enter.":
		"Dans ce périmètre, l'agent travaille sans demander. Entrée retire une ligne.",
	"Within it, the agent works without asking. Untick a line to leave it out.":
		"Dans ce périmètre, l'agent travaille sans demander. Décochez une ligne pour la retirer.",
	"(Enter: change)": "(Entrée : changer)",
	"While it runs: I stay here": "Pendant ce temps : je reste là",
	"While it runs: I'm away": "Pendant ce temps : je m'absente",
	"Anything else is asked about, as now.": "Pour le reste, une question, comme aujourd'hui.",
	"Anything else is refused at once; you get the list when the task ends.":
		"Le reste est refusé tout de suite ; vous en avez la liste à la fin de la tâche.",
	"Limits: the commands run, the files changed, the hosts sandboxed commands connect to, and the other tools, which still ask.":
		"Limite : les commandes lancées, les fichiers modifiés, les hôtes que joignent les commandes de la sandbox, et les autres outils, qui demandent toujours.",
	"Does not limit: reading files outside the project (except hidden folders), commands that run outside the sandbox, what an allowed program does with its connections.":
		"Ne limite pas : la lecture des fichiers hors du projet (sauf les dossiers masqués), les commandes lancées hors de la sandbox, ce qu'un programme autorisé fait de ses connexions.",
	"Limits: the commands run, the files changed, the hosts sandboxed commands connect to, and the other tools, which still ask. Reading stays limited to the project and what its tools need (/settings › What the agent reads).":
		"Limite : les commandes lancées, les fichiers modifiés, les hôtes que joignent les commandes de la sandbox, et les autres outils, qui demandent toujours. La lecture reste limitée au projet et à ce dont ses outils ont besoin (/settings › Ce que l'agent lit).",
	"Does not limit: commands that run outside the sandbox, what MCP and LSP servers and your browser read themselves, what an allowed program does with its connections.":
		"Ne limite pas : les commandes lancées hors de la sandbox, ce que lisent eux-mêmes les serveurs MCP et LSP et votre navigateur, ce qu'un programme autorisé fait de ses connexions.",
	Approve: "Approuver",
	Cancel: "Annuler",
	"↑↓ move · Enter choose · Esc cancel": "↑↓ se déplacer · Entrée choisir · Échap annuler",
	"runs any command in the sandbox, except dangerous ones":
		"lance toute commande dans la sandbox, sauf les dangereuses",
	"changes any file in the project": "modifie tout fichier du projet",
	"Run commands in the sandbox, except dangerous ones": "Lancer des commandes dans la sandbox, sauf les dangereuses",
	"Task scope ended. Outside it, Prism refused:": "Périmètre de tâche terminé. Hors de lui, Prism a refusé :",
	"refused while you were away": "refusé pendant votre absence",
	"refused again: already refused in this task": "refusé de nouveau : déjà refusé dans cette tâche",
	"you blocked it": "vous l'avez bloqué",
	"not answered": "sans réponse",
	"A task scope needs the interactive mode.": "Un périmètre de tâche demande le mode interactif.",
	"End the task scope now": "Terminer le périmètre maintenant",
	"Keep it": "Le garder",
	"you are away": "vous êtes absent",
	"you stay": "vous restez là",
	"Lets your next task change the project's files (and run sandboxed commands) without asking, for a set time, while you stay or go away. It limits the commands run, the files changed and the hosts sandboxed commands connect to, and reading stays limited to the project; it does not limit commands that run outside the sandbox, what MCP and LSP servers and your browser read themselves, or what an allowed program does with its connections (also /perm scope).":
		"Laisse votre prochaine tâche modifier les fichiers du projet (et lancer des commandes dans la sandbox) sans demander, pour une durée fixée, que vous restiez là ou non. Il limite les commandes lancées, les fichiers modifiés et les hôtes que joignent les commandes de la sandbox, et la lecture reste limitée au projet ; il ne limite pas les commandes lancées hors de la sandbox, ce que lisent eux-mêmes les serveurs MCP et LSP et votre navigateur, ni ce qu'un programme autorisé fait de ses connexions (aussi /perm scope).",
	"Lets your next task change the project's files (and run sandboxed commands) without asking, for a set time, while you stay or go away. It limits the commands run, the files changed and the hosts sandboxed commands connect to; it does not limit reading files outside the project (except hidden folders), commands that run outside the sandbox, or what an allowed program does with its connections (also /perm scope).":
		"Laisse votre prochaine tâche modifier les fichiers du projet (et lancer des commandes dans la sandbox) sans demander, pour une durée fixée, que vous restiez là ou non. Il limite les commandes lancées, les fichiers modifiés et les hôtes que joignent les commandes de la sandbox ; il ne limite pas la lecture des fichiers hors du projet (sauf les dossiers masqués), les commandes lancées hors de la sandbox, ni ce qu'un programme autorisé fait de ses connexions (aussi /perm scope).",
	// fork: keys filled at the call site, whose slots must not be translated (a command name, a count).
	"/{0} is not available in this session.": "/{0} n’est pas disponible dans cette session.",
	"{0} already {1}.": "{0} est déjà {1}.",
	"{0} — background {1}": "{0} — tâche en arrière-plan {1}",
	"{0} — waiting for you": "{0} — attend votre réponse",
	"{0} — done": "{0} — terminé",
	"{0} — test": "{0} — essai",
	"Loading {0}": "Chargement {0}",
	"{0}: {1} restored": "{0} : {1} restauré(s)",
	"{0} deleted": "{0} supprimé(s)",
	"{0} failed": "{0} en échec",
	"{0} file(s):": "{0} fichier(s) :",
	"path {0}": "chemin {0}",
	// fork: web.
	"Set the selected web search provider's API key or SearXNG URL. Optional provider: /web-key brave; remove: /web-key brave remove. Exa works without a key.":
		"Définir la clé d'API du service de recherche choisi ou l'URL SearXNG. Service facultatif : /web-key brave ; retirer : /web-key brave remove. Exa fonctionne sans clé.",
	"Usage: /web-key [exa|brave|tavily|firecrawl|searxng] [remove]":
		"Utilisation : /web-key [exa|brave|tavily|firecrawl|searxng] [remove]",
	"{0} key removed from auth.json.": "Clé {0} retirée de auth.json.",
	"{0} API key (saved in auth.json)": "Clé d’API {0} (enregistrée dans auth.json)",
	"{0} key": "clé {0}",
	"{0} key saved in auth.json.": "Clé {0} enregistrée dans auth.json.",
	"{0} is set and takes precedence.": "{0} est définie et prioritaire.",
	"SearXNG needs an http(s) base URL without credentials, a query or a fragment: /web-key searxng.":
		"SearXNG demande une URL de base http(s) sans identifiants, paramètres ni fragment : /web-key searxng.",
	// fork: memory.
	"Show memory, or update it from this session: /memory <instruction>":
		"Afficher la mémoire ou la mettre à jour depuis cette session : /memory <instruction>",
	"Show or update project-scoped memory: /memory-project <instruction>":
		"Afficher ou mettre à jour la mémoire du projet : /memory-project <instruction>",
	"Edit the global memory file": "Modifier le fichier de mémoire globale",
	"{0} is empty. Use /{1} <instruction> to fill it.": "{0} est vide. Utilisez /{1} <instruction> pour le remplir.",
	"{0} ({1} chars)": "{0} ({1} caractères)",
	"Updating global memory…": "Mise à jour de la mémoire globale…",
	"Updating project memory…": "Mise à jour de la mémoire du projet…",
	"No interface to edit memory. File: {0}": "Aucune interface pour modifier la mémoire. Fichier : {0}",
	"Global memory ({0})": "Mémoire globale ({0})",
	// fork: session-search.
	"Search past sessions (usage: /sessions [all] <keywords>)":
		"Rechercher dans les sessions passées (utilisation : /sessions [all] <keywords>)",
	"Usage: /sessions [all] <keywords>": "Utilisation : /sessions [all] <keywords>",
	"Search past sessions": "Chercher dans les sessions passées",
	keywords: "mots-clés",
	"Open a session": "Ouvrir une session",
	"{0} match(es) across {1} session(s)": "{0} résultat(s) dans {1} session(s)",
	// fork: consent before excerpts of other sessions reach a cloud model.
	"Send them this time": "Les envoyer cette fois",
	"Send them for the rest of this session": "Les envoyer pour le reste de la session",
	"Do not send them": "Ne pas les envoyer",
	"the model": "le modèle",
	"Send {0} excerpt(s) of {1} other session(s) to {2}? They may hold private work, held with another model or in another project.":
		"Envoyer {0} extrait(s) de {1} autre(s) session(s) à {2} ? Ils peuvent contenir un travail privé, mené avec un autre modèle ou dans un autre projet.",
	user: "utilisateur",
	toolResult: "résultat d'outil",
	// fork: file-browser.
	Files: "Fichiers",
	"  {0} marked": "  {0} sélectionné(s)",
	"(empty)": "(vide)",
	"enter add to message · tab mark": "Entrée ajouter au message · Tab sélectionner",
	"← back · esc close": "← retour · Échap fermer",
	"Browse the project's files and add them to your message (alt+e)":
		"Parcourir les fichiers du projet et les ajouter à votre message (alt+e)",
	// fork: produced files tab of the file browser.
	Produced: "Produits",
	"Files this session wrote or changed": "Fichiers écrits ou modifiés pendant cette session",
	"(nothing produced yet)": "(rien de produit pour l’instant)",
	"produced files": "fichiers produits",
	"project files": "fichiers du projet",
	"enter actions": "Entrée actions",
	"enter choose": "Entrée choisir",
	"esc back": "Échap retour",
	"esc close": "Échap fermer",
	"no longer there": "absent",
	"changed since": "modifié depuis",
	written: "écrit",
	edited: "modifié",
	"by a command": "par une commande",
	"command output": "sortie de commande",
	"Read in Prism": "Lire dans Prism",
	"Add to message": "Ajouter au message",
	"Copy the path": "Copier le chemin",
	"Open with the system's application": "Ouvrir avec l’application du système",
	"Copy to a folder": "Copier dans un dossier",
	"Not a regular file.": "Ce n’est pas un fichier ordinaire.",
	"The file is no longer there.": "Le fichier n’est plus là.",
	"Executable files are not opened, to avoid running them.":
		"Les fichiers exécutables ne sont pas ouverts, pour ne pas les lancer.",
	"Scripts and programs are not opened, to avoid running them.":
		"Les scripts et programmes ne sont pas ouverts, pour ne pas les lancer.",
	"Web pages are not opened in the browser, which would run their scripts: Prism shows their code.":
		"Les pages web ne s'ouvrent pas dans le navigateur, qui exécuterait leurs scripts : Prism montre leur code.",
	"The file cannot be read.": "Le fichier ne peut pas être lu.",
	"Not a folder.": "Ce n’est pas un dossier.",
	"This folder does not exist.": "Ce dossier n’existe pas.",
	"A file with this name is already there.": "Un fichier de ce nom s’y trouve déjà.",
	"Path copied: {0}": "Chemin copié : {0}",
	"Asked the system to open {0}": "Ouverture demandée au système : {0}",
	"Copy to which folder? (empty: your home folder)": "Copier dans quel dossier ? (vide : votre dossier personnel)",
	"Copied to {0}": "Copié dans {0}",
	// fork: compatible-server.
	"Could not add the server: {0}": "Impossible d'ajouter le serveur : {0}",
	"Which API format does your server support? (API: the format used to exchange requests and replies)":
		"Quel format d'API votre serveur accepte-t-il ? (API : format d'échange des requêtes et réponses)",
	"Server URL": "URL du serveur",
	"API key (the server's access key; leave empty if it does not require one)":
		"Clé d'API (clé d'accès du serveur ; laissez vide s'il n'en demande pas)",
	"Listing the server's models...": "Lecture de la liste des modèles du serveur…",
	"Name for this server (default {0})": "Nom de ce serveur (par défaut {0})",
	"This server is already added as {0}: Enter updates it, or type another name":
		"Ce serveur est déjà ajouté sous le nom {0} : Entrée le met à jour, ou tapez un autre nom",
	"Reading what the server says about its models...": "Lecture des capacités indiquées par le serveur…",
	"{0}, {1} slots": "{0}, {1} emplacements",
	"{0}: {1}{2}, vision {3}, tools {4}, reasoning {5}{6}": "{0} : {1}{2}, vision {3}, outils {4}, réflexion {5}{6}",
	"context {0}": "contexte {0}",
	"context unknown": "contexte inconnu",
	" (max {0})": " (max {0})",
	// fork: common interface paths; variable data is filled at the display site.
	Yes: "Oui",
	No: "Non",
	cost: "coût",
	"Session cwd not found": "Dossier de session introuvable",
	"Summarize branch?": "Résumer cette branche ?",
	"No summary": "Sans résumé",
	Summarize: "Résumer",
	"Summarize with custom prompt": "Résumer avec des consignes personnalisées",
	"Custom summarization instructions": "Consignes personnalisées du résumé",
	"Thinking level": "Niveau de réflexion",
	"Level of detail, language and where Prism opens": "Niveau de détail, langue et ouverture de Prism",
	"Safe mode: extensions, skills, prompt templates, themes and context files are not loaded. Restart without --safe to load them.":
		"Mode de secours : extensions, skills, modèles de prompt, thèmes et fichiers de contexte ne sont pas chargés. Redémarrez sans --safe pour les charger.",
	"This is a service of this machine: only this port opens, by any of its addresses.":
		"C'est un service de cette machine : seul ce port s'ouvre, par toutes ses adresses.",
	"{0} leads to {1}, on your local or private network (a router, a VPN such as Tailscale, a cloud metadata service): allowing it opens this name there only, not at another address.":
		"{0} mène à {1}, sur votre réseau local ou privé (une box, un VPN comme Tailscale, un service de métadonnées cloud) : l'autoriser n'ouvre ce nom que là, pas vers une autre adresse.",
	"This is Git over SSH, with your SSH keys: only Git's fetch and push to this host pass, no other command.":
		"C'est Git par SSH, avec vos clés SSH : seuls les échanges de Git avec cet hôte passent, aucune autre commande.",
	"Sandboxed commands reach only the hosts you allow.":
		"Les commandes dans la sandbox ne joignent que les hôtes que vous autorisez.",
	'These questions can be turned off: "sandbox": { "network": { "askNewHosts": false } } in settings.json. Hosts in "deny" stay blocked.':
		'Ces questions peuvent être désactivées : "sandbox": { "network": { "askNewHosts": false } } dans settings.json. Les hôtes dans « deny » restent bloqués.',
	"to expand": "pour déplier",
	"to collapse": "pour replier",
	"Thinking and tool output: expanded": "Réflexion et sorties d'outils : dépliées",
	"Thinking and tool output: collapsed": "Réflexion et sorties d'outils : repliées",
	"Wait for the current compaction or tree navigation to finish before navigating the session tree.":
		"Attendez la fin du résumé ou du déplacement en cours avant de parcourir l'arbre de session.",
	"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.":
		"/logout ne retire que les identifiants enregistrés par /login ; aucun à retirer. Les variables d’environnement et la configuration models.json restent inchangées.",
	"You can also use an AWS profile, IAM keys, or role-based credentials.":
		"Vous pouvez aussi utiliser un profil AWS, des clés IAM ou des identifiants liés à un rôle.",
	"See:": "Voir :",
	"Reloaded keybindings, extensions, skills, prompts, themes, and context files; saved project trust":
		"Raccourcis, extensions, skills, prompts, thèmes et fichiers de contexte rechargés ; confiance dans le projet enregistrée",
	"Reloaded keybindings, extensions, skills, prompts, themes, and context files":
		"Raccourcis, extensions, skills, prompts, thèmes et fichiers de contexte rechargés",
	"Import session": "Importer une session",
	"Show and manage background tasks": "Afficher et gérer les tâches en arrière-plan",
	"Forget finished background tasks": "Oublier les tâches en arrière-plan terminées",

	"Sandbox: state, writable and hidden paths, allowed hosts":
		"Sandbox : état, chemins inscriptibles et cachés, hôtes autorisés",
	"Show the current session state": "Afficher l’état de la session actuelle",
	"\n... ({0} more lines,": "\n... ({0} lignes de plus,",
	"\n... ({0} more lines, {1} total,": "\n... ({0} lignes de plus, {1} au total,",
	"... ({0} earlier lines,": "... ({0} lignes précédentes,",
	"Full output: {0}": "Sortie complète : {0}",
	"Truncated: showing {0} of {1} lines": "Tronqué : {0} lignes affichées sur {1}",
	"Truncated: {0} lines shown ({1} limit)": "Tronqué : {0} lignes affichées (limite de {1})",
	" ({0} to expand)": " ({0} pour déplier)",
	"... ({0} more lines,": "... ({0} lignes de plus,",
	"... ({0} more {1},": "... ({0} {1} de plus,",
	lines: "lignes",
	"... ({0} earlier calls,": "... ({0} appels précédents,",
	"Retrying ({0}/{1}) in {2}s... ({3} to cancel)": "Nouvelle tentative ({0}/{1}) dans {2}s… ({3} pour annuler)",
	"({0} to cancel)": "({0} pour annuler)",
	"Summarizing older messages to make room... {0}": "Résumé des anciens messages pour faire de la place… {0}",
	"{0}Automatically summarizing older messages... {1}": "{0}Résumé automatique des anciens messages… {1}",
	"The conversation exceeded the model's limit. ": "La conversation dépasse la limite du modèle. ",
	"Summarizing branch... ({0} to cancel)": "Résumé de la branche… ({0} pour annuler)",
	"  No user messages found": "  Aucun message utilisateur trouvé",
	"Fork from Message": "Créer une branche depuis un message",
	"Select a user message to copy the active path up to that point into a new session":
		"Choisissez un message utilisateur pour copier le parcours actif jusqu’à ce point dans une nouvelle session",
	"  Message {0} of {1}": "  Message {0} sur {1}",
	trusted: "approuvé",
	untrusted: "non approuvé",
	"Project trust": "Confiance dans le projet",
	"{0} (inherited from {1})": "{0} (hérité de {1})",
	"Saved decision: {0}": "Choix enregistré : {0}",
	"Current session: {0}": "Session actuelle : {0}",
	" [unavailable]": " [indisponible]",
	" ↑ {0} more ": " ↑ {0} de plus ",
	"Running... ({0} to cancel)": "Exécution… ({0} pour annuler)",
	"... {0} more lines (": "... {0} lignes de plus (",
	"(cancelled)": "(annulé)",
	"(exit {0})": "(code {0})",
	"Output truncated. Full output: {0}": "Sortie tronquée. Sortie complète : {0}",
	"[{0}] renderer failed: {1}": "[{0}] échec du rendu : {1}",
	" (+{0} more)": " (+{0} de plus)",
	"Mermaid diagram not rendered: {0}{1}": "Diagramme Mermaid non affiché : {0}{1}",
	"Error: {0}": "Erreur : {0}",
	"Operation aborted": "Opération interrompue",
	"Unknown error": "Erreur inconnue",
	"[conversation summary]": "[résumé de conversation]",
	"**Conversation summarized. Before summary: {0} tokens (units of text used by the model)**\n\n":
		"**Conversation résumée. Avant le résumé : {0} tokens (unités de texte du modèle)**\n\n",
	"Conversation summarized. Before: {0} tokens (text units); ":
		"Conversation résumée. Avant : {0} tokens (unités de texte) ; ",
	" to show summary": " pour voir le résumé",
	"[branch]": "[branche]",
	"**Branch Summary**\n\n": "**Résumé de branche**\n\n",
	"Branch summary ({0} to expand)": "Résumé de branche ({0} pour déplier)",
	"Jump to latest message": "Aller au dernier message",
	Working: "Travail en cours",
	interrupt: "interrompre",
	"↓ {0} more": "↓ {0} de plus",
	" (read-only)": " (lecture seule)",
	"sandbox not working": "sandbox en panne",
	"vision {0}, tool calls {1}, thinking {2}": "vision {0}, appels d’outils {1}, réflexion {2}",
	// fork: interactive notifications and reports.
	"{0} ({1} to interrupt)": "{0} ({1} pour interrompre)",
	"What's New": "Nouveautés",
	"... (widget truncated)": "... (widget tronqué)",
	"Copied!": "Copié !",
	"Copy failed": "Échec de la copie",
	"Update Available": "Mise à jour disponible",
	"Package Updates Available": "Mises à jour des extensions disponibles",
	"Packages:": "Extensions :",
	"Package updates are available. Run ": "Des mises à jour d’extensions sont disponibles. Lancez ",
	"Reloading keybindings, extensions, skills, prompts, themes, and context files...":
		"Rechargement des raccourcis, extensions, skills, prompts, thèmes et fichiers de contexte…",
	"No changelog entries found.": "Aucune nouveauté trouvée.",
	"Updated to v{0}. Use {1} to view full changelog.":
		"Version v{0} installée. Utilisez {1} pour voir toutes les nouveautés.",
	"Migrated credentials to auth.json: {0}": "Identifiants transférés dans auth.json : {0}",
	"Could not load model settings from models.json: {0}":
		"Impossible de charger les réglages de modèles depuis models.json : {0}",
	"{0} crashed on {1} ({2}).": "{0} s’est arrêté sur erreur le {1} ({2}).",
	"Crash details were saved to {0}/crashes.json.":
		"Les détails de l’erreur ont été enregistrés dans {0}/crashes.json.",
	"If this looks like a {0} bug, /bug sends a report to the developers.":
		"Si cela semble être un bug de {0}, /bug envoie un rapport aux développeurs.",
	"Shortcut handler error: {0}": "Erreur du gestionnaire de raccourci : {0}",
	'Extension "{0}" error: {1}': "Erreur de l’extension « {0} » : {1}",
	"Still unable to get a response after {0} attempts: {1}": "Toujours aucune réponse après {0} tentatives : {1}",
	"{0}: {1} tokens billed{2}": "{0} : {1} tokens facturés{2}",
	"{0} tokens re-billed{1}": "{0} tokens refacturés{1}",
	"Cache miss after {0}m idle": "Cache manqué après {0} min d’inactivité",
	"This project folder is untrusted. Its settings, extensions, and instructions were not loaded. Trust it later with /trust, then restart {0}.":
		"Ce dossier de projet n’est pas approuvé. Ses réglages, extensions et instructions n’ont pas été chargés. Approuvez-le avec /trust, puis redémarrez {0}.",
	" (thinking: {0})": " (réflexion : {0})",
	"Switched to {0}{1}": "Modèle actif : {0}{1}",
	"New version {0} is available. Run ": "La version {0} est disponible. Lancez ",
	"Steering: {0}": "Consigne : {0}",
	"Follow-up: {0}": "À suivre : {0}",
	"↳ {0} to edit all queued messages": "↳ {0} pour modifier tous les messages en attente",
	'Unknown thinking level "{0}". Available levels: {1}.':
		"Niveau de réflexion inconnu « {0} ». Niveaux disponibles : {1}.",
	"Default thinking level: {0}": "Niveau de réflexion par défaut : {0}",
	"Could not refresh {0}; searching cached models.":
		"Impossible d’actualiser {0} ; recherche dans les modèles en cache.",
	"Could not save project trust after reload: {0}":
		"Impossible d’enregistrer la confiance dans le projet après rechargement : {0}",
	"Saved trust decision: {0}. Restart {1} for this to take effect.":
		"Choix de confiance enregistré : {0}. Redémarrez {1} pour l’appliquer.",
	"Default model: {0}/{1}": "Modèle par défaut : {0}/{1}",
	"Could not read stored credentials: {0}": "Impossible de lire les identifiants enregistrés : {0}",
	"Removed stored API key for {0}. Environment variables and models.json config are unchanged.":
		"Clé d’API enregistrée retirée pour {0}. Les variables d’environnement et la configuration models.json restent inchangées.",
	"Credentials removed for {0}, but local model state could not be synchronized: {1}":
		"Identifiants retirés pour {0}, mais l’état local des modèles n’a pas pu être synchronisé : {1}",
	"Logout failed: {0}": "Échec de la déconnexion : {0}",
	"Logged in to {0}": "Connecté à {0}",
	"Connected to {0}": "Connecté à {0}",
	"Anthropic allows your Claude subscription in the unmodified Claude Code, but its terms do not say whether an app such as Prism may run it for you. Any risk to your Claude account is yours.":
		"Anthropic autorise votre abonnement Claude dans Claude Code non modifié, mais ses conditions ne disent pas si une application comme Prism peut le lancer pour vous. Le risque pour votre compte Claude est à votre charge.",
	"Anthropic's terms": "Conditions d'Anthropic",
	Connect: "Se connecter",
	"Claude Code (`claude`) is not on PATH. Install Claude Code, then try again.":
		"Claude Code (`claude`) est introuvable dans le PATH. Installez Claude Code, puis réessayez.",
	"Claude Code is not logged in. Run `claude` and log in there, then try again.":
		"Claude Code n'est pas connecté. Lancez `claude` et connectez-vous-y, puis réessayez.",
	"Saved API key for {0}": "Clé d’API enregistrée pour {0}",
	'{0}, but no default model is configured for provider "{1}". Use /model to select a model.':
		"{0}, mais aucun modèle par défaut n’est configuré pour le fournisseur « {1} ». Utilisez /model pour choisir un modèle.",
	"{0}, but no models are available for that provider. Use /model to select a model.":
		"{0}, mais aucun modèle n’est disponible pour ce fournisseur. Utilisez /model pour choisir un modèle.",
	'{0}, but its default model "{1}" is not available. Use /model to select a model.':
		"{0}, mais son modèle par défaut « {1} » est indisponible. Utilisez /model pour choisir un modèle.",
	"{0}, but selecting its default model failed: {1}. Use /model to select a model.":
		"{0}, mais le choix de son modèle par défaut a échoué : {1}. Utilisez /model pour choisir un modèle.",
	"{0}. Selected {1}. Credentials saved to {2}": "{0}. Modèle {1} sélectionné. Identifiants enregistrés dans {2}",
	"{0}. Credentials saved to {1}": "{0}. Identifiants enregistrés dans {1}",
	"{0}. Credentials saved to {1}. Refreshing model catalog…":
		"{0}. Identifiants enregistrés dans {1}. Actualisation de la liste des modèles…",
	"{0}, but its model catalog refresh timed out; using cached models.":
		"{0}, mais l’actualisation de sa liste de modèles a pris trop de temps ; modèles en cache utilisés.",
	"{0}, but its model catalog could not be refreshed; using cached models.":
		"{0}, mais sa liste de modèles n’a pas pu être actualisée ; modèles en cache utilisés.",
	"{0}, but its model catalog could not be refreshed: {1}":
		"{0}, mais sa liste de modèles n’a pas pu être actualisée : {1}",
	" Selected {0}.": " Modèle {0} sélectionné.",
	"Added {0} ({1} model) to {2}.{3} Use /model to choose a model.":
		"{0} ajouté ({1} modèle) dans {2}.{3} Utilisez /model pour choisir un modèle.",
	"Added {0} ({1} models) to {2}.{3} Use /model to choose a model.":
		"{0} ajouté ({1} modèles) dans {2}.{3} Utilisez /model pour choisir un modèle.",
	"{0} setup": "Configuration de {0}",
	"{0} is configured outside {1}.": "{0} se configure en dehors de {1}.",
	"API key saved for {0}, but the app could not update its model information: {1}":
		"Clé d’API enregistrée pour {0}, mais l’application n’a pas pu actualiser les informations des modèles : {1}",
	"Failed to save API key for {0}: {1}": "Impossible d’enregistrer la clé d’API pour {0} : {1}",
	"Logged in to {0}, but local model state could not be synchronized: {1}":
		"Connecté à {0}, mais l’état local des modèles n’a pas pu être synchronisé : {1}",
	"Configure {0} MCP in {1}?": "Configurer MCP pour {0} dans {1} ?",
	"Could not update {0}: {1}": "Impossible de mettre à jour {0} : {1}",
	"Replace current session with {0}?": "Remplacer la session actuelle par {0} ?",
	"/bug is disabled in {0}.": "/bug est désactivé dans {0}.",
	"Session name was normalized from {0} to {1}": "Le nom de session a été normalisé de {0} à {1}",
	"Session name: {0}": "Nom de session : {0}",
	"Session name set: {0}": "Nom de session enregistré : {0}",
	"1 time": "1 fois",
	"{0} times": "{0} fois",
	"Session compacted {0}": "Session résumée {0}",
	"Anthropic dropped {0} thinking block (details in session)":
		"Anthropic a retiré {0} bloc de réflexion (détails dans la session)",
	"Anthropic dropped {0} thinking blocks (details in session)":
		"Anthropic a retiré {0} blocs de réflexion (détails dans la session)",
	"Cache miss": "Cache manqué",
	"Cache miss after model switch": "Cache manqué après changement de modèle",
	Compaction: "Résumé de conversation",
	"Branch summary": "Résumé de branche",
	"Cache warmed{0}: {1}": "Cache maintenu{0} : {1}",
	"Failed to send queued message: {0}": "Impossible d’envoyer le message en attente : {0}",
	"Failed to send queued messages: {0}": "Impossible d’envoyer les messages en attente : {0}",
	" and ": " et ",
	", and ": " et ",
	"A stack frame came from loaded extension {0}, which may be involved. Try disabling it with `{1} config`, or run `{1} -ne` to confirm.":
		"Une ligne de la pile provient de l’extension chargée {0}, peut-être en cause. Essayez de la désactiver avec `{1} config`, ou lancez `{1} -ne` pour confirmer.",
	"A stack frame came from loaded extensions {0}, which may be involved. Try disabling them with `{1} config`, or run `{1} -ne` to confirm.":
		"Une ligne de la pile provient des extensions chargées {0}, peut-être en cause. Essayez de les désactiver avec `{1} config`, ou lancez `{1} -ne` pour confirmer.",
	"Session Info": "Informations de session",
	"Name:": "Nom :",
	"File:": "Fichier :",
	"In-memory": "En mémoire",
	"User:": "Utilisateur :",
	"Assistant:": "Assistant :",
	"Tools:": "Outils :",
	"Input:": "Entrée :",
	"Cached:": "En cache :",
	"Uncached:": "Hors cache :",
	"Output:": "Sortie :",
	"Total:": "Total :",
	"Cache Warming": "Maintien du cache",
	"Mode:": "Mode :",
	"Status:": "État :",
	"Inactive (cache warming unavailable)": "Inactif (maintien du cache indisponible)",
	"Cache miss penalty:": "Surcoût du cache manqué :",
	"Refresh cost:": "Coût d’actualisation :",
	"Cache Re-billed:": "Cache refacturé :",
	"{0} calls, {1} results": "{0} appels, {1} résultats",
	"({0} written to cache)": "({0} écrits dans le cache)",
	"1 miss": "1 cache manqué",
	"{0} misses": "{0} caches manqués",
	"[grep: /{0}/ in {1}]": "[grep: /{0}/ dans {1}]",
	"[find: {0} in {1}]": "[find: {0} dans {1}]",
	"Trust parent folder ({0})": "Approuver le dossier parent ({0})",
	Trust: "Approuver",
	"Do not trust": "Ne pas approuver",
	"Trust (this session only)": "Approuver (cette session seulement)",
	"Do not trust (this session only)": "Ne pas approuver (cette session seulement)",
	"Trust project folder?\n{0}\n\nThis allows {1} to load its settings, extensions, and project instructions, install missing project packages, and execute project extensions.":
		"Approuver le dossier du projet ?\n{0}\n\nCela permet à {1} de charger ses réglages, ses extensions et les instructions du projet, d’installer les paquets manquants du projet et d’exécuter ses extensions.",
	"Revert the file changes from the last model turn":
		"Annuler les modifications de fichiers du dernier tour du modèle",
	"List file checkpoints and rewind to one": "Lister les points de restauration de fichiers et revenir à l’un d’eux",
	"Install this project's language servers, turn them on or off; `all` lists every one":
		"Installer les serveurs de langage du projet, les activer ou les désactiver ; `all` les liste tous",
	"Which language servers are ready; `all` lists each one's command":
		"Les serveurs de langage prêts ; `all` liste la commande de chacun",
	"Show and correct the current model's name, context, output limit, sampling and other request parameters, next to the server's values":
		"Afficher et corriger le nom, le contexte, la limite de sortie, l’échantillonnage et les autres paramètres du modèle actuel, à côté des valeurs du serveur",
	"{0}. No llama.cpp models are loaded. Use /llama to load a model, then /model to select it.":
		"{0}. Aucun modèle llama.cpp n’est chargé. Utilisez /llama pour en charger un, puis /model pour le choisir.",
	"{0}. Use /model to select a loaded llama.cpp model, or /llama to manage models.":
		"{0}. Utilisez /model pour choisir un modèle llama.cpp chargé, ou /llama pour gérer les modèles.",
	Authentication: "Authentification",
	"Compaction would have nothing to summarize: it starts at {0} tokens and keeps the last {1} as they are. Raise the threshold percentage.":
		"Le résumé n’aurait rien à résumer : il démarre à {0} tokens et garde les {1} derniers tels quels. Augmentez le pourcentage du seuil.",
	'Failed to load theme "{0}": {1}': "Impossible de charger le thème « {0} » : {1}",
	"Fell back to the system theme.": "Retour au thème du système.",
	// fork: the menus, dialogs and notifications of the bundled Goal and Plan plug-ins
	// (src/fork/menu-i18n.ts), and the key hints of their menus.
	close: "fermer",
	details: "détails",
	scroll: "défiler",
	change: "modifier",
	"type to search": "tapez pour chercher",
	"Type to search": "Tapez pour chercher",
	Space: "Espace",
	"to change": "pour changer",
	"to go back": "pour revenir",
	paused: "en pause",
	waiting: "en attente",
	complete: "terminé",
	usage_limited: "limité par l'utilisation",
	budget_limited: "limité par le budget",
	On: "Activé",
	Off: "Désactivé",
	Unlimited: "Illimité",
	Goal: "Objectif",
	"Start a goal…": "Lancer un objectif…",
	"Start with token budget…": "Lancer avec un budget de jetons…",
	"Pause goal": "Mettre l'objectif en pause",
	"Resume goal": "Reprendre l'objectif",
	"Review and continue…": "Vérifier et continuer…",
	"Increase budget and resume…": "Augmenter le budget et reprendre…",
	"Edit goal…": "Modifier l'objectif…",
	"Replace goal…": "Remplacer l'objectif…",
	"View full status": "Voir l'état complet",
	"Settings…": "Réglages…",
	"Clear goal…": "Effacer l'objectif…",
	"Paused — automatic-work limit reached": "En pause — limite du travail automatique atteinte",
	"Progress is saved. Review the safety limit before continuing.":
		"La progression est enregistrée. Vérifiez la limite de sécurité avant de continuer.",
	"No goal is currently set": "Aucun objectif n'est défini",
	"No goal is currently set.": "Aucun objectif n'est défini.",
	"Automatic work is configured as Unlimited.": "Le travail automatique est réglé sur illimité.",
	"Choose token budget": "Choisir le budget de jetons",
	"25k — Lower token ceiling": "25k — plafond de jetons bas",
	"100k — Suggested": "100k — suggéré",
	"300k — Higher token ceiling": "300k — plafond de jetons haut",
	"Set a custom budget…": "Définir un budget personnalisé…",
	"Enter an exact cumulative token limit.": "Saisir une limite cumulée de jetons exacte.",
	"Custom token budget": "Budget de jetons personnalisé",
	"Increase token budget unavailable": "Augmentation du budget de jetons impossible",
	"No larger safe whole-number token budget is available. Progress remains saved; choose Back and clear or replace the goal when ready.":
		"Aucun budget entier plus grand n'est possible sans risque. La progression reste enregistrée ; choisissez Retour, puis effacez ou remplacez l'objectif quand vous voulez.",
	"Increase token budget": "Augmenter le budget de jetons",
	"The budget-limited goal is no longer available. Return to the Goal menu.":
		"L'objectif limité par son budget n'existe plus. Revenez au menu Objectif.",
	"Automatic work paused": "Travail automatique en pause",
	"The objective and usage are preserved.": "L'objectif et l'utilisation sont conservés.",
	"Continuing resets the counter to 0 and resumes with Unlimited automatic work.":
		"Continuer remet le compteur à 0 et reprend avec un travail automatique illimité.",
	"The paused goal is no longer available. Return to the Goal menu.":
		"L'objectif en pause n'existe plus. Revenez au menu Objectif.",
	"Continue — Unlimited": "Continuer — illimité",
	"Change automatic-work limit…": "Changer la limite du travail automatique…",
	"Goal status": "État de l'objectif",
	"Goal help": "Aide de l'objectif",
	"Goal menu": "Menu Objectif",
	"Use the menu for guided status, edits, settings, and confirmations.":
		"Le menu guide pour l'état, les modifications, les réglages et les confirmations.",
	"Direct routes remain available for deterministic workflows:":
		"Les commandes directes restent disponibles pour les usages prévisibles :",
	"/goal <objective>": "/goal <objectif>",
	"/goal --tokens 100k <objective>": "/goal --tokens 100k <objectif>",
	"Escape cancels the current menu or input without changing goal state.":
		"Échap annule le menu ou la saisie en cours sans changer l'objectif.",
	"Enter a positive token amount, for example 25k, 300k, or 1.5m.":
		"Saisissez un nombre de jetons positif, par exemple 25k, 300k ou 1.5m.",
	"Enter a positive token amount, for example 300k, 1.5m, or 300000.":
		"Saisissez un nombre de jetons positif, par exemple 300k, 1.5m ou 300000.",
	"Increase goal budget?": "Augmenter le budget de l'objectif ?",
	"Goal objective": "Énoncé de l'objectif",
	"Set the maximum cumulative token usage for this goal.":
		"Fixez l'utilisation cumulée maximale de jetons pour cet objectif.",
	"The final model call may exceed the limit; this is not a dollar-cost cap.":
		"Le dernier appel au modèle peut dépasser la limite ; ce n'est pas un plafond de coût.",
	"Enter the maximum cumulative token usage for this goal.":
		"Saisissez l'utilisation cumulée maximale de jetons pour cet objectif.",
	"Examples: 25k, 300k, 1.5m, or 300000.": "Exemples : 25k, 300k, 1.5m ou 300000.",
	"The final model call may exceed this value; this is not a dollar-cost cap.":
		"Le dernier appel au modèle peut dépasser cette valeur ; ce n'est pas un plafond de coût.",
	"Automatic work has no response-count cap.": "Le travail automatique n'a pas de plafond de réponses.",
	"Examples: 300k, 1.5m, or 300000.": "Exemples : 300k, 1.5m ou 300000.",
	"Automatic work: Unlimited after resume": "Travail automatique : illimité après la reprise",
	"The goal will resume immediately.": "L'objectif reprendra immédiatement.",
	"Edit goal objective": "Modifier l'énoncé de l'objectif",
	"Apply goal edit?": "Appliquer la modification de l'objectif ?",
	"Current goal:": "Objectif actuel :",
	"Updated goal:": "Objectif modifié :",
	"Applying this edit starts a new guarded goal instance.":
		"Appliquer cette modification lance une nouvelle instance surveillée de l'objectif.",
	"Clear goal?": "Effacer l'objectif ?",
	"Remove this goal:": "Supprimer cet objectif :",
	"This cannot be undone.": "Cette action est irréversible.",
	"Replace goal?": "Remplacer l'objectif ?",
	"The goal changed or its usage changed while the budget dialog was open. Reopen /goal and try again.":
		"L'objectif ou son utilisation a changé pendant que la fenêtre du budget était ouverte. Rouvrez /goal et réessayez.",
	"The active goal changed while the dialog was open. Reopen /goal and try again.":
		"L'objectif actif a changé pendant que la fenêtre était ouverte. Rouvrez /goal et réessayez.",
	"Safety pause: no progress. Progress is saved; open /goal to review and continue.":
		"Pause de sécurité : aucun progrès. La progression est enregistrée ; ouvrez /goal pour vérifier et continuer.",
	"Pi Goal Settings": "Réglages de Pi Goal",
	"Pi Goal Settings · Read only": "Réglages de Pi Goal · lecture seule",
	"Automatic-work limit": "Limite du travail automatique",
	"Pause automatic Goal work after a visible number of model responses.":
		"Met en pause le travail automatique de l'objectif après un nombre affiché de réponses du modèle.",
	"No-progress guard": "Garde-fou sans progrès",
	"Pause after repeated or empty tool-free automatic runs.":
		"Met en pause après des passages automatiques répétés ou vides, sans outil.",
	"Managed run RPC": "Pilotage RPC des passages",
	"Allow trusted installed extensions to start and cancel Goal runs; this is not an extension sandbox.":
		"Autorise les extensions installées de confiance à lancer et annuler les passages de l'objectif ; ce n'est pas une sandbox d'extensions.",
	"No response-count cap. Completion, manual pause, blockers, provider limits, and other configured guards still apply.":
		"Pas de plafond de réponses. La fin de l'objectif, la pause manuelle, les blocages, les limites du fournisseur et les autres garde-fous réglés s'appliquent toujours.",
	"Set response limit…": "Fixer la limite de réponses…",
	"Unlimited…": "Illimité…",
	"Pause after the default number of repeated or empty tool-free runs.":
		"Met en pause après le nombre par défaut de passages répétés ou vides, sans outil.",
	"Set threshold…": "Fixer le seuil…",
	"Choose a whole number of repeated or empty runs before pausing.":
		"Choisir un nombre entier de passages répétés ou vides avant la pause.",
	"Do not pause based on repeated or empty tool-free runs.":
		"Pas de pause pour des passages répétés ou vides, sans outil.",
	"The active goal changed while the safety setting was open. No settings were changed.":
		"L'objectif actif a changé pendant que le réglage de sécurité était ouvert. Aucun réglage n'a changé.",
	"The active goal changed while editing the safety setting. No settings were changed.":
		"L'objectif actif a changé pendant la modification du réglage de sécurité. Aucun réglage n'a changé.",
	"The active goal changed while confirming the limit. No settings were changed.":
		"L'objectif actif a changé pendant la confirmation de la limite. Aucun réglage n'a changé.",
	"Allow Unlimited automatic work?": "Autoriser un travail automatique illimité ?",
	"Tool loops can continue without a response-count limit and may consume substantial tokens and provider cost. Completion, manual pause, blockers, provider limits, and the no-progress guard still apply.":
		"Les boucles d'outils peuvent continuer sans limite de réponses et consommer beaucoup de jetons et de coût chez le fournisseur. La fin de l'objectif, la pause manuelle, les blocages, les limites du fournisseur et le garde-fou sans progrès s'appliquent toujours.",
	"Repeated-run threshold (whole number greater than 0)": "Seuil de passages répétés (nombre entier supérieur à 0)",
	"Positive whole number": "Nombre entier positif",
	"Apply limit and pause now?": "Appliquer la limite et mettre en pause maintenant ?",
	"No active goal.": "Aucun objectif actif.",
	"No active goal. Use /goal <objective> to start one.": "Aucun objectif actif. Lancez-en un avec /goal <objectif>.",
	"The active goal changed while confirmation was open. Try again.":
		"L'objectif actif a changé pendant la confirmation. Réessayez.",
	"Export plan": "Exporter le plan",
	"Existing paths are never overwritten.": "Les chemins existants ne sont jamais écrasés.",
	"Active implementation plan": "Plan d'implémentation actif",
	"Show active implementation plan": "Afficher le plan d'implémentation actif",
	"Export plan…": "Exporter le plan…",
	"Start a new plan": "Commencer un nouveau plan",
	"Clear active implementation plan": "Effacer le plan d'implémentation actif",
	"Implement here keeps this planning conversation.": "Implémenter ici garde cette conversation de planification.",
	"Start fresh transfers only the approved plan to a new session.":
		"Repartir de zéro ne transmet que le plan approuvé à une nouvelle session.",
	"Show latest proposed plan": "Afficher le dernier plan proposé",
	"Implement here": "Implémenter ici",
	"Continue in this session with the planning conversation.":
		"Continuer dans cette session, avec la conversation de planification.",
	"Start fresh and implement": "Repartir de zéro et implémenter",
	"Configure one-shot model and thinking choices first.": "Choisir d'abord le modèle et la réflexion pour cette fois.",
	"Save for later": "Garder pour plus tard",
	"Stay in Plan mode": "Rester en mode Plan",
	"Discard plan and exit": "Abandonner le plan et quitter",
	"Request final plan": "Demander le plan final",
	"Exit Plan mode": "Quitter le mode Plan",
	"Proposed plan ready. What next?": "Plan proposé prêt. Et ensuite ?",
	"Fresh implementation settings": "Réglages de la nouvelle implémentation",
	"These choices apply once to the new implementation session.":
		"Ces choix valent une seule fois, pour la nouvelle session d'implémentation.",
	"Start fresh implementation": "Lancer la nouvelle implémentation",
	"Create the linked session and begin implementation.": "Créer la session liée et commencer l'implémentation.",
	"Starting fresh implementation session…": "Lancement de la nouvelle session d'implémentation…",
	"Same as plan": "Comme le plan",
	"same as plan": "comme le plan",
	inherit: "hérité",
	"Off — conversation history only": "Coupée — historique de la conversation seul",
	"Through first implementation run": "Jusqu'à la fin de la première implémentation",
	"Until manually cleared": "Jusqu'à effacement manuel",
	"Implementation model": "Modèle d'implémentation",
	"Implementation thinking level": "Niveau de réflexion de l'implémentation",
	"Start Plan mode": "Lancer le mode Plan",
	"Choose tools, then start…": "Choisir les outils, puis lancer…",
	"How Plan mode works": "Fonctionnement du mode Plan",
	"Choose Plan policy allowlist": "Choisir les outils autorisés en mode Plan",
	"Policy changes apply only when you start Plan mode; first use may also reveal Plan helpers.":
		"Les changements s'appliquent au lancement du mode Plan ; la première fois, ses outils d'aide peuvent aussi apparaître.",
	"Active tools can be chosen now; retained names resolve before the first request.":
		"Les outils actifs se choisissent maintenant ; les noms retenus sont résolus avant la première requête.",
	"Plan mode never activates tools, and non-built-ins run at user risk.":
		"Le mode Plan n'active jamais d'outil, et ceux qui ne sont pas intégrés s'exécutent à vos risques.",
	"Done — start with this policy": "Terminé — lancer avec ces outils",
	"Plan mode uses read-only exploration to understand the project before implementation.":
		"Le mode Plan explore le projet en lecture seule pour le comprendre avant l'implémentation.",
	"The agent can ask important decision questions, then returns a complete implementation-ready plan.":
		"L'agent peut poser les questions de décision importantes, puis rend un plan complet, prêt à implémenter.",
	"File mutation stays blocked until you explicitly choose to implement the completed plan.":
		"Les modifications de fichiers restent bloquées tant que vous ne choisissez pas d'implémenter le plan terminé.",
	"Saved plan": "Plan gardé",
	"Show saved plan": "Afficher le plan gardé",
	"Open a new linked session; transfer only the approved plan.":
		"Ouvrir une nouvelle session liée ; ne transmettre que le plan approuvé.",
	"Clear saved plan": "Effacer le plan gardé",
	"Plan Mode Settings": "Réglages du mode Plan",
	"Plan Mode Settings · Read only": "Réglages du mode Plan · lecture seule",
	"Plan thinking": "Réflexion du plan",
	"Set the thinking level when the next Plan workflow starts.":
		"Fixe le niveau de réflexion au prochain lancement du mode Plan.",
	"Plan policy tools": "Outils autorisés en mode Plan",
	"Choose active tools or retain names to resolve before the first request.":
		"Choisir des outils actifs ou retenir des noms à résoudre avant la première requête.",
	"Plan reinjection": "Réinjection du plan",
	"Choose how long Plan mode restores the exact plan when ordinary context no longer contains it.":
		"Choisir combien de temps le mode Plan restaure le plan exact quand le contexte ne le contient plus.",
	"Fresh model": "Modèle (nouvelle session)",
	"Choose the default model for a fresh implementation session.":
		"Choisir le modèle par défaut d'une nouvelle session d'implémentation.",
	"Fresh thinking": "Réflexion (nouvelle session)",
	"Choose the default thinking level for a fresh implementation session.":
		"Choisir le niveau de réflexion par défaut d'une nouvelle session d'implémentation.",
	"Export destination": "Destination de l'export",
	"Set the destination used when an export omits its path.":
		"Fixe la destination utilisée quand un export ne donne pas de chemin.",
	"Plan mode shortcut": "Raccourci du mode Plan",
	"Saved TUI shortcut. Changes require /reload or restarting Pi; the current binding stays unchanged.":
		"Raccourci enregistré. Un changement demande /reload ou un redémarrage ; le raccourci actuel reste le même.",
	"Default Plan policy allowlist": "Outils autorisés par défaut en mode Plan",
	"Changes apply when a later Plan workflow starts; model-visible tools stay unchanged.":
		"Les changements s'appliquent au prochain lancement du mode Plan ; les outils visibles du modèle ne changent pas.",
	"Retained inactive names resolve before that workflow's first request.":
		"Les noms inactifs retenus sont résolus avant la première requête de ce lancement.",
	"Use automatic safe built-ins": "Utiliser les outils intégrés sûrs",
	"Fresh implementation model": "Modèle de la nouvelle implémentation",
	"Same as plan is the default and fallback when a configured model is unavailable.":
		"« Comme le plan » est le choix par défaut, et le repli quand le modèle choisi n'est pas disponible.",
	"Submit an empty value to reset to PLAN.md. Changes affect the next export.":
		"Validez un champ vide pour revenir à PLAN.md. Les changements valent pour le prochain export.",
	"TUI only. Use Pi key identifiers; Pi may reject conflicting shortcuts.":
		"Terminal seulement. Utilisez les noms de touches ; un raccourci en conflit peut être refusé.",
	"Submit an empty value to remove the saved shortcut.":
		"Validez un champ vide pour supprimer le raccourci enregistré.",
	"Run /reload or restart Pi to apply changes; the current binding stays unchanged until then.":
		"Lancez /reload ou redémarrez pour appliquer ; le raccourci actuel reste le même d'ici là.",
	"Plan defaults apply to the next workflow; reinjection and export choices apply to their next action.":
		"Les réglages par défaut valent pour le prochain lancement ; la réinjection et l'export, pour leur prochaine action.",
	"The settings file is invalid.": "Le fichier de réglages est invalide.",
	"Use the planning session model.": "Utiliser le modèle de la session de planification.",
	"Automatic safe built-ins": "Outils intégrés sûrs",
	"No optional tools": "Aucun outil facultatif",
	"No description available": "Aucune description",
	"Not active yet; retained and resolved before the first request":
		"Pas encore actif ; retenu et résolu avant la première requête",
	"Not active in Pi; Plan mode will not activate it": "Inactif ; le mode Plan ne l'activera pas",
	"Blocked by Plan-mode policy": "Bloqué par le mode Plan",
	"Not usable in Plan mode": "Inutilisable en mode Plan",
	"Status: Off — visible Plan helpers stay inactive until /plan starts.":
		"État : coupé — les outils d'aide du Plan restent inactifs jusqu'au lancement de /plan.",
	"Status: Off — required Plan helpers are unavailable under the active tool policy.":
		"État : coupé — les outils d'aide nécessaires au Plan ne sont pas disponibles avec les outils actifs.",
	"Plan mode is active and a proposed plan is ready.": "Le mode Plan est actif et un plan proposé est prêt.",
	"Plan mode is active.": "Le mode Plan est actif.",
	"Model-visible tools stay unchanged.": "Les outils visibles du modèle ne changent pas.",
	"Explore, ask, and finish with plan_mode_complete when decision-ready.":
		"Explorez, posez vos questions, et terminez avec plan_mode_complete quand tout est décidé.",
	"A plan is saved for later.": "Un plan est gardé pour plus tard.",
	"An implementation plan is active.": "Un plan d'implémentation est actif.",
	"Plan mode is off.": "Le mode Plan est coupé.",
	"Plan reinjection: Off; use conversation history only.":
		"Réinjection du plan : coupée ; seul l'historique de la conversation sert.",
	"Plan reinjection: Through the first implementation run.":
		"Réinjection du plan : jusqu'à la fin de la première implémentation.",
	"Plan reinjection: Until /plan exit.": "Réinjection du plan : jusqu'à /plan exit.",
	"1 run": "1 passage",
	// Plan's widget/status and the labels added by pi-tui-kit.
	"Plan mode: planning": "Mode Plan : planification",
	"Finish with plan_mode_complete when decision-ready.": "Terminez avec plan_mode_complete quand tout est décidé.",
	"Proposed plan ready": "Plan proposé prêt",
	"Use /plan to implement, save, revise, or exit Plan mode.":
		"Utilisez /plan pour implémenter, garder, réviser ou quitter le mode Plan.",
	"Plan saved for later": "Plan gardé pour plus tard",
	"Use /plan to show, implement, or clear it.": "Utilisez /plan pour l'afficher, l'implémenter ou l'effacer.",
	"Implementation plan active": "Plan d'implémentation actif",
	"Use /plan to show, replace, or clear it.": "Utilisez /plan pour l'afficher, le remplacer ou l'effacer.",
	"plan active": "plan actif",
	"plan ready": "plan prêt",
	"plan saved": "plan gardé",
	"plan implementing": "plan en implémentation",
	"built-in read-only": "intégré, lecture seule",
	"built-in limited": "intégré, limité",
	"built-in blocked": "intégré, bloqué",
	"not active yet; retained for first-request resolution": "pas encore actif ; retenu pour la première requête",
	"not active in this Pi session": "inactif dans cette session",
	"pending registration · Retained and resolved before the first request":
		"en attente d'enregistrement · Retenu et résolu avant la première requête",
	"pending registration · Retained and resolved before the first Plan request":
		"en attente d'enregistrement · Retenu et résolu avant la première requête du Plan",
	"Not registered yet; reset defaults to remove retained names":
		"Pas encore enregistré ; réinitialisez les réglages pour retirer les noms retenus",
	"Not registered yet; Plan mode will not activate it and will resolve it before the first request":
		"Pas encore enregistré ; le mode Plan ne l'activera pas et le résoudra avant la première requête",
	"(unnamed tool)": "(outil sans nom)",
	"unknown model": "modèle inconnu",
	"unknown provider": "fournisseur inconnu",
	Unavailable: "Indisponible",
	"  Unavailable": "  Indisponible",
	"  No items available": "  Aucun élément disponible",
	"  No matching items": "  Aucun résultat",
	"  No choices available": "  Aucun choix disponible",
	"  No matching choices": "  Aucun choix ne correspond",
	// pi-tui-kit's fixed parts around a value (src/fork/menu-i18n.ts, translateKitText).
	"(unavailable) ": "(indisponible) ",
	"  Unavailable: ": "  Indisponible : ",
	"Unavailable: ": "Indisponible : ",
	"unavailable: ": "indisponible : ",
	" ✓ current": " ✓ actuel",
	" (unavailable)": " (indisponible)",
	// Plan's labels built around a value: named slots, filled by the plug-in (prismFill), never matched as patterns.
	"user opt-in: {source}": "activation volontaire : {source}",
	"{model} · same as plan": "{model} · comme le plan",
	"{level} · same as plan": "{level} · comme le plan",
	"same as plan · {model} unavailable": "comme le plan · {model} indisponible",
	"1 selected": "1 sélectionné",
	"{count} selected": "{count} sélectionnés",
	"Plan policy will allow: {tools}.": "Le mode Plan autorisera : {tools}.",
	"Pending registration: {tools}, +{count} more.": "En attente d'enregistrement : {tools}, +{count} autres.",
	"Pending registration: {tools}.": "En attente d'enregistrement : {tools}.",
	"Plan policy allows: {tools}. Model-visible tools stay unchanged.":
		"Le mode Plan autorise : {tools}. Les outils visibles du modèle ne changent pas.",
	"Enter or manage Codex-like Plan mode": "Entrer dans le mode Plan (façon Codex) ou le gérer",
	"configured model": "modèle configuré",
	"settings path is not a regular file": "le chemin des réglages n'est pas un fichier ordinaire",
	"settings file is not valid UTF-8": "le fichier de réglages n'est pas en UTF-8 valide",
	// Notifications of the bundled Plan plug-in.
	"Fresh implementation requires the interactive /plan command. Reopen /plan and try again.":
		"La nouvelle implémentation demande la commande interactive /plan. Rouvrez /plan et réessayez.",
	"No completed plan is available to implement.": "Aucun plan terminé à implémenter.",
	"Fresh implementation cancelled. The plan remains available.":
		"Nouvelle implémentation annulée. Le plan reste disponible.",
	"Unable to implement the plan: no model is selected.":
		"Impossible d'implémenter le plan : aucun modèle n'est choisi.",
	"The configured fresh implementation model is unavailable; using the planning model.":
		"Le modèle choisi pour la nouvelle implémentation n'est pas disponible ; celui de la planification est utilisé.",
	"No completed plan is available. Use /plan finalize when planning is complete.":
		"Aucun plan terminé. Lancez /plan finalize quand la planification est finie.",
	"A plan is saved for later. Implement or clear it before starting another Plan-mode workflow.":
		"Un plan est gardé pour plus tard. Implémentez-le ou effacez-le avant de relancer le mode Plan.",
	"Unable to implement saved plan: no model is selected.":
		"Impossible d'implémenter le plan gardé : aucun modèle n'est choisi.",
	"Plan mode disabled. Proposed plan discarded.": "Mode Plan coupé. Plan proposé abandonné.",
	"Saved plan cleared.": "Plan gardé effacé.",
	"Plan mode is already active.": "Le mode Plan est déjà actif.",
	"Plan mode enabled. I will explore and plan, but not modify files.":
		"Mode Plan activé. J'explore et je planifie, sans modifier de fichiers.",
	"Active implementation plan cleared.": "Plan d'implémentation actif effacé.",
	"Plan mode disabled.": "Mode Plan coupé.",
	"Plan-mode tools are locked while Planning is active. Exit Plan mode and choose tools before starting again.":
		"Les outils du mode Plan sont verrouillés pendant la planification. Quittez le mode Plan et choisissez les outils avant de relancer.",
	"invalid JSON": "JSON invalide",
	"invalid settings shape": "forme de réglages invalide",
	"Wait for fresh implementation startup to admit the pending prompts before changing branches.":
		"Attendez que la nouvelle implémentation ait pris en compte les messages en attente avant de changer de branche.",
	"Plan mode transition markers are internal. Select the adjacent conversation entry instead.":
		"Les marqueurs de transition du mode Plan sont internes. Choisissez plutôt l'entrée voisine de la conversation.",
	"the block is empty": "le bloc est vide",
	"more than one plan block was produced": "plusieurs blocs de plan ont été produits",
	"the tags must be on their own lines": "les balises doivent être seules sur leur ligne",
	"the closing tag is missing": "la balise fermante manque",
	"plan must be a string": "le plan doit être un texte",
	"plan must not be empty": "le plan ne doit pas être vide",
	"Plan finalization ended twice without a structured question or completed plan. Plan mode remains active; revise the plan or run /plan finalize again.":
		"La finalisation du plan s'est terminée deux fois sans question structurée ni plan terminé. Le mode Plan reste actif ; révisez le plan ou relancez /plan finalize.",
	"Plan mode is not active. Use /plan first.": "Le mode Plan n'est pas actif. Lancez d'abord /plan.",
	"No completed plan is available to save.": "Aucun plan terminé à garder.",
	"Plan saved for later. Plan mode disabled.": "Plan gardé pour plus tard. Mode Plan coupé.",
	"Plan mode disabled. No proposed plan is available to implement.":
		"Mode Plan coupé. Aucun plan proposé à implémenter.",
	"Plan mode enabled with the selected tools.": "Mode Plan activé avec les outils choisis.",
	// What "Cannot {0} while an agent run is active…" names, after « Impossible de ».
	"start Plan mode": "lancer le mode Plan",
	"leave or clear Plan mode": "quitter ou effacer le mode Plan",
	"save the plan and leave Plan mode": "garder le plan et quitter le mode Plan",
	"start plan implementation": "lancer l'implémentation du plan",
	"export the ready plan and leave Plan mode": "sortir le plan prêt dans un fichier et quitter le mode Plan",
	"Another workflow is active in this session. End it before starting Plan mode.":
		"Un autre flux de travail est actif dans cette session. Terminez-le avant de lancer le mode Plan.",
	"Plan mode was not restored because another workflow is active in this session. Reload or start Plan mode after it ends.":
		"Le mode Plan n'a pas été restauré, car un autre flux de travail est actif dans cette session. Rechargez, ou lancez le mode Plan quand il sera terminé.",
	"Plan mode was not restored because its helper tools are unavailable under the active tool policy.":
		"Le mode Plan n'a pas été restauré, car ses outils d'aide ne sont pas disponibles avec les outils actifs.",
	"plan_mode_question and plan_mode_complete are unavailable; include them in the active tool allowlist or leave the restrictive tool mode before starting Plan mode":
		"plan_mode_question et plan_mode_complete ne sont pas disponibles ; ajoutez-les aux outils actifs autorisés ou quittez le mode d'outils restreint avant de lancer le mode Plan",
	"No completed plan is available to export. Use /plan finalize when planning is complete.":
		"Aucun plan terminé à exporter. Lancez /plan finalize quand la planification est finie.",
	"Plan export path must not be empty.": "Le chemin de l'export ne doit pas être vide.",
	"Plan export path must not contain NUL bytes.": "Le chemin de l'export ne doit pas contenir d'octet NUL.",
	"Default Plan export destination reset to PLAN.md.": "Destination par défaut de l'export du plan remise à PLAN.md.",
	"Default Plan-mode tools: automatic safe built-ins.": "Outils par défaut du mode Plan : outils intégrés sûrs.",
	"Default Plan policy: no optional tools.": "Outils autorisés par défaut en mode Plan : aucun outil facultatif.",
	"Plan mode shortcut removal saved. Run /reload or restart Pi to apply; the current binding is unchanged.":
		"Suppression du raccourci du mode Plan enregistrée. Lancez /reload ou redémarrez pour appliquer ; le raccourci actuel reste le même.",
	// The footer hint of pi-tui-kit's check-box lists (Plan's settings) and of /config: "Enter toggle".
	toggle: "cocher/décocher",

	// fork: the Secret Service keyring, /doctor and warnings.
	Keyring: "Trousseau",
	"Some credentials in the keyring could not be read.": "Des identifiants du trousseau n'ont pas pu être lus.",
	"Confirmed: secret-tool failed; the keyring may be locked or stopped.":
		"Confirmé : secret-tool a échoué ; le trousseau est peut-être verrouillé ou arrêté.",
	"Unlock the keyring, then restart Prism, or log in again with /login.":
		"Déverrouillez le trousseau puis relancez Prism, ou reconnectez-vous avec /login.",
	"Some credentials were not saved: the keyring is there but did not take them.":
		"Des identifiants n'ont pas été enregistrés : le trousseau est là mais ne les a pas acceptés.",
	"Confirmed: secret-tool failed while saving them; the keyring may be locked or busy.":
		"Confirmé : secret-tool a échoué en les enregistrant ; le trousseau est peut-être verrouillé ou occupé.",
	"Unlock the keyring, then log in again with /login.":
		"Déverrouillez le trousseau, puis reconnectez-vous avec /login.",
	"New credentials were saved in clear in auth.json because there is no keyring.":
		"De nouveaux identifiants ont été enregistrés en clair dans auth.json, car il n'y a pas de trousseau.",
	"Confirmed: no Secret Service on the session bus, or secret-tool is missing.":
		"Confirmé : pas de Secret Service sur le bus de session, ou secret-tool est absent.",
	"Check that a Secret Service keyring (GNOME Keyring, KWallet) runs and is unlocked, then log in again with /login.":
		"Vérifiez qu'un trousseau Secret Service (GNOME Keyring, KWallet) tourne et est déverrouillé, puis reconnectez-vous avec /login.",
	"Some credentials are in the keyring, which this session cannot reach.":
		"Des identifiants sont dans le trousseau, que cette session ne peut pas joindre.",
	"No keyring in this session: new credentials are saved in auth.json.":
		"Pas de trousseau dans cette session : les nouveaux identifiants sont enregistrés dans auth.json.",
	"Confirmed: no D-Bus session bus, or PRISM_SECRET_SERVICE=off.":
		"Confirmé : pas de bus de session D-Bus, ou PRISM_SECRET_SERVICE=off.",
	"Start Prism in a desktop session with a Secret Service keyring to keep new credentials out of auth.json.":
		"Lancez Prism dans une session de bureau avec un trousseau Secret Service pour garder les nouveaux identifiants hors d'auth.json.",
	"New credentials are saved in the keyring (Secret Service).":
		"Les nouveaux identifiants sont enregistrés dans le trousseau (Secret Service).",
	"Hypothesis: a D-Bus session bus is present; the keyring answers at the next read or login.":
		"Hypothèse : un bus de session D-Bus est présent ; le trousseau répondra à la prochaine lecture ou connexion.",
	"Credentials already in auth.json stay there; no action required.":
		"Les identifiants déjà dans auth.json y restent ; aucune action requise.",
	"secret-tool is not installed (package libsecret or libsecret-tools)":
		"secret-tool n'est pas installé (paquet libsecret ou libsecret-tools)",
	"the keyring did not answer in time; it may be locked":
		"le trousseau n'a pas répondu à temps ; il est peut-être verrouillé",
	"the keyring has no such item, or it is locked": "le trousseau n'a pas cet élément, ou il est verrouillé",
	"the keyring item is not a credential": "l'élément du trousseau n'est pas un identifiant",
	"the keyring is not available in this session": "aucun trousseau n'est disponible dans cette session",
	"secret-tool failed": "secret-tool a échoué",
	// fork: moving the credentials in clear to the keyring, /settings › Permissions & sandbox.
	"Move credentials to the keyring": "Déplacer les identifiants vers le trousseau",
	"Credentials saved in clear in auth.json before the keyring was used move to the keyring only from here, after a confirmation.":
		"Les identifiants enregistrés en clair dans auth.json avant l'usage du trousseau n'y passent que d'ici, après confirmation.",
	"none in clear": "aucun en clair",
	"Credentials saved before the keyring was used are still in clear in auth.json. Each one is stored in the keyring and read back before auth.json keeps only a marker; one that fails stays in clear. References to a command or a variable stay.":
		"Les identifiants enregistrés avant l'usage du trousseau sont encore en clair dans auth.json. Chacun est enregistré dans le trousseau et relu avant qu'auth.json n'en garde qu'un marqueur ; un échec le laisse en clair. Les références à une commande ou à une variable restent.",
	"No keyring in this session: nothing can be moved.":
		"Pas de trousseau dans cette session : rien ne peut être déplacé.",
	"Esc back": "Échap retour",
	"No credential in clear in auth.json.": "Aucun identifiant en clair dans auth.json.",
	"OAuth tokens": "Jetons OAuth",
	"Moving to the keyring…": "Déplacement vers le trousseau…",
	"Unlock the keyring if needed, then open this page again to retry.":
		"Déverrouillez le trousseau si besoin, puis rouvrez cette page pour réessayer.",
	"Enter or Esc closes": "Entrée ou Échap ferme",
	"the keyring gave back another value": "le trousseau a rendu une autre valeur",
	// fork.9 (CAP-02): /export-zip.
	"outside the project folder": "hors du dossier du projet",
	"may hold credentials": "peut contenir des identifiants",
	"a symbolic link": "un lien symbolique",
	"not a regular file": "pas un fichier ordinaire",
	"a symbolic link in its path": "un lien symbolique dans son chemin",
	"could not be read": "illisible",
	"changed while being read": "modifié pendant la lecture",
	"the archive's size limit is reached": "la taille maximale de l'archive est atteinte",
	"the archive's entry limit is reached": "le nombre maximal d'entrées de l'archive est atteint",
	"Export chosen sessions and files as a portable ZIP archive":
		"Exporter les sessions et fichiers choisis dans une archive ZIP portable",
	"/export-zip needs the interactive terminal.": "/export-zip demande le terminal interactif.",
	"No saved session to export in this project.": "Aucune session enregistrée à exporter dans ce projet.",
	"Sessions to export": "Sessions à exporter",
	"No session chosen: nothing exported.": "Aucune session choisie : rien n'a été exporté.",
	"Files to include (none by default)": "Fichiers à inclure (aucun par défaut)",
	"Not analysed: messages, tool results and files may contain personal or confidential data, and the paths of this machine.":
		"Non analysé : les messages, résultats d'outils et fichiers peuvent contenir des données personnelles ou confidentielles, et les chemins de cette machine.",
	"Create the archive": "Créer l'archive",
	"Portable export": "Export portable",
	"parameters changed": "paramètres modifiés",
	"description changed": "description modifiée",
	"its earlier version could not be read": "sa version précédente n'a pas pu être lue",
	"Accept the new version": "Accepter la nouvelle version",
	Refuse: "Refuser",
	"The earlier approval does not cover this version. The permission rules still apply after.":
		"L'accord précédent ne couvre pas cette version. Les règles de permission s'appliquent ensuite.",
	// sandbox settings that cannot be read.
	"The file is not valid JSON.": "Le fichier n'est pas du JSON valide.",
	"The file is not a JSON object.": "Le fichier n'est pas un objet JSON.",
	"Until the file is fixed, every tool call and command is refused, so that hidden paths, blocked hosts and other limits cannot be lost.":
		"Tant qu'il n'est pas réparé, chaque appel d'outil et chaque commande est refusé, pour que les chemins masqués, les hôtes bloqués et les autres limites ne soient pas perdus.",
	"Fix the file, or remove it to start from the defaults: Prism uses it again as soon as it can be read.":
		"Réparez le fichier, ou supprimez-le pour repartir des valeurs par défaut : Prism le reprend dès qu'il est lisible.",
	"cannot be read": "illisible",
	// Engine interface text and native screens.
	init: "initialiser",
	Share: "Partager",
	"broad (default)": "large (par défaut)",
	"Uploading to Radius...": "Envoi vers Radius…",
	"Creating gist...": "Création du gist…",
	"Share cancelled": "Partage annulé",
	"GitHub CLI is not logged in. Run 'gh auth login' first.":
		"GitHub CLI n’est pas connecté. Lancez d’abord 'gh auth login'.",
	"GitHub CLI (gh) is not installed. Install it from https://cli.github.com/":
		"GitHub CLI (gh) n’est pas installé. Installez-le depuis https://cli.github.com/",
	"Failed to parse gist ID from gh output": "Impossible de lire l’identifiant du gist dans la sortie de gh",
	"Unknown checkpoint turn.": "Tour de restauration inconnu.",
	"Stop the current turn before restoring files.": "Arrêtez le tour en cours avant de restaurer les fichiers.",
	"Checkpoints changed. Review the files again before restoring.":
		"Les points de restauration ont changé. Vérifiez à nouveau les fichiers avant de les restaurer.",
	"Permissions: mode, default, rules (menu); alt+m cycles the mode":
		"Permissions : mode, default, rules (menu) ; alt+m change de mode",
	"(no output yet)": "(aucune sortie pour l’instant)",
	"(none)": "(aucun)",
	"Modes with the sandbox": "Modes avec la sandbox",
	"Shell commands are blocked until it works; nothing runs outside it.":
		"Les commandes shell sont bloquées tant qu’elle ne fonctionne pas ; rien ne s’exécute en dehors.",
	"Fix it as said above, then choose Check the sandbox again in /settings › Permissions & sandbox, or turn it off for this mode under In modes.":
		"Corrigez le problème comme indiqué ci-dessus, puis choisissez Vérifier la sandbox à nouveau dans /settings › Permissions et sandbox, ou désactivez-la pour ce mode sous Dans les modes.",
	Writable: "Accessible en écriture",
	"Read-only inside them": "En lecture seule à l’intérieur",
	"Git in a private copy": "Git dans une copie privée",
	Hidden: "Masqués",
	"asks for each new host": "demande pour chaque nouvel hôte",
	"new hosts pass without a question": "les nouveaux hôtes passent sans question",
	"System D-Bus and Unix sockets: blocked": "D-Bus système et sockets Unix : bloqués",
	"System D-Bus: commands read the state of services, other calls are refused; Unix sockets: blocked":
		"D-Bus système : les commandes lisent l'état des services, les autres appels sont refusés ; sockets Unix : bloqués",
	"Your ! commands": "Vos commandes !",
	"in the sandbox": "dans la sandbox",
	"outside it": "en dehors",
	"Commands run outside": "Commandes exécutées en dehors",
	"Kept Git copies": "Copies Git conservées",
	"Git repositories that would run programs, to check before running Git there":
		"Dépôts Git qui lanceraient des programmes, à vérifier avant d'y lancer Git",
	"A command made or changed Git repositories whose hooks or configuration run programs: {0}. Git run there outside Prism (git status, your shell prompt, your editor) would run them. Check them first; /sandbox lists them.":
		"Une commande a créé ou modifié des dépôts Git dont les hooks ou la configuration lancent des programmes : {0}. Git lancé là hors de Prism (git status, l'invite de votre shell, votre éditeur) les lancerait. Vérifiez-les d'abord ; /sandbox les liste.",
	"kept, its changes were refused": "conservée, ses changements ont été refusés",
	"not checked": "non vérifiée",
	"in use by a background task": "utilisée par une tâche en arrière-plan",
	"provenance unreadable": "provenance illisible",
	Folder: "Dossier",
	"background task": "tâche en arrière-plan",
	command: "commande",
	"its Prism ended before this background task did, so its Git changes were not checked":
		"son Prism s’est arrêté avant la fin de cette tâche en arrière-plan, donc ses changements Git n’ont pas été vérifiés",
	"its Prism ended (stopped, killed or crashed) before this command did, so its Git changes were not checked":
		"son Prism s’est arrêté (interruption, arrêt forcé ou plantage) avant la fin de cette commande, donc ses changements Git n’ont pas été vérifiés",
	"Prism was opened in your home folder: shell commands stay blocked here.":
		"Prism a été ouvert dans votre dossier personnel : les commandes du terminal y restent bloquées.",
	"Open Prism in a project folder (cd into it first). Details: /docs sandbox.":
		"Ouvrez Prism dans un dossier de projet (placez-vous d'abord dedans avec cd). Détails : /docs sandbox.",
	"Shell commands stay blocked until it works; nothing runs outside it.":
		"Les commandes shell restent bloquées tant qu’elle ne fonctionne pas ; rien ne s’exécute en dehors.",
	"Once it is fixed, choose Check the sandbox again in /sandbox. To go without it in this mode, turn it off there, under In modes.":
		"Une fois le problème corrigé, choisissez Vérifier la sandbox à nouveau dans /sandbox. Pour vous en passer dans ce mode, désactivez-la sous Dans les modes.",
	"Start Plan mode without sending a prompt": "Lancer le mode Plan sans envoyer de message",
	"Show the ready, saved, or active plan": "Afficher le plan prêt, gardé ou actif",
	"Request a completed plan": "Demander un plan terminé",
	"Implement the completed or saved plan": "Implémenter le plan terminé ou gardé",
	"Save the completed plan for later": "Garder le plan terminé pour plus tard",
	"Open Plan mode settings": "Ouvrir les réglages du mode Plan",
	"Export the stored plan to a Markdown file": "Exporter le plan gardé dans un fichier Markdown",
	"Leave Plan mode or clear a saved/active plan": "Quitter le mode Plan ou effacer un plan gardé ou actif",
	"Choose tools before starting this Plan workflow": "Choisir les outils avant de lancer ce travail en mode Plan",
	"Set a token budget before the goal": "Fixer un budget de tokens avant l’objectif",
	"Pause the active goal": "Mettre l’objectif actif en pause",
	"Resume a stopped or budget-limited goal": "Reprendre un objectif arrêté ou limité par son budget",
	"Clear the current goal": "Effacer l’objectif actuel",
	"Edit the current goal objective": "Modifier l’énoncé de l’objectif actuel",
	"Show the current goal": "Afficher l’objectif actuel",
	"Set a token budget before the updated goal": "Fixer un budget de tokens avant l’objectif modifié",
	"Run a goal to completion: /goal [--tokens 100k] <goal_to_complete>":
		"Poursuivre un objectif jusqu’à sa réalisation : /goal [--tokens 100k] <goal_to_complete>",
	"Inspect context usage, system prompt, tools, messages, and full LLM context in a tabbed overlay":
		"Inspecter l’utilisation du contexte, le prompt système, les outils, les messages et le contexte complet du modèle dans une vue à onglets",
	"Manage MCP servers: sign in, reconnect, enable or disable, and change exposure":
		"Gérer les serveurs MCP : se connecter, reconnecter, activer ou désactiver et changer l’exposition des outils",
	"Show shared LSP extension configuration": "Afficher la configuration partagée de l’extension LSP",
	"Manage llama.cpp router models": "Gérer les modèles du routeur llama.cpp",
	// the /mcp manager.
	manage: "gérer",
	"unknown error": "erreur inconnue",
	"needs sign-in": "connexion requise",
	starting: "démarrage",
	"connecting…": "connexion…",
	connecting: "connexion",
	connected: "connecté",
	Enable: "Activer",
	Disable: "Désactiver",
	Reconnect: "Reconnecter",
	"Sign out": "Se déconnecter",
	Exposure: "Exposition",
	unreachable: "inaccessibles",
	"opens the browser": "ouvre le navigateur",
	"deletes the stored credentials": "supprime les identifiants enregistrés",
	"for this session": "pour cette session",
	"saved to mcp.json": "enregistré dans mcp.json",
	"This server is no longer configured.": "Ce serveur n'est plus configuré.",
	"The server offers no tools.": "Le serveur ne propose aucun outil.",
	"Some tools override it with toolExposure.": "Certains outils la remplacent avec toolExposure.",
	"called from codemode scripts, which find them with searchTools()":
		"appelés depuis les scripts codemode, qui les trouvent avec searchTools()",
	"not declared until tool_search loads them, then called directly; no codemode needed":
		"non déclarés tant que tool_search ne les charge pas, puis appelés directement ; codemode n'est pas nécessaire",
	"declared to the model like built-in tools": "déclarés au modèle comme les outils intégrés",
	"Contacting the authorization server…": "Contact du serveur d'autorisation…",
	"Connecting…": "Connexion…",
	"Reconnecting…": "Reconnexion…",
	"Disconnecting…": "Déconnexion…",
	"Loading…": "Chargement…",
	"Nothing to show.": "Rien à afficher.",
	"MCP server": "Serveur MCP",
	"Approve access in your browser. If it did not open, visit:":
		"Autorisez l'accès dans votre navigateur. S'il ne s'est pas ouvert, allez sur :",
	"If the browser runs on another machine, paste the URL it was redirected to:":
		"Si le navigateur est sur une autre machine, collez l'URL vers laquelle il a été redirigé :",
	"Sign-in cancelled.": "Connexion annulée.",
	"No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.":
		"Aucun serveur MCP activé n'utilise OAuth. Seuls les serveurs HTTP sans en-tête Authorization l'utilisent.",
	"No enabled MCP server to reconnect.": "Aucun serveur MCP activé à reconnecter.",
	"MCP servers are still connecting; their tools become available once connected.":
		"Les serveurs MCP sont encore en cours de connexion ; leurs outils seront disponibles une fois connectés.",
	"Usage: /mcp, /mcp add, /mcp login [server], /mcp logout [server], /mcp reconnect [server]":
		"Utilisation : /mcp, /mcp add, /mcp login [serveur], /mcp logout [serveur], /mcp reconnect [serveur]",
	"disconnected, reconnects on next call": "déconnecté, se reconnecte au prochain appel",
	// the Goal status (pi-goal fork, formatStatus).
	"automatic Unlimited": "automatique illimité",
	"automatic {turns}/{limit}": "automatique {turns}/{limit}",
	"waiting {reason} · {automatic}": "en attente : {reason} · {automatic}",
	"paused · previous automatic limit at {turns}": "en pause · ancienne limite automatique à {turns}",
	"paused · automatic {turns}/{limit}": "en pause · automatique {turns}/{limit}",
	"paused · automatic limit {turns}/{limit}": "en pause · limite automatique {turns}/{limit}",
	"paused · {automatic}": "en pause · {automatic}",
	"blocked · {automatic}": "bloqué · {automatic}",
	"usage · {automatic}": "limite d'usage · {automatic}",
	"budget {budget} · {automatic}": "budget {budget} · {automatic}",
	"active {budget} · {automatic}": "actif {budget} · {automatic}",
	"active {duration} · {automatic}": "actif {duration} · {automatic}",
	// the ask_user_question tool's dialog (its i18n bridge falls back on Prism's catalog).
	"Type something.": "Écrire autre chose.",
	"Submit answers": "Envoyer les réponses",
	"Enter to select": "Entrée pour choisir",
	"↑/↓ to navigate": "↑/↓ pour parcourir",
	"Shift+Enter for newline": "Maj+Entrée pour aller à la ligne",
	"Ctrl+U to clear": "Ctrl+U pour effacer",
	"Space to toggle": "Espace pour cocher/décocher",
	"n to add notes": "n pour ajouter des notes",
	"Tab to switch questions": "Tab pour changer de question",
	"{key} to collapse": "{key} pour replier",
	"{key} to expand · Esc to cancel": "{key} pour déplier · Échap pour annuler",
	"Esc to cancel": "Échap pour annuler",
	"Review your answers": "Relisez vos réponses",
	"Ready to submit your answers?": "Envoyer vos réponses ?",
	"⚠ Answer remaining questions before submitting:": "⚠ Répondez aux questions restantes avant d'envoyer :",
	"n to add a note": "n pour ajouter une note",
	Note: "Note",
	"No preview available": "Aucun aperçu",
	"Notes: press n to add notes": "Notes : appuyez sur n pour en ajouter",
	"Notes:": "Notes :",
	"Global note:": "Note générale :",
	"External editor failed": "L'éditeur externe a échoué",
	'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.':
		"Entrez les numéros de toutes les réponses qui conviennent, séparés par des virgules (par exemple « 1,3 »), ou écrivez votre propre réponse.",
	"Type your answer:": "Votre réponse :",
	"--- {n}. {option} preview ---": "--- Aperçu de {n}. {option} ---",
	// going back, and the review, in the window's questions.
	"← Previous question": "← Question précédente",
	"Change {n}. {question}": "Modifier {n}. {question}",
	"(no answer)": "(sans réponse)",
	// pi-lsp activity status.
	fix: "correction",
	// engine errors shown in the window (O06).
	"No model available for summarization": "Aucun modèle disponible pour le résumé",
	"No model selected": "Aucun modèle choisi",
	"Cannot clone session: no current entry selected": "Impossible de dupliquer la session : aucune entrée choisie",
	"Session name cannot be empty": "Le nom de session ne peut pas être vide",
	// fork: /fork's whole-conversation entry.
	"The whole conversation, as it is now": "Toute la conversation, telle qu'elle est",
	"Copy it into a new session, up to its last reply":
		"La copier dans une nouvelle session, jusqu'à la dernière réponse",
	// where Prism opens (src/fork/launch-interface.ts).
	"This installation has no window: Prism opens in the terminal.":
		"Cette installation n'a pas de fenêtre : Prism s'ouvre dans le terminal.",
	"No graphical display here: Prism opens in the terminal.":
		"Pas d'affichage graphique ici : Prism s'ouvre dans le terminal.",
	"Prism now has a window. How should it open from now on?":
		"Prism a maintenant une fenêtre. Comment l'ouvrir désormais ?",
	"In its window": "Dans sa fenêtre",
	"In the terminal": "Dans le terminal",
	"Prism is in the applications menu.": "Prism est dans le menu des applications.",
	"Prism could not be added to the applications menu: {0}":
		"Prism n'a pas pu être ajouté au menu des applications : {0}",
	"Change it in /settings › Interface; prism --tui or prism --gui choose for one launch.":
		"Modifiable dans /settings › Interface ; prism --tui ou prism --gui choisissent pour un lancement.",
	"Prism opened in its window.": "Prism s'est ouvert dans sa fenêtre.",
	"the window stopped ({0})": "la fenêtre s'est arrêtée ({0})",
	"exit code {0}": "code de sortie {0}",
	"{0}; whole log: {1}": "{0} ; journal complet : {1}",
	"The window needs glibc 2.39 or newer (Debian 13, Ubuntu 24.04, Fedora 40 or newer), which this system does not have: Prism opens in the terminal.":
		"La fenêtre demande glibc 2.39 ou plus récent (Debian 13, Ubuntu 24.04, Fedora 40 ou plus récent), que ce système n'a pas : Prism s'ouvre dans le terminal.",
	"The window could not open ({0}): Prism opens in the terminal.":
		"La fenêtre n'a pas pu s'ouvrir ({0}) : Prism s'ouvre dans le terminal.",
	"The window does not take {0} yet: Prism opens in the terminal.":
		"La fenêtre ne reprend pas encore {0} : Prism s'ouvre dans le terminal.",
	"Open Prism in": "Ouvrir Prism dans",
	"Where a plain prism command opens. prism --tui and prism --gui choose for one launch; the window needs a graphical display.":
		"Où s'ouvre une simple commande prism. prism --tui et prism --gui choisissent pour un lancement ; la fenêtre demande un affichage graphique.",
	"Applications menu entry": "Entrée dans le menu des applications",
	"Update the model catalog": "Mettre à jour le catalogue des modèles",
	"Downloads the list of each signed-in provider's models from pi.dev (the site of pi, which Prism is built on) at startup, in /model and after /login, at most every 4 hours, so new models appear without a Prism update. Off, only prism update --models downloads it.":
		"Télécharge depuis pi.dev (le site de pi, sur lequel Prism est construit) la liste des modèles de chaque fournisseur connecté, au démarrage, dans /model et après /login, au plus toutes les 4 heures : les nouveaux modèles apparaissent sans mise à jour de Prism. Désactivé, seul prism update --models la télécharge.",
	"A Prism entry in your desktop's applications menu, which opens the window.":
		"Une entrée Prism dans le menu des applications du bureau, qui ouvre la fenêtre.",
	// /browser, the user's browser linked through the Prism extension.
	"Link Prism to your browser: /browser (status), /browser setup, /browser resume, /browser firefox":
		"Relier Prism à votre navigateur : /browser (état), /browser setup, /browser resume, /browser firefox",
	"Close Firefox first: Prism starts it again with remote control for real clicks.":
		"Fermez d’abord Firefox : Prism le relance avec le contrôle à distance pour de vrais clics.",
	"Start Firefox with remote control?": "Lancer Firefox avec le contrôle à distance ?",
	"Prism starts Firefox with WebDriver BiDi on a local port, so the agent's clicks and keys in its own tabs are real input. Prism's sandbox refuses this port to the agent's commands. Firefox started the usual way goes back to clicks by script.":
		"Prism lance Firefox avec WebDriver BiDi sur un port local : les clics et les touches de l’agent dans ses propres onglets deviennent de vraies entrées. La sandbox de Prism refuse ce port aux commandes de l’agent. Firefox lancé de la façon habituelle revient aux clics par script.",
	"Firefox started with remote control on port {0}. Real clicks start once the Prism extension connects.":
		"Firefox lancé avec le contrôle à distance sur le port {0}. Les vrais clics commencent dès que l’extension Prism se connecte.",
	"Could not start Firefox: {0}": "Impossible de lancer Firefox : {0}",
	"Could not declare the browser host: {0}": "Impossible de déclarer l’hôte du navigateur : {0}",
	"Host declared for: {0}": "Hôte déclaré pour : {0}",
	"No supported browser found in your home folder (Chromium, Chrome, Brave, Vivaldi, Edge, Helium, Firefox, Zen, or one of them in Flatpak).":
		"Aucun navigateur pris en charge dans votre dossier personnel (Chromium, Chrome, Brave, Vivaldi, Edge, Helium, Firefox, Zen, ou l’un d’eux en Flatpak).",
	"Chrome, Chromium, Brave, Vivaldi, Edge: install the Prism extension from the Chrome Web Store: {0}":
		"Chrome, Chromium, Brave, Vivaldi, Edge : installez l’extension Prism depuis le Chrome Web Store : {0}",
	"Firefox, Zen and other Firefox-based browsers: install the Prism extension from addons.mozilla.org: {0}":
		"Firefox, Zen et les autres navigateurs basés sur Firefox : installez l’extension Prism depuis addons.mozilla.org : {0}",
	"Without the store, Chromium family: open chrome://extensions, turn on Developer mode, choose Load unpacked and select {0}.":
		"Sans la boutique, famille Chromium : ouvrez chrome://extensions, activez le mode développeur, choisissez « Charger l’extension non empaquetée » et sélectionnez {0}.",
	"Without the store, Firefox family: open about:debugging#/runtime/this-firefox, choose Load Temporary Add-on and select manifest.json in {0} (removed at each restart).":
		"Sans la boutique, famille Firefox : ouvrez about:debugging#/runtime/this-firefox, choisissez « Charger un module complémentaire temporaire » et sélectionnez manifest.json dans {0} (retiré à chaque redémarrage).",
	"Let {0} start Prism outside its sandbox?": "Autoriser {0} à lancer Prism hors de sa sandbox ?",
	"The Prism extension reaches Prism through flatpak-spawn --host. Prism runs: flatpak override --user --talk-name=org.freedesktop.Flatpak {0}. With it, this browser can start any program on your computer outside its sandbox, not only Prism. Undo with: flatpak override --user --no-talk-name=org.freedesktop.Flatpak {0}.":
		"L’extension Prism joint Prism par flatpak-spawn --host. Prism lance : flatpak override --user --talk-name=org.freedesktop.Flatpak {0}. Avec cette autorisation, ce navigateur peut lancer n’importe quel programme de votre ordinateur hors de sa sandbox, pas seulement Prism. Pour l’annuler : flatpak override --user --no-talk-name=org.freedesktop.Flatpak {0}.",
	"{0}: declared, but it cannot reach Prism until it may leave its sandbox.":
		"{0} : déclaré, mais il ne pourra joindre Prism qu’une fois autorisé à sortir de sa sandbox.",
	"{0}: may now start Prism. Restart it.": "{0} : peut maintenant lancer Prism. Redémarrez-le.",
	"{0}: flatpak override failed: {1}": "{0} : échec de flatpak override : {1}",
	"The agent can use the browser again.": "L’agent peut de nouveau utiliser le navigateur.",
	"No linked browser to resume.": "Aucun navigateur relié à reprendre.",
	"Usage: /browser [setup|resume|firefox]": "Utilisation : /browser [setup|resume|firefox]",
	"No browser linked. Run /browser setup, then add the Prism extension to your browser.":
		"Aucun navigateur relié. Lancez /browser setup, puis ajoutez l’extension Prism à votre navigateur.",
	"Linked browsers:": "Navigateurs reliés :",
	"real clicks": "vrais clics",
	"clicks by script": "clics par script",
	"stopped by you: /browser resume": "arrêté par vous : /browser resume",
	"/browser: the agent opens and uses web pages in your own browser, in tabs of its own, through the Prism extension.":
		"/browser : l’agent ouvre et utilise des pages web dans votre propre navigateur, dans ses propres onglets, par l’extension Prism.",
	"Your browser (Prism extension)": "Votre navigateur (extension Prism)",
	"/desktop: the agent uses graphical programs on a desktop of its own, with its own pointer and keyboard, apart from yours. Needs labwc.":
		"/desktop : l’agent utilise des programmes graphiques sur un bureau à lui, avec son propre pointeur et son propre clavier, à l’écart du vôtre. Nécessite labwc.",
	"The agent's own desktop": "Le bureau de l’agent",
	"Your desktop": "Votre bureau",
	"The agent may use your own screen, pointer and keyboard when you ask it to and agree in Prism's dialog, until you take them back (your shortcut, or moving the mouse). Needs Hyprland, GNOME or KDE.":
		"L’agent peut utiliser votre propre écran, votre pointeur et votre clavier quand vous le lui demandez et l’acceptez dans la fenêtre de Prism, jusqu’à ce que vous les repreniez (votre raccourci, ou en bougeant la souris). Nécessite Hyprland, GNOME ou KDE.",
	"needs a Wayland session (Hyprland, GNOME or KDE)": "nécessite une session Wayland (Hyprland, GNOME ou KDE)",
	"The agent's own desktop: /desktop (live view, or status), /desktop stop":
		"Le bureau de l’agent : /desktop (vue en direct, ou état), /desktop stop",
	"· {0}×{1}": "· {0}×{1}",
	"Could not capture the desktop: {0}": "Capture du bureau impossible : {0}",
	"esc close · /desktop stop stops the desktop": "échap fermer · /desktop stop arrête le bureau",
	"The agent's desktop is not running.": "Le bureau de l’agent n’est pas lancé.",
	"The agent's desktop is stopped.": "Le bureau de l’agent est arrêté.",
	"The agent's desktop is not running. The agent starts it when it needs it.":
		"Le bureau de l’agent n’est pas lancé. L’agent le lance quand il en a besoin.",
	"The agent's desktop runs: {0}x{1}.": "Le bureau de l’agent tourne : {0}×{1}.",
	"The agent's desktop is off.": "Le bureau de l’agent est désactivé.",
	"You have your desktop back.": "Vous avez repris la main sur votre bureau.",
	"Let the agent use your desktop?": "Laisser l’agent utiliser votre bureau ?",
	"Let the agent start this program on your desktop?\n{0}":
		"Laisser l’agent lancer ce programme sur votre bureau ?\n{0}",
	"Yes, and do not ask again in this session": "Oui, et ne plus demander dans cette session",
	"The agent will move your pointer and type on your screen until it gives it back. Take it back at any time: {0}, or move the mouse for {1} seconds.":
		"L’agent va déplacer votre pointeur et taper sur votre écran jusqu’à ce qu’il vous le rende. Reprenez la main à tout moment : {0}, ou bougez la souris pendant {1} secondes.",
	// fork: what the agreement gives besides the pointer and the keyboard, in red.
	"Until it gives your desktop back, the agent can also start programs and run commands with your rights, outside the sandbox, without another question.":
		"Tant qu’il ne vous a pas rendu votre bureau, l’agent peut aussi lancer des programmes et des commandes avec vos droits, hors de la sandbox, sans autre question.",
	"Prism: the agent has your desktop. {0} or move the mouse to take it back.":
		"Prism : l’agent a la main sur votre bureau. {0} ou bougez la souris pour la reprendre.",
	"The agent has your desktop · {0} to take it back": "L’agent a la main sur votre bureau · {0} pour la reprendre",
	"The agent has your desktop ({0}). Take it back: {1}, or /desktop stop.":
		"L’agent a la main sur votre bureau ({0}). Pour la reprendre : {1}, ou /desktop stop.",
	"The agent will move your pointer and type on your screen until it gives it back. Your desktop then asks what to share: choose the screen and allow remote interaction. Take it back at any time: stop the sharing from your desktop, {0}, or move the mouse for {1} seconds.":
		"L’agent va déplacer votre pointeur et taper sur votre écran jusqu’à ce qu’il vous le rende. Votre bureau demande ensuite quoi partager : choisissez l’écran et autorisez l’interaction à distance. Reprenez la main à tout moment : arrêtez le partage depuis votre bureau, {0}, ou bougez la souris pendant {1} secondes.",
	"The agent has your desktop · stop the sharing or move the mouse to take it back":
		"L’agent a la main sur votre bureau · arrêtez le partage ou bougez la souris pour la reprendre",
	"The agent has your desktop. Take it back: {0}, or /desktop stop.":
		"L’agent a la main sur votre bureau. Pour la reprendre : {0}, ou /desktop stop.",
	"stop the sharing from your desktop": "arrêtez le partage depuis votre bureau",
	"labwc is not installed (Fedora, Debian, Ubuntu, Arch: package labwc)":
		"labwc n’est pas installé (Fedora, Debian, Ubuntu, Arch : paquet labwc)",
	"prism-desktop-helper is missing from this installation": "prism-desktop-helper manque dans cette installation",
	// confirmations that apply only to the state they showed.
	"It changed during the question three times in a row; nothing was done.":
		"L’état a changé pendant la question trois fois de suite ; rien n’a été fait.",
	"Checkpoints changed during the question three times in a row; nothing was restored.":
		"Les points de restauration ont changé pendant la question trois fois de suite ; rien n’a été restauré.",
	'This project\'s mcp.json also defines "{0}": that one is used in this project.':
		"Le mcp.json de ce projet définit aussi « {0} » : c’est celui-là qui sert dans ce projet.",
	"This entry changed or was removed meanwhile; nothing was removed.":
		"Cette entrée a changé ou a été retirée entre-temps ; rien n’a été retiré.",
	"The list changed; this is the entry you chose.": "La liste a changé ; voici l’entrée que vous aviez choisie.",
	"The task is not the one its summary showed. Review it again before creating it.":
		"La tâche n’est plus celle que montrait son résumé. Revoyez-la avant de la créer.",
	"Global memory ({0}) changed while you edited it: merge what was saved meanwhile, shown at the end, then save":
		"La mémoire globale ({0}) a changé pendant votre modification : reprenez ce qui a été enregistré entre-temps, affiché à la fin, puis enregistrez",
	"----- Saved meanwhile (merge what you need above, then delete from this line) -----":
		"----- Enregistré entre-temps (reprenez ce qu’il faut au-dessus, puis supprimez à partir de cette ligne) -----",
	"Global memory changed during the edit three times in a row; it was not saved.":
		"La mémoire globale a changé pendant la modification trois fois de suite ; elle n’a pas été enregistrée.",
	"Your text is in {0}.": "Votre texte est dans {0}.",
	"Global memory unchanged.": "Mémoire globale inchangée.",
	"It changed again during the question.": "Il a encore changé pendant la question.",
	// fork: /browser setup as a guided setup (browser/wizard.ts) and Settings > Computer use.
	"Set up your browser": "Régler votre navigateur",
	"Which browser should the agent use? It opens tabs of its own there; your tabs stay out of its reach.":
		"Quel navigateur l’agent doit-il utiliser ? Il y ouvre ses propres onglets ; les vôtres restent hors de sa portée.",
	"Real clicks and keys.": "Vrais clics et vraies touches.",
	"Clicks by script; real ones once started with /browser firefox.":
		"Clics par script ; de vrais clics une fois lancé avec /browser firefox.",
	"Set up {0}": "Régler {0}",
	"Allow and continue": "Autoriser et continuer",
	"Choose another browser": "Choisir un autre navigateur",
	"Turn on Developer mode, at the top right.": "Activez le mode développeur, en haut à droite.",
	"Choose Load unpacked and select this folder: {0}":
		"Choisissez « Charger l’extension non empaquetée » et sélectionnez ce dossier : {0}",
	"Choose Load Temporary Add-on and select manifest.json in this folder: {0}":
		"Choisissez « Charger un module complémentaire temporaire » et sélectionnez manifest.json dans ce dossier : {0}",
	"A temporary add-on is removed when the browser closes: add it again after a restart, or install the extension from the store.":
		"Un module temporaire disparaît à la fermeture du navigateur : ajoutez-le de nouveau après un redémarrage, ou installez l’extension depuis la boutique.",
	"Open the Prism extension's page in {1}: {0} (the buttons below open it there and copy its address).":
		"Ouvrez la page de l’extension Prism dans {1} : {0} (les boutons ci-dessous l’y ouvrent et copient son adresse).",
	"Choose Add to Chrome, then Add extension.": "Choisissez « Ajouter à Chrome », puis « Ajouter l’extension ».",
	"Choose Add to Firefox, then Add.": "Choisissez « Ajouter à Firefox », puis « Ajouter ».",
	"No store in this browser, or no add button? Load the extension from a folder instead.":
		"Pas de boutique dans ce navigateur, ou pas de bouton d’ajout ? Chargez plutôt l’extension depuis un dossier.",
	"Close {0} completely, then start it again: what was just changed applies only when it starts.":
		"Fermez complètement {0}, puis relancez-le : ce qui vient d’être changé ne s’applique qu’à son démarrage.",
	"Open the page in {0}": "Ouvrir la page dans {0}",
	"Load from a folder instead": "Charger depuis un dossier",
	"Developer mode, for a browser without the store.": "Mode développeur, pour un navigateur sans la boutique.",
	"A temporary add-on, removed at each restart.": "Un module temporaire, retiré à chaque redémarrage.",
	"Back to the store": "Retour à la boutique",
	"Is the Prism extension in about:addons, turned on? Restarting the browser after the first declaration can help.":
		"L’extension Prism est-elle dans about:addons, activée ? Redémarrer le navigateur après la première déclaration peut aider.",
	"Add the Prism extension:": "Ajoutez l’extension Prism :",
	"Prism also runs: flatpak override --user {0} {1}. This browser can then read and write the extension folder: without write access, the file picker of a Flatpak gives it a copy of manifest.json alone, and the extension cannot load.":
		"Prism lance aussi : flatpak override --user {0} {1}. Ce navigateur peut alors lire et écrire le dossier de l’extension : sans l’écriture, le sélecteur de fichiers d’un Flatpak ne lui donne qu’une copie de manifest.json, et l’extension ne peut pas se charger.",
	"Prism also runs: flatpak override --user {0} {1}. This browser then keeps its ~/.mozilla folder, where it reads the Prism host declaration.":
		"Prism lance aussi : flatpak override --user {0} {1}. Ce navigateur conserve alors son dossier ~/.mozilla, où il lit la déclaration de l’hôte Prism.",
	"Prism also runs: flatpak override --user {0} {1}. The browser then reads and writes the extension folder and keeps its ~/.mozilla folder, where it reads the Prism host declaration.":
		"Prism lance aussi : flatpak override --user {0} {1}. Le navigateur lit et écrit alors le dossier de l’extension et conserve son dossier ~/.mozilla, où il lit la déclaration de l’hôte Prism.",
	"In {0}, open about:config and set widget.use-xdg-desktop-portal.native-messaging to 0: without it, {0} does not read Prism's host declaration.":
		"Dans {0}, ouvrez about:config et mettez widget.use-xdg-desktop-portal.native-messaging à 0 : sans cela, {0} ne lit pas la déclaration de l’hôte Prism.",
	"Close {0} completely, then start it again: what was just changed applies only when it starts. Do it before adding the extension, which a restart removes.":
		"Fermez complètement {0}, puis relancez-le : ce qui vient d’être changé ne s’applique qu’à son démarrage. Faites-le avant d’ajouter l’extension, qu’un redémarrage retire.",
	"Copy the folder path": "Copier le chemin du dossier",
	"It is added: check": "C’est ajouté : vérifier",
	"Opens, reads and closes a tab of its own.": "Ouvre, lit et ferme un onglet à elle.",
	"Folder path copied.": "Chemin du dossier copié.",
	"Could not copy: {0}": "Copie impossible : {0}",
	"The agent's control was stopped from this browser: /browser resume gives it back.":
		"Le contrôle de l’agent a été arrêté depuis ce navigateur : /browser resume le lui rend.",
	"Waiting for the Prism extension in {0} to connect, then opening a tab to check…":
		"En attente de la connexion de l’extension Prism dans {0}, puis ouverture d’un onglet pour vérifier…",
	"Back to the steps": "Retour aux étapes",
	"{0} is linked": "{0} est lié",
	"{0} {1}: {2}.": "{0} {1} : {2}.",
	"Checked: Prism opened, read and closed a tab of its own through the extension.":
		"Vérifié : Prism a ouvert, lu et fermé un onglet à lui par l’extension.",
	"The agent uses this browser from now on.": "L’agent utilise désormais ce navigateur.",
	"For real clicks and keys in Firefox: /browser firefox (it restarts Firefox with remote control).":
		"Pour de vrais clics et de vraies touches dans Firefox : /browser firefox (il relance Firefox avec le contrôle à distance).",
	"Host declared for {0}: {1}": "Hôte déclaré pour {0} : {1}",
	"The browser may start Prism outside its sandbox.": "Le navigateur peut lancer Prism hors de sa sandbox.",
	"The browser may not start Prism outside its sandbox.": "Le navigateur ne peut pas lancer Prism hors de sa sandbox.",
	"The extension did not connect from {0}.": "L’extension ne s’est pas connectée depuis {0}.",
	"Is the extension in about:debugging? A temporary add-on is gone after a restart of the browser.":
		"L’extension est-elle dans about:debugging ? Un module temporaire disparaît au redémarrage du navigateur.",
	"Is the extension in chrome://extensions, turned on, without an error? Restarting the browser after the first declaration can help.":
		"L’extension est-elle dans chrome://extensions, activée, sans erreur ? Redémarrer le navigateur après la première déclaration peut aider.",
	"Connected instead: {0}.": "Connecté à la place : {0}.",
	"The extension connected, but the check failed: {0}":
		"L’extension s’est connectée, mais la vérification a échoué : {0}",
	"Check again": "Vérifier de nouveau",
	"The browser disconnected.": "Le navigateur s’est déconnecté.",
	"The tab opened was not listed.": "L’onglet ouvert n’apparaît pas dans la liste.",
	"Computer use": "Utilisation de l’ordinateur",
	"The agent using your browser, a desktop of its own or yours: each module, its settings and the browser's setup":
		"L’agent qui utilise votre navigateur, un bureau à lui ou le vôtre : chaque module, ses réglages et le réglage du navigateur",
	"Set up a browser": "Régler un navigateur",
	"Link a phone": "Lier un téléphone",
	"The Prism app on Android uses this PC: the phone server, a pairing code as a QR code and as text, the phones linked and their removal (also /phone).":
		"L’app Prism sur Android utilise ce PC : le serveur du téléphone, un code d’appairage en QR et en texte, les téléphones liés et leur retrait (aussi /phone).",
	"Step by step: choose the browser, add the Prism extension, then a check from end to end. Linking another browser makes it the one the agent uses (also /browser setup).":
		"Pas à pas : choisir le navigateur, ajouter l’extension Prism, puis une vérification de bout en bout. Lier un autre navigateur en fait celui qu’utilise l’agent (aussi /browser setup).",
	// Prism's updates.
	Updates: "Mises à jour",
	"When Prism looks for a newer version of itself on its site. Manual asks nothing until you run /update; the other choices check at most once an hour.":
		"Quand Prism cherche une version plus récente de lui-même sur son site. Manuelle ne demande rien tant que vous ne lancez pas /update ; les autres choix vérifient au plus une fois par heure.",
	manual: "manuelle",
	"notify me": "me prévenir",
	automatic: "automatique",
	"Only when you ask, with /update": "Seulement quand vous le demandez, avec /update",
	"Checks at start and tells you": "Vérifie au démarrage et vous prévient",
	"Checks at start and installs; the new version opens at the next start":
		"Vérifie au démarrage et installe ; la nouvelle version s’ouvre au lancement suivant",
	"Check for updates": "Rechercher une mise à jour",
	"Asks the Prism site for a newer version and installs it on request; also switches between the stable and canary channels and goes back to the previous version (also /update).":
		"Demande au site de Prism s’il existe une version plus récente et l’installe à votre demande ; change aussi de canal entre stable et canary, et revient à la version précédente (aussi /update).",
	"Check for a Prism update, switch channel or go back to the previous version":
		"Rechercher une mise à jour de Prism, changer de canal ou revenir à la version précédente",
	stable: "stable",
	canary: "canary",
	"no message": "aucun message",
	"Prism {0} is installed: it opens at the next start.":
		"Prism {0} est installé : il s’ouvrira au prochain lancement.",
	"The update failed: {0}": "La mise à jour a échoué : {0}",
	"Prism {0} is available. /update installs it.": "Prism {0} est disponible. /update l’installe.",
	"Installing Prism {0}…": "Installation de Prism {0}…",
	"This {0} was not installed from {1}, so it cannot update itself. Install it from there with: curl -fsSL {1}/install.sh | sh":
		"Ce {0} n’a pas été installé depuis {1}, il ne peut donc pas se mettre à jour lui-même. Installez-le depuis ce site avec : curl -fsSL {1}/install.sh | sh",
	"This {0} was installed by {1}: update it with {1}, which keeps it with the rest of the system.":
		"Ce {0} a été installé par {1} : mettez-le à jour avec {1}, qui le garde avec le reste du système.",
	"This {0} is an AppImage: download the new one from {1}/downloads/ and replace this file with it.":
		"Ce {0} est une AppImage : téléchargez la nouvelle depuis {1}/downloads/ et remplacez ce fichier par celle-ci.",
	"Prism {0} is available.": "Prism {0} est disponible.",
	"Prism is up to date.": "Prism est à jour.",
	"{0} could not be reached.": "{0} est injoignable.",
	"Install Prism {0}": "Installer Prism {0}",
	"Switch to the canary channel (experimental, can break)": "Passer au canal canary (expérimental, peut casser)",
	"Back to the stable channel": "Revenir au canal stable",
	"Go back to the previous version": "Revenir à la version précédente",
	"Prism {0}, {1} channel. {2}": "Prism {0}, canal {1}. {2}",
	"Switch to the canary channel?": "Passer au canal canary ?",
	"Canary versions are built from each change that passes the tests, before any review: they can break. Your settings are kept, and /update brings you back to stable.":
		"Les versions canary sont construites à chaque modification qui passe les tests, avant toute relecture : elles peuvent casser. Vos réglages sont gardés, et /update vous ramène à stable.",
	"Installing the latest canary…": "Installation de la dernière canary…",
	"Installing the latest stable version…": "Installation de la dernière version stable…",
	"Going back to the previous version…": "Retour à la version précédente…",
	"The Prism extension in {0} comes from another version of Prism: /browser setup updates it.":
		"L’extension Prism de {0} vient d’une autre version de Prism : /browser setup la met à jour.",
	"extension out of date: /browser setup": "extension à mettre à jour : /browser setup",
	"The Prism extension in {0} (version {1}) is newer than this Prism's ({2}): /update updates Prism.":
		"L’extension Prism de {0} (version {1}) est plus récente que celle de ce Prism ({2}) : /update met Prism à jour.",
	"extension {0}, newer than this Prism's {1}: /update":
		"extension {0}, plus récente que celle de ce Prism ({1}) : /update",
	"extension {0}, this Prism comes with {1}: the store updates it":
		"extension {0}, ce Prism est livré avec la {1} : la boutique la met à jour",
	// fork (audit PB-22): `prism auth login` and `prism auth logout` (src/fork/auth-login-cli.ts).
	"The API key is empty.": "La clé d’API est vide.",
	"--no-browser only applies to account sign-in; omit it with --api-key.":
		"--no-browser ne sert qu’à la connexion avec un compte ; retirez-le avec --api-key.",
	"{0} has no API key login. Omit --api-key to sign in.":
		"{0} ne se connecte pas avec une clé d’API. Retirez --api-key pour vous connecter.",
	"Select 1-{0}: ": "Choisissez 1-{0} : ",
	"Enter a number from 1 to {0}.": "Saisissez un nombre de 1 à {0}.",
	'"{0}" requires an interactive terminal.': "« {0} » doit être lancé dans un terminal interactif.",
	"To save an API key without one: {0}": "Pour enregistrer une clé d’API sans terminal interactif : {0}",
	"Open this URL to sign in:\n  {0}": "Ouvrez cette adresse pour vous connecter :\n  {0}",
	'To use "{0}" instead, run {1}': "Pour utiliser « {0} » à la place, lancez {1}",
	"Other sign-in methods: {0}. Run {1} to choose one.":
		"Autres méthodes de connexion : {0}. Lancez {1} pour en choisir une.",
	"Open {0} and enter code: {1}": "Ouvrez {0} et saisissez le code : {1}",
	"Login cancelled.": "Connexion annulée.",
	"No stored credentials for {0}. Environment variables and models.json config are unchanged.":
		"Aucun identifiant enregistré pour {0}. Les variables d’environnement et la configuration models.json restent inchangées.",
	"Stored credentials: {0}": "Identifiants enregistrés : {0}",
	"Providers: {0}": "Fournisseurs : {0}",
	'Unknown provider "{0}".': "Fournisseur inconnu : « {0} ».",
};

/** Texts with variable parts, `{0}` `{1}`…; the parts are kept as they are. */
export const FR_PATTERNS: Record<string, string> = {
	"Possible prompt injection in the result of {0}": "Injection de prompt possible dans le résultat de {0}",
	// the /llama manager.
	"Configure llama.cpp with /login {0}": "Configurez llama.cpp avec /login {0}",
	"{0} model is loaded": "{0} modèle est chargé",
	"{0} models are loaded": "{0} modèles sont chargés",
	"Loaded {0}": "Modèle chargé : {0}",
	"Load started for {0}": "Chargement démarré pour {0}",
	"Unloaded {0}": "Modèle déchargé : {0}",
	"Hugging Face access required\n{0}\n\n{1} at:\n{2}\n\nThe llama.cpp server needs HF_TOKEN with access.":
		"Accès à Hugging Face nécessaire\n{0}\n\n{1} sur :\n{2}\n\nLe serveur llama.cpp a besoin de HF_TOKEN avec les droits d’accès.",
	"Select quantization\n{0}": "Choisir la quantification\n{0}",
	"Downloaded {0}": "Modèle téléchargé : {0}",
	"Model {0} is {1}": "Le modèle {0} est {1}",
	"{0} context": "contexte de {0}",
	"{0} downloads": "{0} téléchargements",
	"llama.cpp unavailable\n{0}\n\n{1}": "llama.cpp indisponible\n{0}\n\n{1}",
	"Model exited with code {0}": "Le modèle s’est arrêté avec le code {0}",
	"llama.cpp returned HTTP {0}": "llama.cpp a renvoyé HTTP {0}",
	"llama.cpp SSE returned HTTP {0}": "Le flux SSE de llama.cpp a renvoyé HTTP {0}",
	"Hugging Face returned HTTP {0}": "Hugging Face a renvoyé HTTP {0}",
	"Hugging Face rate limit reached; retry in {0}s":
		"La limite de requêtes de Hugging Face est atteinte ; réessayez dans {0}s",
	// Chrome DevTools plug-in.
	"Failed to upload Radius artifact: {0}": "Impossible d’envoyer le fichier vers Radius : {0}",
	"Failed to create gist: {0}": "Impossible de créer le gist : {0}",
	"Share URL: {0}": "URL de partage : {0}",
	// Engine interface wrappers; model-facing producers keep their English text.
	"Could not update {0}: it must contain valid JSON (a structured settings format, without comments). Check the file, then retry.":
		"Impossible de modifier {0} : le fichier doit contenir du JSON valide (un format structuré de réglages, sans commentaires). Vérifiez le fichier, puis réessayez.",
	"broken: {0}": "en panne : {0}",
	"on ({0} mode)": "activée (mode {0})",
	"off in {0} mode": "désactivée en mode {0}",
	"{0} (private to this session)": "{0} (privé pour cette session)",
	"Readable in the home folder: the project and {0}; not shown: the rest, and {1}":
		"Lisibles dans le dossier personnel : le projet et {0} ; masqués : le reste et {1}",
	"Writes refused under {0}: {1}. Reads remain available; the sandbox stays on.":
		"Écritures refusées sous {0} : {1}. La lecture reste possible ; la sandbox reste activée.",
	"Network: through Prism's proxy; {0}": "Réseau : via le proxy de Prism ; {0}",
	'Settings: "sandbox" in {0}': 'Réglages : "sandbox" dans {0}',
	"Kept Git copies: {0}, not applied to their repositories. Prism never publishes, removes or resumes them: remove a folder once read.":
		"Copies Git conservées : {0}, non appliquées à leurs dépôts. Prism ne les publie, ne les supprime et ne les reprend jamais : supprimez un dossier après l’avoir consulté.",
	"From: {0} in {1}, {2}, Prism {3}": "Origine : {0} dans {1}, {2}, Prism {3}",
	"and {0} older ones in {1}": "et {0} plus anciennes dans {1}",
	"and {0} more in {1}": "et {0} autres dans {1}",
	"its {0} is unreadable": "son fichier {0} est illisible",
	"it has no {0}": "son fichier {0} est absent",
	"background task {0} still works in it; its Prism ended, so its Git changes will not be published when it ends":
		"la tâche en arrière-plan {0} y travaille encore ; son Prism s’est arrêté, donc ses changements Git ne seront pas publiés à sa fin",
	"The sandbox is on for {0} mode but does not work: {1}":
		"La sandbox est activée pour le mode {0} mais ne fonctionne pas : {1}",
	'To go without it, turn it off for this mode in settings.json ("sandbox": { "modes": { "{0}": false } }) or choose another mode with --perm-mode.':
		'Pour vous en passer, désactivez-la pour ce mode dans settings.json ("sandbox": { "modes": { "{0}": false } }) ou choisissez un autre mode avec --perm-mode.',
	// fork.9 QA: core/auth-guidance.ts; {1} is the /login help, translated by its own entry.
	"No access key is available for {0}.\n\n{1}": "Aucune clé d'accès n'est disponible pour {0}.\n\n{1}",
	"Name resembles popular package {0}.": "Le nom ressemble à celui du paquet populaire {0}.",
	// Before the general form below, which would match it first.
	"Package could not be verified: Prism's network permissions do not allow {0}; it was not contacted.":
		"Le paquet n'a pas pu être vérifié : les permissions réseau de Prism n'autorisent pas {0} ; il n'a pas été contacté.",
	"Package could not be verified: {0}": "Le paquet n'a pas pu être vérifié : {0}",
	"Package could not be verified: registry returned HTTP {0}.":
		"Le paquet n'a pas pu être vérifié : le registre a renvoyé HTTP {0}.",
	"Only {0} downloads last week (fewer than 1,000).":
		"Seulement {0} téléchargements la semaine dernière (moins de 1 000).",
	// fork.9 (CAP-01): the detail of a scheduled run, recorded in English and translated when shown.
	"the folder {0} does not exist.": "le dossier {0} n'existe pas.",
	"exit code {0}; journalctl --user -u {1} shows the error":
		"code de sortie {0} ; journalctl --user -u {1} montre l'erreur",
	"Prism's own files are in the task's folder ({0}): the task could change the code its next run starts outside the sandbox.":
		"Les fichiers de Prism sont dans le dossier de la tâche ({0}) : la tâche pourrait modifier le code que son prochain passage lance hors de la sandbox.",
	"Prism runs from a Git working tree ({0}), a project agents can change before the timer runs it outside the sandbox. Schedule tasks from an installed Prism (release or npm).":
		"Prism tourne depuis un dépôt Git de travail ({0}), un projet que des agents peuvent modifier avant que le timer ne le lance hors de la sandbox. Planifiez les tâches depuis un Prism installé (release ou npm).",
	"Compaction failed: {0}": "Échec du résumé : {0}",
	"How would you like to connect to {0}?": "Comment voulez-vous vous connecter à {0} ?",
	"Permissions: {0}": "Permissions : {0}",
	"session: {0} allow, {1} deny": "session : {0} autorisées, {1} refusées",
	"config: {0}{1} (mode: {2})": "configuration : {0}{1} (mode : {2})",
	"config: {0} (default mode: {1})": "configuration : {0} (mode par défaut : {1})",
	"Usage: /perm {0} <{1}>": "Utilisation : /perm {0} <{1}>",

	'Invalid rule: "{0}" (expected: tool or tool(glob))': 'Règle invalide : "{0}" (attendu : outil ou outil(motif))',
	"{0} rule for this session: {1}": "Règle pour cette session ({0}) : {1}",
	'Saved {0} rule "{1}" to {2}': 'Règle enregistrée ({0}) "{1}" dans {2}',
	"Unknown subcommand: {0} (try /perm help)": "Sous-commande inconnue : {0} (consultez /perm help)",

	"Could not stop {0}: {1}": "Impossible d’arrêter {0} : {1}",
	"Thinking Level for {0}": "Niveau de réflexion pour {0}",
	"Revert to global default ({0})": "Revenir au réglage global par défaut ({0})",

	"SearXNG URL {0}.": "URL SearXNG {0}.",
	"Finished after {0}s. Ready for input.": "Terminé après {0}s. Prêt pour votre saisie.",
	" (+{0} more waiting)": " (+{0} autres en attente)",
	// fork: selectors, built-in notices and startup warnings.
	"  {0} to select · {1} to set as default · {2} to cancel": "  {0} choisir · {1} par défaut · {2} annuler",
	"{0} cycles thinking levels in-session": "{0} parcourt les niveaux de réflexion dans la session",
	"Could not refresh {0}; showing cached models.": "Impossible d’actualiser {0} ; modèles en cache affichés.",
	"Could not refresh {0} model catalogs ({1}); showing cached models.":
		"Impossible d’actualiser {0} catalogues de modèles ({1}) ; modèles en cache affichés.",
	"Could not refresh model catalogs: {0}": "Impossible d’actualiser les catalogues de modèles : {0}",
	"Step {0}/{1} · {2}": "Étape {0}/{1} · {2}",
	"API key configured": "Clé d’API configurée",
	"account configured": "compte configuré",
	"subscription configured": "abonnement configuré",
	"Login to {0}": "Connexion à {0}",
	"On the web page above, enter this code: {0}": "Sur la page web ci-dessus, saisissez ce code : {0}",
	"e.g., {0}": "par ex. {0}",
	"{0} to save · {1} to cancel": "{0} enregistrer · {1} annuler",
	"  No named sessions found. Press {0} to show all.": "  Aucune session nommée. {0} affiche toutes les sessions.",
	"  No named sessions in current folder. Press {0} to show all, or Tab to view all.":
		"  Aucune session nommée dans ce dossier. {0} montre les autres, Tab les autres dossiers.",
	"Failed to delete: {0}": "Échec de la suppression : {0}",
	"Failed to load sessions: {0}": "Échec du chargement des sessions : {0}",
	"Failed to rename: {0}": "Échec du renommage : {0}",
	"[compaction (conversation summary): {0}k tokens]": "[compaction (résumé de conversation) : {0}k tokens]",
	"[model: {0}]": "[modèle : {0}]",
	"[thinking: {0}]": "[réflexion : {0}]",
	"[custom: {0}]": "[personnalisé : {0}]",
	"[context omit: {0}]": "[contexte omis : {0}]",
	"[context replace: {0}]": "[contexte remplacé : {0}]",
	"[label: {0}]": "[étiquette : {0}]",
	"Cleared {0} task(s).": "{0} tâche(s) effacée(s).",
	"{0}: the checkpoint could not be saved ({1}), /undo cannot restore it.":
		"{0} : la copie n'a pas pu être enregistrée ({1}), /undo ne pourra pas le restaurer.",
	"{0} is larger than {1} MB: no checkpoint, /undo cannot restore it.":
		"{0} dépasse {1} Mo : pas de copie, /undo ne pourra pas le restaurer.",
	"Undo turn {0}?": "Annuler le tour {0} ?",
	"Undid turn {0}": "Tour {0} annulé",
	"Rewound to before turn {0}": "Retour avant le tour {0}",
	"turn {0} · {1} file(s) · {2}": "tour {0} · {1} fichier(s) · {2}",
	"Language servers let the model check its code changes. To install for this project: {0}. /lsp-setup shows how.":
		"Les serveurs de langage permettent au modèle de vérifier ses changements de code. À installer pour ce projet : {0}. /lsp-setup indique comment faire.",
	'pi-lsp uses only the servers in your pi-lsp.json: add {0} there (command "{1}") to use it.':
		'pi-lsp utilise seulement les serveurs de votre pi-lsp.json : ajoutez-y {0} (commande "{1}") pour l’utiliser.',
	"{0}: install {1} first, then run /lsp-setup again.": "{0} : installez d’abord {1}, puis relancez /lsp-setup.",
	"Run this in a terminal (it asks for your password): {0}":
		"Lancez ceci dans un terminal (votre mot de passe sera demandé) : {0}",
	"How to install: {0} first": "Comment l’installer : d’abord {0}",
	"Install in a terminal: {0}": "Installer dans un terminal : {0}",
	"Install: put {0} in the input box": "Installer : mettre {0} dans la saisie",
	"Language servers ready: {0}.": "Serveurs de langage prêts : {0}.",
	"Turned off in /settings › Servers: {0}.": "Désactivés dans /settings › Serveurs : {0}.",
	"{0} is not installed: /lsp-setup lists this project's servers and installs them.":
		"{0} n’est pas installé : /lsp-setup liste les serveurs de ce projet et les installe.",
	"{0} others are not installed: /lsp-setup lists this project's servers and installs them.":
		"{0} autres ne sont pas installés : /lsp-setup liste les serveurs de ce projet et les installe.",
	"{0} ({1} chars)": "{0} ({1} caractères)",
	"Updating {0} memory…": "Mise à jour de la mémoire {0}…",
	"No interface to edit memory. File: {0}": "Aucune interface pour modifier la mémoire. Fichier : {0}",
	"Global memory ({0})": "Mémoire globale ({0})",
	"The sandbox is off in {0} mode.": "La sandbox est désactivée en mode {0}.",
	"Permission mode: {0} — {1}": "Mode de permission : {0} — {1}",
	"Permission mode: unrestricted. {0}": "Mode de permission : sans limite. {0}",
	'Saved deny rule "{0}" to {1}': 'Règle de refus "{0}" enregistrée dans {1}',
	"{0} match(es) across {1} session(s)": "{0} résultat(s) dans {1} session(s)",
	"{0} key removed from auth.json.": "Clé {0} retirée de auth.json.",
	"{0} API key (saved in auth.json)": "Clé d’API {0} (enregistrée dans auth.json)",
	"{0} key saved in auth.json.": "Clé {0} enregistrée dans auth.json.",
	"{0} is set and takes precedence.": "{0} est définie et prioritaire.",
	"Provider in use: {0}": "Service utilisé : {0}",
	"{0} not found. Offline mode enabled, skipping download.":
		"{0} introuvable. Mode hors ligne activé, téléchargement ignoré.",
	"{0} not found. Install with: pkg install {1}": "{0} introuvable. Installez-le avec : pkg install {1}",
	"Downloading {0}...": "Téléchargement de {0}...",
	"{0} downloaded.": "{0} téléchargé.",
	"Failed to download {0}: {1}": "Échec du téléchargement de {0} : {1}",
	"tmux extended-keys-format is xterm. {0} works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.":
		"L’option extended-keys-format de tmux vaut xterm. {0} fonctionne mieux avec csi-u. Ajoutez `set -g extended-keys-format csi-u` dans ~/.tmux.conf et redémarrez tmux.",
	// fork: the theme editor (theme-editor.ts).
	"Editing {0}, saved in themes/{1}.json.": "Modification de {0}, enregistré dans themes/{1}.json.",
	"A copy of {0}, saved as themes/{1}.json at the first change.":
		"Une copie de {0}, enregistrée dans themes/{1}.json à la première modification.",
	"New value for {0}: a colour such as #3a7bd5, a palette name, or empty for the terminal's own.":
		"Nouvelle valeur pour {0} : une couleur comme #3a7bd5, un nom de la palette, ou vide pour celle du terminal.",
	"Saved in themes/{0}.json.": "Enregistré dans themes/{0}.json.",
	// fork: the Animations row of /settings > Appearance.
	"Turned off: {0}.": "Désactivées : {0}.",
	"Canary channel: this release is experimental and can break. Back to stable: {0} update --channel stable":
		"Canal canary : cette version est expérimentale et peut casser. Retour au canal stable : {0} update --channel stable",
	// fork: the Ctrl+P cycle in /settings > Models (settings-models.ts).
	"all {0} models": "les {0} modèles",
	"{0} of {1} models": "{0} modèles sur {1}",
	// fork: a model's corrections in /settings > Models (settings-model-page.ts).
	"current · {0} changes": "actuel · {0} modifications",
	"{0} changes": "{0} modifications",
	// fork: /settings > Permissions & sandbox (permissions.ts).
	"{0} is not a valid permissions file. Fix it, then retry.":
		"{0} n'est pas un fichier de permissions valide. Corrigez-le, puis réessayez.",
	// fork: /settings > Notifications (notify.ts) and Servers (settings-servers.ts).
	"A desktop notification when a run of more than {0} s ends, and when the agent waits for your approval; none while the Prism window is in front.":
		"Une notification de bureau quand un travail de plus de {0} s se termine, et quand l'agent attend votre accord ; aucune tant que la fenêtre de Prism est au premier plan.",
	"A desktop notification when the agent has waited {0} s for your approval, at most one per {1} s.":
		"Une notification de bureau quand l'agent attend votre accord depuis {0} s, au plus une toutes les {1} s.",
	"MCP server {0} ({1}): {2}. Off, it is not started and its tools are gone.":
		"Serveur MCP {0} ({1}) : {2}. Désactivé, il n'est pas lancé et ses outils disparaissent.",
	"MCP {0} · exposure": "MCP {0} · exposition",
	"Language server {0} ({1}): {2}. Off, lsp_diagnostics and lsp_fix do not start it.":
		"Serveur de langage {0} ({1}) : {2}. Désactivé, lsp_diagnostics et lsp_fix ne le lancent pas.",
	// fork: the simple interface's one line per action (fork/prism/plain-action.ts).
	"Read file {0}": "Lecture de {0}",
	"Edit file {0}": "Modification de {0}",
	"Write file {0}": "Écriture de {0}",
	"Run a command ({0})": "Commande lancée ({0})",
	"Search for “{0}” in {1}": "Recherche de « {0} » dans {1}",
	"Find files {0} in {1}": "Recherche des fichiers {0} dans {1}",
	"List folder {0}": "Contenu du dossier {0}",
	"Measuring {0}/{1}: {2}…": "Mesure {0}/{1} : {2}…",
	"Measurement failed: {0}": "Échec de la mesure : {0}",
	"below noise (±{0} ms)": "sous le bruit (±{0} ms)",
	"below noise (±{0} MiB)": "sous le bruit (±{0} Mio)",
	"{0} ms": "{0} ms",
	"{0} MiB": "{0} Mio",
	"Current model": "Modèle actuel",
	"A model is selected; credentials {0}; stored capabilities: {1}.":
		"Un modèle est sélectionné ; identifiants {0} ; capacités enregistrées : {1}.",
	"Could not export diagnostic report: {0}": "Impossible d'exporter le rapport de diagnostic : {0}",
	"{0} crash(es) recorded in the last 7 days; the last one: {1}.":
		"{0} plantage(s) enregistré(s) ces 7 derniers jours ; le dernier : {1}.",
	"{0} problem(s), {1} not tested, {2} fine": "{0} problème(s), {1} non testé(s), {2} correct(s)",
	"Model request failed. Run /doctor for local diagnostics.":
		"La requête au modèle a échoué. Lancez /doctor pour un diagnostic local.",
	"Extension {0} failed to load. Run /doctor for details; start with --safe to isolate it.":
		"L'extension {0} n'a pas pu être chargée. Lancez /doctor pour les détails ; démarrez avec --safe pour l'isoler.",
	"The server refused the request. Possible cause, not confirmed: this model may not support {0} (its server does not say). /model-settings turns it off for this model.":
		"Le serveur a refusé la requête. Cause possible, non confirmée : ce modèle ne gère peut-être pas {0} (son serveur ne le dit pas). /model-settings le coupe pour ce modèle.",
	"server: what {0} reports. Prism: what Prism sends or assumes; changing it does not change the server.":
		"serveur : ce que {0} indique. Prism : ce que Prism envoie ou suppose ; le changer ne change pas le serveur.",
	"failed (code {0})": "échec (code {0})",
	"stopped after {0} s (time limit)": "arrêté après {0} s (limite de temps)",
	"Effective: {0}.": "En vigueur : {0}.",
	"Included add-on (builtin:{0}).": "Module inclus (builtin:{0}).",
	"{0} API key": "Clé d'API {0}",
	"Model: {0}": "Modèle : {0}",
	"Thinking level: {0}": "Niveau de réflexion : {0}",
	"Switched to {0}": "Modèle actif : {0}",
	"Session exported to: {0}": "Session exportée dans : {0}",
	"Session imported from: {0}": "Session importée depuis : {0}",
	"Session compacted {0}": "Session résumée {0}",
	"Cache warming: {0}": "Maintien du cache : {0}",
	"HTTP idle timeout: {0}": "Délai d'attente HTTP : {0}",
	"TUI mode: {0}": "Affichage : {0}",
	"Restored {0} queued message{1} to editor": "{0} message{1} en attente remis dans la saisie",
	"Failed to export session: {0}": "Échec de l'export de la session : {0}",
	"Failed to import session: {0}": "Échec de l'import de la session : {0}",
	"Failed to login to {0}: {1}": "Échec de la connexion à {0} : {1}",
	"Failed to paste from clipboard: {0}": "Échec du collage : {0}",
	"Reload failed: {0}": "Échec du rechargement : {0}",
	"Bash command failed: {0}": "La commande bash a échoué : {0}",
	"Could not add the server: {0}": "Impossible d'ajouter le serveur : {0}",
	"Could not read {0}.": "Impossible de lire {0}.",
	"{0} twice": "{0} deux fois",
	"Press {0} to show full startup help.": "Appuyez sur {0} pour l'aide complète du démarrage.",
	// fork.9 QA: main.ts, an extension that fails to load stops the start.
	'Failed to load extension "{0}": {1}': "Impossible de charger l'extension « {0} » : {1}",
	'Hint: Start in safe mode using "{0} --safe", or without extensions only using "{1} -ne".':
		"Conseil : démarrez en mode de secours avec « {0} --safe », ou seulement sans extensions avec « {1} -ne ».",
	"Press {0} to show full startup help and loaded resources.":
		"Appuyez sur {0} pour l'aide complète du démarrage et les ressources chargées.",
	"{0} can explain its own features and look up its docs. Ask it how to use or extend {1}.":
		"{0} peut expliquer ses propres fonctions et chercher dans sa documentation. Demandez-lui comment l'utiliser ou l'étendre.",
	"Ask {0} anything…": "Demandez ce que vous voulez à {0}…",
	"{0} too low, nothing to summarize (compacts at ~{1} of {2} tokens)":
		"{0} trop bas, rien à résumer (résumé vers ~{1} sur {2} tokens)",
	"{0} (compacts at ~{1} of {2} tokens)": "{0} (résumé vers ~{1} sur {2} tokens)",
	// fork: values /settings builds from numbers.
	"{0} (capped at {1}; compacts at ~{2} of {3} tokens)": "{0} (plafonné à {1} ; résumé vers ~{2} sur {3} tokens)",
	"{0} too low, nothing to summarize (capped at {1}; compacts at ~{2} of {3} tokens)":
		"{0} trop bas, rien à résumer (plafonné à {1} ; résumé vers ~{2} sur {3} tokens)",
	"{0} configured": "{0} configurés",
	// the bottom bar in the simple interface.
	"sent {0}": "envoyés {0}",
	"received {0}": "reçus {0}",
	// fork: the end-of-turn line (fork/prism/turn-summary.ts).
	"{0} tools": "{0} outils",
	"{0} failures": "{0} échecs",
	"Press {0} to save a message for after the current task. 'one-at-a-time': send one message, then wait for a response. 'all': send the waiting messages together.":
		"Appuyez sur {0} pour garder un message pour après la tâche en cours. « un par un » : un message, puis attente de la réponse. « tous » : les messages en attente partent ensemble.",
	"Choose each model's default thinking level before answering. Higher thinking levels may take longer and cost more. Press {0} to change it for the current session.":
		"Le niveau de réflexion par défaut de chaque modèle avant de répondre. Plus il est élevé, plus la réponse peut être longue et coûteuse. {0} le change pour la session en cours.",
	"{0} sec": "{0} s",
	"Allow this action? {0}": "Autoriser cette action ? {0}",
	"Potentially dangerous action: {0}": "Action peut-être dangereuse : {0}",
	"This action needs your permission: {0}": "Cette action demande votre accord : {0}",
	"This action may be dangerous: {0}": "Cette action peut être dangereuse : {0}",
	"Saved rules ({0})": "Règles enregistrées ({0})",
	"{0} min left": "reste {0} min",
	"Run {0}": "Lancer {0}",
	"Change {0}": "Modifier {0}",
	"Block: {0}": "Bloquer : {0}",
	"Default permission mode: {0} ({1})": "Mode de permission par défaut : {0} ({1})",
	'The tool "{0}" declares no permissions, so the {1} mode blocks it. Allow it with /perm allow {0} (this session), /perm always {0}, or the broad mode.':
		"L'outil « {0} » ne déclare pas ses permissions, donc le mode {1} le bloque. Autorisez-le avec /perm allow {0} (cette session), /perm always {0}, ou le mode large.",
	// fork: the sandbox's network question (permissions.ts askHost)
	// fork (SEC-08): the question about a sandboxed command's change to Git's hooks folder.
	"A command changed the Git hooks folder of {0}:": "Une commande a changé le dossier des hooks Git de {0} :",
	"Git would run hooks from {0}": "Git exécuterait les hooks de {0}",
	"Hooks there now: {0}": "Hooks présents : {0}",
	"These hooks run the scripts of {0}, with node_modules/.bin first in PATH.":
		"Ces hooks exécutent les scripts de {0}, avec node_modules/.bin en tête du PATH.",
	"Sandboxed commands still cannot change {0}.": "Les commandes de la sandbox ne peuvent toujours pas modifier {0}.",
	"Sandboxed commands still cannot change {0} or {1}.":
		"Les commandes de la sandbox ne peuvent toujours pas modifier {0} ni {1}.",
	"The command {0} wants to connect to {1}": "La commande {0} veut se connecter à {1}",
	"Allow {0} for this command": "Autoriser {0} pour cette commande",
	// fork: the browser's host question.
	"Allow every site in this session (browser only)":
		"Autoriser tous les sites dans cette session (navigateur seulement)",
	"Allow {0} for this request": "Autoriser {0} pour cette demande",
	"Allow every site for this request (browser only)":
		"Autoriser tous les sites pour cette demande (navigateur seulement)",
	"The agent opens it in your own browser, where you are signed in to your sites.":
		"L’agent l’ouvre dans votre propre navigateur, où vous êtes connecté à vos sites.",
	"Once a page is open, its links and the scripts the agent runs in it reach other sites without another question.":
		"Une fois une page ouverte, ses liens et les scripts que l’agent y lance atteignent d’autres sites sans autre question.",
	"Open any site in the browser": "Ouvrir n’importe quel site dans le navigateur",
	"This session's saved permissions were not given back: its file was not written by this Prism, or was changed. Mode: {0}; the rules allowed in this session are gone.":
		"Les permissions enregistrées de cette session n’ont pas été rendues : son fichier n’a pas été écrit par ce Prism, ou a été modifié. Mode : {0} ; les règles autorisées dans cette session sont perdues.",
	// fork: the permission question in plain words; the quoted text is
	// translated before it is inserted, so these come before the unquoted host ones.
	'Allow "{0}" for {1} minutes': "Autoriser « {0} » pendant {1} minutes",
	'Allow "{0}" in this session': "Autoriser « {0} » dans cette session",
	'Allow "{0}" in this project': "Autoriser « {0} » dans ce projet",
	'Block "{0}" in this project': "Bloquer « {0} » dans ce projet",
	'Always block "{0}"; save in {1}': "Toujours bloquer « {0} » ; enregistré dans {1}",
	"Allow {0} in this session": "Autoriser {0} dans cette session",
	'Allow {0} for "{1}" in this project': "Autoriser {0} pour « {1} » dans ce projet",
	'Let "{0}" connect to {1}': "Laisser « {0} » se connecter à {1}",
	"Could not keep it for this project: {0}": "Impossible de l'enregistrer pour ce projet : {0}",
	"run {0}": "lancer {0}",
	"change {0}": "modifier {0}",
	"use the {0} tool": "utiliser l'outil {0}",
	"Connect to {0}": "Se connecter à {0}",
	"Will probably connect to: {0}": "Se connectera probablement à : {0}",

	// fork: the footer's "more…" menu (src/fork/prism/more-menu.ts).
	"more…": "plus…",
	More: "Plus",
	"Help and shortcuts": "Aide et raccourcis",
	"Session details": "Détails de la session",
	"New session": "Nouvelle session",
	"Resume a session": "Reprendre une session",
	"Export the session": "Exporter la session",
	"Compact the context": "Compacter le contexte",
	// footer buttons and the context gauge's menu (src/fork/prism/footer-actions.ts).
	"Footer buttons…": "Boutons du pied de page…",
	"Footer buttons": "Boutons du pied de page",
	"Numbered commands show in the footer, in that order; those that do not fit stay in more….":
		"Les commandes numérotées s'affichent dans le pied de page, dans cet ordre ; celles qui n'y tiennent pas restent dans plus….",
	"Pin to the footer": "Épingler au pied de page",
	"Remove from the footer": "Retirer du pied de page",
	"Move left": "Déplacer à gauche",
	"Move right": "Déplacer à droite",
	"Could not save the footer buttons: {0}": "Impossible d'enregistrer les boutons du pied de page : {0}",
	"No model is configured, so its context window is not known.":
		"Aucun modèle n'est configuré : sa fenêtre de contexte n'est pas connue.",
	"The model's context window is not known.": "La fenêtre de contexte du modèle n'est pas connue.",
	"{0} of the model's {1}-token window is used by this conversation.":
		"Cette conversation occupe {0} de la fenêtre de {1} tokens du modèle.",
	"Auto-compaction is off: the context fills up until you run /compact.":
		"Compaction automatique coupée : le contexte se remplit jusqu'à ce que vous lanciez /compact.",
	"auto: at {0}, Prism summarises the older messages to make room (auto-compaction).":
		"auto : à {0}, Prism résume les anciens messages pour faire de la place (compaction automatique).",
	"auto: when the context is nearly full, Prism summarises the older messages to make room.":
		"auto : quand le contexte est presque plein, Prism résume les anciens messages pour faire de la place.",
	"Compact now": "Compacter maintenant",
	"Compaction settings": "Réglages de la compaction",

	// fork: why a module's feature is missing (src/fork/feature-state.ts).
	"tool calls are turned off for {0} in /model-settings, and this module works through tools":
		"les appels d'outils sont coupés pour {0} dans /model-settings, et ce module passe par des outils",
	"{0} cannot call tools (its server says so), and this module works through tools":
		"{0} ne sait pas appeler d'outils (son serveur le dit), et ce module passe par des outils",
	"Unavailable: {0}.": "Indisponible : {0}.",
	"Not supported by this model: {0}.": "Non pris en charge par ce modèle : {0}.",
	"Commands: {0}.": "Commandes : {0}.",
	"/{0}: the {1} module is off. Turn it on in /settings › Modules.":
		"/{0} : le module {1} est désactivé. Activez-le dans /settings › Modules.",
	"/{0} is unavailable: {1}.": "/{0} est indisponible : {1}.",
	"Unknown command /{0}. Did you mean /{1}? It was not sent to the model.":
		"Commande inconnue : /{0}. Vouliez-vous dire /{1} ? Elle n'a pas été envoyée au modèle.",
	"Unknown command /{0}. Type / to see the commands. It was not sent to the model.":
		"Commande inconnue : /{0}. Tapez / pour voir les commandes. Elle n'a pas été envoyée au modèle.",
	"/{0} is not supported by this model: {1}.": "/{0} n'est pas pris en charge par ce modèle : {1}.",

	// fork: the task scope. The quoted forms come first: the others would match them too.
	'Allow {0} for "{1}" for this task': "Autoriser {0} pour « {1} » pendant cette tâche",
	'Allow "{0}" for this task': "Autoriser « {0} » pendant cette tâche",
	'Block "{0}" for this task': "Bloquer « {0} » pour cette tâche",
	"Block {0} for this task": "Bloquer {0} pour cette tâche",
	"runs {0}": "lance {0}",
	"changes {0}": "modifie {0}",
	"connects to {0}": "se connecte à {0}",
	"any command may connect to {0}": "toute commande peut se connecter à {0}",
	"Duration: {0} min": "Durée : {0} min",
	" ({0} times)": " ({0} fois)",
	"Task scope: {0} min left, {1}": "Périmètre de tâche : {0} min restantes, {1}",
	"Task scope set for your next task ({0} min at most).":
		"Périmètre fixé pour votre prochaine tâche ({0} min au plus).",
	"{0} {1} failed: {2}": "Échec de {0} {1} : {2}",
	"Permission mode: {0}": "Mode de permission : {0}",
	"{0} {1}: done in {2}{3}.": "{0} {1} : terminé en {2}{3}.",
	// fork: compatible-server.
	"Use a server address starting with http:// or https://. Received: {0}":
		"Utilisez une adresse de serveur commençant par http:// ou https://. Protocole reçu : {0}",
	"Could not list models: the server returned HTTP {0} for GET {1}/models.":
		"Impossible de lister les modèles : le serveur a renvoyé HTTP {0} pour GET {1}/models.",
	"The server returned no model names at {0}/models. Check that its model list is available.":
		"Le serveur n'a renvoyé aucun nom de modèle à {0}/models. Vérifiez que sa liste de modèles est disponible.",
	"No model list at {0}": "Aucune liste de modèles à {0}",
	"The model list at {0}/models is larger than {1} bytes.": "La liste de modèles à {0}/models dépasse {1} octets.",
	'Could not update {0}: it must contain valid JSON (a structured settings format, without comments). Check the file, then retry, or add "{1}" manually.':
		'Impossible de modifier {0} : le fichier doit contenir du JSON valide (un format structuré de réglages, sans commentaires). Vérifiez le fichier puis réessayez, ou ajoutez "{1}" à la main.',
	'Invalid name "{0}": use lowercase letters, digits, ".", "_" or "-".':
		'Nom invalide "{0}" : utilisez des lettres minuscules, des chiffres, ".", "_" ou "-".',
	'"{0}" is already a provider; choose another name.': '"{0}" est déjà un fournisseur ; choisissez un autre nom.',
	// fork: the document viewer and on-demand text extraction.
	"PDF document": "Document PDF",
	"DOCX document": "Document DOCX",
	"ODT document": "Document ODT",
	"PNG image": "Image PNG",
	"JPEG image": "Image JPEG",
	"GIF image": "Image GIF",
	"WEBP image": "Image WEBP",
	"BMP image": "Image BMP",
	Markdown: "Markdown",
	"CSV table": "Tableau CSV",
	"TSV table": "Tableau TSV",
	"Text file": "Fichier texte",
	"binary file": "fichier binaire",
	"Not a regular file": "Pas un fichier ordinaire",
	"Unavailable file": "Fichier indisponible",
	"Image exceeds 20 MiB; preview omitted.": "L’image dépasse 20 Mio ; aperçu omis.",
	"File truncated to 4 MiB; full size: {0} bytes.": "Fichier limité à 4 Mio ; taille complète : {0} octets.",
	"Install {0} ({1}) to read this document.": "Installez {0} ({1}) pour lire ce document.",
	"Install bubblewrap (bwrap) to read this document: Prism runs document programs only in isolation.":
		"Installez bubblewrap (bwrap) pour lire ce document : Prism ne lance les programmes de lecture de documents qu’isolés.",
	"The isolation (bubblewrap) could not start: {0}. Once bubblewrap is allowed (see Sandbox in /settings for how), try again.":
		"L’isolation (bubblewrap) n’a pas pu démarrer : {0}. Une fois bubblewrap autorisé (voir Sandbox dans /settings pour la marche à suivre), réessayez.",
	"Text extraction by {0} failed (timeout, memory limit, output limit or program error).":
		"Échec de l’extraction par {0} (délai dépassé, limite de mémoire, limite de sortie ou erreur du programme).",
	"Text extracted by {0}; layout is lost.": "Texte extrait par {0} ; mise en page perdue.",
	"This format does not support text extraction.": "Ce format ne permet pas l’extraction du texte.",
	"File is missing or cannot be read.": "Fichier absent ou illisible.",
	"File is missing or is not a regular file.": "Fichier absent ou pas un fichier ordinaire.",
	"Unsupported document format.": "Format de document non pris en charge.",
	"This terminal cannot display images.": "Cette vue ne peut pas afficher les images.",
	"Dimensions: {0} × {1} px": "Dimensions : {0} × {1} px",
	"{0} bytes": "{0} octets",
	"match {0}/{1}": "résultat {0}/{1}",
	"no match": "aucun résultat",
	"↑↓ scroll · enter next match · esc clear/close": "↑↓ défiler · enter résultat suivant · esc effacer/fermer",
	// fork: the bundled Goal and Plan plug-ins (src/fork/menu-i18n.ts).
	"Waiting — {0}": "En attente — {0}",
	"Automatic work: {0} responses · Unlimited": "Travail automatique : {0} réponses · illimité",
	"Automatic work: {0} of {1} responses · {2} remaining": "Travail automatique : {0} réponses sur {1} · {2} restantes",
	"Automatic work: {0} of {1} responses": "Travail automatique : {0} réponses sur {1}",
	"Automatic work: up to {0} more responses after resume":
		"Travail automatique : jusqu'à {0} réponses de plus après la reprise",
	"Goal · {0}": "Objectif · {0}",
	"Usage: {0}": "Utilisation : {0}",
	"Automatic work is configured to pause after {0} responses.":
		"Le travail automatique est réglé pour s'arrêter après {0} réponses.",
	"Set the cumulative token limit to {0}.": "Fixe la limite cumulée de jetons à {0}.",
	"Current usage: {0}": "Utilisation actuelle : {0}",
	"{0} is preserved.": "{0} : conservé.",
	"{0} cumulative tokens and {1} active time are preserved.":
		"{0} jetons cumulés et {1} de temps actif sont conservés.",
	"Continuing resets the counter to 0 and allows up to {0} more automatic model responses.":
		"Continuer remet le compteur à 0 et autorise jusqu'à {0} réponses automatiques de plus.",
	"Continue — up to {0} more responses": "Continuer — jusqu'à {0} réponses de plus",
	"Enter a new cumulative total greater than current usage ({0}).":
		"Saisissez un nouveau total cumulé supérieur à l'utilisation actuelle ({0}).",
	"Goal objective · Token budget {0} · Automatic Unlimited":
		"Énoncé de l'objectif · budget de jetons {0} · travail automatique illimité",
	"Goal objective · Token budget {0} · Automatic limit {1}":
		"Énoncé de l'objectif · budget de jetons {0} · limite automatique {1}",
	"Automatic work will also pause after {0} responses.": "Le travail automatique s'arrêtera aussi après {0} réponses.",
	"Current budget: {0}": "Budget actuel : {0}",
	"Enter a new cumulative total greater than {0}.": "Saisissez un nouveau total cumulé supérieur à {0}.",
	"Goal: {0}": "Objectif : {0}",
	"Budget: {0} → {1}": "Budget : {0} → {1}",
	"Goal paused after {0} responses at its previous safety limit. Current limit: Unlimited.":
		"Objectif en pause après {0} réponses, à son ancienne limite de sécurité. Limite actuelle : illimitée.",
	"Goal paused after {0} responses at its previous safety limit. Current automatic-work limit: {1}.":
		"Objectif en pause après {0} réponses, à son ancienne limite de sécurité. Limite actuelle du travail automatique : {1}.",
	"Goal reached its {0}-of-{1} safety limit.": "L'objectif a atteint sa limite de sécurité ({0} sur {1}).",
	"Status: {0}": "État : {0}",
	"Waiting: {0}": "En attente : {0}",
	"Resume deadline: {0}": "Échéance de reprise : {0}",
	"Iteration: {0}": "Itération : {0}",
	"Active elapsed: {0}": "Temps actif : {0}",
	"Tokens: {0}": "Jetons : {0}",
	"Safety pause: automatic-work limit reached ({0} of {1} responses). Progress is saved; open /goal to review and continue.":
		"Pause de sécurité : limite du travail automatique atteinte ({0} réponses sur {1}). La progression est enregistrée ; ouvrez /goal pour vérifier et continuer.",
	"Commands: {0}": "Commandes : {0}",
	"Edit pi-goal settings manually: {0}": "Modifiez les réglages de pi-goal à la main : {0}",
	"User settings · {0}": "Réglages utilisateur · {0}",
	"Invalid settings file. Pi-goal is using built-in defaults. Fix {0} and run /reload. The file will not be overwritten.":
		"Fichier de réglages invalide. Pi-goal utilise ses réglages par défaut. Corrigez {0} puis lancez /reload. Le fichier ne sera pas écrasé.",
	"Current: Up to {0} responses": "Actuel : jusqu'à {0} réponses",
	"Current: After {0} repeated runs": "Actuel : après {0} passages répétés",
	"Current: After {0} repeated run": "Actuel : après {0} passage répété",
	"Automatic-work limit: Up to {0} responses": "Limite du travail automatique : jusqu'à {0} réponses",
	"Automatic-work limit: After {0} repeated runs": "Limite du travail automatique : après {0} passages répétés",
	"Automatic-work limit: After {0} repeated run": "Limite du travail automatique : après {0} passage répété",
	"Automatic-work limit: Up to {0} responses.": "Limite du travail automatique : jusqu'à {0} réponses.",
	"Automatic-work limit: After {0} repeated runs.": "Limite du travail automatique : après {0} passages répétés.",
	"Automatic-work limit: After {0} repeated run.": "Limite du travail automatique : après {0} passage répété.",
	"No-progress guard: Up to {0} responses": "Garde-fou sans progrès : jusqu'à {0} réponses",
	"No-progress guard: After {0} repeated runs": "Garde-fou sans progrès : après {0} passages répétés",
	"No-progress guard: After {0} repeated run": "Garde-fou sans progrès : après {0} passage répété",
	"No-progress guard: Up to {0} responses.": "Garde-fou sans progrès : jusqu'à {0} réponses.",
	"No-progress guard: After {0} repeated runs.": "Garde-fou sans progrès : après {0} passages répétés.",
	"No-progress guard: After {0} repeated run.": "Garde-fou sans progrès : après {0} passage répété.",
	"Automatic-work limit: {0}.": "Limite du travail automatique : {0}.",
	"Automatic-work limit: {0}": "Limite du travail automatique : {0}",
	"No-progress guard: {0}.": "Garde-fou sans progrès : {0}.",
	"No-progress guard: {0}": "Garde-fou sans progrès : {0}",
	"Managed run RPC: {0}.": "Pilotage RPC des passages : {0}.",
	"Managed run RPC: {0}": "Pilotage RPC des passages : {0}",
	"Current: {0}": "Actuel : {0}",
	"Set a whole-number response limit for each automatic-work epoch. Default: {0}.":
		"Fixez une limite entière de réponses pour chaque période de travail automatique. Par défaut : {0}.",
	"Active goal: {0} automatic responses used": "Objectif actif : {0} réponses automatiques utilisées",
	"Active goal: {0} repeated or empty runs detected": "Objectif actif : {0} passages répétés ou vides détectés",
	"Remove the current {0}-response cap. Goal work will have no response-count cap; other configured stop conditions remain.":
		"Retirer le plafond actuel de {0} réponses. L'objectif n'aura plus de plafond de réponses ; les autres conditions d'arrêt réglées restent.",
	"Remove the current {0}-response cap. The active goal has used {1} responses; other configured stop conditions remain.":
		"Retirer le plafond actuel de {0} réponses. L'objectif actif a utilisé {1} réponses ; les autres conditions d'arrêt réglées restent.",
	"Choose a whole-number response limit for each automatic-work epoch. Default: {0}.":
		"Choisir une limite entière de réponses pour chaque période de travail automatique. Par défaut : {0}.",
	"After {0} repeated runs (default)": "Après {0} passages répétés (par défaut)",
	"Automatic-work response limit (whole number greater than 0) · Default: {0}":
		"Limite de réponses du travail automatique (nombre entier supérieur à 0) · par défaut : {0}",
	"Enter a whole number greater than 0. Choose {0} from the previous screen if you do not want a limit.":
		"Saisissez un nombre entier supérieur à 0. Choisissez {0} à l'écran précédent si vous ne voulez pas de limite.",
	"The active goal has already used {0}. Setting this limit to {1} will pause it immediately without deleting progress.":
		"L'objectif actif a déjà utilisé {0}. Fixer cette limite à {1} le met en pause tout de suite, sans effacer sa progression.",
	"Up to {0} responses": "Jusqu'à {0} réponses",
	"After {0} repeated run": "Après {0} passage répété",
	"After {0} repeated runs": "Après {0} passages répétés",
	"{0} responses": "{0} réponses",
	"{0} runs": "{0} passages",
	"Could not apply Goal settings, and rollback was incomplete. Check {0}, run /reload, and verify the effective settings before retrying: {1}":
		"Impossible d'appliquer les réglages de l'objectif, et le retour en arrière est incomplet. Vérifiez {0}, lancez /reload et contrôlez les réglages en vigueur avant de réessayer : {1}",
	"Could not save Goal settings; the previous value remains. Check {0} and retry: {1}":
		"Impossible d'enregistrer les réglages de l'objectif ; la valeur précédente reste. Vérifiez {0} et réessayez : {1}",
	"Current goal: {0}": "Objectif actuel : {0}",
	"New goal: {0}": "Nouvel objectif : {0}",
	"Goal kept: {0}": "Objectif gardé : {0}",
	"Goal paused: {0}": "Objectif en pause : {0}",
	"Goal cleared: {0}": "Objectif effacé : {0}",
	"Goal updated: {0}": "Objectif modifié : {0}",
	"Goal complete: {0}": "Objectif atteint : {0}",
	"Goal blocked: {0}": "Objectif bloqué : {0}",
	"Goal waiting: {0}": "Objectif en attente : {0}",
	"Goal resumed from waiting: {0}": "Objectif repris après l'attente : {0}",
	"Goal token budget reached: {0}": "Budget de jetons de l'objectif atteint : {0}",
	"Goal token budget is still reached: {0}": "Le budget de jetons de l'objectif est toujours atteint : {0}",
	"Cannot start /goal: {0}": "Impossible de lancer /goal : {0}",
	"Cannot resume /goal: {0}": "Impossible de reprendre /goal : {0}",
	"Cannot reactivate /goal: {0}": "Impossible de réactiver /goal : {0}",
	"Goal is {0}; only active goals can be paused.":
		"L'objectif est {0} ; seul un objectif actif peut être mis en pause.",
	"Default: {0}": "Par défaut : {0}",
	"Resolves to: {0}": "Correspond à : {0}",
	"Configured default {0} is unavailable; using same as plan.":
		"Le choix par défaut {0} n'est pas disponible ; celui du plan est utilisé.",
	"Model Name: {0}": "Nom du modèle : {0}",
	"Configured: {0}": "Réglé : {0}",
	"Resolves here to: {0}": "Correspond ici à : {0}",
	"Loaded at startup: {0}": "Chargé au démarrage : {0}",
	"Invalid settings file. Fix {0} before saving.": "Fichier de réglages invalide. Corrigez {0} avant d'enregistrer.",
	"{0} more not usable in Plan mode": "{0} autres, inutilisables en mode Plan",
	"Blocked in Plan mode, not active or deprecated: {0}": "Bloqués en mode Plan, inactifs ou obsolètes : {0}",
	"Plan policy will allow: {0}.": "Le mode Plan autorisera : {0}.",
	"Pending registration: {0}.": "En attente d'enregistrement : {0}.",
	"settings file exceeds {0} bytes": "le fichier de réglages dépasse {0} octets",
	"settings document exceeds {0} bytes": "le document de réglages dépasse {0} octets",
	"Plan policy allows: {0}.": "Le mode Plan autorise : {0}.",
	// Notifications of the bundled Plan plug-in; a longer form comes before the shorter one it would match too.
	"Unable to implement the plan: implementation model provider and ID must each contain 1-{0} characters. Choose another model and retry.":
		"Impossible d'implémenter le plan : le fournisseur et l'identifiant du modèle d'implémentation doivent compter chacun de 1 à {0} caractères. Choisissez un autre modèle et réessayez.",
	"Unable to implement the plan: implementation model {0} is no longer available. Choose another model and retry.":
		"Impossible d'implémenter le plan : le modèle d'implémentation {0} n'est plus disponible. Choisissez un autre modèle et réessayez.",
	"Unable to implement the plan with {0}: {1}. Choose another model or configure authentication, then retry.":
		"Impossible d'implémenter le plan avec {0} : {1}. Choisissez un autre modèle ou configurez l'authentification, puis réessayez.",
	"Unable to implement the plan: {0}": "Impossible d'implémenter le plan : {0}",
	"Unable to show completed plan: {0}": "Impossible d'afficher le plan terminé : {0}",
	"Unable to implement saved plan: {0}": "Impossible d'implémenter le plan gardé : {0}",
	"pi-plan-mode settings ignored: {0}": "Réglages de pi-plan-mode ignorés : {0}",
	"{0} ignored because {1} takes precedence.": "{0} ignoré, car {1} est prioritaire.",
	"Using legacy {0}; rename it to {1}. The legacy file was not modified.":
		"Ancien fichier {0} utilisé ; renommez-le en {1}. L'ancien fichier n'a pas été modifié.",
	"Proposed plan is not ready: {0}. Continue Plan mode and produce one complete non-empty <proposed_plan> block.":
		"Le plan proposé n'est pas prêt : {0}. Continuez en mode Plan et produisez un seul bloc <proposed_plan> complet et non vide.",
	"Proposed plan is not ready: plan must not exceed {0} characters.":
		"Le plan proposé n'est pas prêt : le plan ne doit pas dépasser {0} caractères.",
	"Proposed plan is not ready: {0}.": "Le plan proposé n'est pas prêt : {0}.",
	"Unable to publish the Plan mode contract: {0}": "Impossible de publier le contrat du mode Plan : {0}",
	"Unable to publish the Normal mode contract: {0}": "Impossible de publier le contrat du mode normal : {0}",
	"Unable to send Plan-mode message: {0}": "Impossible d'envoyer le message du mode Plan : {0}",
	"Unable to start the deferred fresh implementation: {0}":
		"Impossible de lancer la nouvelle implémentation différée : {0}",
	"Cannot {0} while an agent run is active. Wait for the run to settle, then retry.":
		"Impossible de {0} pendant qu'un passage de l'agent est en cours. Attendez qu'il se termine, puis réessayez.",
	"Implementation thinking {0} is unsupported by the destination model; Pi is using {1}.":
		"Le niveau de réflexion {0} n'est pas pris en charge par le modèle de destination ; {1} est utilisé.",
	"Implementation thinking {0} could not be applied: {1}. The destination default will continue.":
		"Le niveau de réflexion {0} n'a pas pu être appliqué : {1}. Le réglage par défaut de la destination reste en place.",
	"Implementation model {0} could not be applied after authentication changed. The destination default model will continue.":
		"Le modèle d'implémentation {0} n'a pas pu être appliqué après un changement d'authentification. Le modèle par défaut de la destination reste en place.",
	"Implementation model {0} could not be resolved: {1}. The destination default model will continue.":
		"Le modèle d'implémentation {0} n'a pas pu être résolu : {1}. Le modèle par défaut de la destination reste en place.",
	"Implementation model {0} is no longer available. The destination default model will continue.":
		"Le modèle d'implémentation {0} n'est plus disponible. Le modèle par défaut de la destination reste en place.",
	"Implementation model {0} could not be authenticated: {1}. The destination default model will continue.":
		"Le modèle d'implémentation {0} n'a pas pu être authentifié : {1}. Le modèle par défaut de la destination reste en place.",
	"Implementation model {0} could not be applied: {1}. The destination default model will continue.":
		"Le modèle d'implémentation {0} n'a pas pu être appliqué : {1}. Le modèle par défaut de la destination reste en place.",
	"Unable to apply fresh implementation settings because their one-shot state could not be consumed: {0}. The implementation request was not sent; retry after session persistence is available.":
		"Impossible d'appliquer les réglages de la nouvelle implémentation, car leur état à usage unique n'a pas pu être lu : {0}. La demande d'implémentation n'a pas été envoyée ; réessayez quand l'enregistrement de la session sera disponible.",
	"Cannot start Plan mode: {0}.": "Impossible de lancer le mode Plan : {0}.",
	"Unable to export plan: Plan export target already exists: {0}. Choose another path or remove it first.":
		"Impossible d'exporter le plan : la destination existe déjà : {0}. Choisissez un autre chemin ou supprimez-la d'abord.",
	"Unable to export plan: {0}": "Impossible d'exporter le plan : {0}",
	"Plan exported to {0}. Plan mode disabled.": "Plan exporté vers {0}. Mode Plan coupé.",
	"Plan exported to {0}.": "Plan exporté vers {0}.",
	"Invalid key identifier: {0}. Use Pi key identifiers like ctrl+alt+p.":
		"Identifiant de touche invalide : {0}. Utilisez les noms de touches, comme ctrl+alt+p.",
	"Could not save Plan mode settings; the previous value remains: {0}":
		"Impossible d'enregistrer les réglages du mode Plan ; la valeur précédente reste : {0}",
	"Default Plan export destination: {0}.": "Destination par défaut de l'export du plan : {0}.",
	"Default Plan policy: {0} allowed.": "Outils autorisés par défaut en mode Plan : {0}.",
	"Fresh implementation model: {0}.": "Modèle de la nouvelle implémentation : {0}.",
	"Fresh implementation thinking: {0}.": "Réflexion de la nouvelle implémentation : {0}.",
	"Plan mode shortcut saved: {0}. Run /reload or restart Pi to apply; the current binding is unchanged.":
		"Raccourci du mode Plan enregistré : {0}. Lancez /reload ou redémarrez pour appliquer ; le raccourci actuel reste le même.",
	"Plan mode thinking level: {0}. Applies to the next Plan workflow.":
		"Niveau de réflexion du mode Plan : {0}. S'applique au prochain lancement du mode Plan.",
	"Plan reinjection: {0}. Applies to the next Implement action.":
		"Réinjection du plan : {0}. S'applique à la prochaine implémentation.",

	// fork: keyring warnings.
	"The credential of {0} is in the keyring, which could not be read: {1}. Unlock the keyring, then restart Prism, or log in again with /login.":
		"L'identifiant de {0} est dans le trousseau, qui n'a pas pu être lu : {1}. Déverrouillez le trousseau puis relancez Prism, ou reconnectez-vous avec /login.",
	"The credential of {0} was saved in clear in auth.json: there is no keyring ({1}).":
		"L'identifiant de {0} a été enregistré en clair dans auth.json : il n'y a pas de trousseau ({1}).",
	"Nothing was saved for {0}: the keyring did not take the credential ({1}). Unlock the keyring, then try again.":
		"Rien n'a été enregistré pour {0} : le trousseau n'a pas accepté l'identifiant ({1}). Déverrouillez le trousseau, puis réessayez.",
	"secret-tool failed: {0}": "secret-tool a échoué : {0}",
	// fork: the migration page.
	"{0} in clear": "{0} en clair",
	"Move {0} credential(s) to the keyring? Enter confirms, Esc cancels.":
		"Déplacer {0} identifiant(s) vers le trousseau ? Entrée confirme, Échap annule.",
	"Enter moves {0} credential(s) to the keyring · Esc back":
		"Entrée déplace {0} identifiant(s) vers le trousseau · Échap retour",
	"Nothing was moved: {0}": "Rien n'a été déplacé : {0}",
	"Moved to the keyring: {0}": "Déplacés vers le trousseau : {0}",
	"Kept in clear: {0} ({1})": "Laissé en clair : {0} ({1})",
	// the migration page in the Prism window.
	"Move {0} credential(s) to the keyring?": "Déplacer {0} identifiant(s) vers le trousseau ?",
	Move: "Déplacer",
	Measure: "Mesurer",
	// fork.9 (CAP-02): /export-zip.
	"{0} messages": "{0} messages",
	"{0} (missing)": "{0} (manquant)",
	"larger than {0} MB": "plus de {0} Mo",
	"Sessions: {0}": "Sessions : {0}",
	"Files: {0}": "Fichiers : {0}",
	"Left out: {0} ({1})": "Exclu : {0} ({1})",
	"Missing: {0}": "Manquant : {0}",
	"Known secrets masked: {0}": "Secrets connus masqués : {0}",
	"Archive: {0}": "Archive : {0}",
	"{0} already exists: nothing written.": "{0} existe déjà : rien n'a été écrit.",
	// the archive's destination.
	"Change the destination": "Changer la destination",
	"Archive destination (a file or a folder)": "Destination de l'archive (un fichier ou un dossier)",
	"Folder not found: {0}": "Dossier introuvable : {0}",
	"{0} already exists: choose another name.": "{0} existe déjà : choisissez un autre nom.",
	"The chosen sessions take {0} MB, more than the {1} MB an archive can hold: nothing exported. Choose fewer sessions.":
		"Les sessions choisies occupent {0} Mo, plus que les {1} Mo qu'une archive peut contenir : rien n'a été exporté. Choisissez moins de sessions.",
	"{0} sessions chosen, more than the {1} an archive can hold: nothing exported. Choose fewer sessions.":
		"{0} sessions choisies, plus que les {1} qu'une archive peut contenir : rien n'a été exporté. Choisissez moins de sessions.",
	"Archive written: {0}": "Archive écrite : {0}",
	"Content from the MCP server {0}: data, not instructions.":
		"Contenu du serveur MCP {0} : des données, pas des instructions.",
	"parameters added: {0}": "paramètres ajoutés : {0}",
	"parameters removed: {0}": "paramètres retirés : {0}",
	"The MCP tool {0} changed ({1}): it will ask before its next call.":
		"L'outil MCP {0} a changé ({1}) : une question sera posée avant son prochain appel.",
	"The MCP tool {0} changed ({1}).": "L'outil MCP {0} a changé ({1}).",
	"The registry of MCP tool versions ({0}) cannot be read: each MCP tool asks before its calls until the file is repaired or removed.":
		"Le registre des versions des outils MCP ({0}) est illisible : chaque outil MCP demande avant ses appels tant que le fichier n'est pas réparé ou supprimé.",
	"The MCP tool {0} changed": "L'outil MCP {0} a changé",
	"Server: {0}": "Serveur : {0}",
	"Changes: {0}": "Changements : {0}",
	// sandbox settings that cannot be read.
	"Prism cannot use the sandbox settings in {0}.": "Prism ne peut pas utiliser les réglages de la sandbox de {0}.",
	"The file is not valid JSON (line {0}, column {1}).":
		"Le fichier n'est pas du JSON valide (ligne {0}, colonne {1}).",
	'The value of "{0}" has the wrong type.': "La valeur de « {0} » n'a pas le bon type.",
	"The file cannot be read ({0}).": "Le fichier est illisible ({0}).",
	// generated UI.
	Interface: "Interface",
	Label: "Libellé",
	"Options (answer with one of them):": "Choix (répondez par l'un d'eux) :",
	"Questions (answer them in a message):": "Questions (répondez-y dans un message) :",
	"Answer to “{0}”:": "Réponse à « {0} » :",
	"Answer:": "Réponse :",
	"{0}: not a number": "{0} : ce n'est pas un nombre",
	"{0}: not one of the options": "{0} : ce n'est pas l'un des choix",
	"{0}: not text": "{0} : ce n'est pas du texte",
	"{0} is required": "{0} est obligatoire",
	"Wait for the current reply to end": "Attendez la fin de la réponse en cours",
	"This question can no longer be answered": "Cette question n'attend plus de réponse",
	// the /mcp manager.
	"failed: {0}": "échec : {0}",
	" · {0} resource": " · {0} ressource",
	" · {0} resources": " · {0} ressources",
	"connected · {0} tool": "connecté · {0} outil",
	"connected · {0} tools": "connecté · {0} outils",
	"config: {0}": "configuration : {0}",
	"config error: {0}": "erreur de configuration : {0}",
	"overridden: {0}": "remplacé : {0}",
	"MCP servers need attention:\n{0}\nRun /mcp to fix.":
		"Des serveurs MCP demandent votre attention :\n{0}\nLancez /mcp pour corriger.",
	'MCP server "{0}" does not use OAuth.': "Le serveur MCP « {0} » n'utilise pas OAuth.",
	"Sign-in failed: {0}": "Échec de la connexion : {0}",
	"Signed in, but {0}": "Connecté, mais {0}",
	'MCP server "{0}" is disabled.': "Le serveur MCP « {0} » est désactivé.",
	"No MCP servers configured. Add them to {0} or {1}.": "Aucun serveur MCP configuré. Ajoutez-les dans {0} ou {1}.",
	"saved to the {0} mcp.json": "enregistré dans le mcp.json {0}",
	"{0} offered": "{0} proposés",
	"MCP server {0}": "Serveur MCP {0}",
	"Tools of {0}": "Outils de {0}",
	"Exposure {0}: {1}": "Exposition {0} : {1}",
	"Exposure of {0}": "Exposition de {0}",
	"Applies to this session; the server is registered by {0}.":
		"S'applique à cette session ; le serveur est déclaré par {0}.",
	"Saved to {0}.": "Enregistré dans {0}.",
	"Sign in to {0}": "Se connecter à {0}",
	"{0}: needs sign-in, run /mcp login {1} ({2})": "{0} : connexion requise, lancez /mcp login {1} ({2})",
	", {0} tools": ", {0} outils",
	'No MCP server named "{0}".': "Aucun serveur MCP nommé « {0} ».",
	'Signing in to MCP server "{0}" requires interactive mode.':
		"La connexion au serveur MCP « {0} » demande le mode interactif.",
	'Sign in to MCP server "{0}" in your browser:\n{1}':
		"Connectez-vous au serveur MCP « {0} » dans votre navigateur :\n{1}",
	'Waiting for sign-in to "{0}". If the browser cannot reach this machine, paste the URL it was redirected to.':
		"En attente de la connexion à « {0} ». Si le navigateur ne peut pas joindre cette machine, collez l'URL vers laquelle il a été redirigé.",
	'Signed in to MCP server "{0}" ({1} tools).': "Connecté au serveur MCP « {0} » ({1} outils).",
	'MCP server "{0}" is not configured.': "Le serveur MCP « {0} » n'est pas configuré.",
	"MCP failed to load: {0}": "MCP n'a pas pu se charger : {0}",
	'Signed out of MCP server "{0}".': "Déconnecté du serveur MCP « {0} ».",
	'No stored credentials for MCP server "{0}".': "Aucun identifiant enregistré pour le serveur MCP « {0} ».",
	'Reconnected to MCP server "{0}" ({1}).': "Reconnecté au serveur MCP « {0} » ({1}).",
	// pi-lsp notices and /lsp all.
	"LSP config ignored: {0}": "Configuration LSP ignorée : {0}",
	"{0} LSP command: {1}": "Commande LSP de {0} : {1}",
	"{0} status: ready": "{0} : prêt",
	"{0} status: command missing": "{0} : commande introuvable",
	"{0} status: off in /settings > Servers": "{0} : désactivé dans /settings › Serveurs",
	// engine errors shown in the window (O06).
	"Model not found: {0}": "Modèle introuvable : {0}",
	"Auto-compaction failed: {0}": "Échec du résumé automatique : {0}",
	"Context overflow recovery failed: {0}": "Échec du résumé après dépassement du contexte : {0}",
	// files added to a message (file-attachments.ts).
	"{0} is not a file": "{0} n'est pas un fichier",
	"{0} is larger than {1} MB": "{0} dépasse {1} Mo",
	"Could not restore the attached files: {0}": "Impossible de remettre les fichiers joints : {0}",
	"Could not keep the changed attached files: {0}": "Impossible de garder les fichiers joints modifiés : {0}",
	// sign-in with a Claude subscription (anthropic-subscription.ts).
	"Claude subscription": "Abonnement Claude",
	"Anthropic does not allow third-party apps such as Prism to sign in with a Claude Free, Pro, Max or Ultra subscription. Your Claude account may be suspended or banned, without notice. The allowed way is an API key from the Claude Console.":
		"Anthropic n'autorise pas les applications tierces comme Prism à se connecter avec un abonnement Claude Free, Pro, Max ou Ultra. Votre compte Claude peut être suspendu ou banni, sans préavis. La voie autorisée est une clé d'API de la Claude Console.",
	"Sign in anyway": "Se connecter quand même",
	"Install WebKitGTK 4.1 with: {0}": "Installez WebKitGTK 4.1 avec : {0}",
	"Yes, this time": "Oui, cette fois",
	"Yes, for this file until the end of the session": "Oui, pour ce fichier jusqu’à la fin de la session",
	"Yes, for {0} until the end of the session": "Oui, pour {0} jusqu’à la fin de la session",
	"Yes, always for {0}": "Oui, toujours pour {0}",
	"The agent wants to use {0} in this command. Prism puts the key in when it runs; the agent never sees it.":
		"L’agent veut utiliser {0} dans cette commande. Prism y met la clé à l’exécution ; l’agent ne la voit pas.",
	"The agent wants to write {0} into {1}. Prism puts the key in when it writes; the agent never sees it, and {1} is then hidden from the agent until the end of the session.":
		"L’agent veut écrire {0} dans {1}. Prism y met la clé à l’écriture ; l’agent ne la voit pas, et {1} lui est ensuite caché jusqu’à la fin de la session.",
	"The agent wants to write {0} into {1}. Prism puts the key in when it writes and hides {1} from the agent's file tools until the end of the session; its commands, which run without the sandbox, can read it.":
		"L’agent veut écrire {0} dans {1}. Prism y met la clé à l’écriture et cache {1} aux outils de fichiers de l’agent jusqu’à la fin de la session ; ses commandes, qui tournent sans la sandbox, peuvent le lire.",
	"Could not save the rule: {0}": "Règle non enregistrée : {0}",
	// fork: /phone, linking a phone from the terminal (phone-link.ts).
	"The phone server does not answer.": "Le serveur du téléphone ne répond pas.",
	"The phone server did not start.": "Le serveur du téléphone n’a pas démarré.",
	"Scan this code with the Prism app on the phone (valid 5 minutes):":
		"Scannez ce code avec l’app Prism du téléphone (valable 5 minutes) :",
	"Or paste this code in the app:": "Ou collez ce code dans l’app :",
	"The phone will try {0}, port {1}.": "Le téléphone essaiera {0}, port {1}.",
	"The Android app: {0}": "L’app Android : {0}",
	"Enter or Esc closes.": "Entrée ou Échap ferme.",
	"Link a phone: the Prism app on Android uses this PC (/phone)":
		"Lier un téléphone : l’app Prism sur Android utilise ce PC (/phone)",
	"prism-remote is missing from this installation (from a source checkout: cargo build --release in fork/android/server).":
		"prism-remote manque à cette installation (depuis les sources : cargo build --release dans fork/android/server).",
	"The phone server runs ({0}) on {1}, port {2}.": "Serveur du téléphone actif ({0}) sur {1}, port {2}.",
	"always, as a service": "toujours, en service de votre session",
	"while this Prism is open": "pendant que ce Prism est ouvert",
	"started elsewhere": "lancé ailleurs",
	"The phone server is stopped: no phone can reach this PC.":
		"Serveur du téléphone arrêté : aucun téléphone ne peut joindre ce PC.",
	"Linked phones: {0}.": "Téléphones liés : {0}.",
	"No phone linked yet.": "Aucun téléphone lié pour l’instant.",
	"Show a pairing code": "Afficher un code d’appairage",
	"Run while this Prism is open": "Actif pendant que ce Prism est ouvert",
	"Run always, as a user service": "Toujours actif (service de votre session)",
	"Stop the phone server": "Arrêter le serveur du téléphone",
	"Revoke the phone {0}…": "Retirer le téléphone {0}…",
	"Revoke this phone?": "Retirer ce téléphone ?",
	"It will have to be paired again with a new code.": "Il devra être appairé de nouveau avec un nouveau code.",
	"Without Tailscale, the phone reaches this PC on the same network only.":
		"Sans Tailscale, le téléphone ne joint ce PC que sur le même réseau.",
	"Widen the terminal to show the QR code.": "Élargissez le terminal pour voir le QR code.",
	// fork: the onboarding's computer use step (onboarding.ts).
	"The agent can use your browser, a desktop of its own, or yours. Enter turns each on or off; at the end, Prism says what to install, if anything. Every one is in /settings › Computer use.":
		"L’agent peut utiliser votre navigateur, un bureau à lui ou le vôtre. Entrée allume ou éteint chacun ; à la fin, Prism dit quoi installer, s’il le faut. Tous sont dans /settings › Utilisation de l’ordinateur.",
	"Your browser": "Votre navigateur",
	"web pages in your own browser, in tabs of their own (Prism extension)":
		"des pages web dans votre propre navigateur, dans des onglets à lui (extension Prism)",
	"Needs Prism's extension in Firefox, Chromium, Chrome, Brave or Zen: /browser setup walks you through it.":
		"Il faut l’extension Prism dans Firefox, Chromium, Chrome, Brave ou Zen : /browser setup vous guide.",
	"A desktop of its own": "Un bureau à lui",
	"graphical programs on a desktop apart from yours": "des programmes graphiques sur un bureau à part du vôtre",
	"Needs labwc, a small Wayland compositor; Prism says how to install it.":
		"Il faut labwc, un petit compositeur Wayland ; Prism dit comment l’installer.",
	"your own screen, pointer and keyboard, when you agree":
		"votre écran, votre pointeur et votre clavier, quand vous l’acceptez",
	"Needs a Wayland session: Hyprland, GNOME or KDE.": "Il faut une session Wayland : Hyprland, GNOME ou KDE.",
	"{0}: install Prism's extension with /browser setup.": "{0} : installez l’extension Prism avec /browser setup.",
	"To finish setting up computer use:": "Pour finir de préparer l’utilisation de l’ordinateur :",
	// the privacy step of the onboarding.
	Privacy: "Confidentialité",
	"Besides the model you connect, Prism contacts these services. Enter turns each on or off; they stay in /settings › Network & web.":
		"En plus du modèle que vous connectez, Prism contacte ces services. Entrée allume ou éteint chacun ; ils restent dans /settings › Réseau et web.",
	"Model list from pi.dev": "Liste des modèles de pi.dev",
	"new models, at most every 4 hours": "les nouveaux modèles, au plus toutes les 4 heures",
	"Prism asks pi.dev for the models of the providers you connected: pi.dev sees their names, Prism's version and your address. Off, the list changes only with Prism's updates and prism update --models.":
		"Prism demande à pi.dev les modèles des fournisseurs que vous avez connectés : pi.dev voit leurs noms, la version de Prism et votre adresse. Éteint, la liste ne change qu’avec les mises à jour de Prism et prism update --models.",
	"Web search through Exa": "Recherche web par Exa",
	"the model's searches go to Exa, without a key": "les recherches du modèle vont à Exa, sans clé",
	"Off, searches go to your own SearXNG instance: give its address with /web-key searxng. Brave, Tavily and Firecrawl are in /settings › Network & web.":
		"Éteint, les recherches vont à votre propre instance SearXNG : donnez son adresse avec /web-key searxng. Brave, Tavily et Firecrawl sont dans /settings › Réseau et web.",
	"Web search: give your SearXNG instance's address with /web-key searxng.":
		"Recherche web : donnez l’adresse de votre instance SearXNG avec /web-key searxng.",
	"labwc is not installed; install it with: {0}": "labwc n’est pas installé ; installez-le avec : {0}",
	// fork (audit PB-22): what logoutProvider() returns, printed by `prism auth logout` (src/fork/auth-login-cli.ts).
	"Logged out of {0}": "Déconnecté de {0}",
};
