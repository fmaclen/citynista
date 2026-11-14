# Backlog

Running list of decisions, open questions, and side-quests spawned while
building the road/junction/connector model. Lightweight on purpose — promote any
of these to GitHub issues if/when we want them tracked there.

Status key: **now** (in progress) · **next** (agreed, queued) · **later**
(parked) · **idea** (unvalidated).

## Connector tool

- **later** — Re-enabling a blocked movement is "drag the same pair again."
  Revisit if it feels unclear.
- **later** — Fallback if drag still confuses: TM:PE-style click-source-then-
  click-targets.

## Overlays (general)

- **next** — Apply the hover convention (blue + slight scale + grab cursor) to
  **setback handles** and any other overlay, not just connector dots.

## Junctions / geometry

- **next** — #213: break the solid centerline at a node when a connection
  actually crosses the opposing flow (it's functionally an intersection there).
  Check first whether the line cutting in `road-model/node.ts` already does
  this; no test covers it.
- **later** — #214: converting a lane type live (e.g. sidewalk→road to draw a
  slip lane) didn't regenerate crosswalks / fully recompute. Check first
  whether it still happens: lane edits now go through the same rebuild as a
  fresh load, and no test covers it.

- **later** — The diagonal avenue's 5–6-arm crossings render as big asphalt
  blobs; they really want traffic circles.
- **later** — Materials: a per-junction paving override from a menu. Today a
  junction is paved in the material that carries the most car-lane width
  across its arms.

## Known drawing bugs

Each is left out of `bun run test:jitter` (the `KNOWN` and `WALKS` lists in
`unit/jitter.ts`) or was found by review; fixing one means dropping its
exclusion.

- **later** — `footpaths`: where a footpath crosses a street through a node
  (the arc at rest, or the bend moved 5 m north or south), a wedge of ground
  up to 2 cm wide and over half a metre long opens between the path's end and
  the crossing's sidewalk.
- **later** — `junction-materials`: with `tee` nudged south, or `tee-e` or
  `tee-w` nudged north, the lines of `tee-west` and `tee-east` cross `tee`'s.
- **later** — Neighbourhood example at rest: a sidewalk spike at (192.2, 60.9).
- **later** — Neighbourhood example, its spread sample of nodes moved 5 m
  east or west: two arms of one junction swing together and lie over each
  other short of it, sidewalk, verge and a hair of lane (`segment-284` and
  `segment-285` east, `segment-380` and `segment-451` west, whose lines cross
  too, and `segment-289` and `segment-293` sidewalk). Moved west,
  `segment-380` and `segment-451` also lie over a sliver of `node-181`'s
  paving.
- **later** — Neighbourhood example, the same moves: at `node-137` and
  `node-184` a wedge of ground up to 4 cm wide opens between a road's
  sidewalk and the corner sidewalk.
- **later** — `tight-junction`: with `b` or `c` moved 5 m north or south, the
  merged junction's own lines cross.
- **later** — `tight-bend`: with `a` or `b` moved toward the other, tightening
  the hairpin, the sidewalk on the inside of the fold lies over the far lanes
  and their paint.
- **later** — Bends sharper than about 155° make the two roads overlap: the
  bend setback stops growing at `TAPER.SHARPEST`.
- **later** — `short-footpath`, its junction walked into its neighbour: nearing
  the merge, the footpath's sidewalk runs over asphalt and paint lands on it;
  in the last half metre before the two draw as one, the sidewalk carried
  across `t` lies over `j`'s corner sidewalk, by up to 1.1 m².
- **later** — `offset`, its junction walked into its neighbour: nearing the
  merge, sidewalk runs over asphalt and `w1j1`'s lines cross `j1`'s; in the
  last 1.5 m before `j1` and `j2` draw as one, their corner sidewalks lie over
  each other.
- **later** — `off-ramp`, its junction walked toward its neighbour: one frame
  paints on grass.
- **later** — A few attached ramps whose curve is pulled across or behind the
  host road connect to a worse lane than before the one-pass `PlaceBuilder`.

## Next projects

- **next** — Corner sidewalks built from curb runs instead of polygon
  clipping. They are most of a junction's drawing time (a drag frame on the
  example's busiest node is about 77 ms) and the source of the sidewalk
  spikes, wedges and overlaps above; with them out of `road-model/node.ts`,
  the node drawer's two paths could merge further.
- **idea** — Pedestrian lanes need a pass of their own: how they connect,
  end and cross does not work well yet. Until then they connect only where
  the user makes the connection (see `docs/road-model.md`, attached roads).
- **idea** — The graph as plain data with one change counter instead of
  Svelte rune classes. Only the lane panel and one toolbar button need the
  reactivity, tests fake the graph with casts, and the example city has to be
  rebuilt by a script that drives a browser.
- **idea** — Before cities are stored for other people: migrate a city of an
  older schema version instead of dropping it, and make saving asynchronous
  (about twenty call sites assume it is instant).
- **idea** — Curb and boundary ownership in the description, for 3D: which
  edges are real curbs and which are only where a surface was sliced.
- **idea** — A lane graph for vehicles. Lane paths through nodes are in the
  description, tied to their connections, but nothing joins them with the
  roads' lanes into one network, and two-way lanes have no path across a
  two-road node.
