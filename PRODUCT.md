# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vanilla JS, no build step. Node 24 (`node:sqlite`, `node:http`, strips types directly), MCP over HTTP on loopback.

## Users

The founder: solo founder of ReddGrow, working across Claude Code, Codex, Cursor, Gemini CLI, and Claude Desktop. Cloud agents (Grok Bot, Meta Muse) are v2, not v1.

## Product Purpose

Muse Brain is a local "company brain": a typed knowledge graph (thought, action, rule, conclusion) that every AI agent in the company reads and writes through an MCP server, so decisions, their reasons, and their outcomes accumulate in one place instead of evaporating per session. A graph page at `http://127.0.0.1:4747` lets the founder watch, trace, and query that graph directly.

## Positioning

Not a memory log and not a generic knowledge base: every node is one of four closed kinds with enforced edges (thought motivated an action, action complies with a rule, conclusion evaluates an action or supports/refutes a thought), so the graph stays a legible reasoning chain rather than an unstructured dump. Guards and approved rules can constrain live agent actions; nothing else in the founder's stack does that.

## Operating Context

The graph page is the **Operate** surface: opened on purpose, minutes at a time, on a laptop in daylight or on a screen-share, to watch live agent activity, trace a decision's reasons and consequences, review what needs the founder's attention, or show the brain off. Agents consult the brain before acting (via MCP verbs and hooks) and log after real-world work.

## Capabilities and Constraints

Four node kinds only: thought, action, rule, conclusion. Company-wide or per-project scope. No delete verb; superseded/retired nodes are kept and faded. Guards can deny, ask, or allow a tool call; only approved rules are live. V1 is local-only (loopback); v2 adds cloud agent access.

## Brand Commitments

Direction round outcome: the category standard played straight (dark canvas, force-directed constellation, inspector at the side) with **Linear** as the quality bar. Single dark theme, committed (no light/dark swap). One reserved amber, meaning exactly "waiting on you." Anti-goals: glow, gradients, 3D, HUD ornaments, numbered eyebrows, cards inside cards, a second accent. No em-dashes anywhere in copy.

## Evidence on Hand

Built page at `public/index.html`; direction and UI contract recorded in `docs/design.md`; finish-review screenshots at `.impeccable/review/desktop.png` and `laptop.png`.

## Product Principles

- Every visual signal encodes a fact; nothing is decoration.
- The brain is thin: no model in the commit path, ever.
- One committed world, executed straight, no smuggled quirk.
- Beauty in service of reading, not display.

## Accessibility & Inclusion

Keyboard reaches everything the mouse does (`/` or `⌘K` to ask, arrow keys to walk a trace, `⌘⇧T` for an accessible table view of loaded nodes). Focus rings visible. `prefers-reduced-motion` disables all animation. Kind colors are colorblind-validated on the dark surface.
