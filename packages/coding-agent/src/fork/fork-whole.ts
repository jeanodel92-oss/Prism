/**
 * fork: /fork and /clone merged. /fork's list ends with the whole conversation as it
 * is now, which is what /clone copies; /clone still runs when typed (UNLISTED_COMMANDS, autocomplete.ts).
 */
export const FORK_WHOLE_CONVERSATION = "prism:fork-whole-conversation";
export const FORK_WHOLE_LABEL = "The whole conversation, as it is now";
export const FORK_WHOLE_DETAIL = "Copy it into a new session, up to its last reply";
