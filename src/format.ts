/**
 * Token-efficient output formatting.
 *
 * Every byte returned by a tool lands in the client model's context window,
 * so responses default to a compact plain-text layout:
 * - No pretty-printed JSON (indentation alone is ~30% of a JSON response)
 * - No derived fields (titles are just the filename, already in the path)
 * - Note content is returned raw, not JSON-escaped (escaping inflates
 *   newlines and quotes)
 *
 * A minified `json` format is still available for programmatic consumers.
 */

import { SearchResult } from './search.js';

export type OutputFormat = 'text' | 'json';

/**
 * Format search results.
 *
 * text: one "score<TAB>path" line per result, best first.
 */
export function formatSearchResults(
  results: SearchResult[],
  format: OutputFormat,
  query?: string
): string {
  if (format === 'json') {
    return JSON.stringify(query === undefined ? { results } : { query, results });
  }

  if (results.length === 0) {
    return 'No matches above threshold.';
  }

  return results.map(r => `${r.score.toFixed(3)}\t${r.path}`).join('\n');
}

/**
 * Format a page of indexed note paths.
 *
 * text: a one-line header with the total and paging hint, then one path per line.
 */
export function formatNoteList(
  paths: string[],
  total: number,
  offset: number,
  format: OutputFormat
): string {
  const end = offset + paths.length;
  const nextOffset = end < total ? end : undefined;

  if (format === 'json') {
    return JSON.stringify({
      count: total,
      offset,
      ...(nextOffset !== undefined && { nextOffset }),
      notes: paths,
    });
  }

  if (total === 0) {
    return '0 notes';
  }
  if (paths.length === 0) {
    return `${total} notes; offset ${offset} is past the end`;
  }

  let header = `${total} notes`;
  if (offset > 0 || nextOffset !== undefined) {
    header += ` (${offset + 1}-${end})`;
  }
  if (nextOffset !== undefined) {
    header += `; next offset=${nextOffset}`;
  }
  return header + '\n' + paths.join('\n');
}

export interface NoteSlice {
  path: string;
  content: string;
  /** Start of the slice within the (post-processed) note text. */
  offset: number;
  /** Length of the full (post-processed) note text. */
  total: number;
}

/**
 * Format a note (or a slice of one).
 *
 * text: the raw content. When only part of the note is returned, a trailing
 * marker says where to continue so the client can page instead of guessing.
 */
export function formatNote(slice: NoteSlice, format: OutputFormat): string {
  const end = slice.offset + slice.content.length;
  const nextOffset = end < slice.total ? end : undefined;

  if (format === 'json') {
    return JSON.stringify({
      path: slice.path,
      content: slice.content,
      offset: slice.offset,
      total: slice.total,
      ...(nextOffset !== undefined && { nextOffset }),
    });
  }

  if (slice.offset > 0 && slice.offset >= slice.total) {
    return `[offset ${slice.offset} is past the end; note is ${slice.total} chars]`;
  }
  if (nextOffset === undefined) {
    return slice.content;
  }
  return `${slice.content}\n\n[truncated: chars ${slice.offset}-${end} of ${slice.total}; next offset=${nextOffset}]`;
}

/**
 * Take up to maxLength UTF-16 code units of content starting at offset,
 * without splitting a surrogate pair at either edge (a split pair becomes a
 * replacement character in the client). Returns the actual start offset.
 */
export function sliceNote(
  content: string,
  offset: number,
  maxLength: number
): { content: string; offset: number } {
  let start = offset;
  if (start > 0 && start < content.length && isLowSurrogate(content, start) && isHighSurrogate(content, start - 1)) {
    start--;
  }

  let end = Math.min(start + maxLength, content.length);
  if (end < content.length && isHighSurrogate(content, end - 1) && isLowSurrogate(content, end)) {
    // Back off one unit, unless that would leave nothing to return (a client
    // paging with maxLength 1 would otherwise never advance).
    end = end - 1 > start ? end - 1 : end + 1;
  }

  return { content: content.slice(start, end), offset: start };
}

function isHighSurrogate(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
}

/**
 * Remove a leading YAML frontmatter block (--- ... ---).
 */
export function stripFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  return match ? content.slice(match[0].length).replace(/^\s*\n/, '') : content;
}

/**
 * Extract a single markdown section by heading text (case-insensitive).
 *
 * Returns the heading line and everything up to the next heading of the same
 * or higher level, or null if no heading matches. Headings inside fenced code
 * blocks are ignored.
 */
export function extractSection(content: string, heading: string): string | null {
  const wanted = heading.trim().replace(/^#+\s*/, '').toLowerCase();
  const lines = content.split('\n');

  // The fence that opened the current code block ('' when outside one). Only a
  // fence of the same character and at least the same length closes it.
  let openFence = '';
  let start = -1;
  let level = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1];
      if (!openFence) {
        openFence = marker;
      } else if (marker[0] === openFence[0] && marker.length >= openFence.length) {
        openFence = '';
      }
      continue;
    }
    if (openFence) continue;

    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;

    if (start === -1) {
      if (m[2].toLowerCase() === wanted) {
        start = i;
        level = m[1].length;
      }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join('\n').trimEnd();
    }
  }

  return start === -1 ? null : lines.slice(start).join('\n').trimEnd();
}
