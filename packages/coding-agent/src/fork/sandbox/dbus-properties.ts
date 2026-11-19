import type { DbusHeader } from "./dbus.ts";

const SYSTEMD = "org.freedesktop.systemd1";

// Owner decision D17: operational state and identity, never execution configuration or free-form status text.
const STATE = new Map<string, ReadonlyMap<string, string>>([
	[
		`${SYSTEMD}.Unit`,
		new Map(
			Object.entries({
				Id: "s",
				Names: "as",
				Description: "s",
				LoadState: "s",
				ActiveState: "s",
				SubState: "s",
				UnitFileState: "s",
				StateChangeTimestamp: "t",
				StateChangeTimestampMonotonic: "t",
				InactiveExitTimestamp: "t",
				InactiveExitTimestampMonotonic: "t",
				ActiveEnterTimestamp: "t",
				ActiveEnterTimestampMonotonic: "t",
				ActiveExitTimestamp: "t",
				ActiveExitTimestampMonotonic: "t",
				InactiveEnterTimestamp: "t",
				InactiveEnterTimestampMonotonic: "t",
			}),
		),
	],
	[
		`${SYSTEMD}.Service`,
		new Map(
			Object.entries({
				MainPID: "u",
				ControlPID: "u",
				Result: "s",
				NRestarts: "u",
				ExecMainCode: "i",
				ExecMainStatus: "i",
				ExecMainStartTimestamp: "t",
				ExecMainStartTimestampMonotonic: "t",
				ExecMainExitTimestamp: "t",
				ExecMainExitTimestampMonotonic: "t",
			}),
		),
	],
	[
		`${SYSTEMD}.Timer`,
		new Map(
			Object.entries({
				Result: "s",
				NextElapseUSecRealtime: "t",
				NextElapseUSecMonotonic: "t",
				LastTriggerUSec: "t",
				LastTriggerUSecMonotonic: "t",
			}),
		),
	],
	...["Socket", "Path", "Mount", "Automount", "Swap", "Scope"].map((kind): [string, ReadonlyMap<string, string>] => [
		`${SYSTEMD}.${kind}`,
		new Map([["Result", "s"]]),
	]),
	[
		`${SYSTEMD}.Manager`,
		new Map([
			["SystemState", "s"],
			["NFailedUnits", "u"],
			["NJobs", "u"],
		]),
	],
]);
const UNIT_STATE = new Map(
	[...STATE].filter(([iface]) => iface !== `${SYSTEMD}.Manager`).flatMap(([, fields]) => [...fields]),
);

const alignment = (type: string) => {
	if ("ygv".includes(type)) return 1;
	if ("nq".includes(type)) return 2;
	if ("buihsoa".includes(type)) return 4;
	if ("xtd({".includes(type)) return 8;
	throw new Error("unsupported D-Bus type");
};

function typeEnd(signature: string, at: number, depth = 0): number {
	if (depth > 64 || at >= signature.length) throw new Error("invalid D-Bus signature");
	const type = signature[at]!;
	if (type === "a") return typeEnd(signature, at + 1, depth + 1);
	if (type === "(" || type === "{") {
		const close = type === "(" ? ")" : "}";
		let end = at + 1;
		while (signature[end] !== close) end = typeEnd(signature, end, depth + 1);
		return end + 1;
	}
	if (!"ybnqiuxtdsoghv".includes(type)) throw new Error("invalid D-Bus signature");
	return at + 1;
}

/** A bounded reader; array contents can be skipped using their wire length, including unknown properties. */
class Reader {
	data: Buffer;
	little: boolean;
	at: number;
	constructor(data: Buffer, header: DbusHeader) {
		this.data = data.subarray(0, header.length);
		this.little = header.little;
		this.at = header.body;
	}
	pad(to: number): void {
		this.take(Math.ceil(this.at / to) * to - this.at);
	}
	take(size: number): Buffer {
		if (this.at + size > this.data.length) throw new Error("truncated D-Bus body");
		const result = this.data.subarray(this.at, this.at + size);
		this.at += size;
		return result;
	}
	u32(): number {
		this.pad(4);
		const value = this.take(4);
		return this.little ? value.readUInt32LE() : value.readUInt32BE();
	}
	text(signature = false): string {
		const size = signature ? this.take(1)[0]! : this.u32();
		const value = this.take(size);
		if (this.take(1)[0] !== 0 || value.includes(0)) throw new Error("invalid D-Bus string");
		return value.toString("utf8");
	}
	skip(signature: string, depth = 0): void {
		if (depth > 64 || !signature) throw new Error("invalid D-Bus signature");
		for (let at = 0; at < signature.length; ) {
			const end = typeEnd(signature, at);
			const type = signature.slice(at, end);
			at = end;
			this.pad(alignment(type[0]!));
			if (type[0] === "a") {
				const size = this.u32();
				this.pad(alignment(type[1]!));
				this.take(size);
			} else if (type[0] === "(" || type[0] === "{") this.skip(type.slice(1, -1), depth + 1);
			else if (type === "v") this.skip(this.text(true), depth + 1);
			else if (type === "s" || type === "o" || type === "g") this.text(type === "g");
			else this.take(type === "y" ? 1 : "nq".includes(type) ? 2 : "xtd".includes(type) ? 8 : 4);
		}
	}
}

/** Validate the exact request body before forwarding; the empty GetAll interface is used by systemctl. */
export function stateProperties(message: Buffer, header: DbusHeader): ReadonlyMap<string, string> {
	const get = header.member === "Get";
	if (header.signature !== (get ? "ss" : "s")) throw new Error("invalid property request signature");
	const reader = new Reader(message, header);
	const iface = reader.text();
	const unit = /^\/org\/freedesktop\/systemd1\/unit\/[^/]+$/.test(header.path ?? "");
	const fields = unit
		? iface === "" && !get
			? UNIT_STATE
			: iface === `${SYSTEMD}.Manager`
				? undefined
				: STATE.get(iface)
		: header.path === "/org/freedesktop/systemd1" && (iface === `${SYSTEMD}.Manager` || (!get && iface === ""))
			? STATE.get(`${SYSTEMD}.Manager`)
			: undefined;
	if (!fields || (get && !fields.has(reader.text())) || reader.at !== header.length)
		throw new Error("only allow-listed state properties may be read; configuration and environment are refused");
	return fields;
}

/** Keep complete dictionary entries: moving them by multiples of eight preserves all D-Bus alignments. */
export function filterStateProperties(
	message: Buffer,
	header: DbusHeader,
	fields: ReadonlyMap<string, string>,
): Buffer {
	if (header.signature !== "a{sv}") throw new Error("invalid property reply signature");
	const reader = new Reader(message, header);
	const size = reader.u32();
	reader.pad(8);
	const end = reader.at + size;
	if (end !== header.length) throw new Error("invalid property dictionary length");
	const parts: Buffer[] = [message.subarray(0, header.body), Buffer.alloc(8)];
	let length = 0;
	while (reader.at < end) {
		reader.pad(8);
		const start = reader.at;
		const name = reader.text();
		const signature = reader.text(true);
		reader.skip(signature);
		if (fields.get(name) !== signature) continue;
		const padding = Buffer.alloc((8 - (length % 8)) % 8);
		parts.push(padding, message.subarray(start, reader.at));
		length += padding.length + reader.at - start;
	}
	const result = Buffer.concat(parts);
	if (header.little) {
		result.writeUInt32LE(length + 8, 4);
		result.writeUInt32LE(length, header.body);
	} else {
		result.writeUInt32BE(length + 8, 4);
		result.writeUInt32BE(length, header.body);
	}
	return result;
}
