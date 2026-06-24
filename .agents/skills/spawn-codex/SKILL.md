---
name: spawn-codex
description: Spawn project-local Codex CLI instances from an agent, pinned to GPT-5.5, with explicit reasoning effort and speed controls.
---

# Spawn Codex Instances

Use this skill when an agent needs to launch another Codex CLI instance for a bounded task in this repository.

## Command

Use `codex exec` for non-interactive agent runs:

```bash
codex exec \
  -C ~/projects/citynista \
  -m gpt-5.5 \
  "inspect the selected area and report findings"
```

Use stdin when the prompt is easier to compose as a block:

```bash
codex exec \
  -C ~/projects/citynista \
  -m gpt-5.5 \
  -
```

Then pass the full prompt on stdin.

## Permissions

Default to read-only for exploration and review:

```bash
codex exec \
  -C ~/projects/citynista \
  -m gpt-5.5 \
  --sandbox read-only \
  "review this branch for correctness risks"
```

Allow workspace edits only when the child instance is explicitly expected to modify files:

```bash
codex exec \
  -C ~/projects/citynista \
  -m gpt-5.5 \
  --sandbox workspace-write \
  "make the smallest code change needed to fix the described issue"
```

Do not use `danger-full-access` for spawned instances unless the parent task explicitly requires broad filesystem access and the environment is externally controlled.

## Model

Always use GPT-5.5 for spawned Codex instances in this project:

```bash
-m gpt-5.5
```

Do not choose mini models for spawned instances in this repository.

## Reasoning Effort

Set reasoning effort with `model_reasoning_effort`.

Use `medium` for straightforward implementation, focused review, and summarization:

```bash
codex exec \
  -C ~/projects/citynista \
  -m gpt-5.5 \
  -c model_reasoning_effort='"medium"' \
  "summarize the rendering pipeline"
```

Use `high` for debugging, geometry changes, code review where false negatives are costly, or tasks spanning multiple modules:

```bash
codex exec \
  -C ~/projects/citynista \
  -m gpt-5.5 \
  -c model_reasoning_effort='"high"' \
  "find the likely cause of this road-geometry rendering bug"
```

Use `xhigh` only for hard design/debugging tasks where latency and token cost are acceptable:

```bash
codex exec \
  -C ~/projects/citynista \
  -m gpt-5.5 \
  -c model_reasoning_effort='"xhigh"' \
  "analyze transition morph geometry and propose a minimal robust fix"
```

Supported effort values are `minimal`, `low`, `medium`, `high`, and `xhigh`. Prefer `medium` or `high` unless the prompt gives a reason to do otherwise.

## Speed

Set speed tier with `service_tier`.

Use standard/default speed by omitting `service_tier`.

Use Fast mode when the task is latency-sensitive and the extra credit cost is acceptable:

```bash
codex exec \
  -C ~/projects/citynista \
  -m gpt-5.5 \
  -c service_tier='"fast"' \
  -c model_reasoning_effort='"medium"' \
  "quickly inspect the changed files and list likely issues"
```

Use Flex when lower-priority/background execution is acceptable:

```bash
codex exec \
  -C ~/projects/citynista \
  -m gpt-5.5 \
  -c service_tier='"flex"' \
  -c model_reasoning_effort='"high"' \
  "perform a deeper background review of road geometry edge cases"
```

Do not use `service_tier = "priority"`; this CLI expects `fast` or `flex`.

## Reusable Custom Agent

For reusable spawned agents, create TOML files under `.codex/agents/` or `~/.codex/agents/`.

Example:

```toml
name = "citynista-reviewer"
description = "GPT-5.5 reviewer for Citynista correctness, geometry, and test-risk checks."

model = "gpt-5.5"
model_reasoning_effort = "high"
service_tier = "fast"
sandbox_mode = "read-only"

developer_instructions = """
Review code like an owner.
Prioritize correctness bugs, behavior regressions, rendering geometry risks, and missing tests.
Use Citynista's AGENTS.md instructions.
Do not suggest broad refactors unless required to fix the issue.
"""
```

Then ask the parent Codex session to spawn it:

```text
Spawn a citynista-reviewer agent to inspect the renderer changes, wait for it, and summarize its findings.
```

## Output

For scriptable runs, add `--json` to stream JSONL events:

```bash
codex exec \
  -C ~/projects/citynista \
  -m gpt-5.5 \
  --json \
  "review the current diff"
```

For a final response file:

```bash
codex exec \
  -C ~/projects/citynista \
  -m gpt-5.5 \
  --output-last-message /tmp/citynista-codex-result.md \
  "summarize the current diff"
```
