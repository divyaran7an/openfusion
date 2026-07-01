#!/usr/bin/env node
// A tiny streaming chat client for a Fusion endpoint. Zero dependencies.
//
// Fusion speaks the OpenAI Chat Completions API, so this is just a normal
// OpenAI client: POST /chat/completions with stream:true and read the SSE.
// Point it at your server and talk to your council from the terminal.
//
//   node examples/chat/chat.mjs
//
// Configure with env vars (sensible local defaults):
//   FUSION_BASE_URL   default http://localhost:3000/v1
//   FUSION_API_KEY    default local-fusion (only enforced if you set FUSION_API_KEYS)
//   FUSION_MODEL      default fusion (any name runs your active graph)

import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

const BASE_URL = (process.env.FUSION_BASE_URL ?? "http://localhost:3000/v1").replace(/\/$/, "");
const API_KEY = process.env.FUSION_API_KEY ?? "local-fusion";
const MODEL = process.env.FUSION_MODEL ?? "openfusion";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

// Live phase labels from Fusion's streamed run events. A small glimpse into the
// council while it deliberates. A plain OpenAI server simply won't send these.
const PHASE = {
  "panel.started": "panel deliberating",
  "judge.started": "judge comparing",
  "synthesis.started": "synthesizing"
};

const messages = [];

async function ask(prompt) {
  messages.push({ role: "user", content: prompt });

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify({ model: MODEL, stream: true, messages })
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`${response.status} ${detail}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let phaseShown = "";

  stdout.write(bold("\nfusion  "));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const phase = PHASE[chunk.fusion_event?.type];
      if (phase && phase !== phaseShown && !answer) {
        phaseShown = phase;
        stdout.write(dim(`(${phase}) `));
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string") {
        if (!answer && phaseShown) stdout.write("\n        ");
        answer += delta;
        stdout.write(delta);
      }
    }
  }
  stdout.write("\n\n");
  messages.push({ role: "assistant", content: answer });
}

console.log(bold("OpenFusion chat") + dim(`  ${MODEL} @ ${BASE_URL}`));
console.log(dim("Type a message and press enter. Ctrl+C to exit.\n"));

const rl = createInterface({ input: stdin, output: stdout, prompt: bold("you     ") });
rl.prompt();
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  rl.pause();
  try {
    await ask(text);
  } catch (error) {
    console.error(`\x1b[31m${error.message}\x1b[0m\n`);
  }
  rl.resume();
  rl.prompt();
});
rl.on("close", () => console.log(dim("\nbye.")));
