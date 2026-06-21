# Lane-centric road model (rebuild in progress)

Pivot from "a segment owns one rigid cross-section" to lanes as first-class,
with explicit connectivity at nodes. Winston's vision (TM:PE lane connectors +
his "Urbanfront" detachable lanes). Keep the bundle/preset as the default; add
identity, connectivity, and detachment.

## Core ideas

1. **Bundle (preset).** A road is still drawn as a bundle of parallel lanes —
   today's cross-section. Common case, unchanged to draw.
2. **Lane identity.** Each lane in a segment is addressable: `{segmentId, laneIndex}`.
3. **Connectivity at a node (TM:PE).** A node stores which incoming lane feeds
   which outgoing lane: a set of `{from:{seg,lane}, to:{seg,lane}}`. Default
   connections are computed; the user can override (restrict/add).
   - A **turn lane** is then just a regular lane whose only connections route to
     the cross street. No `turn` lane type.
4. **Detachment (Urbanfront).** A lane can be peeled out of the bundle onto its
   own path. (Later phase.)

## What derives from connectivity (instead of being inferred)

- **Geometry:** lanes curve through the node along their connections; the road
  surface fills between them; a lane that doesn't continue across the node
  **tapers automatically** — full at the node, closing a controllable distance
  _back_ from it (per-node drag handle, his #193). See [[transition-approach-distance]].
- **Markings:** dashed where a lane change is allowed (you can reach the next
  lane), solid where not. Fixes #189 (solid line made the pocket unreachable).
  Turn arrows come from the movements a lane's connections cover.
- **Crosswalks:** per-mouth, click to toggle (decoupled — #187 dropped).

## What we keep / drop / rebuild

- **Keep:** ribbon strips, the taper rendering primitive, Clipper, markings
  logic, the bundle/preset cross-section default.
- **Drop:** the `turn` lane type; "segment owns one rigid cross-section" as the
  only representation; the manual taper toggle (taper is automatic).
- **Rebuild:** node geometry + markings derive from connections; the connector
  editing UI; lane detachment.

## Slice plan (small, browser-verified)

1. **Connection data + endpoints** — DONE. `lane-connections.ts`: each travel
   lane's endpoint at a node (position, in/out flow) + permissive default
   connections. Lanes addressable as `{segmentId, laneIndex}` (types.ts).
2. **Visualize** — DONE. `connection-renderer.ts` draws the movements as bezier
   arcs when a single node is selected (bright = allowed, faint = disabled).
3. **Edit** — DONE. A node stores `disabledConnections`; clicking a connector
   toggles it (click vs drag distinguished — a drag still moves the node), and
   it persists. Reachability: connectors live inside the node ring, so editing
   is click-to-toggle on the selected junction, not a separate tool yet. A
   dedicated connector MODE (TM:PE-style) is the eventual UX if this feels off.
4. **Derive markings** (dashed/solid + arrows) from connections; retire the
   `turn` type. ← NEXT. Risky: arrows/markings live in the fragile road-renderer
   paint path and would need the downstream node's connections threaded in + the
   segment hash extended. Needs browser iteration — do with Winston watching.
5. **Derive geometry**: lanes curve through the node along connections;
   auto-taper for non-continuing lanes + the per-node distance handle (#193).
6. **Detachment** (later) — peel a lane onto its own path.
