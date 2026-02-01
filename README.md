# tm - Git Worktree Manager

A lightweight git worktree manager built with TypeScript and Bun that simplifies managing multiple worktrees for a single repository.

## Installation

### Quick Try (No Install)

Run instantly without installing:

```bash
# Using bunx (fastest)
bunx yawtm --help

# Using npx
npx yawtm --help
```

### Install Globally

```bash
# Via Bun (recommended)
bun install -g yawtm

# Via NPM
npm install -g yawtm
```

### Via Compiled Binaries

Download pre-built binaries from the [releases page](https://github.com/yourusername/yawtm/releases):

```bash
# macOS Apple Silicon
curl -L -o tm https://github.com/yourusername/yawtm/releases/latest/download/tm-darwin-arm64

# Linux AMD64
curl -L -o tm https://github.com/yourusername/yawtm/releases/latest/download/tm-linux-x64

chmod +x tm
sudo mv tm /usr/local/bin/
```

### Development Setup

```bash
# Clone this repository
git clone <this-repo>
cd yawtm

# Install dependencies
bun install

# Symlink for local development
ln -s $(pwd)/tm.ts /usr/local/bin/tm
```

## Usage

### Clone a repository
```bash
tm clone https://github.com/user/reponame.git
```
This creates:
- `reponame/.bare/` - The bare git repository
- `reponame/main/` (or `master/`) - Worktree for the main branch
- `reponame/post-hook.json` - Empty hooks file

### Create a new branch and worktree
```bash
cd reponame
tm branch feature-branch
```
Creates a new branch and worktree at `reponame/feature-branch/`.

### Remove a worktree
```bash
cd reponame
tm rm feature-branch          # Remove worktree only
tm rm feature-branch -D       # Remove worktree and delete the branch
```

## Post-Hook Configuration

The `post-hook.json` file allows you to specify commands that run automatically when creating new worktrees:

```json
{
  "hooks": [
    "npm install",
    "echo 'Setup complete'",
    "git config user.name 'Your Name'"
  ]
}
```

## Features

- Bare repository setup with automatic main branch detection
- Automatic worktree management
- Post-creation hook support
- Minimal dependencies (just bun)
- Simple command-line interface