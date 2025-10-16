# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Citynista is a web-based city planning tool prototype focused on drawing street networks, defining zoning, and rendering in a low-fidelity 2D/3D environment. The project prioritizes a snappy experience with flat shading and simple graphics over high-fidelity rendering.

## Development Commands

- **Start dev server**: `bun run dev` (runs Vite dev server with HMR)
- **Build for production**: `bun run build`
- **Preview production build**: `bun run preview`
- **Type check**: `bun x tsc --noEmit`

## LLM Instructions

- never run the dev server, assume the user is already running the dev server
- always use strict typesafety, never use any, don't add return types, always rely on inference
