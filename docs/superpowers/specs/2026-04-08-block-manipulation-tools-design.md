# AFFiNE MCP Server — 10 Block Manipulation Tools

**Date:** 2026-04-08
**Status:** Approved
**Approach:** Hybrid (Approach C) — internal helpers + tools at end of docs.ts

## Problem

The current AFFiNE MCP toolset has no way to surgically edit sections of a document without replacing the entire document content. `replace_doc_with_markdown` destroys non-markdown blocks (embedded linked docs, databases), and `find_and_replace` only works for small text substitutions. We need block-level manipulation — reading, inserting, deleting, moving, and replacing content at specific positions while preserving blocks we don't want to touch.

## Architecture

### Approach

All 8 new block tools and 2 tool extensions are added to the existing `registerDocTools` closure in `src/tools/docs.ts`. `batch_resolve_comments` is added to `src/tools/comments.ts`. No refactoring of existing code — new helpers and tools are appended.

### Assumption

`findSectionRange` assumes headings are direct children of the note block, not nested inside other blocks. This is correct for standard AFFiNE document structure (page → note → content blocks).

### File Changes

| File | Change |
|------|--------|
| `src/tools/docs.ts` | Add 4 internal helpers + 6 new tools + 2 tool extensions (~1,100 lines) |
| `src/tools/comments.ts` | Add `batch_resolve_comments` tool (~50 lines) |
| `tests/test-block-tools.mjs` | New E2E test suite for all 10 tools |

## Internal Helper Primitives

These 4 functions are internal to the `registerDocTools` closure, placed after `collectDescendantBlockIds` (~line 1901). They mutate Y.Doc in place — the caller owns the WebSocket lifecycle and delta push.

### `deleteBlocksFromTree(blocks, blockIds)`

```typescript
function deleteBlocksFromTree(
  blocks: Y.Map<any>,
  blockIds: string[]
): { deleted: string[]; notFound: string[] }
```

For each blockId:
1. If block doesn't exist in blocks map → add to `notFound`, skip
2. Collect all descendants via `collectDescendantBlockIds([blockId])`
3. Find parent via `findParentIdByChild`, remove blockId from parent's `sys:children` Y.Array
4. Delete block and all descendants from blocks Y.Map

### `walkBlockTree(blocks, startIds, opts?)`

```typescript
function walkBlockTree(
  blocks: Y.Map<any>,
  startIds: string[],
  opts?: { maxDepth?: number; blockTypes?: string[]; textPreviewLength?: number }
): BlockInfo[]
```

DFS traversal. For each block:
- Extract id, type (reverse-mapped from AFFiNE flavour), text preview (first N chars), depth, childCount, parentId
- Filter by `blockTypes` if specified (still traverse children to find deeper matches)
- Respect `maxDepth` limit

Type mapping: `affine:paragraph` + `prop:type=h1` → `"heading"`, `affine:list` → `"list"`, etc. Reverse of `normalizeBlockTypeInput`.

### `findSectionRange(blocks, headingBlockId)`

```typescript
function findSectionRange(
  blocks: Y.Map<any>,
  headingBlockId: string
): { headingBlock: Y.Map<any>; headingLevel: number; contentBlockIds: string[]; nextHeadingId: string | null }
```

1. Verify block exists and is a heading — error if not
2. Determine heading level (1-6)
3. Find parent (note block), walk `sys:children` after the heading
4. Collect block IDs until hitting a heading of same or higher level (lower number), or end of children
5. Nested headings (`### Subsection` under `## Section`) are included in the range

### `getBlockInfo(blocks, blockId, depth?)`

```typescript
function getBlockInfo(
  blocks: Y.Map<any>,
  blockId: string,
  depth?: number
): { id: string; type: string; textPreview: string; depth: number; childCount: number; parentId: string | null }
```

Reads a single block's metadata. Maps AFFiNE flavour to human-readable type name. Used by `walkBlockTree` and `find_blocks`.

## Tool Designs

### Tool 1: `delete_blocks`

Remove one or more blocks and their subtrees by block ID.

**Schema:**
- `docId` (string, required)
- `blockIds` (string[], required, min 1)
- `workspaceId` (string, optional)

**Flow:** WebSocket lifecycle → `deleteBlocksFromTree(blocks, blockIds)` → delta push

**Return:** `{ deleted: string[], notFound: string[] }`

Non-existent block IDs appear in `notFound`, no error.

---

### Tool 2: `insert_markdown`

Insert markdown content at a specific position. Like `append_markdown` with positional control.

**Schema:**
- `docId` (string, required)
- `markdown` (string, required, min 1)
- `placement` (object, required) — exactly one of `afterBlockId`, `beforeBlockId`, or `parentId` (with optional `index`)
- `workspaceId` (string, optional)

**Flow:**
1. Validate placement — exactly one of `afterBlockId`, `beforeBlockId`, or `parentId` must be provided. This is validated in the handler (not at Zod schema level, matching existing `resolveInsertContext` pattern). Error with clear message if none or multiple are set.
2. Parse markdown via `parseMarkdownToOperations`
3. Iterate operations: first uses user's placement, subsequent use `{ afterBlockId: lastInsertedBlockId }`
4. Single atomic delta push at end (not per-block)

**Return:** `{ insertedBlockIds: string[], stats: { parsedBlocks: number, appliedBlocks: number } }`

---

### Tool 3: `replace_section`

Replace all content under a heading until the next heading of same or higher level.

**Schema:**
- `docId` (string, required)
- `headingBlockId` (string, required)
- `markdown` (string, required) — body content; if `includeHeading=true`, first line must be a heading
- `includeHeading` (boolean, optional, default false)
- `workspaceId` (string, optional)

**Flow:**
1. `findSectionRange(blocks, headingBlockId)` → get content block IDs
2. `deleteBlocksFromTree(blocks, contentBlockIds)` → remove old content
3. If `includeHeading: true`: parse markdown, first operation must be a heading type — error if not ("markdown must start with a heading line when includeHeading is true"). Use first heading operation to update existing heading block's `prop:text` and `prop:type` in place. Remaining operations become body.
4. If `includeHeading: false`: all operations are body content.
5. Insert body operations at `{ afterBlockId: headingBlockId }`, sequential chaining
6. Single delta push

**Return:** `{ deletedBlockCount, insertedBlockCount, sectionRange: { from: headingBlockId, to: nextHeadingId | null } }`

---

### Tool 4: `move_block`

Move a block and its subtree to a new position within the same document.

**Schema:**
- `docId` (string, required)
- `blockId` (string, required)
- `placement` (object, required) — same as `insert_markdown`
- `workspaceId` (string, optional)

**Flow:**
1. Record original position (parentId + index)
2. Remove blockId from current parent's `sys:children` (reference only — don't delete from blocks map)
3. Resolve new placement via `resolveInsertContext` (after removal, so indices are correct)
4. Insert blockId into new parent's `sys:children` at resolved index
5. No-op detection: if from and to are identical, skip delta push

**Return:** `{ moved: true, blockId, from: { parentId, index }, to: { parentId, index } }`

---

### Tool 5: `list_blocks`

Return a lightweight block tree with IDs, types, and text previews.

**Schema:**
- `docId` (string, required)
- `maxDepth` (number, optional)
- `blockTypes` (string[], optional)
- `textPreviewLength` (number, optional, default 80)
- `workspaceId` (string, optional)

**Flow:** Read-only. Load doc → find root (`affine:page`) → `walkBlockTree(blocks, rootChildIds, opts)` → return. No delta push.

**Return:** `{ blocks: BlockInfo[], totalCount: number }`

---

### Tool 6: `update_block`

Update a single block's text, type, or properties in place.

**Schema:**
- `docId` (string, required)
- `blockId` (string, required)
- `text` (string, optional)
- `type` (string, optional) — restricted to text-like family: paragraph, heading, quote, code, list, todo
- `level` (number, 1-6, optional) — only for headings
- `language` (string, optional) — only for code blocks
- `checked` (boolean, optional) — only for todo list items
- `workspaceId` (string, optional)

**Flow:**
1. Find block — error if not found
2. Apply only provided fields:
   - `text`: mutate existing `prop:text` Y.Text (delete + insert, preserve object identity)
   - `type`: change `prop:type`, update `sys:flavour` + `sys:version` if flavour changes
   - `level`: set `prop:type` to `h1`-`h6` — error if not a heading
   - `language`: set `prop:language` — error if not code block
   - `checked`: set `prop:checked` — error if not todo
3. No fields provided = no-op (empty `changes`, no delta push)

**Type transition restrictions:** Only text-like blocks (paragraph, heading, quote, code, list). Attempting to change table/database/embed type → error.

**Type transition mapping:**
| Target type | Flavour | `prop:type` |
|------------|---------|-------------|
| paragraph | `affine:paragraph` | `text` |
| heading | `affine:paragraph` | `h1`-`h6` |
| quote | `affine:paragraph` | `quote` |
| code | `affine:code` | — |
| list | `affine:list` | `bulleted` |
| todo | `affine:list` | `todo` |

**Return:** `{ updated: true, blockId, changes: string[] }`

---

### Tool 7: `replace_doc_with_markdown` — add `preserveBlockIds`

Extend existing tool with optional parameter to keep specific blocks alive during replacement.

**New schema addition:**
- `preserveBlockIds` (string[], optional)

**Modified flow** (when `preserveBlockIds` is provided):
1. For each ID: check existence, record parent + index. Non-existent → `notFound` list.
2. Delete all blocks except preserved ones from note's children (using `deleteBlocksFromTree` on non-preserved blocks)
3. Parse and insert new markdown sequentially, with cursor-advancement logic:
   - Start at beginning of note (parentId = noteBlockId, index = 0)
   - Before each insert, check if current position in note's children is a preserved block → skip past it
4. Verify preserved blocks: check each still has valid parent. `repositioned: false` if in original spot, `true` if adjusted.

**When omitted:** Existing behavior, no change. Backward compatible.

**Return addition:** `{ preservedBlocks: [{ id, repositioned }], notFound: string[] }`

---

### Tool 8: `find_blocks`

Search for blocks by text content, return matching block IDs with context.

**Schema:**
- `docId` (string, required)
- `query` (string, required, min 1)
- `blockTypes` (string[], optional)
- `limit` (number, optional, default 20)
- `workspaceId` (string, optional)

**Flow:** Read-only. Walk all blocks, extract Y.Text fields (same pattern as `find_and_replace`), case-insensitive substring match. Filter by `blockTypes`. Use `getBlockInfo` for each match. Scan all blocks for `totalMatches` count even past `limit`.

**Return:** `{ matches: BlockMatch[], totalMatches: number }`

---

### Tool 9: `batch_resolve_comments`

Resolve multiple comments in a single call. Located in `src/tools/comments.ts`.

**Schema:**
- `docId` (string, required)
- `commentIds` (string[], required, min 1)
- `workspaceId` (string, optional)

**Flow:**
1. Fetch all comments via `list_comments` GraphQL query
2. Build map: commentId → { exists, resolved }
3. Categorize each input ID:
   - Not in map → `notFound`
   - Already `resolved: true` → `alreadyResolved`
   - Unresolved → call `resolveComment` mutation, add to `resolved`

**Return:** `{ resolved: string[], alreadyResolved: string[], notFound: string[] }`

---

### Tool 10: Scoped `find_and_replace` — add `scopeBlockId`

Extend existing tool with optional parameter to limit replacements to a block subtree.

**New schema addition:**
- `scopeBlockId` (string, optional)

**Modified flow** (when `scopeBlockId` is provided):
1. Find block — error if not found
2. Build subtree set: `new Set(collectDescendantBlockIds([scopeBlockId]))`
3. In the existing iteration loop, add: `if (scopeBlockId && !subtreeIds.has(blockId)) continue;`

**When omitted:** Existing behavior. Backward compatible.

## Testing Strategy

All tests in `tests/test-block-tools.mjs`, following existing patterns (MCP client over stdio, `parseContent` + `expectEqual` helpers).

### Per-tool test cases

Verification steps as described in the original spec (6-8 test cases per tool).

### End-to-end integration test

After all tools implemented:
1. Create test doc with rich content
2. Add `embed_linked_doc` via `append_block`
3. Add 3 comments
4. `list_blocks` → verify tree
5. `find_blocks` → search known string
6. `insert_markdown` → insert before heading, verify position
7. `update_block` → change paragraph to heading
8. `move_block` → reorder paragraph
9. `replace_section` → rewrite section, verify others untouched
10. `delete_blocks` → remove 2 blocks
11. Scoped `find_and_replace` → replace in one section only
12. `replace_doc_with_markdown` with `preserveBlockIds` → keep embedded doc
13. `batch_resolve_comments` → resolve all 3
14. Final `export_doc_markdown` → verify coherence

## Implementation Order

Dependencies dictate the build sequence:

1. **Internal helpers** — `getBlockInfo`, `walkBlockTree`, `deleteBlocksFromTree`, `findSectionRange`
2. **Read-only tools** — `list_blocks` (#5), `find_blocks` (#8) — no mutation risk, validate helpers
3. **Atomic mutation tools** — `delete_blocks` (#1), `update_block` (#6) — single-operation mutations
4. **Positional tools** — `insert_markdown` (#2), `move_block` (#4) — placement-dependent
5. **Composite tools** — `replace_section` (#3) — composes delete + insert
6. **Tool extensions** — scoped `find_and_replace` (#10), `replace_doc_with_markdown` + `preserveBlockIds` (#7)
7. **Comments tool** — `batch_resolve_comments` (#9) — independent, in different file
8. **Tests** — E2E test suite covering all tools + integration scenario
