// ultracode-gpt: OpenAI's hosted web_search tool on the openai-codex (Responses API) provider.
// Adds { type: "web_search" } to each request's tools; the backend runs the search itself.
export default function (pi: any) {
  pi.on("before_provider_request", (event: any) => {
    const payload = event?.payload;
    if (!payload || typeof payload !== "object" || !("input" in payload)) return;
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    if (tools.some((t: any) => t?.type === "web_search")) return;
    return { ...payload, tools: [...tools, { type: "web_search" }] };
  });
}
