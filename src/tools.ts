/**
 * MCP Tool definitions and handlers.
 *
 * Exposes 6 read-only tools for semantic search:
 * - search_by_text: Search using freeform text query (computes embedding locally)
 * - search_similar: Find notes similar to an existing note
 * - search_by_embedding: Search using a raw embedding vector
 * - get_note: Get content (or one section / a slice) of a specific note
 * - get_model_info: Get embedding model configuration
 * - list_indexed: List indexed notes, paged
 *
 * Responses use the compact formats in format.ts by default to keep the
 * client's context window small; pass format: "json" for structured output.
 */

import * as fs from 'node:fs';
import { z } from 'zod';
import {
  Config,
  validateNotePath,
  validateEmbedding,
  validateLimit,
  log,
} from './security.js';
import { SmartConnectionsData } from './data.js';
import { findSimilar, findSimilarToNote } from './search.js';
import { Embedder } from './embeddings.js';
import {
  formatSearchResults,
  formatNoteList,
  formatNote,
  stripFrontmatter,
  extractSection,
} from './format.js';

// ============================================================================
// Tool Schemas (Zod)
// ============================================================================

const FormatSchema = z.enum(['text', 'json']).default('text');

export const SearchSimilarSchema = z.object({
  notePath: z.string(),
  limit: z.number().int().min(1).max(50).default(10),
  threshold: z.number().min(0).max(1).default(0.3),
  format: FormatSchema,
});

export const SearchByEmbeddingSchema = z.object({
  embedding: z.array(z.number()),
  limit: z.number().int().min(1).max(50).default(10),
  threshold: z.number().min(0).max(1).default(0.3),
  format: FormatSchema,
});

export const GetNoteSchema = z.object({
  notePath: z.string(),
  section: z.string().min(1).max(200).optional(),
  stripFrontmatter: z.boolean().default(false),
  offset: z.number().int().min(0).default(0),
  maxLength: z.number().int().min(1).optional(),
  format: FormatSchema,
});

export const ListIndexedSchema = z.object({
  pattern: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(200),
  offset: z.number().int().min(0).default(0),
  format: FormatSchema,
});

export const SearchByTextSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
  threshold: z.number().min(0).max(1).default(0.3),
  format: FormatSchema,
});

// ============================================================================
// Tool Definitions (for MCP registration)
// ============================================================================

// Tool definitions are sent to the client on every session and usually sit in
// the model's context for the whole conversation, so descriptions are kept
// terse and shared properties are defined once.

const formatProp = { type: 'string', enum: ['text', 'json'] };

const searchProps = {
  limit: { type: 'integer', description: '1-50, def 10' },
  threshold: { type: 'number', description: '0-1, def 0.3' },
  format: formatProp,
};

export const toolDefinitions = [
  {
    name: 'search_by_text',
    description: 'Semantic search by text. Returns score<TAB>path lines.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Max 500 chars' },
        ...searchProps,
      },
      required: ['query'],
    },
  },
  {
    name: 'search_similar',
    description: 'Notes similar to a note.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        notePath: { type: 'string', description: 'e.g. "Topics/Foo.md"' },
        ...searchProps,
      },
      required: ['notePath'],
    },
  },
  {
    name: 'search_by_embedding',
    description: 'Notes similar to a vector.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        embedding: { type: 'array', items: { type: 'number' } },
        ...searchProps,
      },
      required: ['embedding'],
    },
  },
  {
    name: 'get_note',
    description: 'Read a note. Prefer section/maxLength over whole notes; page with offset.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        notePath: { type: 'string' },
        section: { type: 'string', description: 'Heading text' },
        stripFrontmatter: { type: 'boolean' },
        offset: { type: 'integer' },
        maxLength: { type: 'integer', description: 'Chars, max 10240' },
        format: formatProp,
      },
      required: ['notePath'],
    },
  },
  {
    name: 'get_model_info',
    description: 'Embedding model info.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'list_indexed',
    description: 'List indexed note paths.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Path prefix' },
        limit: { type: 'integer', description: '1-1000, def 200' },
        offset: { type: 'integer' },
        format: formatProp,
      },
    },
  },
];

// ============================================================================
// Tool Handlers
// ============================================================================

export interface ToolContext {
  config: Config;
  data: SmartConnectionsData;
  embedder?: Embedder;
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * Handle search_similar tool call.
 */
export function handleSearchSimilar(
  args: unknown,
  ctx: ToolContext
): ToolResult {
  const parsed = SearchSimilarSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }

  const { notePath, limit, threshold, format } = parsed.data;

  // Validate the note path exists in index (no filesystem access needed for search)
  const normalizedPath = notePath.replace(/^\/+/, '');
  if (!ctx.data.entries.has(normalizedPath)) {
    return errorResult(`Note not found in index: ${notePath}`);
  }

  const results = findSimilarToNote(normalizedPath, ctx.data.entries, {
    limit: validateLimit(limit, 1, ctx.config.limits.maxResults, 'limit'),
    threshold,
  });

  if (!results) {
    return errorResult(`Note not found in index: ${notePath}`);
  }

  log('INFO', 'search_similar', { notePath, resultCount: results.length });

  return textResult(formatSearchResults(results, format, notePath));
}

/**
 * Handle search_by_embedding tool call.
 */
export function handleSearchByEmbedding(
  args: unknown,
  ctx: ToolContext
): ToolResult {
  const parsed = SearchByEmbeddingSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }

  const { embedding, limit, threshold, format } = parsed.data;

  // Validate embedding dimensions
  const validation = validateEmbedding(embedding, ctx.data.modelInfo.dimensions);
  if (!validation.valid) {
    return errorResult(validation.error!);
  }

  const results = findSimilar(embedding, ctx.data.entries, {
    limit: validateLimit(limit, 1, ctx.config.limits.maxResults, 'limit'),
    threshold,
  });

  log('INFO', 'search_by_embedding', { resultCount: results.length });

  return textResult(formatSearchResults(results, format));
}

/**
 * Handle search_by_text tool call.
 *
 * Computes embedding for the query text locally, then searches.
 * Requires embedder to be initialized at startup.
 */
export async function handleSearchByText(
  args: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  // Check if embedder is available
  if (!ctx.embedder || !ctx.embedder.isReady()) {
    return errorResult('Text search not available: embedder not initialized');
  }

  const parsed = SearchByTextSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }

  const { query, limit, threshold, format } = parsed.data;

  // Compute embedding for the query text
  let embedding: number[];
  try {
    embedding = await ctx.embedder.embed(query);
  } catch (e) {
    log('ERROR', 'search_by_text_embed_failed', { error: String(e) });
    // Don't expose internal error details to client
    return errorResult('Failed to compute embedding');
  }

  // Search using the computed embedding
  const results = findSimilar(embedding, ctx.data.entries, {
    limit: validateLimit(limit, 1, ctx.config.limits.maxResults, 'limit'),
    threshold,
  });

  log('INFO', 'search_by_text', { queryLength: query.length, resultCount: results.length });

  return textResult(formatSearchResults(results, format, query));
}

/**
 * Handle get_note tool call.
 *
 * SECURITY: This is a sensitive operation - validates path carefully.
 */
export function handleGetNote(
  args: unknown,
  ctx: ToolContext
): ToolResult {
  const parsed = GetNoteSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }

  const { notePath, section, offset, format } = parsed.data;

  // SECURITY: Validate path before any filesystem access
  const validation = validateNotePath(ctx.config, notePath);
  if (!validation.valid) {
    return errorResult(validation.error!);
  }

  // Read file content
  let content: string;
  try {
    content = fs.readFileSync(validation.resolvedPath!, 'utf-8');
  } catch {
    // SECURITY: Don't expose filesystem error details
    return errorResult('Failed to read note');
  }

  if (parsed.data.stripFrontmatter) {
    content = stripFrontmatter(content);
  }

  if (section !== undefined) {
    const extracted = extractSection(content, section);
    if (extracted === null) {
      return errorResult(`Section not found: ${section}`);
    }
    content = extracted;
  }

  // SECURITY: Enforce content length limit (caller may only lower it)
  const cap = ctx.config.limits.maxContentLength;
  const maxLength = Math.min(parsed.data.maxLength ?? cap, cap);
  const total = content.length;
  const slice = content.slice(offset, offset + maxLength);

  log('INFO', 'get_note', { notePath, offset, returnedLength: slice.length, total });

  return textResult(formatNote({ path: notePath, content: slice, offset, total }, format));
}

/**
 * Handle get_model_info tool call.
 */
export function handleGetModelInfo(
  _args: unknown,
  ctx: ToolContext
): ToolResult {
  return textResult(JSON.stringify({
    modelKey: ctx.data.modelInfo.modelKey,
    dimensions: ctx.data.modelInfo.dimensions,
    adapter: ctx.data.modelInfo.adapter,
  }));
}

/**
 * Handle list_indexed tool call.
 */
export function handleListIndexed(
  args: unknown,
  ctx: ToolContext
): ToolResult {
  const parsed = ListIndexedSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }

  const { pattern, limit, offset, format } = parsed.data;

  const paths: string[] = [];
  for (const notePath of ctx.data.entries.keys()) {
    if (pattern && !notePath.startsWith(pattern)) {
      continue;
    }
    paths.push(notePath);
  }

  // Sort alphabetically so offsets are stable between calls
  paths.sort((a, b) => a.localeCompare(b));

  const page = paths.slice(offset, offset + limit);
  return textResult(formatNoteList(page, paths.length, offset, format));
}

// ============================================================================
// Helper Functions
// ============================================================================

function textResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/**
 * Route a tool call to the appropriate handler.
 */
export async function handleToolCall(
  name: string,
  args: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  switch (name) {
    case 'search_by_text':
      return handleSearchByText(args, ctx);
    case 'search_similar':
      return handleSearchSimilar(args, ctx);
    case 'search_by_embedding':
      return handleSearchByEmbedding(args, ctx);
    case 'get_note':
      return handleGetNote(args, ctx);
    case 'get_model_info':
      return handleGetModelInfo(args, ctx);
    case 'list_indexed':
      return handleListIndexed(args, ctx);
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}
