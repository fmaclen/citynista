# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Citynista is a web-based city planning tool prototype focused on drawing street networks, defining zoning, and rendering in a low-fidelity 2D/3D environment. The project prioritizes a snappy experience with flat shading and simple graphics over high-fidelity rendering.

## Development Commands

- **Start dev server**: `bun run dev` (runs Vite dev server with HMR)
- **Build for production**: `bun run build`
- **Preview production build**: `bun run preview`
- **Type check**: `bun x tsc --noEmit`

## Technology Stack

- **Runtime**: Bun (preferred over Node.js)
- **Build tool**: Vite (for dev server and bundling)
- **Language**: TypeScript (strict mode enabled)
- **Canvas library**: Fabric.js 6.7+ for vector-based drawing and interactive canvas manipulation

## Architecture

The application is currently a single-page canvas interface:

- **Entry point**: `index.html` loads `main.ts` as a module
- **Main canvas**: `main.ts` initializes a Fabric.js canvas that fills the viewport
- **Drawing interaction**: Click-and-drag creates road segments (Line objects)
- **State management**: Simple module-level state for tracking drawing mode and current line

### Key Design Patterns

1. **Event-driven drawing**: Fabric.js canvas events (`mouse:down`, `mouse:move`, `mouse:up`) handle user interaction
2. **Viewport coordinates**: Use `options.viewportPoint` from `TPointerEventInfo` for pointer positions (not deprecated `absolutePointer` or `canvas.getPointer()`)
3. **Responsive canvas**: Window resize listener updates canvas dimensions dynamically

## TypeScript Configuration

The project uses **strict TypeScript** with all strict flags enabled:

- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noPropertyAccessFromIndexSignature: true`
- `noUncheckedIndexedAccess: true`

All code must pass strict type checking.

## Fabric.js Usage Notes

- Import types from `fabric` (e.g., `TPointerEventInfo`)
- Use `options.viewportPoint` for current pointer coordinates in event handlers
- Objects created with `selectable: false` and `evented: false` are non-interactive
- Roads are currently implemented as `Line` objects with rounded caps (`strokeLineCap: 'round'`)

## Future Direction

The codebase is designed to eventually support:

- Node-based street editing (moving/bending segments)
- Zoning definition and area painting between roads
- 3D rendering (likely without heavy game engines, using web-native 3D tools)
