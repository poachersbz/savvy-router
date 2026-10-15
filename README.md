# savvy-router

Run Claude Code worker agents on cheap models from a local gateway, such as Gemini Flash or GPT through 9router. Your main Claude session plans, reviews and handles design, and the workers do the multi-step work. The workers' tokens go to the gateway, not to your Claude plan.

The repository is a Claude Code plugin marketplace with two plugins:

| Plugin | What it is |
|---|---|
| `router-workers` | A mod. It registers the `delegate` and `models` tools, starts each worker as a headless `claude -p` pointed at the gateway (up to 8 in parallel), and shows the workers live in a band above the prompt and in a `/router-workers` panel (model, status, current action, tokens, time). |
| `savvy-router` | A skill. `/savvy-router <task>`: the session model splits the task, decides what to do itself and what to delegate, delegates with self-contained briefs, then reviews each worker's actual changes before accepting them. |

## When it saves tokens

Each turn of your main session re-reads the whole context, often 60-100k tokens of which most is fixed tool definitions (check with `/context`). Delegating one task costs about two of those turns (sending the brief, reading the report), no matter what the worker does. So:

- **Short tasks** (1-3 tool calls) are cheaper to do directly. Delegating them saves nothing.
- **Long, multi-step tasks** (exploring code, multi-file changes, iterative debugging, big search or processing loops) are where it pays: those many turns run on the gateway instead of on your plan.
- A Claude sub-agent (Haiku/Sonnet) is not a token saver, because it bills your Claude plan.

One measured example (collect 100 PubMed papers with curl): the main session did it in one Bash call; a Gemini 3.8 Flash worker used 9 tool calls and ~131k gateway tokens (0 Claude tokens); a Haiku sub-agent used ~68k Claude tokens. All three returned the same 100 papers. The skill encodes these rules.

## Requirements

- A Claude Code build with **mod support**: plugins whose `hooks/hooks.json` lists `modules`, which use `$.tool.register` and render UI (the band and panel). Without mod support, the skill has no `delegate` tool. You can still use `bin/gw-agent` by hand.
- A local Anthropic-compatible gateway (`/v1/messages`, `/v1/models`), for example 9router, with an API key.
- The `claude` CLI installed. Workers are spawned as `claude -p`.

## Install

From GitHub (or from a fork: replace `poachersbz` with its owner):

```
/plugin marketplace add poachersbz/savvy-router
/plugin install router-workers@savvy-router
/plugin install savvy-router@savvy-router
```

Or manually: copy `plugins/router-workers` and `plugins/savvy-router` into `~/.claude/skills/` (or point `--plugin-dir` at them) and restart Claude Code.

## Configure

Set the `router-workers` options in `/config` (plugin options), or use environment variables:

| Option | Env fallback | Default |
|---|---|---|
| `gatewayUrl` | `ROUTER_GATEWAY_URL` | `http://localhost:20128` |
| `gatewayKey` (stored as sensitive) | `ROUTER_GATEWAY_KEY` | none, required |
| `gatewayConfigFile` | | JSON file with `inferenceGatewayBaseUrl` and `inferenceGatewayApiKey`, as written by Claude desktop's third-party gateway setup |
| `defaultModel` | | `ag/gemini-3.8-flash-high` (change it to a model id your gateway serves) |
| `claudePath` | | `~/.local/bin/claude(.exe)`, then `claude` on PATH |

The key is resolved in this order: the option, then the env var, then the config file. Check the setup by asking Claude to call the `models` tool. It lists the gateway's model ids.

## Use

```
/savvy-router add input validation to the signup form and tests for it
/savvy-router using cx/gpt-6-luna: port utils/date.py to TypeScript
/router-workers        # toggle the panel
```

Workers run with `Read, Grep, Glob, Bash, Edit, Write` (or only the read tools with `readOnly`), `--permission-mode acceptEdits`, no MCP servers, and an extra system prompt (`plugins/router-workers/worker.md`) that keeps them in scope and requires a short, verified report. A worker cannot start workers of its own.

**Security note:** workers can edit files and run shell commands in their `cwd` without asking. Give them a project directory, not your home folder.

## Without the mod

`bin/gw-agent` runs one worker from any shell:

```
ROUTER_GATEWAY_KEY=... bin/gw-agent --models
ROUTER_GATEWAY_KEY=... bin/gw-agent -m ag/gemini-3.8-flash-high -d ./myproject "fix the failing test in tests/test_api.py"
```

## Credits

The band, panel drawings and orchestration flow are adapted from [savvy-progress and savvy-flow](https://github.com/johnnyvizz/claude-kit) by johnnyvizz (MIT). See `NOTICE`.

## License

MIT
