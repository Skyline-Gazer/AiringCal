# AiringCal development

Use Ponytail: reuse existing code, prefer platform features, make the smallest working change. No phase state, approval scaffold, or speculative framework.

- Verify external CLI flags, config keys and APIs from help, types, source or official documentation before writing them.
- Check `docs/example/api/bgm-api.json` before changing bgm.tv interactions.
- Commit and push each atomic change; update current documentation with code.
- Preserve input validation, credentials, finite timeouts and data integrity.
- Keep production actions separate from repository edits.
- See `docs/rules/docs-sync.md` for documentation and delivery rules.
