# Contributing

OpenFusion is a real-provider runtime. Product paths must not use mock model responses, fake tool output, or placeholder runs. Test doubles are acceptable only at explicit transport boundaries.

## Local Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set real credentials in `.env.local` before running provider-backed flows. Keep that file private.

For OpenCode:

```bash
npm run dev:opencode
OPENCODE_CONFIG=/path/to/fusion/opencode.json opencode
```

## Quality Bar

- Keep model routing configurable through environment variables.
- Preserve Fusion semantics: if a preset says eight panel models, attempt eight real panel calls and mark degraded partial failures honestly.
- Keep local tools bounded, read-only, root-scoped, and secret-denying unless a separate approval harness is introduced.
- Treat web, file, and search content as untrusted data.
- Do not imply an unimplemented harness, tool, benchmark, or hosted deployment is ready.
- Do not commit private prompts, keys, local logs, `node_modules`, or build artifacts.
- Use public-safe paths in docs, prompts, tests, and tool descriptions. Prefer `/path/to/...`, `~/...`, or `/tmp/...` over real usernames or machine paths.

## Verification

Run:

```bash
npm run verify
```

Run real provider checks manually from the studio or an OpenAI-compatible client when runtime behavior changes; those calls can spend provider credits.

## Documentation

Keep docs small:

- `README.md` for the product, quick start, common client setup, and boundaries
- `docs/SETUP.md` for installation, clients, models, subscriptions, and troubleshooting
- `docs/API.md` for OpenAI-compatible and native endpoint contracts
- `docs/ARCHITECTURE.md` for implementation flow, Fusion compatibility, harness direction, research grounding, and benchmarking bar
- `SECURITY.md` for keys, local tools, web fetch, and reporting

Keep docs human:

- Use short sentences and concrete examples.
- Avoid repeated positioning. Say the core idea once, then show how to use it.
- Do not use em dashes in Markdown docs. Prefer a period, colon, semicolon, or plain hyphen.

If a feature is not implemented, document it as a gap instead of implying it works.
