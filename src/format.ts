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

  if (nextOffset === undefined) {
    return slice.content;
  }
  return `${slice.content}\n\n[truncated: chars ${slice.offset}-${end} of ${slice.total}; next offset=${nextOffset}]`;
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

  let inFence = false;
  let start = -1;
  let level = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

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
