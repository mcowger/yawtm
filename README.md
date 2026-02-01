# tm - Git Worktree Manager

A lightweight git worktree manager built with TypeScript and bun that simplifies managing multiple worktrees for a single repository.

## Installation

```bash
# Clone this repository
git clone <this-repo>
cd yawtm

# Install dependencies and globally using bun
bun install
bun install -g

# Or symlink for local development
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