# Smart Connections MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)

A security-first MCP server for Smart Connections. Read-only. Path-validated. Auditable.

Exposes [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) embeddings to Claude Code and other [MCP](https://modelcontextprotocol.io/) clients for semantic search of your Obsidian vault.

## Why This Exists

We needed semantic search of our Obsidian vault from Claude Code. Existing options have problems:

- **No path validation** - User input passed directly to file operations
- **Write access** - Some expose mutation tools we don't need
- **Heavy dependencies** - PyTorch/transformers for what's essentially vector math

This implementation:
- **Minimal dependencies** - MCP SDK + Transformers.js (for text search)
- **Fail-closed security** - path validation with realpath, symlink detection
- **Auditable** - small TypeScript codebase you can actually read

## Features

- **Text search** - query with plain text, not just note paths
- **Token-efficient** - compact responses, section-level reads, paging (see below)
- **Semantic search** using Smart Connections embeddings
- **Local inference** - uses Transformers.js (same model as Smart Connections)
- **Read-only** - no write operations, no shell execution
- **Secure** - strict path validation, bounded responses
- **Offline** - works without Obsidian running

## Security Model

| Property | Guarantee |
|----------|-----------|
| Path confinement | All file access validated against vault root |
| No traversal | `../` and symlink attacks blocked |
| Read-only | No write operations exposed |
| Bounded responses | Capped results (50), content length (10KB) |
| Fail closed | Errors deny access, never bypass |
| Audit logging | Security events logged with context |

## Installation

### Prerequisites

- Node.js 18+
- Obsidian with [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) plugin installed
- Embeddings built (open vault in Obsidian, let Smart Connections index)

### Setup

```bash
git clone https://github.com/gogogadgetbytes/smart-connections-mcp
cd smart-connections-mcp
npm install
npm run build
```

### Configure Claude Code

Add to your Claude Code config:

```bash
claude mcp add smart-connections \
  -e VAULT_PATH="/path/to/your/obsidian/vault" \
  -- node /path/to/smart-connections-mcp/dist/index.js
```

Or manually add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "smart-connections": {
      "command": "node",
      "args": ["/path/to/smart-connections-mcp/dist/index.js"],
      "env": {
        "VAULT_PATH": "/path/to/your/obsidian/vault"
      }
    }
  }
}
```

Restart Claude Code to load the server.

## Usage

Once configured, Claude Code can use these tools:

### Search by Text

```
"Search my vault for notes about backup strategies"
→ Uses search_by_text tool
```

### Search Similar Notes

```
"Find notes similar to Topics/Claude_Code.md"
→ Uses search_similar tool
```

### Get Note Content

```
"Show me the content of Topics/Obsidian.md"
→ Uses get_note tool
```

### List Indexed Notes

```
"What notes are indexed in my vault?"
→ Uses list_indexed tool
```

## Tools

| Tool | Description |
|------|-------------|
| `search_by_text` | Search using freeform text (computes embedding locally) |
| `search_similar` | Find notes semantically similar to a given note |
| `search_by_embedding` | Search using a raw embedding vector |
| `get_note` | Get content of a specific note (path validated); supports `section`, `stripFrontmatter`, `offset`, `maxLength` |
| `get_model_info` | Get embedding model configuration |
| `list_indexed` | List indexed notes, paged with `limit` (default 200) / `offset` |

## Token Efficiency

Everything a tool returns ends up in the model's context window, so responses are kept lean by default:

| Technique | Effect |
|-----------|--------|
| Plain-text results (`score<TAB>path` per line) instead of pretty-printed JSON | Search responses ~67% smaller |
| `list_indexed` paged at 200 by default, with a `next offset=` hint | Listing a 500-note vault: ~85% smaller |
| `get_note` `section` (one heading and its subsections) + `stripFrontmatter` | Reading one section of a long note: ~89% smaller |
| Note content returned raw, not JSON-escaped | No `\n` / `\"` overhead |
| Terse tool descriptions with shared parameter definitions | Tool list ~9% smaller than v0.2.0 even with the new parameters |

Long notes come back in slices with a trailer like `[truncated: chars 0-10240 of 25000; next offset=10240]`, so the client can page through deliberately instead of guessing.

Every tool except `get_model_info` takes `format: "json"` for structured (minified) output. Search results in JSON keep the v0.2.0 shape (`path`, `title`, `score`).

> **Upgrading from 0.2.x:** the default response format is now `text`. Pass `format: "json"` if you parse responses programmatically. `list_indexed` now returns at most 200 paths per call unless you raise `limit`.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `VAULT_PATH` | Yes | Absolute path to Obsidian vault |

## Limitations

- **Single vault** - Configure one vault per MCP server instance
- **Index from Smart Connections** - Note embeddings come from the plugin; text queries are embedded locally
- **No write access** - By design; use Obsidian for edits
- **First run downloads model** - ~50MB model cached in `~/.cache/huggingface/`

## Development

```bash
# Build
npm run build

# Build and run tests (node:test, no extra dependencies)
npm test

# Test with MCP Inspector
npx @modelcontextprotocol/inspector node dist/index.js
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security-focused PRs welcome.

## Security

To report security vulnerabilities, please email gogogadgetcode@proton.me. Do not open public issues for security concerns.

## License

MIT - see [LICENSE](LICENSE)

## Credits

- [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) by Brian Petro
- [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic
