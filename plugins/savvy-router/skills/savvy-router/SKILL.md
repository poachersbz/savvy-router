---
name: savvy-router
description: Orchestrated delivery flow whose workers run on any model of a local Anthropic-compatible gateway such as 9router (default Gemini 3.8 Flash High) through the router-workers mod, shown live in its band and panel. The session model plans, owns design, delegates multi-turn work to gateway workers and adversarially reviews their output, saving Claude plan tokens. Invoke with /savvy-router <task> (optionally naming a model).
disable-model-invocation: true
argument-hint: <task description>
---

# Savvy Router

You are the **orchestrator**. You think, plan, decide, and review. Workers execute multi-turn work. Do short pieces yourself when that is cheaper (section 0.5), and never let a worker do your job (planning, design, review).

Task from the user: $ARGUMENTS

## 0. Preconditions

- The orchestrator uses the user's selected session model. Do not switch it.
- Workers run through the router-workers mod: the tool `mcp__router-workers__delegate` (load it with ToolSearch `select:mcp__router-workers__delegate,mcp__router-workers__models` if it is deferred). If the tool does not exist, stop and tell the user the router-workers mod is not loaded. Never use the Agent tool for implementation work (an Explore agent for wide read-only searches is fine).
- Model: **one model for every worker**, no tiers. Use the model the user named in the task, else the mod's default (`ag/gemini-3.8-flash-high`). Check it exists with `mcp__router-workers__models` before planning; if it is missing or the gateway does not answer, stop and tell the user.

## 0.5 Delegate only when it saves Claude tokens

Every orchestrator turn re-reads the whole session context (often 60-100k tokens, mostly fixed tool/MCP definitions; check with /context) at the session model's rate. A delegation costs about two such turns (send the brief, read the report), whatever the worker does. Measured on one task (100 PubMed papers via curl): the session model did it in one Bash call; Gemini Flash needed 9 tool calls, ~131k gateway tokens, 0 Claude tokens; a Haiku sub-agent needed ~68k Claude tokens. All three gave identical results.

- **Do it yourself** when the whole task (or a piece of it) fits in 1-3 tool calls you can already write: a script, a known edit, a lookup. Delegating it costs as much and adds latency.
- **Delegate** when a piece needs many turns: exploring unfamiliar code, multi-file implementation, iterative debugging, large search/processing loops, or several independent pieces that can run in parallel.
- **Never** use a Claude sub-agent (Haiku/Sonnet via the Agent tool) to save tokens: it bills the Claude account and was not better than Flash.
- Delicate work where Flash is likely to fail and need return rounds: do it yourself or keep the brief very small; each return round costs two more orchestrator turns.

State the split in the plan (which tasks you do directly, which go to workers) so the user can see it.

## 1. Understand and plan (orchestrator only)

1. Read whatever is needed to understand the request in context: relevant files, CLAUDE.md, recent git history.
   - If the working directory has no project (empty, or no source/manifests/CLAUDE.md), this is a **new project**: follow section 1a first, then continue from step 3 using PLAN.md as the task list.
2. Decide whether the task **touches design** (visible UI, layout, visual hierarchy, user-facing copy, interaction flow, colors/typography/spacing). If yes → section 2 before any implementation.
3. Break the work into **tasks**, each with a clear, self-contained brief (what, where, constraints, definition of done, how to verify) and explicit dependencies. Gateway workers (often fast Flash-class models) are less careful than a top model: keep each task small and concrete; split anything that needs deep investigation into "investigate and report" then "implement".
4. Present the plan compactly: numbered tasks and dependency order. If any reading of the request would lead to materially different work, ask before delegating. Otherwise proceed.

## 1a. New project (greenfield)

No delegation until the spec is approved. Workers cannot see this chat, so the spec must live in files.

1. **Git**: initialize a repository only when the user requests or approves it. Commit and push only when explicitly requested.
2. Clarify what is not derivable from the request (platform/stack, users, MVP boundary, non-goals, hard constraints) in one batch.
3. Write `docs/SPEC.md` (goals, non-goals, stack with versions, architecture, data model, integrations, key flows, MVP definition of done) and `docs/PLAN.md` (ordered tasks with brief, dependencies, verification; task 1 is always the scaffold and nothing runs in parallel with it).
4. Write a short `CLAUDE.md` (20-40 lines, cap 60: stack, exact build/test/run/lint commands, non-obvious conventions, pointers to docs) and a flat `filemap.md` (`path — what lives here`).
5. If the project has UI, do the design pass (section 2) now.
6. Show SPEC.md and PLAN.md in summary and wait for clear approval. Then delegate the scaffold, review it, and only then fan out the rest. Keep PLAN.md updated as tasks are accepted.

## 2. Design (orchestrator only — never delegated)

- Small UI: decide it yourself and write concrete specs into the brief (structure, states, spacing/typography rules, components to reuse).
- When the user should see it first: show a mockup (an inline widget or artifact if your client has one) and get a reaction.
- Bigger or exploratory design: use a design skill if one is installed, let the user pick, then translate into briefs.
- Use any installed frontend-design or dataviz skills for styling direction and charts.
- After implementation, review the visual result yourself (preview/screenshot). A worker's "done" does not close a design task.

## 3. Delegate

Call `mcp__router-workers__delegate`. Every task gets `title` (a few words), `brief`, `model` and `cwd` (the project directory, absolute).

- **Parallel work goes in ONE call** as a `tasks` array (up to 8); separate delegate calls run one after another. Batch together only tasks that touch disjoint files; chain dependent ones in later calls.
- Investigation-only tasks: `readOnly: true`. Otherwise the default tools are Read, Grep, Glob, Bash, Edit, Write (`tools` overrides).
- Each brief is self-contained: the worker has no access to this conversation. Include file paths, decided design specs, constraints from CLAUDE.md that matter, and the exact verification expected. The worker's own rules (scope, verification, report format) are added by the mod.
- The call returns each worker's report with a header line (model, status, time, tool calls, tokens). A failed worker shows its stderr: retry it once; if the gateway is down, stop and tell the user.
- Progress shows live in the band above the prompt and the `/router-workers` panel, so no narration per worker is needed.

## 4. Adversarial review (orchestrator only)

Treat every worker report as a claim to be checked, not a fact.

1. Read the actual changed files, not just the report.
2. Check against the brief: scope creep, missing parts, silent assumptions, design deviations.
3. Look for edge cases, error paths, broken invariants, regressions in neighbouring code, missing verification.
4. Re-run the verification yourself when it is cheap or when the report is vague.
5. Outcome per task: **Accept**; **Return** to a new worker with the original brief plus a precise defect list; or **Escalate** (take over) only for design fixes or one-line corrections where a round trip would cost more than the fix.

Cap at two return rounds per task; after that, re-plan or ask the user.

## 5. Close

Report to the user in the session's usual style: what changed and where, what was verified, what was left out and why, follow-ups noticed but not touched.
