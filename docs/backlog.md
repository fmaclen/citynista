# Backlog

Running list of decisions, open questions, and side-quests spawned while
building the road/junction/connector model. Lightweight on purpose — promote any
of these to GitHub issues if/when we want them tracked there.

Status key: **now** (in progress) · **next** (agreed, queued) · **later**
(parked) · **idea** (unvalidated).

## Connector tool

- **now** — Editor-overlay lines (connector arcs, setback stems, bezier guides)
  are hairlines, easily confused with road markings. Make them ~half a dot wide
  and **dashed**, so "editor mode" is unmistakable. Doing connector arcs first;
  apply the same to setback/bezier after.
- **now** — Disabled connector arcs → white at 50% opacity so they recede into
  whatever's underneath.
- **now** — Modality (#217): in connector mode, nothing else should hover or
  select; exit only via Esc or clicking empty ground.
- **later** — Re-enabling a blocked movement is "drag the same pair again"
  (absence of an arc = blocked). Revisit if it feels unclear.
- **later** — Fallback if drag model keeps confusing: switch to TM:PE-style
  click-source-then-click-targets.

## Overlays (general)

- **next** — Apply the hover convention (blue + slight scale + grab cursor) to
  **setback handles** and any other overlay, not just connector dots.
- **next** — Same thick/dashed editor-line styling for setback stems and the
  bezier curvature guides.
- **idea** — Overlay handles are sized in world units, so they balloon when
  zoomed in. Consider constant screen-pixel sizing for all handles/dots.

## Junctions / geometry

- **next** — #213: break the solid centerline at a node when a connection
  actually crosses the opposing flow (it's functionally an intersection there).
  Connection-aware paint rule; leans on the connector data. Agreed to do after
  the current connector behavior is ironed out.
- **later** — Dead-corner carve is subtle on a plain 4-way (just drops the
  corner fillet). Make it more pronounced if we want carving to read stronger.
- **later** — The diagonal avenue's 5–6-arm crossings render as big asphalt
  blobs; they really want traffic circles.
- **closed** — #209 crosswalk-vs-setback decoupling: Winston said the current
  flanked-crosswalk behavior is fine as-is.

## Lanes — bigger rethink

- **later** — #214: converting a lane type live (e.g. sidewalk→road to draw a
  slip lane) didn't regenerate crosswalks / fully recompute. On fresh load it's
  clean, so it's a live-edit rebuild-invalidation gap.
- **later** — #216: the lane-type list mixes **use** (sidewalk, road, bike,
  parking, transit, turn, median) with **material** (concrete) and surface
  (grass). Rethink: a lane has a _use_ and a _material_ independently, instead of
  one conflated type. Connects to the materials direction below. Separate stage.
- **later** — Materials: per-lane material (asphalt/concrete/cobble/tile,
  shared road+pedestrian), junction inherits the dominant carriageway material
  by default with a per-junction texture override from a menu later.

## Infra

- **later** — Undo silently no-ops because `graph.save()` swallows a
  localStorage QuotaExceededError (Winston's `localhost:5173` is shared across
  many Svelte projects). Fixes: record history even if `setItem` fails; surface
  the error; give this project its own dev port.
