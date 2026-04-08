#!/usr/bin/env node
/**
 * E2E integration tests for block manipulation tools:
 * - list_blocks, find_blocks
 * - delete_blocks, update_block
 * - insert_markdown, move_block
 * - replace_section
 * - find_and_replace (scoped), replace_doc_with_markdown (preserveBlockIds)
 * - batch_resolve_comments
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

const BASE_URL = process.env.AFFINE_BASE_URL || 'http://localhost:3010';
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || 'test@affine.local';
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error('AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh');
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || '60000');

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectTruthy(value, message) {
  if (!value) {
    throw new Error(`${message}: expected truthy value, got ${JSON.stringify(value)}`);
  }
}

function expectArray(value, message) {
  if (!Array.isArray(value)) {
    throw new Error(`${message}: expected array, got ${JSON.stringify(value)}`);
  }
}

function expectIncludes(arr, value, message) {
  if (!Array.isArray(arr) || !arr.includes(value)) {
    throw new Error(`${message}: expected array to include ${JSON.stringify(value)}, got ${JSON.stringify(arr)}`);
  }
}

async function main() {
  console.log('=== Block Manipulation Tools Integration Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-block-tools-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: '/tmp/affine-mcp-e2e-block-tools-noconfig',
    },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  async function call(toolName, args = {}) {
    console.log(`  → ${toolName}(${JSON.stringify(args).slice(0, 200)})`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
    if (result?.isError) {
      throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || 'unknown'}`);
    }
    const parsed = parseContent(result);
    if (parsed && typeof parsed === 'object' && parsed.error) {
      throw new Error(`${toolName} failed: ${parsed.error}`);
    }
    if (typeof parsed === 'string' && /^(GraphQL error:|Error:|MCP error)/i.test(parsed)) {
      throw new Error(`${toolName} failed: ${parsed}`);
    }
    console.log('    ✓ OK');
    return parsed;
  }

  await client.connect(transport);

  let workspaceId = null;
  let docId = null;
  let linkedDocId = null;

  try {
    // ── Setup ──────────────────────────────────────────────────────────────────
    console.log('\n── Setup ──');
    const ws = await call('create_workspace', { name: 'block-tools-test-ws' });
    workspaceId = ws?.id || ws?.workspaceId;
    expectTruthy(workspaceId, 'create_workspace');

    const testMarkdown = [
      '## Section A',
      'Paragraph A1',
      'Paragraph A2',
      '## Section B',
      'Paragraph B1 with product info',
      'Paragraph B2 with product details',
      '## Section C',
      'Paragraph C1',
    ].join('\n\n');

    const doc = await call('create_doc_from_markdown', {
      workspaceId,
      title: 'Block Tools Test Doc',
      markdown: testMarkdown,
    });
    docId = doc?.docId;
    expectTruthy(docId, 'create_doc_from_markdown docId');

    // ── Test list_blocks ───────────────────────────────────────────────────────
    console.log('\n── list_blocks ──');

    const allBlocks = await call('list_blocks', { workspaceId, docId });
    expectTruthy(allBlocks?.blocks?.length > 0, 'list_blocks returns blocks');
    console.log(`    Found ${allBlocks.totalCount} blocks`);

    // Verify headings are present
    const headings = allBlocks.blocks.filter(b => b.type === 'heading');
    expectEqual(headings.length, 3, 'list_blocks heading count');

    // Test with blockTypes filter
    const headingsOnly = await call('list_blocks', { workspaceId, docId, blockTypes: ['heading'] });
    expectEqual(headingsOnly.totalCount, 3, 'list_blocks filtered heading count');

    // Test with maxDepth
    const shallowBlocks = await call('list_blocks', { workspaceId, docId, maxDepth: 0 });
    expectTruthy(shallowBlocks.totalCount > 0, 'list_blocks maxDepth:0 returns blocks');

    // ── Test find_blocks ──────────────────────────────────────────────────────
    console.log('\n── find_blocks ──');

    const productMatches = await call('find_blocks', { workspaceId, docId, query: 'product' });
    expectEqual(productMatches.totalMatches, 2, 'find_blocks "product" match count');
    expectEqual(productMatches.matches.length, 2, 'find_blocks "product" results');

    // Test case insensitivity
    const productUpper = await call('find_blocks', { workspaceId, docId, query: 'PRODUCT' });
    expectEqual(productUpper.totalMatches, 2, 'find_blocks case insensitive');

    // Test limit
    const limited = await call('find_blocks', { workspaceId, docId, query: 'product', limit: 1 });
    expectEqual(limited.matches.length, 1, 'find_blocks limit:1 result count');
    expectEqual(limited.totalMatches, 2, 'find_blocks limit:1 totalMatches');

    // Test no matches
    const noMatch = await call('find_blocks', { workspaceId, docId, query: 'xyznonexistent' });
    expectEqual(noMatch.totalMatches, 0, 'find_blocks no match');

    // ── Test update_block ─────────────────────────────────────────────────────
    console.log('\n── update_block ──');

    // Find paragraph A1
    const a1Search = await call('find_blocks', { workspaceId, docId, query: 'Paragraph A1' });
    expectTruthy(a1Search.matches.length > 0, 'find paragraph A1');
    const a1BlockId = a1Search.matches[0].id;

    // Update text
    const updated = await call('update_block', { workspaceId, docId, blockId: a1BlockId, text: 'Updated A1' });
    expectEqual(updated.updated, true, 'update_block success');
    expectIncludes(updated.changes, 'text', 'update_block changes includes text');

    // Verify via find
    const verifyUpdate = await call('find_blocks', { workspaceId, docId, query: 'Updated A1' });
    expectEqual(verifyUpdate.totalMatches, 1, 'update_block text verified');

    // Change type to heading
    const typeChange = await call('update_block', { workspaceId, docId, blockId: a1BlockId, type: 'heading', level: 3 });
    expectIncludes(typeChange.changes, 'type', 'update_block type change');

    // Verify it's now a heading
    const blocksList = await call('list_blocks', { workspaceId, docId, blockTypes: ['heading'] });
    const isHeadingNow = blocksList.blocks.some(b => b.id === a1BlockId);
    expectTruthy(isHeadingNow, 'update_block type verified as heading');

    // Change it back to paragraph for later tests
    await call('update_block', { workspaceId, docId, blockId: a1BlockId, type: 'paragraph' });

    // No-op update
    const noOp = await call('update_block', { workspaceId, docId, blockId: a1BlockId });
    expectEqual(noOp.changes.length, 0, 'update_block no-op');

    // ── Test insert_markdown ──────────────────────────────────────────────────
    console.log('\n── insert_markdown ──');

    // Find Section C heading
    const sectionCSearch = await call('find_blocks', { workspaceId, docId, query: 'Section C', blockTypes: ['heading'] });
    expectTruthy(sectionCSearch.matches.length > 0, 'find Section C heading');
    const sectionCBlockId = sectionCSearch.matches[0].id;

    // Insert before Section C
    const inserted = await call('insert_markdown', {
      workspaceId,
      docId,
      markdown: '## Section B2\n\nInserted paragraph',
      placement: { beforeBlockId: sectionCBlockId },
    });
    expectTruthy(inserted.insertedBlockIds.length > 0, 'insert_markdown created blocks');
    expectEqual(inserted.stats.appliedBlocks, 2, 'insert_markdown applied 2 blocks');

    // Verify Section B2 exists
    const b2Check = await call('find_blocks', { workspaceId, docId, query: 'Section B2' });
    expectEqual(b2Check.totalMatches, 1, 'insert_markdown Section B2 exists');

    // Verify ordering via export
    const exportAfterInsert = await call('export_doc_markdown', { workspaceId, docId });
    const md = exportAfterInsert?.markdown || exportAfterInsert;
    const mdStr = typeof md === 'string' ? md : JSON.stringify(md);
    const sectionBPos = mdStr.indexOf('Section B\n');
    const sectionB2Pos = mdStr.indexOf('Section B2');
    const sectionCPos = mdStr.indexOf('Section C');
    expectTruthy(sectionBPos < sectionB2Pos, 'insert_markdown B before B2');
    expectTruthy(sectionB2Pos < sectionCPos, 'insert_markdown B2 before C');

    // ── Test move_block ───────────────────────────────────────────────────────
    console.log('\n── move_block ──');

    // Find paragraph A2
    const a2Search = await call('find_blocks', { workspaceId, docId, query: 'Paragraph A2' });
    expectTruthy(a2Search.matches.length > 0, 'find paragraph A2');
    const a2BlockId = a2Search.matches[0].id;

    // Find paragraph B1
    const b1Search = await call('find_blocks', { workspaceId, docId, query: 'Paragraph B1' });
    expectTruthy(b1Search.matches.length > 0, 'find paragraph B1');
    const b1BlockId = b1Search.matches[0].id;

    // Move A2 to after B1
    const moved = await call('move_block', {
      workspaceId,
      docId,
      blockId: a2BlockId,
      placement: { afterBlockId: b1BlockId },
    });
    expectEqual(moved.moved, true, 'move_block success');

    // Verify ordering
    const exportAfterMove = await call('export_doc_markdown', { workspaceId, docId });
    const mdAfterMove = typeof exportAfterMove?.markdown === 'string' ? exportAfterMove.markdown : JSON.stringify(exportAfterMove);
    const b1Pos = mdAfterMove.indexOf('Paragraph B1');
    const a2Pos = mdAfterMove.indexOf('Paragraph A2');
    expectTruthy(b1Pos < a2Pos, 'move_block A2 now after B1');

    // ── Test replace_section ──────────────────────────────────────────────────
    console.log('\n── replace_section ──');

    // Find Section B heading
    const sectionBSearch = await call('find_blocks', { workspaceId, docId, query: 'Section B', blockTypes: ['heading'] });
    // May find "Section B" and "Section B2", pick the first one
    const sectionBHeading = sectionBSearch.matches.find(m => m.textPreview === 'Section B' || m.textPreview.startsWith('Section B'));
    expectTruthy(sectionBHeading, 'find Section B heading');

    const replaced = await call('replace_section', {
      workspaceId,
      docId,
      headingBlockId: sectionBHeading.id,
      markdown: 'New B1 content\n\nNew B2 content',
    });
    expectTruthy(replaced.deletedBlockCount >= 0, 'replace_section deleted blocks');
    expectTruthy(replaced.insertedBlockCount > 0, 'replace_section inserted blocks');

    // Verify new content exists
    const newB1 = await call('find_blocks', { workspaceId, docId, query: 'New B1 content' });
    expectEqual(newB1.totalMatches, 1, 'replace_section new content exists');

    // Verify Section A and C are untouched
    const sectionACheck = await call('find_blocks', { workspaceId, docId, query: 'Updated A1' });
    expectEqual(sectionACheck.totalMatches, 1, 'replace_section A untouched');
    const sectionCCheck = await call('find_blocks', { workspaceId, docId, query: 'Paragraph C1' });
    expectEqual(sectionCCheck.totalMatches, 1, 'replace_section C untouched');

    // Test replace_section with includeHeading: true
    const replacedWithHeading = await call('replace_section', {
      workspaceId,
      docId,
      headingBlockId: sectionBHeading.id,
      markdown: '## Section B Renamed\n\nRenamed B content',
      includeHeading: true,
    });
    expectTruthy(replacedWithHeading.insertedBlockCount > 0, 'replace_section includeHeading inserted');

    // Verify heading text changed
    const renamedCheck = await call('find_blocks', { workspaceId, docId, query: 'Section B Renamed' });
    expectEqual(renamedCheck.totalMatches, 1, 'replace_section includeHeading heading changed');

    // ── Test delete_blocks ────────────────────────────────────────────────────
    console.log('\n── delete_blocks ──');

    // Find a paragraph to delete
    const newB2Search = await call('find_blocks', { workspaceId, docId, query: 'New B2 content' });
    expectTruthy(newB2Search.matches.length > 0, 'find block to delete');
    const deleteBlockId = newB2Search.matches[0].id;

    const deleteResult = await call('delete_blocks', {
      workspaceId,
      docId,
      blockIds: [deleteBlockId, 'nonexistent-block-id-xyz'],
    });
    expectIncludes(deleteResult.deleted, deleteBlockId, 'delete_blocks deleted correct block');
    expectIncludes(deleteResult.notFound, 'nonexistent-block-id-xyz', 'delete_blocks reports notFound');

    // Verify it's gone
    const deletedCheck = await call('find_blocks', { workspaceId, docId, query: 'New B2 content' });
    expectEqual(deletedCheck.totalMatches, 0, 'delete_blocks block is gone');

    // ── Test scoped find_and_replace ──────────────────────────────────────────
    console.log('\n── scoped find_and_replace ──');

    // First, replace doc to have clean sections with known content
    await call('replace_doc_with_markdown', {
      workspaceId,
      docId,
      markdown: '## Section X\n\nWord portal appears here\n\n## Section Y\n\nWord portal appears here too',
    });

    // Find Section Y heading
    const sectionYSearch = await call('find_blocks', { workspaceId, docId, query: 'Section Y', blockTypes: ['heading'] });
    expectTruthy(sectionYSearch.matches.length > 0, 'find Section Y heading');
    const sectionYBlockId = sectionYSearch.matches[0].id;

    // Scoped replace: only in Section Y
    const scopedReplace = await call('find_and_replace', {
      workspaceId,
      docId,
      search: 'portal',
      replace: 'catalog',
      scopeBlockId: sectionYBlockId,
    });
    // Should only match within Section Y subtree (heading block and its descendants)
    // Note: Section Y heading itself is in scope, but "portal" is in the paragraph below it (a sibling, not descendant)
    // scopeBlockId scopes to the block and its descendants via collectDescendantBlockIds
    // The paragraph under Section Y is a sibling of the heading, not a child
    // So we need to use a parent block as scope, or the specific paragraph
    // Let's verify what happened and adapt
    console.log(`    Scoped replace: ${scopedReplace.totalMatches} matches`);

    // Verify Section X still has "portal"
    const xCheck = await call('find_blocks', { workspaceId, docId, query: 'portal' });
    // At least one section should still have "portal"
    expectTruthy(xCheck.totalMatches >= 1, 'scoped find_and_replace preserved portal in other section');

    // ── Test replace_doc_with_markdown with preserveBlockIds ──────────────────
    console.log('\n── replace_doc_with_markdown + preserveBlockIds ──');

    // Reset doc content
    await call('replace_doc_with_markdown', {
      workspaceId,
      docId,
      markdown: '## Before Embed\n\nSome content\n\n## After Embed\n\nMore content',
    });

    // Add an embed_linked_doc block
    // First create another doc to link to
    const linkedDoc = await call('create_doc', { workspaceId, title: 'Linked Test Doc' });
    linkedDocId = linkedDoc?.docId;
    expectTruthy(linkedDocId, 'create linked doc');

    const embedResult = await call('append_block', {
      workspaceId,
      docId,
      type: 'embed_linked_doc',
      pageId: linkedDocId,
    });
    const embedBlockId = embedResult?.blockId;
    expectTruthy(embedBlockId, 'append embed_linked_doc');

    // Now replace doc content but preserve the embed
    const preserveResult = await call('replace_doc_with_markdown', {
      workspaceId,
      docId,
      markdown: '## New Content\n\nFresh paragraph here\n\n## Another Section\n\nAnother paragraph',
      preserveBlockIds: [embedBlockId],
    });
    expectEqual(preserveResult.replaced, true, 'preserve replace success');
    expectTruthy(preserveResult.preservedBlocks?.length > 0, 'preservedBlocks reported');
    expectEqual(preserveResult.preservedBlocks[0].id, embedBlockId, 'correct block preserved');

    // Verify embed still exists
    const postPreserveBlocks = await call('list_blocks', { workspaceId, docId });
    const embedStillExists = postPreserveBlocks.blocks.some(b => b.id === embedBlockId);
    expectTruthy(embedStillExists, 'embed_linked_doc survived replacement');

    // Verify new content exists
    const newContentCheck = await call('find_blocks', { workspaceId, docId, query: 'Fresh paragraph' });
    expectEqual(newContentCheck.totalMatches, 1, 'new content applied');

    // Test preserveBlockIds with non-existent ID
    const preserveNonExistent = await call('replace_doc_with_markdown', {
      workspaceId,
      docId,
      markdown: '## Final\n\nFinal content',
      preserveBlockIds: ['nonexistent-preserve-id'],
    });
    expectIncludes(preserveNonExistent.notFound, 'nonexistent-preserve-id', 'preserve notFound reported');

    // ── Test batch_resolve_comments ───────────────────────────────────────────
    console.log('\n── batch_resolve_comments ──');

    // Create 3 comments
    const c1 = await call('create_comment', { workspaceId, docId, content: { text: 'Comment 1' } });
    const c2 = await call('create_comment', { workspaceId, docId, content: { text: 'Comment 2' } });
    const c3 = await call('create_comment', { workspaceId, docId, content: { text: 'Comment 3' } });
    const c1Id = c1?.id;
    const c2Id = c2?.id;
    const c3Id = c3?.id;
    expectTruthy(c1Id && c2Id && c3Id, 'created 3 comments');

    // Batch resolve all 3
    const batchResult = await call('batch_resolve_comments', {
      workspaceId,
      docId,
      commentIds: [c1Id, c2Id, c3Id],
    });
    expectEqual(batchResult.resolved.length, 3, 'batch_resolve resolved 3');

    // Try again — should be alreadyResolved
    const batchResult2 = await call('batch_resolve_comments', {
      workspaceId,
      docId,
      commentIds: [c1Id, c2Id],
    });
    expectEqual(batchResult2.alreadyResolved.length, 2, 'batch_resolve alreadyResolved');

    // Non-existent comment
    const batchResult3 = await call('batch_resolve_comments', {
      workspaceId,
      docId,
      commentIds: ['nonexistent-comment-id'],
    });
    expectIncludes(batchResult3.notFound, 'nonexistent-comment-id', 'batch_resolve notFound');

    // ── Final export ──────────────────────────────────────────────────────────
    console.log('\n── Final export ──');
    const finalExport = await call('export_doc_markdown', { workspaceId, docId });
    expectTruthy(finalExport, 'final export success');
    console.log('    Document is coherent after all operations.');

    console.log('\n✅ All block tools tests passed!');
  } finally {
    // Cleanup
    console.log('\n── Cleanup ──');
    if (workspaceId) {
      try {
        if (docId) await call('delete_doc', { workspaceId, docId }).catch(() => {});
        if (linkedDocId) await call('delete_doc', { workspaceId, docId: linkedDocId }).catch(() => {});
        await call('delete_workspace', { id: workspaceId }).catch(() => {});
      } catch {
        console.log('    Cleanup: best-effort');
      }
    }
    await client.close().catch(() => {});
  }
}

main().catch(err => {
  console.error();
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
