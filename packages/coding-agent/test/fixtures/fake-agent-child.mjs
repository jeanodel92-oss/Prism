// Stands in for the Prism child that the agent tool starts (`--mode rpc`). FAKE_AGENT_CHILD picks what it prints
// once the task arrives on stdin.
const end = (text) =>
	`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], model: "m", stopReason: "stop" } })}\n`;
await new Promise((resolve) => process.stdin.once("data", resolve));
process.stdin.pause();
const mode = process.env.FAKE_AGENT_CHILD;
if (mode === "not-an-object") {
	process.stdout.write("null\n42\n[]\n");
	process.stdout.write(end("answer after junk"));
} else if (mode === "split-character") {
	// The pipe delivers the line in two chunks, cut inside the two bytes of "é".
	const line = Buffer.from(end("café crème"));
	const cut = line.indexOf(Buffer.from("é")) + 1;
	process.stdout.write(line.subarray(0, cut));
	await new Promise((resolve) => setTimeout(resolve, 200));
	process.stdout.write(line.subarray(cut));
}
