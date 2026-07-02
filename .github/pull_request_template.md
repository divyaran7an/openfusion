## Summary

Describe the runtime, API, UI, docs, or DevEx change.

## Verification

- [ ] `npm run verify`
- [ ] Local endpoint check when runtime behavior changed
- [ ] Real provider check when provider behavior changed, run locally only

## Safety

- [ ] No provider keys, private prompts, `.env.local`, local logs, or token-bearing screenshots are committed
- [ ] Product paths use real provider/runtime behavior, not mock runs or placeholder model data
- [ ] Local tools remain bounded by configured roots and deny secret paths
- [ ] External web/local/tool content is treated as untrusted data
- [ ] New gaps or limitations are documented instead of implied as working

## Docs

Update the relevant docs when behavior changes:

- `README.md`
- `docs/API.md`
- `docs/ARCHITECTURE.md`
- `docs/SETUP.md`
- `SECURITY.md`
