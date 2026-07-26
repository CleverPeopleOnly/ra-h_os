# RA-OS

## What This Is
Open-source, local-first knowledge graph app with MCP integration.

This fork (CleverPeopleOnly/ra-h_os) adds a native belief engine on top of upstream RA-OS.

## Fork rule: belief-system naming (mandatory)

Everything the belief system adds to this codebase must be recognisable as belief-system code on sight, wherever it appears:

- **Every database table or column we add carries the `belief_` prefix** — e.g. `nodes.belief_value`, `edges.belief_evidence_strength`, `belief_source_trust`, `belief_movements`. This matters most on upstream-owned tables (`nodes`, `edges`), where our columns sit beside Brad's.
- **Every identifier we add to an upstream-owned file says belief** — e.g. `hasBeliefEvidenceFields` in `edges.ts`, `recomputeNodeBelief` in `autoEmbedQueue.ts`.
- **Every exported symbol of a belief module contains `belief`/`Belief`** — e.g. `BeliefEvidenceContribution`, `beliefGradingPolicyV1`. Module-internal locals inside `src/services/belief/` are already scoped by their path.
- **MCP tool parameters and API fields follow the column names exactly** (`belief_evidence_direction`, `trust_origin_key` inside `belief_source_trust`, …).

Rationale: our columns are guests in upstream territory — the prefix flags ours in any diff or merge conflict, and no future upstream name can collide with it. Renaming after the MCP surface ships would break callers, so names must be right before a surface goes live.

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
