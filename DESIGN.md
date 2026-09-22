---
name: Muse Brain
description: Dark, keyboard-first constellation view of the company's reasoning graph.
colors:
  ground: "#0e0e10"
  canvas: "#121215"
  panel: "#17171b"
  hairline: "rgba(255,255,255,.08)"
  hairline-strong: "rgba(255,255,255,.16)"
  ink-1: "#ededef"
  ink-2: "#9a9aa3"
  ink-3: "#5c5c66"
  thought: "#3987e5"
  action: "#008300"
  rule: "#d55181"
  conclusion: "#c98500"
  amber: "#f5b342"
  red: "#ef6a62"
  edge: "#3a3a41"
  edge-hot: "#9a9aa3"
typography:
  title: { fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, sans-serif", fontSize: "14px", fontWeight: 600, lineHeight: 1.35 }
  body: { fontFamily: "{typography.title.fontFamily}", fontSize: "13px", fontWeight: 400, lineHeight: 1.45 }
  label: { fontFamily: "{typography.title.fontFamily}", fontSize: "11px", fontWeight: 600 }
  mono: { fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace", fontSize: "12px", fontVariation: "tabular-nums" }
rounded: { xs: "4px", md: "6px", lg: "8px" }
spacing: { xs: "4px", sm: "6px", md: "8px", base: "10px", lg: "12px", xl: "16px" }
components:
  chip: { backgroundColor: "transparent", textColor: "{colors.ink-2}", rounded: "{rounded.md}", padding: "4px 8px" }
  chip-active: { backgroundColor: "rgba(255,255,255,.04)", textColor: "{colors.ink-1}", rounded: "{rounded.md}", padding: "4px 8px" }
  copy-btn: { backgroundColor: "transparent", textColor: "{colors.ink-2}", rounded: "{rounded.xs}", padding: "2px 6px" }
---

# Design System: Muse Brain

## Overview

**Creative North Star: "The Category Standard, Played Straight"**

Dark canvas, force-directed constellation, inspector at the side, executed to Linear's finish: precise, quiet, keyboard-first, every visual signal encoding a fact. No irony, no smuggled quirk. The rut it refuses is neon glow soup where nothing means anything.

**Key Characteristics:** single committed dark theme, no theme swap; a four-shape kind vocabulary carrying meaning through form and color together; mono reserved strictly for anything citable (ids, timestamps, agents); flat surfaces, no ambient shadow; one signal color (amber) for "waiting on you."

## Colors

### Primary (kind vocabulary)
- **Thought** (`#3987e5`, circle)
- **Action** (`#008300`, square)
- **Rule** (`#d55181`, hexagon)
- **Conclusion** (`#c98500`, triangle, `+`/`-`/`~` verdict glyph inside)

### Secondary (signal)
- **Amber** (`#f5b342`): means exactly "waiting on you": proposed rules, actions stale 14+ days, shadow-mode guard asks.
- **Red** (`#ef6a62`): guard denials only.

### Neutral
- **Ground** (`#0e0e10`) / **Canvas** (`#121215`) / **Panel** (`#17171b`): three flat surface tones, darkest to lightest.
- **Ink-1** (`#ededef`) primary text, **Ink-2** (`#9a9aa3`) secondary, **Ink-3** (`#5c5c66`) tertiary/idle.
- **Hairline** (`rgba(255,255,255,.08)`) resting borders, **Hairline-strong** (`rgba(255,255,255,.16)`) hover/active borders.
- **Edge** (`#3a3a41`) resting graph edges, **Edge-hot** (`#9a9aa3`) traced edges.

### Named Rules
**The One World Rule.** Single dark theme, painted explicitly (`color-scheme: dark`), never a `prefers-color-scheme` swap.
**The One Signal Rule.** Amber is the only color that means "waiting on you." Nothing else borrows it.

## Typography

**UI Font:** system stack (`-apple-system, BlinkMacSystemFont`, Inter as unloaded fallback, `Segoe UI`, sans-serif).
**Mono Font:** JetBrains Mono (loaded from Google Fonts), `ui-monospace`/Menlo fallback, tabular numerals wherever numbers align.

**Character:** quiet system UI for chrome; mono is reserved, never decorative, so anything citable looks distinct from prose.

### Hierarchy
- **Title** (600, 14px, 1.35): Inspector node title, the only bold display-weight text in the UI.
- **Body** (400, 13px, 1.45): base UI text, need-row titles, panel copy.
- **Label** (600, 11px, uppercase for section labels): chip labels, panel heads, insp-sub headers.
- **Mono** (400/500, 10-12.5px depending on context, tabular): ids, timestamps, agent names, activity strip; canvas-drawn node ids (10px passive, 12px Present) and node titles (11px, shown only when hot or zoomed past `TITLE_ZOOM`).

### Named Rules
**The Mono-Means-Citable Rule.** If it is an id, a timestamp, an agent name, or a number meant to line up, it is mono. Nothing else is.

## Layout

Three-row shell: 44px top bar, flexible main row (canvas + 360px right column), 28px activity strip. The right column stacks Needs-you (capped 46% height, own scroll) over Inspector (fills the rest). Present mode collapses to canvas-only by hiding the right column and the strip. Spacing is a loose fine scale, not a strict grid: real values in use are 2, 4, 6, 8, 9, 10, 12, 14, 16, 18px depending on component.

## Elevation & Depth

Flat by commitment. No box-shadow anywhere except the two true overlays: the command palette (`0 16px 44px rgba(0,0,0,.5)` over a `rgba(0,0,0,.55)` scrim) and the table view (`rgba(0,0,0,.6)` scrim, no card shadow). Depth otherwise reads through the three flat surface tones and hairline borders, never shadow.

### Named Rules
**The Flat-at-Rest Rule.** Surfaces are flat. A shadow appears only under the palette and the table overlay; nothing else lifts.

## Shapes

6px radius (`--radius`) on chips, the segmented control, selects, the Present toggle, and need-rows. 4px on smaller controls (copy-btn, conn-row, kbd-hint, focus ring, scrollbar thumb). 8px on the two floating overlays (palette, table card). Hairline 1px borders throughout; hover swaps `--hair` for `--hair-strong`, never adds a shadow or a second border. Circles are reserved for the thought glyph; no pill-shaped UI chrome.

## Components

### Top bar
44px, panel background, bottom hairline. Wordmark left; center cluster (kind chips, range segmented control, project select); right cluster (live dot + text, Present toggle, "/ ask" hint).

### Chips (kind filter)
Glyph + label, hairline border, 6px radius. Pressed (`aria-pressed=true`): ink-1 text, hair-strong border, faint white fill. Filtered-off: 45% opacity.

### Segmented control
Time range (24h / 7d / 30d / all, default 30d). Hairline dividers between buttons; the active segment gets a faint white fill and ink-1 text.

### Needs-you rows
Amber count in the panel head. Each row: hairline border, 6px radius, title clamped to 2 lines. Three row kinds: proposed rule (amber "approve rule N" phrase + Copy button), stale action (ink-2 "Nd without an outcome"), guard event (decision word colored red/amber/ink-2 for deny/ask/allow, plus relative time).

### Inspector
Glyph + kind + mono id + optional state pill, 14px/600 title, a definition list of fields (Why, Rejected, Evidence, Files, Agent, Created, Approved, Rev), then Outgoing/Incoming connections as clickable rows. Empty state: "Select a node, or press / to ask."

### Activity strip
28px, mono, one line per event ("agent · text · relative-time"), newest first. Idle: "Waiting for activity…" in ink-3.

### Command palette
`⌘K` or `/`. Centered overlay, 560px, dark scrim, top input, optional amber note row (Jev-off notice), scrollable result rows (glyph + title + mono score). Arrow keys move selection; Enter traces the selection or runs `ask`; typing `#N` jumps directly.

### Table view
`⌘⇧T`. Centered card overlay (max 1100px) with a close button and a plain HTML table of loaded nodes (id, kind, title, state, project, agent, created). The accessible fallback to the canvas.

### Present mode
Hides the right column and activity strip; glyph radius scales 1.5x; node ids render at 12px instead of 10px; titles always show instead of only on hover/zoom/trace.

### Graph canvas (signature component)
Force-directed, drawn on `<canvas>` via `force-graph`. Node glyph by kind (circle/square/hexagon/triangle); hollow with kind-colored stroke for open/proposed status; 34% opacity for retired/refuted; dashed stroke for a proposed rule. A 240ms ease-out-cubic scale-in plus a kind-colored ring marks every arrival and every status flip. `TITLE_ZOOM = 2.2`: node titles stay hidden until hover, selection, trace, or zoom scale exceeds this. Edges are `--edge` at 1px normally; a traced 2-hop chain brightens to `--edge-hot` at 1.6px, gains its type label, and every non-chain node/edge drops to 18% opacity.

### States and keyboard
Empty: "Nothing logged yet." plus three ways to start (connect an agent, log from chat, seed the demo story). Reconnecting: live dot turns ink-3 gray, text reads "reconnecting," last data stays on screen. Jev off: palette shows an amber note ("Meaning search off, showing text matches") and falls back to plain search. Keyboard: `/` or `⌘K` open the palette, `#N` jumps to a node, `←`/`→` walk a trace's cause/effect chain, `Esc` clears a trace or closes an overlay, `⌘⇧T` opens the accessible table view.

## Do's and Don'ts

### Do:
- **Do** reserve amber (`#f5b342`) exclusively for "waiting on you."
- **Do** keep mono strictly for ids, timestamps, and agent names.
- **Do** let the four kind glyphs carry meaning through shape and color together, never color alone.
- **Do** respect `prefers-reduced-motion` by disabling every animation and transition.

### Don't:
- **Don't** add glow, gradients, 3D, or HUD ornaments.
- **Don't** use numbered eyebrows or cards inside cards.
- **Don't** introduce a second accent color beyond amber.
- **Don't** add a light theme or a `prefers-color-scheme` swap; dark is committed, not a default.
- **Don't** use em-dashes anywhere in copy.
