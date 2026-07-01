# Security

OpenFusion is local orchestration software for remote and subscription-backed model calls. It handles provider keys, prompts, external web content, optional local file reads, and local Claude Code / Codex harness calls. Run it on `127.0.0.1` unless you have added production auth, tenant isolation, durable audit logs, secret storage, rate limits, and stricter tool policy.

## Supported Use

- Keep provider keys in `.env.local` or your shell environment.
- Use `FUSION_API_KEYS` when another process or device can call the local API.
- Know that the `/v1` endpoints send permissive CORS headers (`Access-Control-Allow-Origin: *`), like other local OpenAI-compatible servers. That means any web page open in a browser on the same machine can send requests to your local endpoint and spend your provider credits if auth is off. Set `FUSION_API_KEYS` to gate it.
- Keep `FUSION_LOCAL_ROOTS` narrow. Prefer one project directory over an entire home folder.
- Use domain allowlists for shared or repeatable web-fetch workflows.
- Treat all search, fetch, file, and client-tool results as untrusted data.
- Assume prompts and tool context are sent to whichever provider or local CLI node you wire into the graph.

## Secrets

Do not commit:

- `.env.local` or any `.env.*` file except `.env.example`
- provider API keys
- private system prompts
- local auth files
- screenshots that reveal keys or tokens

The repository ignores local Claude prompt files matching `claude-*.md`. Keep private prompts out of public docs and public issues. If you use `FUSION_SYSTEM_PROMPT`, store it locally and never put credentials in it.

## Local Tools

Fusion local tools can list, read, and search files inside configured roots. They intentionally do not write files.

Protections:

- resolves real paths before access
- stays inside `FUSION_LOCAL_ROOTS`
- denies credential, token, auth, key, `.env`, `.ssh`, `.aws`, `.claude`, `.codex`, and `.config` paths
- skips dependency, build, output, and git directories
- caps read and search size

These are inspection tools, not a shell/edit/browser coding harness.

## Web Fetch

The built-in `webFetch` tool is for public HTTP(S) text pages.

Protections:

- allows only `http:` and `https:`
- validates every redirect hop
- blocks localhost, loopback, link-local, private, multicast, and reserved IP ranges
- supports allow and block domain lists
- caps redirects and response bytes
- rejects non-text MIME types
- returns citation metadata when available

It does not authenticate, execute JavaScript, bypass robots or paywalls, or parse arbitrary binary documents.

## Subscription Boundary

Claude Code Pro/Max and Codex subscriptions can run as OpenFusion council nodes through their official local CLIs. They are not hosted API backends or secret API keys: OpenFusion starts the local client in read-only print mode, captures the answer, and normalizes it like any other model result.

Do not add browser automation, credential scraping, hidden token extraction, or subscription UI proxying.

## Reporting

Do not open a public issue with provider keys, private prompts, exploit payloads, or screenshots that reveal tokens.

Until GitHub Security Advisories are enabled, open a minimal public issue that omits sensitive details and says you have a security report to share. Include:

- affected endpoint or tool
- Fusion version or commit
- Node and npm versions
- whether `FUSION_API_KEYS`, `FUSION_LOCAL_ROOTS`, `FUSION_WEB_ALLOW_DOMAINS`, or `FUSION_WEB_BLOCK_DOMAINS` were configured
- expected and actual behavior
