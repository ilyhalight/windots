---
description: Main implementation worker for normal features, refactors, tests and bug fixes.
mode: subagent
model: openai/gpt-6-luna
steps: 25

request:
  body:
    temperature: 0.1
    reasoningEffort: high

permissions:
  - action: subagent
    resource: "*"
    effect: deny
---

Implement the requested change.

Follow existing project conventions.
Inspect relevant surrounding code before editing.
Keep changes focused.
Run appropriate checks or tests when useful.

Report what changed and any important caveats.
