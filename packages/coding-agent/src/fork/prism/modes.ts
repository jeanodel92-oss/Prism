/**
 * fork: when the composer's Plan switch is on, for the terminal's composer and the window's (get_keys). The plan
 * module words its status in the interface language, and a status set before a language change keeps its
 * words, so the words of both languages count.
 */
import { FR } from "../i18n/fr.ts";

export const PLAN_ON_STATUSES: readonly string[] = ["plan active", "plan ready"].flatMap((status) => [
	status,
	FR[status] ?? status,
]);

export const planOn = (status: string | undefined): boolean =>
	status !== undefined && PLAN_ON_STATUSES.includes(status);

/** fork: the Goal status of a finished goal, which the goal module words in the interface language too. */
export const GOAL_DONE_STATUSES: readonly string[] = ["complete", FR.complete ?? "complete"];

/** Whether the composer's Goal switch is on: a goal is set and not finished. */
export const goalOn = (status: string | undefined): boolean =>
	status !== undefined && !GOAL_DONE_STATUSES.includes(status);
