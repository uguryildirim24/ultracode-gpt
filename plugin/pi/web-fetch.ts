// ultracode-gpt: web_fetch, a plain HTTP GET that returns a page as text.
import { Type } from "typebox";

const MAX_DEFAULT = 40000;

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export default function (pi: any) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL over HTTP(S) and return its content as text (HTML is reduced to text). Use it to read a page found by web search or named in the task.",
    promptSnippet: "Fetch a web page as text",
    parameters: Type.Object({
      url: Type.String({ description: "The http(s) URL to fetch" }),
      max_chars: Type.Optional(Type.Number({ description: `Most characters to return (default ${MAX_DEFAULT})` })),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async execute(_id: string, params: { url: string; max_chars?: number }, signal?: AbortSignal) {
      const url = new URL(params.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`not an http(s) URL: ${params.url}`);
      const timeout = AbortSignal.timeout(30000);
      const response = await fetch(url, {
        redirect: "follow",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { "user-agent": "Mozilla/5.0 (ultracode-gpt web_fetch)", accept: "text/html,text/plain,application/json,*/*" },
      });
      const type = response.headers.get("content-type") ?? "";
      const body = await response.text();
      const text = /html/i.test(type) ? htmlToText(body) : body;
      const max = Math.max(1000, params.max_chars ?? MAX_DEFAULT);
      const cut = text.length > max;
      const out = `${response.status} ${response.url}\ncontent-type: ${type}\n\n${cut ? text.slice(0, max) + `\n\n[cut at ${max} of ${text.length} characters]` : text}`;
      if (!response.ok) throw new Error(out.slice(0, 4000));
      return { content: [{ type: "text", text: out }], details: undefined };
    },
  });
}
