# RA-OS

## What This Is
Open-source, local-first knowledge graph app with MCP integration.

This fork (CleverPeopleOnly/ra-h_os) adds a native belief engine on top of upstream RA-OS.

## Fork rule: belief-system naming (mandatory)

Everything the belief system adds to this codebase must be recognisable as belief-system code on sight, wherever it appears:

- **Every database table or column we add carries the `belief_` prefix** — e.g. `nodes.belief_credence`, `edges.belief_evidence_strength`, `belief_movements`. This matters most on upstream-owned tables (`nodes`, `edges`), where our columns sit beside Brad's.
- **Every identifier we add to an upstream-owned file says belief** — e.g. `hasBeliefEvidenceFields` in `edges.ts`, `recomputeNodeBelief` in `autoEmbedQueue.ts`.
- **Every exported symbol of a belief module contains `belief`/`Belief`** — e.g. `BeliefEvidenceContribution`, `beliefGradingPolicyV1`. Module-internal locals inside `src/services/belief/` are already scoped by their path.
- **MCP tool parameters and API fields follow the column names exactly** (`belief_credence`, `belief_evidence_direction`, `belief_evidence_strength`, …).

Rationale: our columns are guests in upstream territory — the prefix flags ours in any diff or merge conflict, and no future upstream name can collide with it. Renaming after the MCP surface ships would break callers, so names must be right before a surface goes live.

Note that `belief_` is a NAMESPACE marker, not a description. Strip it and what remains must still name the quantity: `belief_evidence_strength` → *strength*, `belief_computed_at` → *a timestamp*. A column whose remainder is `value`, `score`, `data` or `grade` is not named — those words describe nothing on their own.

## Fork rule: belief vocabulary (mandatory)

One word per concept, and no synonyms. This exists because the belief system's central quantity kept being written four ways in one sentence, which made the model impossible to reason about in prose or in code.

| The thing | The word | Where it lives |
|---|---|---|
| How much we believe a node | **credence** | `nodes.belief_credence` |
| A source node's influence over evidence it supplies | **credence** | the same number — deliberately the same word |
| What one edge adds to its target | **contribution** | `edges.belief_evidence_contribution` |
| How hard an edge pushes, regardless of who said it | **strength** | `edges.belief_evidence_strength` |
| Which way an edge pushes | **direction** | `edges.belief_evidence_direction` |
| The log of a node's credence changing | **movement** | `belief_movements` |
| Future: learning a source's credence from confirmed outcomes | **calibration** | produces credence; not a new quantity |

The load-bearing row is the second. A source's influence and a node's belief are THE SAME NUMBER, so they must never acquire two names. **`trust`, `standing`, `score`, `weight` and `value` are therefore banned as synonyms for credence** anywhere in belief code, comments, or tool descriptions.

The vocabulary in one sentence: an edge's **contribution** is its **direction** × its **strength** × the source node's **credence**; a node's **credence** is the graded sum of its incoming contributions; a node nobody has grounded has no credence (NULL).

(The `belief_source_trust` table and its `trust_origin_key` are the last code contradicting this rule. They are removed by the sources-as-nodes MR, which replaces the lookup with the source node's own credence.)

CI (.github/workflows/ci.yml) gates every push/PR on the full test suite, full typecheck, and `npm run lint:belief-surface` — everything the belief system owns must lint clean. Upstream's pre-existing lint debt is out of scope and not gated; new belief-owned files must be added to the `lint:belief-surface` script.

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
