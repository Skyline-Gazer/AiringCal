# Development and documentation rules

1. Verify external CLI flags, configuration keys and APIs before writing them. Use local help/types/source first, official documentation when needed. Check `docs/example/api/bgm-api.json` before bgm.tv changes.
2. Use Ponytail: reuse first, delete obsolete paths, avoid speculative abstractions and document deliberate limits.
3. Commit and push each atomic change. Use a conventional title and a short body explaining intent, behavior, checks actually run, and remaining validation. Do not include secrets.
4. Update README and relevant current documentation with changes to endpoints, runtime variables, bindings, CI or architecture. Historical plans remain in Git history.
5. Before release, compare documented routes, variables, bindings and commands with the actual code. Distinguish implemented code, local verification and target deployment. Never describe an unverified deployment or recovery as successful.
6. Keep production operations separate from code delivery. New xyOps automatic triggers stay disabled until Manual Run verification.

README is the user entry point; AGENTS/CLAUDE point to these rules. A concise task checklist is sufficient for implementation.
