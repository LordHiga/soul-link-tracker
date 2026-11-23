# Soul Link Tracker – Codex Project Instructions

## Project
This repository contains a Pokémon Soul Link Nuzlocke tracker for three players. The application is hosted on GitHub Pages and uses Supabase for persistent data and PokéAPI for Pokémon information.

## Goals
1. Fix bugs in run creation, completion, wipe handling and run history.
2. Improve Pokémon search performance with caching and fewer API requests.
3. Improve security, reliability and maintainability.
4. Preserve existing data and functionality.

## Working rules
- Work only within this repository.
- Never access or modify unrelated project directories.
- Work on a dedicated feature branch; do not commit directly to main.
- Never push, merge, deploy or change production database data/schema without explicit user approval.
- Never delete or reset existing runs or Soul Link records.
- Never expose credentials, tokens, secrets or private data.
- Do not make live Supabase writes during tests.
- Use mocks or local fixtures for database-dependent tests.
- Keep changes small, reversible and easy to review.
- Add automated tests where practical.
- Do not install new dependencies without explaining why they are needed.

## Workflow
1. Start with a read-only code review.
2. Identify concrete issues and their root causes.
3. Present a prioritized plan before implementation.
4. Implement only approved changes.
5. Run relevant tests and document results.
6. Summarize modified files, risks and remaining issues after each task.
7. Ask for approval before any destructive, external or production-impacting action.

## Reporting
For every completed task report:
- Findings
- Changes made
- Tests performed and results
- Risks or open questions
- Recommended next step

## Priority
P0: Data loss or critical security issues.
P1: Run completion and run creation bugs.
P2: PokéAPI performance and caching.
P3: Architecture, refactoring and additional features.