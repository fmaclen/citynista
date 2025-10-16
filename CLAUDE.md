# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Citynista is a web-based city planning tool prototype focused on drawing street networks, defining zoning, and rendering in a low-fidelity 2D environment. The project prioritizes a snappy experience with flat shading and simple graphics over high-fidelity rendering.

## Tech Stack

- **Framework**: SvelteKit with Svelte 5 (using runes: `$state`, `$effect`, `$derived`)
- **Runtime**: Bun (use `bun` commands, not `npm` or `node`)
- **Canvas Library**: Fabric.js for 2D canvas rendering
- **Styling**: Tailwind CSS v4
- **UI Components**: bits-ui, shadcn-svelte components

## Development Commands

- **Start dev server**: `bun run dev` (runs Vite dev server with HMR)
- **Build for production**: `bun run build`
- **Preview production build**: `bun run preview`
- **Type check**: `bun run check`
- **Lint & format**: `bun run quality` (runs format, lint, and check)
- **Format code**: `bun run format`
- **Lint code**: `bun run lint`
- **E2E tests**: `bun run test` | `bun run test -- -g 'partial name of test'`

## Architecture

### Core State Management

The application uses Svelte 5's reactive primitives (`$state`, `$effect`, `$derived`) for state management. State is organized into three main classes:

1. **Editor** (`src/lib/editor.svelte.ts`): Top-level controller
   - Manages the canvas and graph instances
   - Handles mode switching (draw, select)
   - Tracks selection state (selectedSegments, selectedNodes)
   - Sets up event handlers for current mode
   - Provides context via `setEditorContext()` / `getEditorContext()`

2. **Graph** (`src/lib/graph.svelte.ts`): Data model
   - Stores nodes and segments using `SvelteMap<string, Node>` and `SvelteMap<string, Segment>`
   - Auto-saves to localStorage on any change via `$effect`
   - Manages node/segment lifecycle (add, delete, cleanup)
   - Serializes/deserializes graph data

3. **Node & Segment** (`src/lib/node.svelte.ts`, `src/lib/segment.svelte.ts`): Graph primitives
   - Node: Represents intersection points with x/y coordinates and connected segments
   - Segment: Represents road segments between nodes with quadratic bezier curves (controlX, controlY)
   - Both use `$state` for reactive properties and auto-render on change

### Mode System

Modes are implemented as separate modules in `src/lib/modes/`:

- **draw.ts**: Click-to-draw road segments with snapping to existing nodes
- **select.ts**: Select, drag nodes/segments, move bezier control points, delete with Delete/Backspace

Each mode returns a `ModeHandlers` object with `onMouseDown`, `onMouseMove`, `onMouseUp`, `onKeyDown`, and `cleanup` functions.

### Reactivity Patterns

- **Auto-save**: Graph uses `$effect` to watch nodes/segments size and positions, triggering save to localStorage
- **Auto-render**: Node and Segment classes use `$effect` in Graph to detect changes and redraw
- **Derived paths**: Segment uses `$derived.by` to update path geometry when nodes or control points move
- **Selection state**: Segment handles visibility (show/hide) based on `isSelected` via `$effect` in Graph

### Canvas Rendering

- Fabric.js objects (Circle, Path) are stored as properties on Node/Segment instances
- Graph holds reference to canvas and passes it to nodes/segments on creation
- Cleanup is managed explicitly (remove Fabric objects before deleting from maps)

### OSM Import

- `src/lib/osm/import.ts`: Fetches and parses OpenStreetMap data
- `src/lib/osm/import-to-graph.ts`: Converts OSM ways to graph nodes/segments
- Supports loading real street networks from OSM XML data

## Testing Guidelines

- **Never use `waitForTimeout()` in tests** - rely on Playwright's default timeouts and auto-waiting
- Use positive and negative assertions to wait for things (e.g., `await expect(element).toBeVisible()`, `await expect(element).not.toBeVisible()`)
- Playwright automatically waits for elements to be actionable before performing actions

## LLM Instructions

- never run the dev server, assume the user is already running the dev server
- always use strict typesafety, never use any, don't add return types, always rely on inference
- use Svelte 5 runes (`$state`, `$effect`, `$derived`) instead of legacy reactivity
- use `SvelteMap` and `SvelteSet` from 'svelte/reactivity' for reactive collections
