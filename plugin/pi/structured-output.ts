// ultracode-gpt: the workflow agent's schema as a terminating pi tool.
// The mod passes the JSON schema in UCGPT_SCHEMA; the tool's arguments are the answer.
import { Type } from "typebox";

export default function (pi: any) {
  const raw = process.env.UCGPT_SCHEMA;
  if (!raw) return;
  const schema = JSON.parse(raw);
  pi.registerTool({
    name: "structured_output",
    label: "Structured Output",
    description:
      "Return your final answer as structured data matching the required schema. Call it exactly once, as your last action.",
    promptSnippet: "Return the final answer through structured_output",
    promptGuidelines: [
      "Your final answer must be given by calling structured_output with arguments matching its schema.",
      "Call structured_output once, as your last action, and write nothing after it.",
    ],
    parameters: Type.Unsafe(schema),
    async execute(_id: string, params: unknown) {
      return {
        content: [{ type: "text", text: "Structured output recorded." }],
        details: { value: params },
        terminate: true,
      };
    },
  });
}
