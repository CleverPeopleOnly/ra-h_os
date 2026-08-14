# RA-OS

## What This Is
Open-source, local-first knowledge graph app with MCP integration.

This fork (CleverPeopleOnly/ra-h_os) adds a belief DISPLAY surface on top of upstream RA-OS. The belief engine itself lives in the samai-diagnostic repo: samai computes beliefs there and writes the results into this store through the remote MCP door. What this fork owns is belief-adjacent plumbing:

- **the four display columns on `nodes`** — `belief_credence`, `belief_uncertainty`, `belief_computed_at`, `belief_credence_is_fixed` — written by samai through the door and read everywhere (node reads, edge answers, the map UI),
- **the display-belief write surface** — `src/services/belief/beliefDisplayWrite.ts`, `app/api/belief/display`, and the `rah_write_display_belief` door tool (which refuses a fixed node),
- **the graph-event journal** — how an external consumer mirrors deaths and re-orientations in this graph,
- **bearer door auth** — every MCP door fails closed without its token.

Edges carry no belief data: an edge is a plain relationship with an explanation. No engine, no evidence, no recompute lives here.

## Fork rule: belief-system naming (mandatory)

Everything the belief surface adds to this codebase must be recognisable as belief code on sight, wherever it appears:

- **Every database column we add carries the `belief_` prefix** — e.g. `nodes.belief_credence`, `nodes.belief_uncertainty`. This matters most on upstream-owned tables (`nodes`), where our columns sit beside Brad's.
- **Every exported symbol of a belief module contains `belief`/`Belief`** — e.g. `writeDisplayBelief` in `beliefDisplayWrite.ts`, `beliefFieldsForNodeRead` in the shared MCP tool contract. Module-internal locals inside `src/services/belief/` are already scoped by their path.
- **MCP tool parameters and API fields follow the column names exactly** (`belief_credence`, `belief_uncertainty`, `belief_computed_at`, `belief_credence_is_fixed`).

Rationale: our columns are guests in upstream territory — the prefix flags ours in any diff or merge conflict, and no future upstream name can collide with it. Renaming after the MCP surface ships would break callers, so names must be right before a surface goes live.

Note that `belief_` is a NAMESPACE marker, not a description. Strip it and what remains must still name the quantity: `belief_credence` → *credence*, `belief_computed_at` → *a timestamp*. A column whose remainder is `value`, `score`, `data` or `grade` is not named — those words describe nothing on their own.

## Fork rule: belief vocabulary (mandatory)

One word per concept, and no synonyms. This exists because the belief system's central quantity kept being written four ways in one sentence, which made the model impossible to reason about in prose or in code.

| The thing | The word | Where it lives |
|---|---|---|
| How much samai believes a node | **credence** | `nodes.belief_credence` |
| How little evidence a credence rests on | **uncertainty** | `nodes.belief_uncertainty` |
| A credence a human asserted by hand | **fixed credence** | `nodes.belief_credence_is_fixed` |
| When the credence was stamped | — | `nodes.belief_computed_at` |

**`trust`, `standing`, `score`, `weight` and `value` are banned as synonyms for credence** anywhere in belief code, comments, or tool descriptions.

**Sign invariant: `nodes.belief_credence` is the only signed quantity in the system.** And NULL is never 0: a NULL credence means nobody has grounded the node, while 0 means it was assessed and believed neither way — two states that must never collapse into each other.

CI (.github/workflows/ci.yml) gates every push/PR on the full test suite, full typecheck, and `npm run lint:belief-surface` — everything the belief surface owns must lint clean. Upstream's pre-existing lint debt is out of scope and not gated; new belief-owned files must be added to the `lint:belief-surface` script.

## Core Stack
- Next.js 15 + TypeScript + Tailwind
- SQLite + sqlite-vec
- BYO API keys (OpenAI/Anthropic)

## Run Locally
```bash
git clone https://github.com/bradwmorris/ra-h_os.git
cd ra-h_os
npm install
npm run setup:local
npm run dev
```

## MCP Setup
```bash
npx -y ra-h-mcp-server@latest setup --client claude-code --yes
```

## Source of Truth for Workflow
- `AGENTS.md` - agent and contributor workflow
- `CONTRIBUTING.md` - PR and contribution policy

## Key Paths
- `src/services/database/` - data layer
- `src/tools/` - MCP tool implementations
- `src/config/skills/` - built-in skill content
- `app/api/` - API routes

## Docs
- `docs/README.md`
- `docs/0_overview.md`
- `docs/2_schema.md`
- `docs/4_tools-and-guides.md`
- `docs/6_ui.md`
- `docs/8_mcp.md` - includes MCP setup plus recommended memory-file guidance
