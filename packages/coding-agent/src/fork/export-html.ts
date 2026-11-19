// fork: Prism's look for `/export`, appended after upstream's template CSS
// (src/core/export-html/template.css). It only restyles: the markup, the script and the
// theme variables stay upstream's, so every theme still drives the colours.
//
// Upstream sets the whole page in a 12px monospace font and gives tool calls a full
// background from `toolPendingBg`/`toolSuccessBg`/`toolErrorBg`. The Prism theme leaves
// those empty (its TUI draws a timeline instead), so tool cards came out pure black.
// Here prose uses a proportional font, code and tools stay monospace.
//
// fork: the site's art direction: the page's colours from the theme
// (prism: the site's black, three inks and hairlines), the site's font stacks without any download, a
// 46rem measure, 1px lines and 3px corners instead of cut tiles, the site's mark instead of the pixel logo,
// and the site's state dots on tool calls. The page stays self-contained: no font or resource is fetched.
//
// fork: closer to the site's overall direction, not a copy of it: the session tree gets air and the
// three inks instead of a colour per role, the header labels the site's sans, and the header line carries
// the dark spectrum from the mark, the opening being one of the spectrum's permitted places (da-site.md § 3.3).

import type { SessionEntry } from "../core/session-manager.ts";
import { getResolvedThemeColors, isLightTheme } from "../modes/interactive/theme/theme.ts";
import { fencePastedCode } from "./pasted-code.ts";
import { hexToRgb, mix, type RGB, spectrumRamp } from "./prism/lib/palette.ts";

const hex = ([r, g, b]: RGB) => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

/** The site's mark (a triangle in outline and its beam) as an SVG data URI, stroked in `ink`. */
function markUri(ink: string): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="${ink}" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M16 5 28 26H4Z"/><path d="M1 19.5h8.4"/></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The Prism stylesheet for an export in `themeName` (the terminal's theme, see export-html/index.ts). */
export function prismExportCss(themeName?: string): string {
	const colors = getResolvedThemeColors(themeName);
	const tile = hexToRgb(colors.userMessageBg || "#343541");
	const band = hexToRgb(colors.selectedBg || "#3a3a4a");
	const ink = colors.text || "#e5e5e7";
	// The beam leaves the mark in the spectrum and fades into the neutral line by mid-page.
	const ramp = spectrumRamp(isLightTheme(themeName));
	const beam = ramp.map((color, i) => `${hex(color)} ${Math.round((i / (ramp.length - 1)) * 30)}%`).join(", ");
	return PRISM_EXPORT_CSS.replace("{{TILE}}", hex(tile))
		.replace("{{TILE2}}", hex(mix(tile, band, 0.4)))
		.replace("{{LINE}}", colors.borderMuted || "#505050")
		.replace("{{STRONG}}", colors.borderAccent || "#808080")
		.replace("{{MARK}}", markUri(ink))
		.replace("{{BEAM}}", beam);
}

const PRISM_EXPORT_CSS = `
    /* Prism export */
    :root {
      --prism-sans: "Inter", "Adwaita Sans", "Helvetica Neue", "Segoe UI", system-ui, sans-serif;
      --prism-mono: "JetBrains Mono", "Adwaita Mono", "DejaVu Sans Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
      --prism-gap: 14px;
      --prism-tile: {{TILE}};
      --prism-tile-2: {{TILE2}};
      --prism-line: {{LINE}};
      --prism-strong: {{STRONG}};
      --prism-radius: 3px;
    }

    body { font-family: var(--prism-sans); font-size: 15px; line-height: 1.62; }
    #content { padding: 32px 40px 64px; }
    #content > * { max-width: 46rem; }
    #messages { gap: var(--prism-gap); }
    a { color: inherit; text-decoration-color: var(--prism-strong); text-underline-offset: 0.22em; }
    a:hover { text-decoration-color: var(--text); }
    :focus-visible { outline: 2px solid var(--text); outline-offset: 3px; border-radius: 2px; }

    /* Header: the site's mark and the session facts, closed by a hairline. */
    .header {
      position: relative;
      background: transparent;
      border: 0;
      border-radius: 0;
      padding: 4px 0 20px 44px;
      margin-bottom: 24px;
    }
    .header::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 1px;
      background: linear-gradient(90deg, {{BEAM}}, var(--prism-line) 55%);
    }
    .header::before {
      content: "";
      position: absolute;
      left: 0;
      top: 4px;
      width: 28px;
      height: 28px;
      background: url("{{MARK}}") no-repeat center / contain;
    }
    .header h1 {
      font-size: 18px;
      font-weight: 500;
      letter-spacing: -0.005em;
      color: var(--text);
      margin-bottom: 10px;
      word-break: break-all;
    }
    .help-bar { color: var(--muted); font-size: 12px; margin-bottom: 14px; }

    /* Buttons: a 1px strong line, 2px corners, the outline in ink on hover; pressed ones in inverted ink. */
    .header-toggle-btn, .download-json-btn, .filter-btn {
      font-family: var(--prism-mono);
      font-size: 11px;
      padding: 4px 10px;
      border: 1px solid var(--prism-strong);
      border-radius: 2px;
      background: transparent;
      color: var(--muted);
    }
    .header-toggle-btn:hover, .download-json-btn:hover, .filter-btn:hover { color: var(--text); border-color: var(--text); }
    .header-toggle-btn[aria-pressed="true"], .filter-btn.active {
      background: var(--text);
      border-color: var(--text);
      color: var(--body-bg);
    }
    .filter-btn { font-size: 10px; padding: 3px 8px; }

    .header-info {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 10px 18px;
      font-size: 12px;
    }
    .info-item { flex-direction: column; color: var(--muted); }
    .info-label {
      min-width: 0;
      margin: 0;
      font-size: 12px;
      font-weight: 400;
      color: var(--muted);
    }
    .info-value { font-family: var(--prism-mono); font-size: 12px; }

    .message-timestamp { font-family: var(--prism-mono); font-size: 10px; color: var(--muted); }

    /* User turns: a tile in the surface with a hairline. */
    .user-message {
      background: var(--prism-tile);
      border: 1px solid var(--prism-line);
      border-radius: var(--prism-radius);
      padding: 12px 16px;
    }
    .user-message .message-timestamp { margin-bottom: 4px; }
    .copy-link-btn { border: 1px solid var(--prism-strong); border-radius: 2px; background: transparent; }

    .assistant-text { padding: 6px 2px 0; }

    /* Thinking: quiet, set apart by a rail in the strong line. */
    .thinking-text, .thinking-collapsed {
      margin: 4px 0;
      padding: 2px 0 2px 14px;
      border-left: 1px solid var(--prism-strong);
      font-size: 14px;
    }

    /* Tool calls: monospace, a hairline, and the site's state dot (empty while running, filled once done). */
    .tool-execution,
    .tool-execution.pending,
    .tool-execution.success,
    .tool-execution.error {
      position: relative;
      background: transparent;
      border: 1px solid var(--prism-line);
      border-radius: var(--prism-radius);
      padding: 10px 14px 10px 34px;
      font-family: var(--prism-mono);
      font-size: 12px;
      line-height: 1.55;
    }
    .tool-execution::before {
      position: absolute;
      left: 14px;
      top: 15px;
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      border: 1px solid var(--success);
      background: var(--success);
    }
    .tool-execution.pending::before { border-color: var(--muted); background: transparent; }
    .tool-execution.error::before { border-color: var(--error); background: var(--error); }
    .tool-execution + .tool-execution,
    .assistant-text + .tool-execution { margin-top: 10px; }
    .tool-name { color: var(--text); }
    .tool-output { margin-top: 8px; }
    .tool-diff { border-radius: 0; }

    /* Markdown: headings in ink, weight 500, never oversized. */
    .markdown-content h1, .markdown-content h2, .markdown-content h3,
    .markdown-content h4, .markdown-content h5, .markdown-content h6 {
      line-height: 1.3;
      margin: 18px 0 8px;
      font-weight: 500;
      color: var(--mdHeading);
    }
    .markdown-content h1 { font-size: 1.3em; }
    .markdown-content h2 { font-size: 1.15em; }
    .markdown-content h3, .markdown-content h4, .markdown-content h5, .markdown-content h6 {
      font-size: 1em;
      color: var(--thinkingText);
    }
    .markdown-content > :first-child { margin-top: 0; }
    .markdown-content p + p { margin-top: 10px; }
    .markdown-content ul, .markdown-content ol { margin: 8px 0; }
    /* bold keeps its weight, in the theme's bold tint when it has one. */
    .markdown-content strong { color: var(--mdBold, inherit); }
    .markdown-content code {
      font-family: var(--prism-mono);
      font-size: 0.88em;
      padding: 1px 6px;
      background: var(--prism-tile-2);
      border-radius: 2px;
    }
    .markdown-content pre {
      font-family: var(--prism-mono);
      font-size: 12.5px;
      line-height: 1.55;
      background: var(--prism-tile-2);
      border: 1px solid var(--prism-line);
      border-radius: var(--prism-radius);
      padding: 12px 16px;
      margin: 12px 0;
    }
    .markdown-content pre code { padding: 0; font-size: inherit; background: transparent; }
    .markdown-content blockquote {
      border-left: 1px solid var(--mdQuoteBorder);
      padding: 2px 0 2px 14px;
      margin: 12px 0;
    }
    .markdown-content table {
      border-collapse: collapse;
      border: 0;
      margin: 12px 0;
      font-size: 13px;
    }
    .markdown-content th, .markdown-content td {
      border: 0;
      border-bottom: 1px solid var(--prism-line);
      padding: 7px 12px;
    }
    .markdown-content tr:last-child td { border-bottom: 0; }
    .markdown-content th { text-align: left; font-weight: 500; color: var(--muted); }
    .markdown-content hr { border: 0; height: 1px; background: var(--prism-line); margin: 18px 0; }

    /* Sidebar: the tree's branches stay monospace; entries in the sans, with air, in the three inks. */
    #sidebar { font-family: var(--prism-mono); font-size: 12px; border-right-color: var(--prism-line); }
    .tree-node { font-size: 12px; line-height: 20px; padding: 0 12px; }
    .tree-content { font-family: var(--prism-sans); color: var(--thinkingText); }
    .tree-role-user { color: var(--text); }
    .tree-role-assistant { color: var(--thinkingText); }
    .tree-role-tool, .tree-role-skill, .tree-custom-message { color: var(--muted); }
    .tree-marker { color: var(--text); }
    .tree-node.active .tree-content { font-weight: 500; color: var(--text); }

    .model-change, .compaction, .branch-summary, .hook-message, .skill-invocation, .system-prompt {
      border-radius: var(--prism-radius);
    }

    @media (max-width: 900px) {
      #content { padding: 56px 16px 40px; }
      .header-info { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
    }

    @media print {
      .user-message, .markdown-content pre, .header-toggle-btn, .filter-btn {
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
      .tool-execution, .markdown-content pre, .header { break-inside: avoid; }
    }
`;

/**
 * fork: user messages as `/export` shows them, keyed by entry id, only where they hold code
 * pasted without fences: that code is fenced as in the TUI (`fencePastedCode`), so `/* **x** *\/` is not turned
 * bold and indentation survives. The session data itself is exported unchanged.
 */
export function pastedCodeDisplay(entries: readonly SessionEntry[]): Record<string, string> {
	const display: Record<string, string> = {};
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		// The text the template renders: a string, or the text parts joined by newlines.
		const text =
			typeof content === "string"
				? content
				: content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		const fenced = fencePastedCode(text);
		if (fenced !== text) display[entry.id] = fenced;
	}
	return display;
}
