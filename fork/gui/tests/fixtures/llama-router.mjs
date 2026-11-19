// A stand-in llama.cpp router for the /llama scenario: two models, a load that takes a few seconds and
// reports its progress, an unload. Nothing is downloaded. Writes its address to the file given as argument.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const models = new Map([
	["alpha", { id: "alpha", status: { value: "loaded" }, meta: { n_ctx: 32768 } }],
	["beta", { id: "beta", status: { value: "unloaded" } }],
]);
const streams = new Set();
const send = (event) => {
	for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`);
};
const json = (response, value) => {
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
};
const body = async (request) => {
	let text = "";
	for await (const chunk of request) text += chunk;
	return JSON.parse(text);
};

const server = createServer(async (request, response) => {
	const path = new URL(request.url ?? "", "http://localhost").pathname;
	if (path === "/models/sse") {
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		streams.add(response);
		request.on("close", () => streams.delete(response));
		return;
	}
	if (path === "/models" && request.method === "GET") return json(response, { data: [...models.values()] });
	if (path === "/props") return json(response, {});
	if (path === "/models/load" && request.method === "POST") {
		const { model } = await body(request);
		models.set(model, { id: model, status: { value: "loading" } });
		json(response, { success: true });
		// Ten steps of 600 ms: long enough to stop it, decline, and see the bar move.
		for (let step = 1; step <= 10; step++) {
			await new Promise((resolve) => setTimeout(resolve, 600));
			if (models.get(model)?.status.value !== "loading") return;
			const data =
				step < 10
					? { status: "loading", progress: { stages: ["text_model"], current: "text_model", value: step / 10 } }
					: { status: "loaded" };
			if (step === 10) models.set(model, { id: model, status: { value: "loaded" }, meta: { n_ctx: 8192 } });
			send({ model, event: "status_change", data });
		}
		return;
	}
	if (path === "/models/unload" && request.method === "POST") {
		const { model } = await body(request);
		models.set(model, { id: model, status: { value: "unloaded" } });
		return json(response, { success: true });
	}
	response.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
	writeFileSync(process.argv[2], `http://127.0.0.1:${server.address().port}`);
});
