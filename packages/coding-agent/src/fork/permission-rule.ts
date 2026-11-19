/**
 * The text of a permission rule, `tool` or `tool(pattern)`: one grammar for the gate (`permissions.ts`) and for the
 * file of rules given to projects (`project-permissions.ts`), so that a rule one of them drops the other refuses
 * too.
 */
export const RULE_TEXT = /^([A-Za-z0-9_-]+)\s*(?:\((.*)\))?$/;

export const isRuleText = (raw: string) => RULE_TEXT.test(raw.trim());
