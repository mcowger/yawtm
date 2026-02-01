# Agent Guidelines for tm (Git Worktree Manager)

## Environment
- **Runtime**: Bun (required, not Node.js)
- **Language**: TypeScript (ES2022)
- **Module**: ESM (type: "module" in package.json)

## Build Commands

```bash
# Run the CLI locally
bun run tm.ts

# Build for distribution
bun build tm.ts --outdir ./dist --target bun

# Install dependencies
bun install

# Type check
bun tsc --noEmit
```

## Testing

No test framework is currently configured. To add tests:
```bash
# Run tests (if/when added)
bun test

# Run single test file
bun test path/to/test.ts
```

## Code Style Guidelines

### Imports
- Use `node:` prefix for Node.js built-ins: `import { join } from 'node:path'`
- External packages without prefix: `import { simpleGit } from 'simple-git'`
- Group imports: Node.js built-ins first, then external packages

### Types & Naming
- Explicit return types on all async functions: `async function foo(): Promise<void>`
- Interface names use PascalCase: `interface PostHookConfig`
- Function names use camelCase: `async function runPostHooks()`
- Type assertions with parentheses: `(error as Error).message`

### Error Handling
- Catch errors and cast to Error: `catch (error) { console.error((error as Error).message) }`
- Exit with code 1 on errors: `process.exit(1)`
- Use try/catch for async operations
- Log errors to stderr: `console.error()`

### Bun-Specific Patterns
- **Strongly prefer Bun builtins over Node.js equivalents** for all operations
- Use `Bun.spawn()` for shell commands (not child_process)
- Use `Bun.file()` and `Bun.write()` for file operations (not fs/promises)
- Access file info: `await Bun.file(path).exists()` (not fs.existsSync)

### Git Operations
- Use `simple-git` library for git operations
- Use `.raw()` for worktree commands (simple-git lacks direct worktree support)
- Always pass binary: 'git' in simpleGit config

### Formatting
- 2-space indentation
- Single quotes for strings
- Trailing commas in objects/arrays
- No semicolons (automatic via Bun formatter)

### Project Structure
- Single entry point: `tm.ts`
- Output directory: `./dist/`
- Types defined in file (no separate .d.ts files)

## Dependencies
- `@octokit/rest`: GitHub API integration
- `simple-git`: Git operations
- `bun-types`: Bun runtime types

## Common Tasks

```bash
# Add a new command to tm.ts
# 1. Add case in main() switch statement
# 2. Implement async function for the command
# 3. Handle errors with try/catch and process.exit(1)

# Add dependency
bun add <package>

# Add dev dependency
bun add -d <package>
```
