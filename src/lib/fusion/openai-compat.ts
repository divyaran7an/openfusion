import Ajv, { type ValidateFunction } from "ajv";
import type {
  ChatMessage,
  OpenAIResponseFormat,
  OpenAIStreamOptions,
  UsageRecord
} from "./schemas.ts";

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateSchema: true
});
const schemaValidators = new Map<string, ValidateFunction>();

export function stopSequencesFrom(stop: string | string[] | undefined) {
  if (typeof stop === "string") {
    return stop ? [stop] : undefined;
  }
  if (!Array.isArray(stop)) {
    return undefined;
  }
  const sequences = stop.filter((entry) => entry.length > 0);
  return sequences.length > 0 ? sequences : undefined;
}

export function applyStopSequences(text: string, stop?: string | string[]) {
  const sequences = stopSequencesFrom(stop);
  if (!sequences?.length) {
    return text;
  }

  let end = text.length;
  for (const sequence of sequences) {
    const index = text.indexOf(sequence);
    if (index >= 0 && index < end) {
      end = index;
    }
  }
  return text.slice(0, end);
}

export function responseFormatType(responseFormat: OpenAIResponseFormat | undefined) {
  return responseFormat?.type ?? "text";
}

export function requiresBufferedResponse(responseFormat: OpenAIResponseFormat | undefined) {
  const type = responseFormatType(responseFormat);
  return type === "json_object" || type === "json_schema";
}

export function responseFormatInstruction(responseFormat: OpenAIResponseFormat | undefined) {
  if (!responseFormat || responseFormat.type === "text") {
    return undefined;
  }

  if (responseFormat.type === "json_object") {
    return [
      "Client response format:",
      "Return only one valid JSON object. Do not include markdown, prose, comments, or code fences."
    ].join("\n");
  }

  return [
    "Client response format:",
    "Return only valid JSON that conforms to this response_format json_schema. Do not include markdown, prose, comments, or code fences.",
    JSON.stringify(responseFormat.json_schema, null, 2)
  ].join("\n");
}

function isJsonObject(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textPartContent(part: Record<string, unknown>) {
  if (part.type !== "text") {
    return undefined;
  }

  return typeof part.text === "string" ? part.text : "";
}

function contentPartType(part: unknown) {
  if (!isRecord(part)) {
    return "invalid";
  }

  return typeof part.type === "string" && part.type.trim()
    ? part.type
    : "unknown";
}

export function messageContentText(message: Pick<ChatMessage, "content">) {
  const { content } = message;
  if (content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => (isRecord(part) ? textPartContent(part) : undefined))
    .filter((part): part is string => part !== undefined)
    .join("\n");
}

export function assertTextOnlyMessages(messages: ChatMessage[] | undefined) {
  for (const [messageIndex, message] of (messages ?? []).entries()) {
    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const [partIndex, part] of message.content.entries()) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        continue;
      }

      throw new Error(
        `OpenFusion only supports text chat content parts. messages[${messageIndex}].content[${partIndex}] has type "${contentPartType(part)}".`
      );
    }
  }
}

function responseSchema(responseFormat: OpenAIResponseFormat | undefined) {
  if (responseFormat?.type !== "json_schema") {
    return undefined;
  }
  return responseFormat.json_schema.schema;
}

function validatorForSchema(schema: Record<string, unknown>) {
  const key = JSON.stringify(schema);
  const cached = schemaValidators.get(key);
  if (cached) {
    return cached;
  }

  try {
    const validator = ajv.compile(schema);
    schemaValidators.set(key, validator);
    return validator;
  } catch (error) {
    throw new Error(
      `Invalid response_format json_schema: ${
        error instanceof Error ? error.message : "schema could not be compiled"
      }`
    );
  }
}

function formatValidationErrors(validator: ValidateFunction) {
  const details = validator.errors
    ?.slice(0, 5)
    .map((error) => {
      const path = error.instancePath || error.schemaPath || "value";
      return `${path}: ${error.message ?? error.keyword}`;
    })
    .join("; ");

  return details || "output does not match schema";
}

export function assertResponseFormatSupported(
  responseFormat: OpenAIResponseFormat | undefined
) {
  const schema = responseSchema(responseFormat);
  if (!schema) {
    return;
  }
  validatorForSchema(schema);
}

export function assertResponseFormatSatisfied(
  text: string,
  responseFormat: OpenAIResponseFormat | undefined
) {
  if (!requiresBufferedResponse(responseFormat)) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Model output did not satisfy response_format ${responseFormatType(responseFormat)}: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`
    );
  }

  if (responseFormat?.type === "json_object" && !isJsonObject(parsed)) {
    throw new Error("Model output did not satisfy response_format json_object: output is not a JSON object.");
  }

  const schema = responseSchema(responseFormat);
  if (!schema) {
    return;
  }

  const validator = validatorForSchema(schema);
  if (!validator(parsed)) {
    throw new Error(
      `Model output did not satisfy response_format json_schema: ${formatValidationErrors(validator)}`
    );
  }
}

export function normalizedChoiceCount(n: number | undefined) {
  return n ?? 1;
}

export function assertOpenAICompatibility(input: {
  n?: number;
  modalities?: string[];
  messages?: ChatMessage[];
}) {
  if (normalizedChoiceCount(input.n) !== 1) {
    throw new Error("OpenFusion produces one council answer per request; n must be 1.");
  }

  if (input.modalities?.some((modality) => modality !== "text")) {
    throw new Error("OpenFusion only supports text chat completions; modalities must be omitted or [\"text\"].");
  }

  assertTextOnlyMessages(input.messages);
}

export function openAIUsage(usage: UsageRecord) {
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens
  };
}

export function wantsStreamUsage(streamOptions: OpenAIStreamOptions | undefined) {
  return streamOptions?.include_usage === true;
}
