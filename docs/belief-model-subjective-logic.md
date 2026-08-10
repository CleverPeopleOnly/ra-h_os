# Belief model v2 — Subjective Logic evidence masses

Status: **implemented** (the §7 follow-on shipped; this line previously lagged the
code). This document records the research that led to the decision, the model itself,
and what the implementation changed. It amends the model shipped in PR#12
(`e^(−C) − e^(−S)` grading); it does not amend the vocabulary rules in `CLAUDE.md`,
which this document follows throughout. **Amended 2026-08-10: edge direction** — the
engine now reads evidence along RA-H's own edge canon (Derivative→Source) instead of
imposing a direction of its own; see §8, and note that §2 and §4 are corrected in
place to the canon reading.

---

## 1. Why change

The PR#12 engine got the *shape* right — signed credence on nodes, unsigned support on
edges, contribution = credence × support, disbelieved sources counting against — but the
aggregation formula `credence = e^(−C) − e^(−S)` is home-made, and an audit
(2026-08-03) plus a literature survey found concrete costs:

1. **A credence near 0 is ambiguous.** One weak vote and heavy conflicting evidence both
   land near 0. Nothing stored can tell "barely assessed" from "heavily contested" —
   and for a system whose whole point is knowing what is *questionable*, that is the
   central quantity to be missing.
2. **Attenuation is an accident.** `SATURATION_RATE = 1.0` makes a lone maximal edge
   from a 0.9-credence source yield ≈ 0.593. Nobody chose that number; there is no
   principled way to tune it.
3. **No propagation.** `recomputeNodeBelief` regrades exactly one node. When a source's
   credence changes, every node it supplies evidence to keeps a stale credence forever,
   and the stamped `belief_evidence_contribution` goes stale while non-NULL — invisible
   to `beliefRecoveryService`, which keys on `contribution IS NULL`.
4. Smaller gaps: a fixed credence cannot be un-fixed; the movement log's `trigger` is a
   constant; the multi-write recompute runs outside a transaction; `belief_movements`
   has no index on `node_id`.

### What the literature says (survey, 2026-08-03)

- **PSL (Probabilistic Soft Logic)** — hinge-loss Markov random fields over [0,1] soft
  truth values (Bach, Broecheler, Huang, Getoor, JMLR 2017). Pujara & Getoor's
  *Knowledge Graph Identification* (ISWC 2013) is the canonical academic treatment of
  exactly our problem: deciding which facts in a graph to believe given noisy sources.
  Rejected as a dependency: Java-only, last stable release 2020, commit activity ended
  ~mid-2024 (the group moved to NeuPSL), and inference is batch — the whole graph is
  re-solved as one convex program; online variants exist only as papers (Dickens et
  al., ICML 2021).
- **Subjective Logic** (Jøsang, *Subjective Logic*, Springer 2016) — **adopted.** Each
  proposition holds an opinion (belief *b*, disbelief *d*, uncertainty *u*, with
  b + d + u = 1) in bijection with a Beta distribution over evidence: *r* positive and
  *s* negative evidence masses give b = r/(r+s+W), d = s/(r+s+W), u = W/(r+s+W) for a
  fixed prior mass W. Natively incremental (a new finding is one mass increment),
  uncertainty is first-class, a human anchor is the formalism's own *dogmatic opinion*
  (u = 0), and the *opposite-belief-favouring discounting* operator is the documented,
  citable form of "a disbelieved source's evidence counts against what it talks about".
  Its signed projection b − d lands in the open interval (−1, +1) — the exact range
  `belief_credence` already enforces.
- **Ruled out**: Markov Logic Networks (#P-complete inference, tooling unmaintained;
  PSL was created to fix this), ProbLog (possible-worlds semantics, exponential exact
  inference — wrong shape for collective graph grading), uncertain-KG embeddings
  (UKGE/BEUrRE — need tens of thousands of scored training triples; opaque; retrain on
  update), Dempster-Shafer (Subjective Logic is its well-behaved practical successor
  for binary frames), batch truth-discovery algorithms (TruthFinder → Knowledge Vault —
  need many sources asserting overlapping content; we keep their *idea*: a source's own
  credence gains negative evidence when a confirmed outcome contradicts it — this is
  the `calibration` row already reserved in the vocabulary table).

Subjective Logic implementations are research-grade (e.g. FZI's SUBJ); the core we need
is small and is owned in-repo, like the current grading policy.

---

## 2. The model

### Stored state

Per node, two **unsigned evidence masses** replace the stored scalar as the primary
belief state:

| Column | Meaning |
|---|---|
| `nodes.belief_evidence_for_mass` | accumulated evidence mass for the node (r) |
| `nodes.belief_evidence_against_mass` | accumulated evidence mass against the node (s) |

Both NULL or both non-NULL, enforced. **NULL means never assessed** — the same
semantics `belief_credence` NULL carries today. Both 0 means assessed and carrying
nothing (the vacuous opinion, u = 1).

`belief_credence` **remains, as the cached signed projection** — every existing reader
keeps working, and the sign invariant is untouched:

```
credence  = (r − s) / (r + s + W)          signed, open (−1, +1)
uncertainty = W / (r + s + W)              unsigned, (0, 1]
```

with **`BELIEF_PRIOR_MASS` W = 2**, the non-informative prior of the Beta/Subjective
Logic correspondence (two virtual observations, one each way). W is the principled
tuning knob that replaces `SATURATION_RATE`: raising it demands more evidence before
credence commits. It is a named constant with a documented meaning, not a magic rate.

`belief_uncertainty` is **derived on read, not stored** — it is a pure function of the
masses and would only be one more cache to go stale.

### Vocabulary (additions — `CLAUDE.md` table gains these rows)

| The thing | The word | Where it lives |
|---|---|---|
| Accumulated evidence for/against a node | **evidence mass** | `nodes.belief_evidence_for_mass`, `nodes.belief_evidence_against_mass` |
| How little evidence a credence rests on | **uncertainty** | derived: W/(r+s+W); never stored |

Banned-word check: *mass* names the accumulated quantity (standard Subjective Logic
usage: "evidence mass"); it is not a synonym for credence and never appears on an edge.
`trust`, `standing`, `score`, `weight`, `value` remain banned. Strip the `belief_`
namespace prefix and the remainders still name their quantity: *evidence for mass*,
*evidence against mass*.

### Edge semantics — unchanged, re-grounded

Support is untouched: unsigned 0..1, NULL = not evidence, 0 = assessed and inert.
An edge's **contribution** is exactly what it is today:

```
contribution = source credence × support        signed
```

Since the 2026-08-10 direction amendment (§8), the edge runs in RA-H's canon —
**Derivative→Source** — so the source is the edge's *target* and the derived node
(whose credence the evidence feeds) is the edge's *from-end*. The contribution lands
in the derived node's masses, split by sign:

```
contribution ≥ 0  →  adds  contribution  to belief_evidence_for_mass
contribution < 0  →  adds |contribution| to belief_evidence_against_mass
```

In Subjective Logic terms this per-edge rule is **discounting in evidence space**: the
source's own credence scales the evidence (a barely-believed source moves little mass),
support scales it further, and a *negative* source credence routes the mass to the
against side — the evidence-mass form of the **opposite-belief-favouring discounting**
operator. That last part is a deliberate, standing decision (PR#12), now with a
citable name: standard discounting would discard a disbelieved source's assertions as
mere uncertainty; we chose, and keep, the variant where they count against.

### Aggregation — cumulative fusion

A node's masses are the plain sums of the contributions arriving over its **outgoing
support-bearing edges** (its evidence basis under the canon direction, §8), split by
sign. This is Subjective Logic's **cumulative fusion** (evidence masses of independent
opinions add). Two standing decisions carry over unchanged:

- **Repetition reinforces** (averaging fusion is rejected): ten edges carrying the same
  content add ten times the mass. Anti-gaming remains the credence of the sources
  themselves, not an origin-collapse step. Under the new formula reinforcement is
  asymptotic — credence approaches ±1 and never arrives — rather than the old
  exponential saturation.
- **Unassessed sources cast no vote**: a source with NULL credence contributes nothing,
  and its edge's contribution stamp is cleared to NULL, exactly as today.

### Fixed credence — the dogmatic opinion

`belief_credence_is_fixed = 1` is Subjective Logic's dogmatic opinion (u = 0): a
credence a human asserts, which the engine reports and never recomputes. Its masses are
NULL — there is no evidence ledger behind an assertion. As a *source*, a fixed node's
projection is simply its asserted credence, supplying contributions to the nodes that
derive from it like any other source.

New in v2: **an un-fix door.** A single operation clears `belief_credence_is_fixed` to
0 and immediately regrades the node from its actual evidence (movement trigger
`belief-fixed-credence-cleared`). Nothing else about the fixed-credence flow changes.

---

## 3. Worked examples (old formula vs new)

Old: `credence = e^(−C) − e^(−S)`, S = Σ positive contributions, C = Σ |negative|.
New: `credence = (r − s)/(r + s + 2)`, `uncertainty = 2/(r + s + 2)`.

| Scenario | Contributions | Old credence | New credence | New uncertainty |
|---|---|---|---|---|
| Lone weak vote (source 0.9, support 0.5) | +0.45 | 0.362 | **0.184** | 0.816 |
| Lone maximal edge (source 0.9, support 1.0) | +0.9 | 0.593 | **0.310** | 0.690 |
| Heavy conflict (five at +0.6, five at −0.6) | S=3, C=3 | 0 | **0** | **0.25** |
| Tiny conflict (one +0.05, one −0.05) | S=0.05, C=0.05 | 0 | **0** | **0.952** |
| Repetition (ten edges at +0.9) | S=9 | 0.99988 | **0.818** | 0.182 |
| Disbelieved source (source −0.8, support 0.75) | −0.6 | −0.451 | **−0.231** | 0.769 |
| Never assessed | none | NULL | **NULL** | — |

Reading the table:

- Rows 3 vs 4 are the point of the change: both are credence 0 under both formulas, but
  the new model *stores the difference* — heavy conflict is a confident 0 (u = 0.25),
  a tiny conflict is a shrug (u = 0.95). The old model cannot express this at all.
- Rows 1–2: the new model is more conservative on lone evidence. That is the prior mass
  W doing openly what `SATURATION_RATE` did by accident — a single edge cannot buy high
  credence, however strong. Uncertainty says exactly why the number is low.
- Row 5: repetition still reinforces, but along r/(r+2) → asymptotic, never
  0.9999-after-ten-copies. The standing decision survives; the pathology softens.
- All new-credence arithmetic in this table is reproducible by hand from the two
  formulas above; e.g. row 1: (0.45 − 0)/(0.45 + 0 + 2) = 0.45/2.45 = 0.1837.

---

## 4. Propagation (fixes audit finding 3)

The one-node recompute becomes a **sweep** (directions below per the 2026-08-10 canon
amendment, §8):

1. A write lands (edge support changed, source graded, fixed credence set/cleared).
2. Regrade the directly affected derived node — the support-bearing edge's from-end.
3. If a regraded node's projected credence moved by more than
   `BELIEF_CREDENCE_CHANGE_EPSILON`, enqueue every node that **derives from it** —
   the from-ends of its *incoming* support-bearing edges
   (`belief_evidence_support IS NOT NULL`) — for regrade.
4. Repeat with a **visited set per sweep**: each node regrades at most once per sweep —
   the echo guard. Cycles terminate because a visited node is never re-entered; the
   next sweep (triggered by the next write) picks up any residual drift. One direction
   of flow per sweep, no fixpoint iteration inside a sweep.
5. Fixed-credence nodes are never regraded but do propagate *through* (the nodes
   deriving from them are still enqueued when the fixed node was the write target —
   which only happens via set/clear-fixed, the only writes that move a fixed node's
   projection).

**Stale stamps become impossible rather than repaired**: `recomputeNodeBelief` already
re-derives every contribution from the live source credence — the stamp is a record of
the last grading, not an input to it. The failure mode was never the stamp; it was that
the *target* was not regraded when a source moved. Propagation closes that. The
recovery sweep additionally learns to detect staleness: an edge whose stamp differs
from `source credence × support` by more than epsilon marks its target for regrade
(today it only finds `contribution IS NULL`).

The whole sweep runs inside **one better-sqlite3 transaction** (fixes audit finding:
today up to N+2 writes across three tables run bare).

---

## 5. Movement log (fixes audit findings 5–6)

`belief_movements` is unchanged in shape; two fixes:

- **`trigger` becomes the actual cause**, one value per entry point:
  `evidence-edge-write`, `embed-grade`, `recovery-sweep`, `propagation`,
  `mcp-recompute`, `belief-fixed-credence-set`, `belief-fixed-credence-cleared`,
  `model-migration`. The constant `'belief-recompute'` disappears.
- **Index on `belief_movements(node_id)`** — every read filters on it.

Movements continue to record the *projection* (`from_credence` / `to_credence`): the
log answers "how did belief move", and credence is the belief. Masses are state, not
story.

---

## 6. Migration sketch (no code in this MR)

Every input to the new model is already stored — masses are fully *recomputable*, so
there is no back-solving problem:

1. Add `belief_evidence_for_mass` and `belief_evidence_against_mass` (REAL, NULL) to
   `nodes`, in `ensureBeliefSchemaLocked` and in the standalone CLI's parallel DDL.
2. Run a global regrade: seed from fixed-credence nodes, sweep outward with the
   propagation mechanism of §4 until every non-fixed node with an evidence basis has
   been regraded once per pass; iterate passes to a bounded depth (the graph is small;
   convergence is asymptotic and epsilon-bounded).
3. Each node whose credence changes gets a movement row, trigger `model-migration` —
   the numbers *will* change (see §3) and the log should say why.
4. `belief_evidence_contribution` stamps are refreshed by the same regrades. Nothing
   is dropped; `belief_credence` and all read surfaces keep their exact shapes, with
   `belief_uncertainty` added alongside `belief_credence` on node reads (`rah_get_nodes`
   and the fields helpers in `beliefMcpToolContract.js`).

There is no populated production database today (the first real store — Marelie's
data — has not been created), so the migration's only live duty is schema correctness,
not data fidelity.

---

## 7. What implementation must touch (follow-on work, own TDD cycle)

- `src/services/belief/beliefGradingPolicy.ts` — mass accumulation + projection
  replaces `e^(−C) − e^(−S)`; `BELIEF_PRIOR_MASS` replaces `SATURATION_RATE`.
- `src/services/belief/beliefService.ts` — sweep with visited set, transaction,
  per-cause triggers, mass persistence.
- `src/services/belief/beliefRecoveryService.ts` — stale-stamp detection added.
- `src/services/belief/beliefFixedCredence.ts` + a new un-fix operation, mirrored on
  all three MCP doors (shared contract file + standalone twin).
- `src/services/database/sqlite-client.ts` + `apps/mcp-server-standalone/cli.js` —
  schema, movement-log index.
- `src/services/belief/beliefMcpToolContract.js` — `belief_uncertainty` on node reads;
  new tool for the un-fix door.
- Tests: the pinned-behaviour tests in `tests/unit/belief/` change numbers per §3 —
  each changed expectation cites its row in the worked-examples table.

---

## 8. Edge direction — the engine reads RA-H's canon (2026-08-10 amendment)

### The decision

**The belief layer reads RA-H's edge direction; it does not impose one of its own.**
An evidence edge runs in RA-H's canonical direction, **Derivative→Source** — the
derived node points at the node it derives from: "my credence derives from you". The
engine's gathering rule follows: **a node's evidence basis is its outgoing
support-bearing edges, and the source credences are read from those edges' targets.**
RA-H's semantic model, edge storage, and prose inference are untouched by this
amendment — no skip-inference flag, no re-orientation fight, no upstream change.

### Why (found live, 2026-08-10)

The engine previously assumed evidence ran Source→Derivative, so writers had to store
edges against RA-H's own canon. RA-H classifies every edge from its explanation prose
and applies the inferred type's canonical direction — so a correctly working inference
*reliably re-oriented* a correctly written evidence edge (observed live: "X is the
source of Y" prose, inferred `source_of` at confidence 0.92–0.95, stored swapped, the
regrade landing on the wrong node). The failure was ours, not the classifier's: two
direction vocabularies on one edge table, with the engine's invented one losing.

Written in canon, both inference paths preserve the direction: a working inference
agrees (the from-node *is* the Derivative — no swap), and the inference-failure
fallback (`related_to`, confidence 0.2) stores as-written. The classifier's
nondeterminism stops mattering.

### What marks evidence

**The presence of a support figure alone.** An outgoing edge with non-NULL
`belief_evidence_support` is in the basis whatever type the prose classifier assigned;
an edge without one is not evidence, whatever its type. The classifier's output stays
what it always was — RA-H's semantic annotation — with no vote in belief. The support
figure itself is a semantic judgement of the relationship's loudness, made by the
caller when the connection is made; the engine consumes the number mechanically and
never judges.

### Scoped residual risk (accepted)

A new node cannot be a source — nothing derives from a node that just arrived — so
evidence written at ingestion is never direction-ambiguous, and its explanation
naturally takes the new node as subject (source-shaped prose, which the classifier
keeps in canon). The only theoretical exposure is an evidence edge between two
already-existing nodes whose explanation is phrased with the source end as
grammatical subject ("Wrote…", "Contains…") — rare, and avoided by writing the
explanation from the derived end, which good explanations do anyway. Accepted; no
store-side mitigation.

### What implementation must touch (the MR sequence after this document)

- The per-node regrade gathers the node's outgoing support-bearing edges; source
  credence from each edge's target (`beliefService.ts`).
- The edge-create and edge-update evidence hooks regrade the edge's **from-end** —
  the derived node (`edges.ts`).
- The sweep enqueue and `propagateBeliefFromSourceNode` invert per §4's corrected
  steps; echo guard, one-direction-per-sweep and one-transaction rules unchanged.
- The duplicate-guard collision (inference flipping an edge into an occupied
  direction slot) gets its behaviour pinned by a test — consumers need to know what
  the store answers.
- Fork test fixtures and the demo graph seed flip to canon so the examples model the
  rule.
