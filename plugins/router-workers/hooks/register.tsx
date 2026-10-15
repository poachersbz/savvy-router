import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Status, Worker } from '../types'

// Worker agents on a local Anthropic-compatible gateway (9router or similar): each
// one is a headless Claude Code (`claude -p`) pointed at the gateway, streamed so
// the band and the panel show what it is doing while it runs.

type DelegateInput = {
  title?: string
  brief?: string
  model?: string
  cwd?: string
  tools?: string[]
  readOnly?: boolean
}

type Gateway = { base: string; key: string }
type ModelInfo = { id: string; context: number }

const workers = atom({ plugin: 'router-workers', key: 'workers' } as const, [])
const now = atom({ plugin: 'router-workers', key: 'now' } as const, 0)
const band = atom({ plugin: 'router-workers', key: 'band' } as const, { isDismissed: false })

const PANE = 'router-workers'
const DEFAULT_GATEWAY_URL = 'http://localhost:20128'
const DEFAULT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']
const MAX_REPORT = 40_000
const MAX_PARALLEL = 8
const ACCENT = '#5aa9e6'
const GLYPH: Record<Status, string> = { running: '●', done: '✓', failed: '✗', stopped: '■' }
const COLOR: Record<Status, string> = { running: ACCENT, done: 'green', failed: 'red', stopped: 'gray' }

let home = ''
let defaultModel = 'ag/gemini-3.8-flash-high'
let workerPrompt = ''
let claudeBin = 'claude'
let modelCache: { at: number; list: ModelInfo[] } | null = null
let opts: Record<string, unknown> = {}

const slash = (p: string) => p.replace(/\\/g, '/')
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

// Gateway URL and key, first found wins: the plugin options, the environment
// (ROUTER_GATEWAY_URL / ROUTER_GATEWAY_KEY), then a JSON file holding
// `inferenceGatewayBaseUrl` and `inferenceGatewayApiKey` (Claude desktop's
// third-party gateway config has that shape).
async function gateway($: EngineInterface): Promise<Gateway> {
  let base = str(opts.gatewayUrl) || str(await $.env.get('ROUTER_GATEWAY_URL'))
  let key = str(opts.gatewayKey) || str(await $.env.get('ROUTER_GATEWAY_KEY'))
  const file = str(opts.gatewayConfigFile).replace(/^~(?=[\\/])/, home)
  if (file && (!base || !key)) {
    const cfg = JSON.parse((await $.fs.read(file)) as string) as { inferenceGatewayBaseUrl?: string; inferenceGatewayApiKey?: string }
    base ||= str(cfg.inferenceGatewayBaseUrl)
    key ||= str(cfg.inferenceGatewayApiKey)
  }
  if (!key) throw new Error('no gateway key: set the plugin option gatewayKey, ROUTER_GATEWAY_KEY, or gatewayConfigFile')
  return { base: (base || DEFAULT_GATEWAY_URL).replace(/\/v1\/?$/, '').replace(/\/$/, ''), key }
}

// The claude executable for workers: the option, then the native installer's
// location, then whatever `claude` resolves to on PATH.
async function resolveClaude($: EngineInterface): Promise<string> {
  const set = str(opts.claudePath)
  if (set) return set
  for (const p of [`${home}/.local/bin/claude.exe`, `${home}/.local/bin/claude`]) {
    if (await $.fs.exists(p).catch(() => false)) return p
  }
  return 'claude'
}

async function models($: EngineInterface): Promise<ModelInfo[]> {
  const at = await $.clock.now()
  if (modelCache && at - modelCache.at < 5 * 60_000) return modelCache.list
  const gw = await gateway($)
  const res = await $.http.fetch(`${gw.base}/v1/models`, { headers: { Authorization: `Bearer ${gw.key}` } })
  if (!res.ok) throw new Error(`gateway answered ${res.status}`)
  const body = JSON.parse(res.text) as { data?: { id: string; context_length?: number }[] }
  const list = (body.data ?? []).map(m => ({ id: m.id, context: m.context_length ?? 0 }))
  modelCache = { at, list }
  return list
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

// "Edit calc.py", "Bash: npm test", "Grep TODO".
function describeTool(name: string, input: Record<string, unknown>): string {
  const path = input.file_path ?? input.path ?? input.notebook_path
  if (typeof path === 'string') return `${name} ${slash(path).split('/').slice(-2).join('/')}`
  if (typeof input.command === 'string') return `${name}: ${oneLine(input.command)}`
  if (typeof input.pattern === 'string') return `${name} ${input.pattern}`
  return name
}

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)
const elapsed = (w: Worker, at: number) => (w.endedAt ?? Math.max(at, w.startedAt)) - w.startedAt

async function patch($: EngineInterface, id: string, change: (w: Worker) => Partial<Worker>) {
  await update($, workers, list => list.map(w => (w.id === id ? { ...w, ...change(w) } : w)))
}

async function togglePane($: EngineInterface): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await update($, now, () => Date.now())
  await $.ui.open({ id: PANE, title: 'Router workers' })
  return true
}

// Opens the pane when a delegate call starts, leaving an already open one alone.
async function ensurePane($: EngineInterface) {
  if ((await $.ui.panes()).some(p => p.id === PANE)) return
  await update($, now, () => Date.now())
  await $.ui.open({ id: PANE, title: 'Router workers' })
}

// One worker from start to report. Pulling the child's stream is a `$` call, so the
// hook's own budget stands still while workers run; several run side by side.
async function runWorker(
  $: EngineInterface,
  task: DelegateInput,
  id: string,
  gw: Gateway,
  list: ModelInfo[],
  sessionCwd: string,
  signal: AbortSignal,
): Promise<{ text: string; failed: boolean }> {
  const brief = (task.brief ?? '').trim()
  const model = (task.model ?? '').trim() || defaultModel
  const title = clip(oneLine(task.title ?? '') || clip(oneLine(brief), 40), 80)
  if (!brief) return { text: `[${title}] skipped: no brief`, failed: true }
  const info = list.find(m => m.id === model)
  if (!info) return { text: `[${title}] unknown gateway model "${model}". Call the models tool for the list.`, failed: true }

  const cwd = task.cwd?.trim() || sessionCwd
  const tools = task.readOnly ? READ_ONLY_TOOLS : task.tools?.length ? task.tools : DEFAULT_TOOLS
  const argv = [
    claudeBin,
    '-p',
    brief,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    '--strict-mcp-config',
    // --tools loads only these tool definitions: ~7k tokens of context instead of ~38k.
    '--tools', tools.join(','),
    '--allowedTools', ...tools,
    ...(workerPrompt ? ['--append-system-prompt', workerPrompt] : []),
  ]
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: gw.base,
    ANTHROPIC_AUTH_TOKEN: gw.key,
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(info.context || 200_000),
    // A worker never runs workers of its own.
    ROUTER_WORKERS_CHILD: '1',
  }

  const startedAt = Date.now()
  await update($, workers, l =>
    [...l.filter(w => w.id !== id), {
      id, title, model, cwd: slash(cwd), status: 'running' as Status, startedAt,
      activity: 'starting…', toolCalls: 0, tokensIn: 0, tokensOut: 0,
    }].slice(-100),
  )
  await update($, band, () => ({ isDismissed: false }))
  await update($, now, () => startedAt)

  let report = ''
  let isError = false
  let buffer = ''
  let stderr = ''
  const child = $.process.spawn({ argv, cwd, env })
  const stop = () => void child.return(undefined as never)
  signal.addEventListener('abort', stop)

  const handle = async (line: string) => {
    let msg: Record<string, any>
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.type === 'assistant' && msg.message) {
      const blocks: any[] = msg.message.content ?? []
      const usage = msg.message.usage ?? {}
      const calls = blocks.filter(b => b.type === 'tool_use')
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join(' ')
      const activity = calls.length
        ? calls.map(c => describeTool(c.name, c.input ?? {})).join(' · ')
        : text ? oneLine(text) : ''
      await patch($, id, w => ({
        activity: activity ? clip(activity, 200) : w.activity,
        toolCalls: w.toolCalls + calls.length,
        tokensIn: Math.max(w.tokensIn, (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)),
        tokensOut: w.tokensOut + (usage.output_tokens ?? 0),
      }))
    } else if (msg.type === 'result') {
      report = typeof msg.result === 'string' ? msg.result : ''
      isError = Boolean(msg.is_error)
      const u = msg.usage ?? {}
      const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      // Streamed messages may carry no usage through the gateway: the result's sum is the fallback.
      await patch($, id, w => ({ tokensIn: Math.max(w.tokensIn, total), tokensOut: Math.max(w.tokensOut, u.output_tokens ?? 0) }))
    }
  }

  let code: number | null = null
  try {
    while (true) {
      const step = await child.next()
      if (step.done) {
        code = step.value?.code ?? null
        break
      }
      const { stream, text } = step.value
      if (stream === 'stderr') {
        stderr = (stderr + text).slice(-4000)
        continue
      }
      buffer += text
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) await handle(line)
      }
    }
    if (buffer.trim()) await handle(buffer.trim())
  } catch (err) {
    isError = true
    stderr += `\n${(err as Error).message}`
  } finally {
    signal.removeEventListener('abort', stop)
  }

  const stopped = signal.aborted
  const failed = stopped || isError || !report || (code !== null && code !== 0)
  const status: Status = stopped ? 'stopped' : failed ? 'failed' : 'done'
  const cleanErr = oneLine(stderr.replace(/.*isn't described by this version's model catalog[\s\S]*?\n(?=\S)/g, ''))
  await patch($, id, () => ({
    status,
    endedAt: Date.now(),
    activity: status === 'done' ? 'finished' : clip(report || cleanErr || `exit ${code}`, 200),
    error: failed ? clip(cleanErr, 500) : undefined,
  }))
  await update($, now, () => Date.now())

  const w = (await read($, workers)).find(x => x.id === id)
  const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB')
  const meta = w
    ? `[${title} · ${model} · ${status} · ${clock(w.startedAt)}→${clock(w.endedAt ?? Date.now())} (${fmtTime(elapsed(w, Date.now()))}) · ${w.toolCalls} tool calls · ${fmtTokens(w.tokensIn)} in / ${fmtTokens(w.tokensOut)} out]`
    : `[${title} · ${model} · ${status}]`
  const body = report ? clip(report, MAX_REPORT) : `No report. ${cleanErr ? `stderr: ${clip(cleanErr, 1500)}` : `exit code ${code}`}`
  return { text: `${meta}\n\n${body}`, failed }
}


// ---------------------------------------------------------------------------
// Drawing helpers adapted from savvy-progress by johnnyvizz (MIT): dithered band,
// dotted grid, Pixel Clawd crabs and their costumes.

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// The whole row is one SVG: the desktop wraps sibling elements onto new lines,
// so title, bar, percent and the crab live in one drawing; only the count and
// the dismiss are Buttons beside it.
const H = 22
const BAR_H = 16
const CRAB_W = 26
// The crab's drawing grid is 30 units wide, props included.
const CRAB_BOX = 30
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)


// CJK, fullwidth forms and emoji advance about 1em; at 0.56em a Chinese title was sized at half its width and the bar drew over it.
// 中日韩文字、全角标点和 emoji 约占 1em；按 0.56em 算时中文标题宽度被低估近一半，进度条会压到标题上。
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}


// --- desktop drawings: each row is one SVG, as the band above the prompt is.

// The pane's backdrop: a dotted grid as tall as the content laid over it; the
// row SVGs are transparent, so it shows through between their marks.
const GRID_STEP = 16
// A Text or Button row on the desktop is about 20px; the grid errs taller.
const LINE_H = 24
// The engine refuses an Svg taller than 4096px, so a long grid is stacked from
// tiles of at most this height; a multiple of GRID_STEP keeps the dots aligned.
const GRID_TILE = 4096
const gridTiles = (H: number) => Array.from({ length: Math.ceil(H / GRID_TILE) }, (_, i) => Math.min(GRID_TILE, H - i * GRID_TILE))
const gridSvg = (W: number, H: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>.d{fill:#d9d8d4}@media (prefers-color-scheme: dark){.d{fill:#3a3a38}}</style>
<defs><pattern id="g" width="${GRID_STEP}" height="${GRID_STEP}" patternUnits="userSpaceOnUse"><circle class="d" cx="${GRID_STEP / 2}" cy="${GRID_STEP / 2}" r="1"/></pattern></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
</svg>`

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}.f{fill:#D0453F}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per tier.
// The body keeps the brand clay; the tier's color lives in the costume's accent.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// each costume adds its prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-fable.run{animation:float 1s ease-in-out infinite}
.c-fable.run .la,.c-fable.run .lb,.c-fable.run .bd{animation:none}
.c-fable.run .ant{animation:blink 1s steps(1) infinite}
.c-fable.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-heavy.run .it{animation:scan 1s steps(1) infinite}
.c-heavy.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-careful.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-medium.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-medium.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-light.run .la{animation-duration:.25s}.c-light.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-light.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Fable: astronaut in a glass dome; floats instead of walking, the antenna and the star blink.
  fable: (f, t) => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, t, 'ant'); f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  // Heavy: detective with a deerstalker; the magnifier sweeps and glints.
  heavy: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Careful: engineer in a hard hat; the wrench turns a bolt.
  careful: (f, t) => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Medium: chef, the toque traced from DockCrab's Sprites.chefHat; tosses the omelette.
  medium: (f, t) => {
    crabBody(f, -4, 'pan')
    stamp(f, 6, 0, ['........lll.......', '.......lllll......', '.wwwwgwwwwwwgwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwgwwwwwggwwwww', '.wwwwgwwwwwggwwwww', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.'], { w: '#F4F3EE', l: '#F7F6F2', g: '#D2D1C8', b: t, d: '#B45F43' })
    f(22, 8, 7, 2, '#4A4A48', 'pan'); f(26, 10, 1, 1, '#4A4A48', 'pan'); f(24, 7, 3, 1, '#F5B731', 'egg')
  },
  // Light: racer in a helmet; runs at double pace, the checkered flag flutters.
  light: (f, t) => {
    crabBody(f, -4)
    stamp(f, 6, 5, ['....rrrrrrrrrr....', '..rrrrrrwwrrrrrr..', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.kkkkkkkkkkkkkkkkr'], { r: t, w: '#F8F6F1', k: INK })
    f(25, 1, 1, 9, '#8E929A')
    stamp(f, 26, 1, ['wkwk', 'kwkw', 'wkwk'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  // Explore: pirate scouting the code; the cutlass fences.
  explore: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  other: f => crabBody(f),
}

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own. `mirror` flips the crab inside its
// own box (x .. x + CRAB_BOX * scale) so it faces left.
const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE, mirror = false): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  const draw = COSTUMES[costume] ?? ((g: Fill) => crabBody(g))
  draw(f, colorOf(costume))
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  const place = mirror ? `translate(${x + CRAB_BOX * scale},${y}) scale(${-scale},${scale})` : `translate(${x},${y}) scale(${scale})`
  return `<g transform="${place}" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

// Panel rows are laid out left to right; in Hebrew each box mirrors across the
// row (`mx`) and text hugs the mirrored side. `words` text may hold Hebrew and
// takes `direction="rtl"` (whose `start` is the right edge); numbers stay
// left to right so "≈$0.25" keeps its order.
const mx = (W: number, x: number, w = 0): number => (isRtl() ? W - x - w : x)

// Text that starts at x: left-aligned, or right-aligned at the mirrored x.
const startText = (W: number, x: number, y: number, words = true): string =>
  !isRtl()
    ? `x="${x}" y="${y}"`
    : `x="${W - x}" y="${y}"${words ? ' direction="rtl" text-anchor="start"' : ' text-anchor="end"'}`

// Text that ends at x: right-aligned, or left-aligned at the mirrored x.
const endText = (W: number, x: number, y: number, words = false): string =>
  !isRtl() ? `x="${x}" y="${y}" text-anchor="end"` : `x="${W - x}" y="${y}"${words ? ' direction="rtl" text-anchor="end"' : ''}`

const crabWidth = (scale: number): number => Math.round(CRAB_BOX * scale * 100) / 100

// A panel crab at x in a row of width W: on the mirrored side and facing left in Hebrew.
const rowCrab = (W: number, x: number, y: number, costume: string, dim = false, isWalking = false): string =>
  crab(mx(W, x, crabWidth(CRAB_SCALE)), y, costume, dim, isWalking, CRAB_SCALE, isRtl())

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`


// ---------------------------------------------------------------------------
// Router drawings: one crab per worker, dressed by model family.

const isRtl = () => false

type Family = 'gemini' | 'gpt' | 'claude' | 'other'
const familyOf = (model: string): Family =>
  /gemini/i.test(model) ? 'gemini' : /claude|opus|sonnet|haiku|fable/i.test(model) ? 'claude' : /gpt|codex|^cx\//i.test(model) ? 'gpt' : 'other'
// Gemini races, GPT investigates, Claude cooks, the rest scout.
const FAMILY_COSTUME: Record<Family, string> = { gemini: 'light', gpt: 'heavy', claude: 'medium', other: 'explore' }
const COSTUME_COLOR: Record<string, string> = { light: '#4C8BF5', heavy: '#10A37F', medium: '#D97757', explore: '#888780', other: '#888780' }
const colorOf = (costume: string): string => COSTUME_COLOR[costume] ?? '#888780'
const costumeOf = (model: string): string => FAMILY_COSTUME[familyOf(model)]
const shortModel = (id: string): string => id.replace(/^[a-z]+\//i, '').replace(/\[.*\]$/, '')
const DONE_GREEN = '#3B9C5F'
const FAIL_RED = '#D0453F'

// The workers of the latest delegate call: ids are `<tool_use_id>:<n>`.
const batchOf = (list: Worker[]): Worker[] => {
  const last = list[list.length - 1]
  if (!last) return []
  const call = last.id.replace(/:\d+$/, '')
  return list.filter(w => w.id.replace(/:\d+$/, '') === call)
}

const routerHeaderSvg = (W: number, list: Worker[], at: number): string => {
  const gap = 6
  const tw = (W - gap * 2) / 3
  const running = list.filter(w => w.status === 'running').length
  const tokens = list.reduce((s, w) => s + w.tokensIn + w.tokensOut, 0)
  const start = Math.min(...list.map(w => w.startedAt))
  const end = Math.max(...list.map(w => w.endedAt ?? Math.max(at, w.startedAt)))
  const time = list.length ? end - start : 0
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="0" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="16" font-family="${FONT}" font-size="11">${k}</text>
<text class="t" x="${i * (tw + gap) + 9}" y="33" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(W, 44, `${tile(0, 'Workers', `${running} / ${list.length}`)}${tile(1, 'Tokens', fmtTokens(tokens))}${tile(2, 'Time', fmtTime(time))}`)
}

const workerSvg = (W: number, w: Worker, at: number): string => {
  const costume = costumeOf(w.model)
  const color = colorOf(costume)
  const textW = W - 42 - 22
  const barW = textW
  const stats = `${fmtTokens(w.tokensIn)} ctx · ${fmtTokens(w.tokensOut)} out  ${fmtTime(elapsed(w, at))}`
  const actW = Math.max(0, barW - textWidth(stats, 11) - 12)
  const activity = (w.status === 'running' ? '↳ ' : '') + w.activity
  const meta = `${w.toolCalls} tools`
  const clipId = `c${w.id.replace(/[^a-z0-9]/gi, '')}`
  // Running: a light sweeps along the track; finished: full in the outcome's color.
  const seg = Math.max(24, Math.round(barW * 0.28))
  const bar =
    w.status === 'running'
      ? `<defs><clipPath id="${clipId}"><rect x="42" y="55" width="${barW}" height="4" rx="2"/></clipPath></defs>
<g clip-path="url(#${clipId})"><rect x="42" y="55" width="${seg}" height="4" rx="2" fill="${color}" class="sweep"/></g>
<style>.sweep{animation:sw 1.5s ease-in-out infinite}@keyframes sw{from{transform:translateX(-${seg}px)}to{transform:translateX(${barW}px)}}@media (prefers-reduced-motion: reduce){.sweep{animation:none}}</style>`
      : `<rect x="42" y="55" width="${barW}" height="4" rx="2" fill="${w.status === 'done' ? color : w.status === 'failed' ? FAIL_RED : '#9a9a96'}"/>`
  return svg(
    W,
    66,
    `${rowCrab(W, 0, 14, costume, w.status !== 'running' && w.status !== 'done', w.status === 'running')}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(w.title, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(shortModel(w.model))}</tspan><tspan class="s">  ·  ${xml(meta)}</tspan></text>
${actW > 30 ? `<text class="${w.status === 'failed' ? 'f' : 't'}" x="42" y="49" font-family="${FONT}" font-size="11">${xml(fitText(activity, 11, actW))}</text>` : ''}
<text class="s" x="${42 + barW}" y="49" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
<rect class="k" x="42" y="55" width="${barW}" height="4" rx="2"/>${bar}
${statusMark(W - 8, 16, w.status === 'stopped' ? 'failed' : w.status, color)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
  )
}

// The band: the latest call's workers as one dithered bar, done ones solid, running ones faint.
const routerBandSvg = (batch: Worker[], W: number): string => {
  const total = batch.length
  const finished = batch.filter(w => w.status !== 'running').length
  const running = total - finished
  const failed = batch.filter(w => w.status === 'failed' || w.status === 'stopped').length
  const isWorking = running > 0
  const lead = batch.filter(w => w.status === 'running').pop() ?? batch[batch.length - 1]
  const costume = lead ? costumeOf(lead.model) : 'other'
  const color = isWorking ? colorOf(costume) : failed ? FAIL_RED : DONE_GREEN
  const title = 'Router'
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  const y0 = (H - BAR_H) / 2
  const ratio = total ? finished / total : 0
  const fillW = Math.round(BAR_W * ratio)
  const dots: string[] = []
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  const faint: string[] = []
  for (let c = cols; c < Math.floor(BAR_W / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (isWorking && noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }
  const ticks: string[] = []
  for (let i = 1; i < total; i++) {
    const x = Math.round((BAR_W * i) / total)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }
  const text = isWorking ? `${finished}/${total} · ${shortModel(lead?.model ?? '')}` : failed ? `${failed} failed` : 'Done'
  const pillW = Math.round(18 + textWidth(text, 11) + 4)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const percent = `${Math.round(ratio * 100)}%`
  const crabW = CRAB_BOX * 0.8
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
.t0,.t1,.t2,.t3{animation:tw ${isWorking ? 2.2 : 3.2}s ease-in-out infinite}
.t1{animation-duration:${isWorking ? 2.8 : 3.8}s;animation-delay:-.7s}.t2{animation-duration:${isWorking ? 1.9 : 4.4}s;animation-delay:-1.3s}.t3{animation-duration:${isWorking ? 3.3 : 3.5}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${isWorking ? 0.3 : 0.8}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${title}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(W - CRAB_W + 1, 0, costume, false, isWorking, 0.8)}
</svg>`
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    home = slash((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '')
    opts = options as Record<string, unknown>
    if (str(options.defaultModel)) defaultModel = str(options.defaultModel)
    claudeBin = await resolveClaude($)
    try {
      workerPrompt = (await $.fs.read(`${$.plugin.root}/worker.md`)) as string
    } catch {
      workerPrompt = ''
    }

    await $.tool.register({
      name: 'models',
      description:
        'List the model ids the configured gateway serves (GPT, Gemini, Claude and others), with context windows. ' +
        'Use one of these ids as `model` in `delegate`.',
      inputSchema: { type: 'object', properties: { filter: { type: 'string', description: 'Substring to keep, e.g. "gemini".' } } },
    })
    const taskFields = {
      title: { type: 'string', description: 'A few words naming the task, shown in the panel.' },
      brief: { type: 'string', description: 'The complete, self-contained task for the worker.' },
      model: { type: 'string', description: `Gateway model id (see the models tool). Default: ${defaultModel}.` },
      cwd: { type: 'string', description: "Absolute working directory for the worker. Default: the session's." },
      tools: { type: 'array', items: { type: 'string' }, description: `Tools the worker may use. Default: ${DEFAULT_TOOLS.join(', ')}.` },
      readOnly: { type: 'boolean', description: 'Only Read, Grep and Glob: for investigation tasks.' },
    }
    await $.tool.register({
      name: 'delegate',
      description:
        'Run worker agents on models of the configured local gateway, e.g. 9router (GPT, Gemini, Claude and others; list them with the models tool) and wait for their reports. ' +
        'Each worker is a headless Claude Code with file and shell tools in its cwd; it cannot see this conversation, so each brief must be self-contained ' +
        '(paths, constraints, definition of done, how to verify). Pass one task as title/brief/model, or several as `tasks`: those run IN PARALLEL ' +
        `(up to ${MAX_PARALLEL}) and must touch disjoint files. Separate delegate calls run one after another, so batch parallel work into one call. ` +
        "Progress shows live in the band above the prompt and the /router-workers panel. Returns every worker's final report.",
      inputSchema: {
        type: 'object',
        properties: {
          ...taskFields,
          tasks: {
            type: 'array',
            description: 'Several tasks to run in parallel; use instead of the single-task fields.',
            items: { type: 'object', properties: taskFields, required: ['title', 'brief'] },
          },
        },
      },
    })
    await $.command.register({
      name: 'router-workers',
      description: 'Show or hide the panel of gateway workers: model, status, current action, tokens and time',
    })

    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, workers)
        if (list.some(w => w.status === 'running')) await update($, now, () => Date.now())
      })()
    })
    return started
  })

  on('command.run', { command: 'router-workers' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? 'Router workers panel opened.' : 'Router workers panel closed.' }
  })

  on('tool.call', { tool: 'mcp__router-workers__models' }, async ($, e) => {
    const filter = String((e as unknown as { filter?: string }).filter ?? '').toLowerCase()
    try {
      const list = (await models($)).filter(m => !filter || m.id.toLowerCase().includes(filter))
      const lines = list.map(m => `${m.id}${m.context ? `  (${fmtTokens(m.context)} ctx)` : ''}`)
      return { result: lines.length ? `default: ${defaultModel}\n${lines.join('\n')}` : 'no matching models' }
    } catch (err) {
      return { result: `gateway unreachable: ${(err as Error).message}`, isError: true }
    }
  })

  on('tool.call', { tool: 'mcp__router-workers__delegate' }, async ($, e, next) => {
    if (await $.env.get('ROUTER_WORKERS_CHILD')) return { result: 'workers cannot delegate further', isError: true }
    const input = e as unknown as DelegateInput & { tasks?: DelegateInput[] }
    const tasks = (input.tasks?.length ? input.tasks : [input]).slice(0, MAX_PARALLEL)

    let gw: Gateway
    let list: ModelInfo[]
    try {
      gw = await gateway($)
      list = await models($)
    } catch (err) {
      return { result: `gateway unreachable: ${(err as Error).message}`, isError: true }
    }
    const sessionCwd = await $.session.cwd()
    await ensurePane($).catch(() => {})
    const results = await Promise.all(
      tasks.map((t, i) => runWorker($, t, `${e.tool_use_id}:${i}`, gw, list, sessionCwd, next.signal)),
    )
    const failed = results.filter(r => r.failed).length
    const head = tasks.length > 1 ? `${tasks.length} workers in parallel, ${tasks.length - failed} done, ${failed} failed.\n\n` : ''
    return {
      result: head + results.map(r => r.text).join('\n\n---\n\n'),
      ...(failed === results.length ? { isError: true } : {}),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = (await read($, workers)).slice().reverse()
    const at = Math.max(await read($, now), Date.now())
    const running = list.filter(w => w.status === 'running')
    const rest = list.filter(w => w.status !== 'running')
    const clear = rest.length > 0 && (
      <Button key="clear" label="Clear finished" plain onPress={() => update($, workers, l => l.filter(w => w.status === 'running'))} />
    )

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const lines = 2 + (list.length === 0 ? 1 : 0) + (running.length > 0 ? 1 : 0) + (rest.length > 0 ? 1 : 0)
      const gridH = 44 + lines * LINE_H + list.length * 66
      return (
        <Box flexDirection="column">
          {gridTiles(gridH).map((tileH, i) => (
            <Svg key={`grid-${i}`} source={gridSvg(W, tileH)} alt="dotted grid" width={W} height={tileH} />
          ))}
          <Box flexDirection="column" position="absolute" top={0} left={0} right={0}>
            <Svg source={routerHeaderSvg(W, list, at)} alt={`${running.length} of ${list.length} workers running`} width={W} height={44} />
            <Text dimColor>default model: {defaultModel}</Text>
            {list.length === 0 && <Text dimColor>No workers yet. They appear here when the delegate tool runs.</Text>}
            {running.length > 0 && <Text dimColor>Running · {running.length}</Text>}
            {running.map(w => (
              <Svg key={w.id} source={workerSvg(W, w, at)} alt={`${w.title}: ${w.model}, running, ${w.activity}`} width={W} height={66} />
            ))}
            {rest.length > 0 && <Text dimColor>Finished · {rest.length}</Text>}
            {rest.map(w => (
              <Svg key={w.id} source={workerSvg(W, w, at)} alt={`${w.title}: ${w.model}, ${w.status}`} width={W} height={66} />
            ))}
            {clear}
          </Box>
        </Box>
      )
    }

    // Terminal: the same rows in text.
    const row = (w: Worker) => (
      <Box key={w.id} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          <Text color={COLOR[w.status]}>{GLYPH[w.status]}</Text>
          <Text bold wrap="truncate-end">{w.title}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {'  '}{w.model} · {fmtTime(elapsed(w, at))} · {w.toolCalls} tools · {fmtTokens(w.tokensIn)} ctx · {fmtTokens(w.tokensOut)} out
        </Text>
        <Text wrap="truncate-end" color={w.status === 'failed' ? 'red' : undefined} dimColor={w.status !== 'running' && w.status !== 'failed'}>
          {'  '}{w.status === 'running' ? '↳ ' : ''}{w.activity}
        </Text>
      </Box>
    )
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>default model: {defaultModel}</Text>
          {clear}
        </Box>
        {list.length === 0 && <Text dimColor>No workers yet. They appear here when the delegate tool runs.</Text>}
        {running.length > 0 && <Text dimColor>Running · {running.length}</Text>}
        {running.map(row)}
        {rest.length > 0 && <Text dimColor>Finished · {rest.length}</Text>}
        {rest.map(row)}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, workers)
    const state = await read($, band)
    if (list.length === 0 || state.isDismissed || e.props.hasSurvey) return next(e)
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const at = Math.max(await read($, now), Date.now())
    const batch = batchOf(list)
    const running = list.filter(w => w.status === 'running')
    const finished = batch.filter(w => w.status !== 'running').length
    const crew = <Button key="router-crew" label={`×${list.length}`} plain onPress={() => void togglePane($)} />
    const dismiss = <Button key="router-dismiss" label="✕" plain role="dismiss" onPress={() => update($, band, () => ({ isDismissed: true }))} />

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={routerBandSvg(batch, width)} alt={`Router: ${finished} of ${batch.length} workers finished`} width={width} height={H} />
            {crew}
            {dismiss}
          </Box>
          {below}
        </Box>
      )
    }

    const latest = running[running.length - 1]
    const cols = e.props.bodyColumns || 80
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={running.length ? ACCENT : 'green'}>{running.length ? '●' : '✓'}</Text>
          <Text bold>Router</Text>
          <Text dimColor>
            {finished}/{batch.length} done
          </Text>
          {latest && (
            <Box flexShrink={1}>
              <Text wrap="truncate-end">
                {clip(`${shortModel(latest.model)} ${fmtTime(elapsed(latest, at))} ↳ ${latest.activity}`, Math.max(20, cols - 40))}
              </Text>
            </Box>
          )}
          {crew}
          {dismiss}
        </Box>
        {below}
      </Box>
    )
  })
}
