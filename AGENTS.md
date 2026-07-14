# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Overview

自然语言意图式 SQL 构造器 — a zero-dependency, single-page web application that generates SQL from structured natural-language intent. No build tools, no frameworks, no backend. Open `index.html` directly in a browser.

## Files

- `index.html` — UI shell (three-panel layout: dictionary, intent builder, output)
- `styles.css` — All styles, CSS custom properties theming, responsive layout
- `assets/bip-data-dictionary-tutorial.png` — tutorial image for BIP dictionary paste import
- `app-main.js` — The entire application, IIFE-wrapped; it is referenced directly by `index.html`

## Architecture (app-main.js)

The code is organized into these layers, roughly in file order:

**Infrastructure** (top of file):
- `$` / `$$` — shorthand for `querySelector` / `querySelectorAll`
- `uid()` — random ID generator
- `clone()` — deep clone via JSON round-trip
- `q()` / `qref()` — SQL identifier quoting (backtick for MySQL-style)

**State management**:
- `state` — single mutable global object (dictionaries, intent, history, UI selections)
- `loadState()` — reads legacy localStorage only for one-time migration; it is not the active storage mechanism
- `saveState()` — schedules an automatic write to the connected local JSON configuration file
- `connectFileSync()` / `createFileSync()` / `restoreFileSyncOnBoot()` — mandatory File System Access API configuration-file workflow; a remembered file handle is retained in IndexedDB
- `normalizeState()` — migrates/repairs loaded state to current schema (version 2)
- `syncActiveDictionaryState()` — writes `state.dictionary` back into the active dictionary entry before save

**Data dictionary**:
- Dictionaries contain tables; tables contain fields (name, label, type, primary)
- `state.activeDictionaryId` — which dictionary is active
- `state.dictionary` — live reference to the active dictionary's tables array (synced before save)
- Field references throughout the intent use `table.field` string format

**Intent model**:
- `state.intent` — the current SQL construction intent
- Key fields: `action`, `baseTable`, `selectedFields`, `joins`, `condition` (tree), `aggregate`, `sort`, `limit`, `advanced`, `expert`
- Condition tree: recursive `{ type: "group" | "condition", logic: "AND"|"OR", children: [...] }` nodes

**Rendering**:
- `render()` — top-level re-render, calls all `render*()` sub-functions
- Each UI section has a dedicated `render*()` function (e.g., `renderDictionary()`, `renderBaseTable()`, `renderConditionTree()`)
- Rendering is full-refresh (not diffed); called after every state mutation

**SQL generation** (`generate()` → `generateIntentSql()`):
- `generateSelectSql()` — SELECT with JOINs, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT
- `generateInsertSql()` / `generateUpdateSql()` / `generateDeleteSql()` — mutation SQL
- `generateExpertSql()` — raw SQL passthrough
- `buildConditionSql()` — recursive condition tree → SQL WHERE clause
- `buildRisks()` / `buildExplanation()` — human-readable output companions
- Advanced mode: WITH (CTE), computed fields/CASE/window functions, HAVING, UNION
- Expert mode: DDL (CREATE/ALTER/DROP TABLE, CREATE INDEX, CREATE VIEW), transactions, GRANT/REVOKE, raw SQL

**Event handling**:
- `attachEvents()` — centralized event binding (delegation on container elements)
- `handleDictionaryClick()` / `handleConditionClick()` — event delegation handlers

**Import and history**:
- `parseBipDictionaryFormat()` — parses BIP data dictionary format from pasted text; the import entry is beside the active dictionary's `+表` action and opens a modal with a visual tutorial
- History is saved only by `recordHistory()` through the result-panel save button; the history modal provides SQL preview only and does not restore the saved intent

**Boot**: `boot()` calls `initElements()`, `attachEvents()`, then `render()`. IIFE auto-boots on DOMContentLoaded.

## Development

No build step. Edit files directly and open `index.html` in a browser to test. There are no tests, no linters, and no package.json.

### Key patterns to follow

- All state mutations go through dedicated functions that call `saveState()` + `render()` afterwards
- Table/field rename or delete must clean up references in the current intent (see `renameTableReferences()`, `sanitizeCurrentIntentForDictionary()`)
- New SQL generation features need updates to `buildExplanation()` and `buildRisks()` to keep the human-readable output accurate
- CSS uses custom properties defined in `:root`; avoid hardcoded colors

### Mode system

Three capability modes controlled by `state.mode`:
- `normal` — basic query, aggregate, insert, update, delete
- `advanced` — adds WITH, computed fields, HAVING, UNION
- `expert` — adds DDL, transactions, permissions, raw SQL

The mode gates which builder steps and UI controls are shown. See `renderBuilderSteps()` and `BUILDER_STEPS`.
