// fork: code pasted in a user message without fences is shown as one code block, whole.
import { describe, expect, it } from "vitest";
import { fencePastedCode } from "../src/fork/pasted-code.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const LIST = `typedef struct node {
    int value;
    struct node *next;
} node_t;

int sum(node_t *head) {
    int total = 0;
    while (head != NULL) {
        total += head->value;
        head = head->next;
    }
    return total;
}

int main(void) {
    node_t *list = malloc(sizeof *list);
    list->value = 3;

    printf("%d\\n", sum(list));
    return 0;
}`;

const C_PROGRAM = `#include <stdio.h>
#include <stdlib.h>

${LIST}`;

const fenced = (code: string) => `\`\`\`\n${code}\n\`\`\``;

describe("fork: code pasted in a user message", () => {
	it("fences a whole C program after a question, blank lines and indentation kept", () => {
		expect(fencePastedCode(`Pourquoi ce code plante ?\n\n${C_PROGRAM}`)).toBe(
			`Pourquoi ce code plante ?\n\n${fenced(C_PROGRAM)}`,
		);
		// Tabs, an opening brace on its own line under the signature, and prose after the code.
		const allman = "int main(void)\n{\n\tint x = 0;\n\n\treturn x;\n}";
		expect(fencePastedCode(`Look:\n\n${allman}\n\nThanks.`)).toBe(`Look:\n\n${fenced(allman)}\n\nThanks.`);
	});

	it("fences each snippet of a mixed message, other languages too, and keeps the prose between them", () => {
		const a = "int a(void) {\n    return 1;\n}";
		const b = "void b(int *p) {\n    *p = 2;\n}";
		expect(fencePastedCode(`First:\n\n${a}\n\nThen this one fails:\n\n${b}\nWhy?`)).toBe(
			`First:\n\n${fenced(a)}\n\nThen this one fails:\n\n${fenced(b)}\nWhy?`,
		);
		const rust = 'fn main() {\n    let v = vec![1, 2];\n    for x in &v {\n        println!("{}", x);\n    }\n}';
		expect(fencePastedCode(rust)).toBe(fenced(rust));
		const python = "def f(x):\n    if x:\n        return 1\n    return 2\n\nprint(f(3))";
		expect(fencePastedCode(python)).toBe(fenced(python));
		// A fence inside the code gets a longer one around it.
		const js = 'const md = "```";\nconsole.log(md);';
		expect(fencePastedCode(js)).toBe(`\`\`\`\`\n${js}\n\`\`\`\``);
	});

	it("leaves prose, French lists, inline code and fenced code as they are", () => {
		for (const text of [
			"Pour chaque défaut :\n- reproduis-le ;\n- corrige-le ;\n- ajoute des tests.",
			"I tried it; it failed.\nThen I retried; same thing.",
			"Ajoute `x++;` à la fin; merci.",
			"```c\nint a(void) {\n  return 1;\n}\n```\nDone.",
			"One statement alone stays text: x = 1;",
		]) {
			expect(fencePastedCode(text)).toBe(text);
		}
	});

	it("shows the pasted program in one code block in the transcript, every line kept", () => {
		initTheme("dark");
		const lines = new UserMessageComponent(`Pourquoi ce code plante ?\n\n${C_PROGRAM}`)
			.render(90)
			.map((line) => stripAnsi(line).trimEnd());
		// Inside the block, each source line keeps its text and indentation, under a two-column code margin.
		const first = lines.findIndex((line) => line.includes("#include <stdio.h>"));
		const source = C_PROGRAM.split("\n");
		const block = lines.slice(first, first + source.length);
		const margin = block[0]!.indexOf("#");
		expect(block.map((line) => line.slice(margin))).toEqual(source.map((line) => line.trimEnd()));
		// One block: upstream's renderer shows its two fence lines, around the whole program.
		expect(lines.filter((line) => line.trim() === "```")).toHaveLength(2);
		expect(lines[first - 1]!.trim()).toBe("```");
	});
});
