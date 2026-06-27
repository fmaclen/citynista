# Lane correspondence — one model, proven by construction

Status: design, agreed 2026-06-25. Supersedes the ad-hoc transition/marking logic in
`node-resolution.ts` (`resolveTransitionArm`, `markingStructure`, `laneBoundaryTargets`).
Builds on `scratchpads/01-lane-connectivity.html` and the `render-derivation` work.

## The goal (why this doc exists)

Not "fix the current bugs." The goal is **correctness by construction**: a model that renders
**any reasonably-realistic lane configuration** correctly, so we stop hand-hunting for the
combination that breaks. Every visible bug to date (turn-pocket dashes, complex-switch asphalt
stubs, the dash that jogs across a transition) is a *symptom* of the same root cause, and the fix
is to remove the root cause, not the symptoms.

## Root cause

"Which lane on one arm corresponds to which lane on the other" is computed **three independent
times**, by three heuristics that only agree when the cross-section is identical:

1. **Geometry** — `resolveTransitionArm` matches lane *intervals* by surface-class count / bounding
   span. It has no per-lane axis at all (`getLaneIntervals` even collapses opposing-direction
   lanes into one roadway blob). → asphalt stubs, misplaced medians on count changes.
2. **Markings** — `markingStructure` + `laneBoundaryTargets` pair dashes centre-out; `lanePaintBetween`
   is purely local (two adjacent same-direction lanes ⇒ always dashed). → can't see a turn bay;
   the dash jogs because its target offset is computed independently of the geometry match.
3. **Movement** — `lane-connections.ts` (`defaultConnections`) is the real, explicit, user-editable
   lane→lane graph (the Connector). Consumed for arrows + centre breaks only — ignored by 1 and 2.

When lane count/structure changes, the three diverge. That divergence **is** the bug class.

## The model: one connectivity graph, consumed two ways

Collapse the three into **two** correspondences — never one. Collapsing everything into the movement
graph would violate the load-bearing invariant *movement may sever structural continuity but must
never create it* (a median continues structurally with zero travel connections; a U-turn must not
drag asphalt across the median).

- **Structural correspondence** drives **geometry + markings**. Lives in the node resolver. Matches
  **per-lane axes** inside **carriageway groups**.
- **Movement correspondence** is the Connector. It **classifies** (centre breaks, split/through
  arrows, live/dead junction corners) and **vetoes**; it **never authors a taper vertex**.

The same graph is consumed two ways depending on locality:

- **Within-segment transitions (2-arm):** structural lateral matcher + movement as a tie-break
  classifier. The connector's fan-out (one lane → left+through+right) is the *wrong* primitive for a
  lateral taper, so it only labels axes; structure executes the taper.
- **Junction interiors (3+ arm):** the drivable surface **is** the union of connector ribbons.
  Each movement is a swept lane-path; union them; that is the asphalt. This
  replaces the parallel connection-pair / gore / merge / patch abstraction over time (slice 5).

> Why both, not just "union of ribbons everywhere": at a 2-arm lane-count change the *born* lanes
> have **no connector on the narrow side at all**, so "union of connectors" yields nothing for them.
> The lateral taper of born/dropped lanes is a structural problem the movement graph cannot express.

## The kernel (structural lateral matcher)

A **pure function**. Inputs: the two arms' plain lane arrays, precomputed widths, relative
orientation (mirrored / start-vs-end frame), a movement summary (per source lane: has-through? /
turn-only), and an optional per-segment-end **alignment offset**. No `Graph`/`Segment`/Svelte imports.
Output: per-strip dispositions + paint-boundary annotations (the existing `resolveNodeStrips` shape,
extended). This boundary is what makes it Bun-unit-testable and is the correct software seam anyway.

Algorithm:

1. **Carriageway groups.** Split each side into maximal **same-direction vehicle runs**, bounded by
   non-vehicle lane / direction change / road edge. A median appearing or vanishing **does not merge
   groups** — opposing direction still splits back/fwd even with no island between them. (Today
   `getLaneIntervals` collapses these — the kernel needs its own finer pass, then collapses back to
   render intervals.)
2. **Pair groups** monotonically by direction + lateral order. Islands/verges/walkways match
   structurally (overlap / nearest nose); an unmatched divider noses to a point + roadway underfill.
3. **Match lane axes inside a paired group** (n source → m anchor): enumerate the monotone,
   non-crossing matches (j lanes born/dropped on the low side), score lexicographically and pick:
   - avoid extras on the structurally-*continuing* side;
   - prefer extras where the island/verge/edge **changed**;
   - prefer the **median side** when otherwise tied (median side is structural — lane order + opposing
     direction, the fact `medianBufferIndex` already uses);
   - then minimise matched-axis displacement; then a deterministic index.
4. **Movement as tie-break only.** When structure is tied, the movement summary (binary
   through-vs-turn mask) picks which axes are the continuing ones. **Never** feed raw `from→to`
   connector pairs into geometry (`A0→B1, A1→B0` would literally cross), and **never** reuse
   `monotonicLanePairs` for geometry (it duplicates a side for fan-out on purpose). Structure
   outranks movement: a connection toggle must never move the road body.
5. **Alignment offset.** The genuinely ambiguous case — `2→3` same-direction, identical material, no
   median/edge cue (the user's "which 2 of the 4 do my 2 lanes line up with") — is **not** solvable
   from two cross-sections. It is resolved by an explicit per-end alignment offset (clean metadata,
   *not* fake spacer lanes), or the structural default. This is a render concern; cross-node lane
   identity (lane-runs, Gap 1) is a *simulation* concern and is deferred.

## Paint contract

Markings derive from the **same** correspondence, so geometry and paint can never disagree (this is
what kills the dash jog). Extend the resolved paint boundary:

```ts
type PaintBoundaryDisposition =
  | 'continue'      // bridgeable across the node
  | 'taperToTarget' // draw through the taper, do not bridge node paint
  | 'cutAtTaper'    // no useful target; stop before the morph zone
  | 'stopAtPatch'
  | 'breakAtNode';  // crossing movement opens the carriageway

type PaintBoundaryStyle =
  | { color: 'lane'; dashed: true }    // dashed white — both axes continue, same direction
  | { color: 'lane'; dashed: false }   // SOLID white — a born/dropped (lane-drop / turn-bay) line
  | { color: 'center'; dashed: false } // yellow centre
  | null;
```

Rules, all derived (no `if (turnPocket)`):

- A same-direction boundary is **dashed** iff *both* adjacent lane axes continue (have counterparts
  that stay adjacent); if one is born/dropped it is **solid white** — the real lane-drop line.
  *This is the turn-pocket fix and the lane-switch fix, from one rule.*
- The yellow **centre** line continues iff both sides have a divider and **breaks** where an active
  movement crosses the through axis (`centerCrossedAt` survives internally; its exported side-channel
  folds into the per-boundary disposition).

`buildPaint` reads these from the morph instead of calling `lanePaintBetween` as the primary source;
`lanePaintBetween` stays the fallback for non-transition / unannotated boundaries.

## Acceptance: a generative stress harness (this is the point)

We prove coverage instead of hand-finding breakages. Enumerate **cases**, emit a coverage manifest,
assert **invariants** headlessly. Do **not** Cartesian-product every cross-section pair: generate the
canonical cross-sections, then only **one-step realistic neighbour** transitions, canonicalise mirrors.

Enumeration axes:

- **Transitions (2-arm):** topology (straight / 45° / 90° bend / curved wide / curved narrow) ×
  flow family (one-way 1..4; two-way 1..3 × 1..3) × centre (none/yellow, concrete island, grass
  island) × edge (none, sidewalks, one-side verge+walk) × **mutation class** (same; lane born
  outside-L/R; born median-side-L/R; dropped outside-L/R; dropped median-side-L/R; symmetric /
  asymmetric widen/narrow; centre appears / vanishes / changes width-material; edge appears /
  vanishes; asphalt↔concrete seam; width-only) × orientation (normal, mirrored, start/end frame) ×
  alignment (default, left-pinned, right-pinned, centre-pinned). ~120–140 canonical sections →
  ~700–1000 transition nodes after dedupe, packed into 20–40 fixtures.
- **Junctions (3–4 arm):** topology × through-classification × major section × minor section ×
  movement mask × material relationship × curvature, via **pairwise coverage + mandatory triples**
  (divided-major + median-break + centre-break; transition-through + 4-way crossing; merge-through +
  extra crossing arms; path attached to a continuing road; dead-corner carve). ~180–250 nodes, packed.

Invariants (asserted, never eyeballed):

- *Resolver:* every source strip resolved exactly once; node intervals ordered / non-overlapping /
  inside the plate span; **matched axes monotone & non-crossing** within a group (no twist); medians
  split groups and never merge opposite directions; born/dropped lanes explicit; **dash continues iff
  both axes continue, solid otherwise; yellow centre iff opposing pair; centre breaks iff a crossing
  movement exists**; movement overrides change classification, never strip vertices.
- *Geometry:* no NaN/Infinity; polygons simple, positive-area, hole-free after decomposition (the
  Earcut caveat is non-negotiable); every terminated strip ends square; no non-nose strip pinches
  below epsilon; **paired mouths meet vertex-for-vertex**; **roadway lies inside arm-body union +
  patch** (no stub); island/verge never floods a patch except explicit median continuation;
  **paint offset continuous through the morph (no jog)**; no stray same-layer slivers.

Harness architecture (two layers):

1. **Pure kernel tests (Bun):** the matcher only, plain inputs, asserted over the generated transition
   matrix. Fast, deterministic, CI-friendly.
2. **Integration harness (preview + Playwright):** authoritative, because `Segment` uses `$derived`
   (`lanesKey`/`totalWidth`) and the rune-shim is unfaithful. Generate packed fixtures, open
   `/?fixture=…&harness=lane`, expose a test-only page hook returning resolver output + geometry
   layers + paint paths via `page.evaluate()` (structured JSON, not console text), assert the invariants.

## Slice plan (harness first; each browser-verifiable, non-regressing)

1. **Harness.** Generator + coverage manifest + Playwright hook. Assert coverage accounting, no
   crashes/NaNs, polygon sanity, dump validity. Strict correspondence assertions written but **gated
   off** until the kernel lands (they flip on in slice 3).
2. **Pure kernel.** Extract the lane-axis matcher (carriageway groups, monotone match, born/dropped
   placement, alignment offset) + pure tests over the transition matrix.
3. **Geometry → kernel.** Wire `resolveNodeStrips` to the kernel for 2-arm transitions; `transitionMorph`
   + renderer inputs stay stable. Flip on the gated resolver assertions. → kills asphalt stubs /
   misplaced medians.
4. **Paint → kernel.** Move `buildPaint` + `buildNodePaint` onto the resolver's boundary continuity +
   style. → kills the turn-pocket dashed line and the dash jog.
5. **Junctions → swept-union.** Make "junction asphalt = union of connector ribbons" the explicit rule
   (junction pavement already uses movement for live/dead corners); add junction invariants.
6. **Alignment offset.** Data/fixture support first; editor affordance after the renderer is correct.
7. **Retire `scripts/node-resolution-check.ts`** — it preserves legacy comparisons, the opposite of the goal.

Per-slice verification: `bun run check` + `bun run test -- -g 'lane correspondence'`.

**Done = the whole generated matrix renders correctly from ONE model, with zero material-specific
geometry code and zero per-case marking branches.**

## Explicitly deferred (not this work)

- **Lane-runs / global routing graph (report Gaps 1 & 3)** — needed for *simulation*, not for render
  correctness. The alignment offset covers the render-side ambiguity.
- Editor UX for the alignment handle (slice 6 is data-first).
