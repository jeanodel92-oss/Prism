#!/usr/bin/env node
// Builds the website's source browser for one version of Prism: a static page per folder and per file, in English
// and French, each file downloadable on its own, the whole tree as a tar.gz archive, and the list of every version
// published so far. The tree is a Git checkout of the public repository (fork/scripts/public-export.mjs), so the
// browser shows the same code as the public repository, at the commit it names.
//
// usage: node fork/scripts/source-pages.mjs --tree <public checkout> --version <version> --site <site root>
//                                          [--repo-url <public repository URL>] [--date YYYY-MM-DD]
//
// It writes, below the site root:
//   source/code/<version>/files/<path>         every tracked file, as is (served as a download, see the Caddyfile)
//   source/code/<version>/prism-<version>-source.tar.gz
//   source/code/<version>/tree/<folder>/        folder pages, English; fr/source/code/... the French ones
//   source/code/<version>/blob/<file>/          file pages
//   source/code/versions.json, source/code/, fr/source/code/   the list of versions
//   source/code/latest/, fr/source/code/latest/                 a redirect to the newest version's tree
// The page shell (header, navigation, footer) is taken from the site's own source/index.html and fr/source/index.html.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Files above this size are offered as downloads only: a page for them would be too heavy to read. */
const MAX_SHOWN = 512 * 1024;

const TEXT = {
	en: {
		kicker: "Source code",
		version: "Version {0}",
		commit: "commit {0}",
		archive: "Download the archive",
		files: "Files",
		name: "Name",
		size: "Size",
		up: "Parent folder",
		download: "Download",
		lines: (n) => (n === 1 ? "1 line" : `${n.toLocaleString("en")} lines`),
		binary: "Binary file: download it to read it.",
		tooLarge: "This file is too large to show here: download it to read it.",
		versions: "Every version",
		versionsTitle: "Every version of the code",
		versionsLead:
			"The complete code of each published version, file by file, as it is in the public repository at that commit.",
		latest: "latest",
		filesCount: (n) => `${n.toLocaleString("en")} files`,
		browse: "Browse",
		titleSuffix: "Source code · Prism",
		description: "Prism's source code, version {0}: {1}.",
		sizeUnits: ["B", "KiB", "MiB", "GiB"],
		decimal: ".",
		breadcrumb: "Path",
		code: "Code of {0}",
	},
	fr: {
		kicker: "Code source",
		version: "Version {0}",
		commit: "commit {0}",
		archive: "Télécharger l'archive",
		files: "Fichiers",
		name: "Nom",
		size: "Taille",
		up: "Dossier parent",
		download: "Télécharger",
		lines: (n) => (n === 1 ? "1 ligne" : `${n.toLocaleString("fr").replace(/ /g, " ")} lignes`),
		binary: "Fichier binaire : téléchargez-le pour le lire.",
		tooLarge: "Ce fichier est trop grand pour être affiché ici : téléchargez-le pour le lire.",
		versions: "Toutes les versions",
		versionsTitle: "Le code de chaque version",
		versionsLead:
			"Le code complet de chaque version publiée, fichier par fichier, tel qu'il est dans le dépôt public à ce commit.",
		latest: "dernière",
		filesCount: (n) => `${n.toLocaleString("fr").replace(/ /g, " ")} fichiers`,
		browse: "Parcourir",
		titleSuffix: "Code source · Prism",
		description: "Le code source de Prism, version {0} : {1}.",
		sizeUnits: ["o", "Kio", "Mio", "Gio"],
		decimal: ",",
		breadcrumb: "Chemin",
		code: "Code de {0}",
	},
};

const fill = (text, ...values) => text.replace(/\{(\d)\}/g, (_, i) => values[Number(i)]);
const escape = (text) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A path as a URL: each segment encoded, "/" kept. */
const href = (path) => path.split("/").map(encodeURIComponent).join("/");

function size(bytes, lang) {
	const t = TEXT[lang];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < t.sizeUnits.length - 1) {
		value /= 1024;
		unit++;
	}
	const shown = unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0).replace(".", t.decimal);
	return `${shown} ${t.sizeUnits[unit]}`;
}

function option(name) {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : undefined;
}

/** The site page's header and footer around its <main>, with the title, description and language links to fill. */
function shell(site, lang) {
	const page = readFileSync(join(site, lang === "fr" ? "fr/source/index.html" : "source/index.html"), "utf8");
	const start = page.indexOf("  <main");
	const end = page.indexOf("  </main>\n");
	if (start < 0 || end < 0) throw new Error(`no <main> in the ${lang} source page`);
	return { head: page.slice(0, start), foot: page.slice(end + "  </main>\n".length) };
}

/** One page: the shell with this page's title, description, alternate and language links, and source.css. */
function page(shells, lang, { title, description, enPath, frPath, main }) {
	const other = lang === "fr" ? enPath : frPath;
	let head = shells[lang].head
		.replace(/<title>[^<]*<\/title>/, `<title>${escape(title)}</title>`)
		.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escape(description)}">`)
		.replace(/<link rel="alternate" hreflang="en" href="[^"]*">/, `<link rel="alternate" hreflang="en" href="${enPath}">`)
		.replace(/<link rel="alternate" hreflang="fr" href="[^"]*">/, `<link rel="alternate" hreflang="fr" href="${frPath}">`)
		.replace(/(<a class="lang" href=")[^"]*(")/, `$1${other}$2`)
		.replace(/<link rel="stylesheet" href="\/style\.css">(?!\n  <link rel="stylesheet" href="\/source\.css">)/, '<link rel="stylesheet" href="/style.css">\n  <link rel="stylesheet" href="/source.css">');
	if (!head.includes("/source.css")) throw new Error("the source page shell has no /style.css link");
	head = head.replace(' aria-current="page"', ' aria-current="true"');
	return `${head}${main}  </main>\n${shells[lang].foot}`;
}

function git(cwd, ...args) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** Text the browser can show: valid UTF-8 without NUL bytes. */
function asText(buffer) {
	if (buffer.subarray(0, 8192).includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		return undefined;
	}
}

function main() {
	const tree = option("--tree");
	const version = option("--version");
	const site = option("--site");
	const repoUrl = option("--repo-url");
	const date = option("--date") ?? new Date().toISOString().slice(0, 10);
	if (!tree || !version || !site || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
		console.error(
			"usage: source-pages.mjs --tree <public checkout> --version <version> --site <site root> [--repo-url <url>] [--date YYYY-MM-DD]",
		);
		process.exit(2);
	}
	const commit = git(tree, "rev-parse", "HEAD").trim();
	const files = git(tree, "ls-files", "-z").split("\0").filter(Boolean).sort();
	const shells = { en: shell(site, "en"), fr: shell(site, "fr") };
	const base = { en: `/source/code/${href(version)}`, fr: `/fr/source/code/${href(version)}` };
	const out = { en: join(site, "source/code", version), fr: join(site, "fr/source/code", version) };
	for (const dir of Object.values(out)) rmSync(dir, { recursive: true, force: true });

	// Raw files and the archive, shared by both languages.
	const rawRoot = join(out.en, "files");
	for (const file of files) {
		mkdirSync(dirname(join(rawRoot, file)), { recursive: true });
		copyFileSync(join(tree, file), join(rawRoot, file));
	}
	const archiveName = `prism-${version}-source.tar.gz`;
	const archive = join(out.en, archiveName);
	execFileSync("git", ["-C", tree, "archive", "--format=tar.gz", `--prefix=prism-${version}/`, "-o", archive, "HEAD"]);
	const archiveBytes = statSync(archive).size;
	const archiveSha = createHash("sha256").update(readFileSync(archive)).digest("hex");

	// Folders and what they hold.
	const folders = new Map([["", { dirs: new Set(), files: [] }]]);
	for (const file of files) {
		const parts = file.split("/");
		for (let i = 1; i < parts.length; i++) {
			const parent = parts.slice(0, i - 1).join("/");
			const folder = parts.slice(0, i).join("/");
			if (!folders.has(folder)) folders.set(folder, { dirs: new Set(), files: [] });
			folders.get(parent).dirs.add(folder);
		}
		folders.get(parts.slice(0, -1).join("/")).files.push(file);
	}

	const commitText = (lang) => {
		const short = commit.slice(0, 12);
		const label = escape(fill(TEXT[lang].commit, short));
		return repoUrl
			? `<a href="${escape(`${repoUrl.replace(/\/$/, "")}/tree/${commit}`)}" rel="noopener noreferrer">${label}</a>`
			: `<span title="${commit}">${label}</span>`;
	};

	/** The block above every folder and file page: version, commit, archive, and the path as links. */
	const top = (lang, path, isFile) => {
		const t = TEXT[lang];
		const parts = path ? path.split("/") : [];
		const crumbs = [`<a href="${base[lang]}/tree/">prism</a>`];
		parts.forEach((part, i) => {
			const sub = parts.slice(0, i + 1).join("/");
			const last = i === parts.length - 1;
			const link = last && isFile ? `${base[lang]}/blob/${href(sub)}/` : `${base[lang]}/tree/${href(sub)}/`;
			crumbs.push(last ? `<span aria-current="page">${escape(part)}</span>` : `<a href="${link}">${escape(part)}</a>`);
		});
		return `    <header class="src-head">
      <p class="kicker"><a href="${lang === "fr" ? "/fr/source/" : "/source/"}">${t.kicker}</a> · <a href="${lang === "fr" ? "/fr/source/code/" : "/source/code/"}">${escape(fill(t.version, version))}</a> · ${commitText(lang)}</p>
      <nav class="src-path" aria-label="${t.breadcrumb}">${crumbs.join('<span class="sep">/</span>')}</nav>
      <p class="src-archive"><a href="${base.en}/${href(archiveName)}" download>${t.archive}</a> <span>tar.gz · ${size(archiveBytes, lang)}</span></p>
    </header>
`;
	};

	let pages = 0;
	const write = (path, html) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, html);
		pages++;
	};

	for (const lang of ["en", "fr"]) {
		const t = TEXT[lang];
		for (const [folder, { dirs, files: inside }] of folders) {
			const rows = [];
			if (folder) {
				const parent = folder.split("/").slice(0, -1).join("/");
				rows.push(
					`<li class="up"><a href="${base[lang]}/tree/${parent ? `${href(parent)}/` : ""}">..</a><span class="sr">${t.up}</span></li>`,
				);
			}
			for (const dir of [...dirs].sort()) {
				const name = dir.split("/").pop();
				rows.push(`<li class="dir"><a href="${base[lang]}/tree/${href(dir)}/">${escape(name)}/</a></li>`);
			}
			for (const file of inside) {
				const name = file.split("/").pop();
				const bytes = statSync(join(tree, file)).size;
				rows.push(
					`<li class="file"><a href="${base[lang]}/blob/${href(file)}/">${escape(name)}</a><span class="size">${size(bytes, lang)}</span></li>`,
				);
			}
			const label = folder || "prism";
			const main = `  <main id="${lang === "fr" ? "contenu" : "content"}" class="src">
${top(lang, folder, false)}    <section class="src-list" aria-label="${t.files}">
      <ul>
        ${rows.join("\n        ")}
      </ul>
    </section>
`;
			const rel = folder ? `${href(folder)}/` : "";
			write(
				join(out[lang], "tree", folder, "index.html"),
				page(shells, lang, {
					title: `${label}/ · ${version} · ${t.titleSuffix}`,
					description: fill(t.description, version, `${label}/`),
					enPath: `${base.en}/tree/${rel}`,
					frPath: `${base.fr}/tree/${rel}`,
					main,
				}),
			);
		}

		for (const file of files) {
			const buffer = readFileSync(join(tree, file));
			const text = buffer.length <= MAX_SHOWN ? asText(buffer) : undefined;
			const download = `<a class="src-dl" href="${base.en}/files/${href(file)}" download="${escape(file.split("/").pop())}">${t.download}</a>`;
			let body;
			let meta = size(buffer.length, lang);
			if (text !== undefined) {
				const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
				meta += ` · ${t.lines(lines.length)}`;
				const numbers = lines.map((_, i) => i + 1).join("\n");
				body = `<div class="src-code" role="region" aria-label="${escape(fill(t.code, file))}" tabindex="0"><pre class="ln" aria-hidden="true">${numbers}</pre><pre class="tx"><code>${escape(lines.join("\n"))}</code></pre></div>`;
			} else {
				body = `<p class="src-none">${buffer.length > MAX_SHOWN && asText(buffer.subarray(0, 8192)) !== undefined ? t.tooLarge : t.binary}</p>`;
			}
			const main = `  <main id="${lang === "fr" ? "contenu" : "content"}" class="src">
${top(lang, file, true)}    <section class="src-file" aria-label="${escape(file)}">
      <p class="src-meta"><span>${meta}</span>${download}</p>
      ${body}
    </section>
`;
			write(
				join(out[lang], "blob", file, "index.html"),
				page(shells, lang, {
					title: `${file} · ${version} · ${t.titleSuffix}`,
					description: fill(t.description, version, file),
					enPath: `${base.en}/blob/${href(file)}/`,
					frPath: `${base.fr}/blob/${href(file)}/`,
					main,
				}),
			);
		}
	}

	// The list of versions: this one added or replaced, newest first. A preview whose name is not a version number
	// (dev-preview) comes after the releases: "latest" is always a release once there is one
	// .
	const listPath = join(site, "source/code/versions.json");
	const list = existsSync(listPath) ? JSON.parse(readFileSync(listPath, "utf8")) : [];
	const entry = { version, commit, date, files: files.length, archive: archiveName, bytes: archiveBytes, sha256: archiveSha };
	const release = (v) => /^[0-9]/.test(v.version);
	const versions = [entry, ...list.filter((v) => v.version !== version)].sort((a, b) =>
		release(a) !== release(b)
			? Number(release(b)) - Number(release(a))
			: a.date === b.date
				? b.version.localeCompare(a.version, "en", { numeric: true })
				: b.date.localeCompare(a.date),
	);
	writeFileSync(listPath, `${JSON.stringify(versions, null, "\t")}\n`);
	for (const lang of ["en", "fr"]) {
		const t = TEXT[lang];
		const items = versions.map((v, i) => {
			const vb = `${lang === "fr" ? "/fr" : ""}/source/code/${href(v.version)}`;
			return `<li><p class="v"><b>${escape(v.version)}</b>${i === 0 ? ` <span class="tag">${t.latest}</span>` : ""}<time datetime="${v.date}">${v.date}</time></p><p class="files"><a href="${vb}/tree/">${t.browse}</a> · <a href="/source/code/${href(v.version)}/${href(v.archive)}" download>${t.archive}</a> (${size(v.bytes, lang)}) · ${t.filesCount(v.files)} · <span title="${v.commit}">${escape(fill(t.commit, v.commit.slice(0, 12)))}</span></p><code>sha256 ${v.sha256}</code></li>`;
		});
		const main = `  <main id="${lang === "fr" ? "contenu" : "content"}">
    <header class="page-hero hero-stray">
      <p class="kicker"><a href="${lang === "fr" ? "/fr/source/" : "/source/"}">${t.kicker}</a></p>
      <h1>${t.versionsTitle}</h1>
      <p class="lead">${t.versionsLead}</p>
    </header>

    <div class="page-body">
      <section class="doc" aria-label="${t.versions}">
        <ol class="versions">
          ${items.join("\n          ")}
        </ol>
      </section>
    </div>
`;
		write(
			join(site, lang === "fr" ? "fr/source/code" : "source/code", "index.html"),
			page(shells, lang, {
				title: `${t.versions} · ${t.titleSuffix}`,
				description: t.versionsLead,
				enPath: "/source/code/",
				frPath: "/fr/source/code/",
				main,
			}),
		);
	}
	// source/code/latest/ (and its French twin) sends to the newest version's tree: the source pages link there.
	for (const lang of ["en", "fr"]) {
		const target = `${lang === "fr" ? "/fr" : ""}/source/code/${href(versions[0].version)}/tree/`;
		const t = TEXT[lang];
		const main = `  <main id="${lang === "fr" ? "contenu" : "content"}" class="src">
    <p><a href="${target}">${escape(fill(t.version, versions[0].version))}</a></p>
`;
		const html = page(shells, lang, {
			title: `${t.versions} · ${t.titleSuffix}`,
			description: t.versionsLead,
			enPath: "/source/code/latest/",
			frPath: "/fr/source/code/latest/",
			main,
		}).replace("</title>", `</title>\n  <meta http-equiv="refresh" content="0; url=${target}">`);
		write(join(site, lang === "fr" ? "fr/source/code" : "source/code", "latest", "index.html"), html);
	}
	console.log(
		`${version} (${commit.slice(0, 12)}): ${files.length} files, ${folders.size} folders, ${pages} pages, archive ${size(archiveBytes, "en")}`,
	);
}

main();
