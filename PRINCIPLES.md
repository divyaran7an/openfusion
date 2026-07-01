# Principles

What OpenFusion stands for. These are the rules we hold the project to. If a change violates one, it needs a very good reason.

### 1. Local-first

It runs on your machine. Your prompts, your graph, your keys, your conversation: none of it leaves your computer unless *you* wire a node to a remote model. The studio, the orchestrator, and the endpoint are all local. There is no OpenFusion cloud, no account, no telemetry.

### 2. Open and hackable

MIT licensed, no closed core, no "pro" tier gating the good parts. The whole graph engine, the studio, and the OpenAI endpoint are in this repo. Fork it, rewire it, embed it.

### 3. You compose it, no magic

There are no fixed modes or presets you can't open up. The canvas *is* the configuration: every node is a `source × model` you chose, and the endpoint runs exactly that graph. Presets are starting points, not black boxes. Change any node and the next call uses it.

### 4. Faithful to the idea, honest about the source

The panel → judge → synthesizer pattern is [OpenRouter's Fusion](https://openrouter.ai/docs/guides/features/server-tools/fusion). We didn't invent it; we brought it local and open. We keep it faithful: the judge **compares** (it doesn't vote or average), the synthesizer **grounds** the answer in the analysis (it doesn't concatenate), and we credit OpenRouter plainly, everywhere.

### 5. Bring your own

Use what you already pay for. Flat-rate Claude Code and Codex subscriptions become real reasoning nodes; one Gateway key adds every other frontier model. No token scraping, no browser automation, no re-buying access you already have. The official local clients and a standard API key, nothing more.

### 6. Show your work

Compound systems are opaque by default; we refuse that. When the council runs you see every model light up: its status, its streamed output, its tool calls, its tokens and cost. Errors say what actually failed and on which node. No spinner that hides a 4× bill.

### 7. No surprises with money or trust

**Stop** cancels the upstream calls. Hitting it stops the spend, it doesn't just hide the stream. There are no silent fallbacks to a different model, no hidden retries that multiply cost, no secrets committed to the repo. What you wired is what runs.

### 8. A real drop-in

OpenFusion speaks the OpenAI Chat Completions API: streaming, tool calls, errors, the lot. It works with the editors and CLIs you already use. Point Cursor, aider, Continue, or the OpenAI SDK at one base URL and the council answers. Compatibility is a feature, not an afterthought.

---

These principles are why OpenFusion exists: the compound-AI idea is powerful, and it should be something you can **run yourself, see fully, and own**, not a service you rent.
