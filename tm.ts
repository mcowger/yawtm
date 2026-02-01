#!/usr/bin/env bun

import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { simpleGit, SimpleGit } from 'simple-git';
import { Octokit } from '@octokit/rest';

interface PostHookConfig {
  hooks: string[];
}

interface RemoveOptions {
  deleteBranch?: boolean;
}

async function runPostHooks(repoPath: string): Promise<void> {
  const hookPath = join(repoPath, 'post-hook.json');
  const hookFile = Bun.file(hookPath);
  
  if (await hookFile.exists()) {
    try {
      const hooks: PostHookConfig = await hookFile.json();
      if (Array.isArray(hooks.hooks)) {
        for (const hook of hooks.hooks) {
          console.log(`Running post-hook: ${hook}`);
          const proc = Bun.spawn(['sh', '-c', hook], {
            cwd: repoPath,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit"
          });
          
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            throw new Error(`Post-hook failed with exit code ${exitCode}`);
          }
        }
      }
    } catch (error) {
      console.error(`Error running post-hooks: ${(error as Error).message}`);
    }
  }
}

async function resolveRepoUrl(repoInput: string): Promise<string> {
  // If it's already a full URL, return as-is
  if (repoInput.startsWith('https://') || repoInput.startsWith('git@') || repoInput.endsWith('.git')) {
    return repoInput;
  }
  
  // Parse "user/repo" format
  const match = repoInput.match(/^([^\/]+)\/([^\/]+)$/);
  if (!match) {
    throw new Error('Invalid repository format. Use "user/repo" or full URL');
  }
  
  const [, owner, repo] = match;
  
  try {
    const octokit = new Octokit();
    const { data } = await octokit.rest.repos.get({
      owner,
      repo
    });
    
    return data.clone_url;
  } catch (error) {
    console.error(`Error resolving repository: ${(error as Error).message}`);
    throw new Error(`Repository "${owner}/${repo}" not found or is not accessible`);
  }
}

async function getDefaultBranchFromGitHub(owner: string, repo: string): Promise<string | null> {
  try {
    const octokit = new Octokit();
    const { data } = await octokit.rest.repos.get({
      owner,
      repo
    });
    
    return data.default_branch || null;
  } catch (error) {
    return null;
  }
}

async function getMainBranch(git: SimpleGit): Promise<string> {
  try {
    // Try to get default remote branch
    const result = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    if (result) {
      const branch = result.replace('refs/remotes/origin/', '').trim();
      if (branch) {
        return branch;
      }
    }
  } catch {
    // If symbolic-ref fails, try remote branch detection
  }
  
  try {
    // Get remote branches
    const { remote } = await git.branch(['-r']);
    const remoteBranches = Object.keys(remote)
      .map(b => b.replace('origin/', '').trim())
      .filter(b => b && !b.includes('HEAD'));
    
    if (remoteBranches.length === 0) {
      throw new Error('No remote branches found');
    }
    
    // Fallback: look for common default branch names
    const commonDefaults = ['main', 'master', 'develop', 'dev'];
    for (const defaultName of commonDefaults) {
      if (remoteBranches.includes(defaultName)) {
        return defaultName;
      }
    }
    
    // Last resort: return the first branch found
    return remoteBranches[0];
  } catch (error) {
    console.error('Error determining main branch:', error);
    throw new Error('Could not determine main branch');
  }
}

async function clone(repoInput: string): Promise<void> {
  try {
    const repoUrl = await resolveRepoUrl(repoInput);
    
    // Extract repo name from URL for directory creation
    const urlMatch = repoUrl.match(/\/([^\/]+)\.git$/);
    if (!urlMatch) {
      console.error('Invalid repository URL format');
      process.exit(1);
    }
    
    const repoName = urlMatch[1];
    const repoPath = join(process.cwd(), repoName);
    const barePath = join(repoPath, '.bare');
    
    // Parse owner/repo from input for GitHub API call
    let owner: string | undefined;
    let repo: string | undefined;
    if (!repoInput.startsWith('https://') && !repoInput.startsWith('git@') && !repoInput.endsWith('.git')) {
      const match = repoInput.match(/^([^\/]+)\/([^\/]+)$/);
      if (match) {
        [, owner, repo] = match;
      }
    }
    
    if (await directoryExists(repoPath)) {
      console.error(`Directory ${repoName} already exists`);
      process.exit(1);
    }
    
    // Create the directory structure
    const mkdirProc = Bun.spawn(['mkdir', '-p', barePath], {
      cwd: process.cwd(),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit"
    });
    
    const exitCode = await mkdirProc.exited;
    if (exitCode !== 0) {
      throw new Error(`Failed to create directory structure`);
    }

    // Clone directly to the target directory
    const parentGit = simpleGit({
      baseDir: process.cwd(),
      binary: 'git'
    });
    
    await parentGit.clone(repoUrl, barePath, ['--bare']);
    
    let mainBranch: string;
    
    // Try to get default branch from GitHub API first
    if (owner && repo) {
      const githubDefault = await getDefaultBranchFromGitHub(owner, repo);
      if (githubDefault) {
        mainBranch = githubDefault;
      } else {
        mainBranch = await getMainBranch(simpleGit({ baseDir: barePath, binary: 'git' }));
      }
    } else {
      mainBranch = await getMainBranch(simpleGit({ baseDir: barePath, binary: 'git' }));
    }
    
    const bareGit = simpleGit({
      baseDir: barePath,
      binary: 'git'
    });

    // simple-git doesn't have worktree methods, need to use raw for worktree
    await bareGit.raw(['worktree', 'add', join(repoPath, mainBranch), mainBranch]);
    
    const emptyHooks: PostHookConfig = { hooks: [] };
    await Bun.write(join(repoPath, 'post-hook.json'), JSON.stringify(emptyHooks, null, 2));
    
    console.log(`Cloned ${repoInput} (${repoUrl}) into ${repoName}/ with worktree structure`);
    console.log(`Main branch '${mainBranch}' created at ${repoName}/${mainBranch}`);
    
    await runPostHooks(repoPath);
  } catch (error) {
    console.error(`Clone failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function branch(branchName: string): Promise<void> {
  const currentPath = process.cwd();
  let barePath = join(currentPath, '.bare');
  
  // Check current directory for .bare, then check parent directory
  if (!(await directoryExists('.bare'))) {
    // Not in main repo directory, check if we're in a worktree
    const parentPath = join(currentPath, '..');
    const parentBarePath = join(parentPath, '.bare');
    
    if (await directoryExists(parentBarePath)) {
      // We're in a worktree directory, use parent's .bare
      barePath = parentBarePath;
    } else {
      console.error('Not in a tm-managed repository (no .bare directory found)');
      console.error('Looking for .bare in current and parent directories');
      process.exit(1);
    }
  }
  
  const actualRepoPath = barePath.replace('/.bare', '');
  const branchPath = join(actualRepoPath, branchName);
  
  if (await directoryExists(branchPath)) {
    console.error(`Worktree ${branchName} already exists`);
    process.exit(1);
  }
  
  try {
    const bareGit = simpleGit({
      baseDir: barePath,
      binary: 'git'
    });

    // Create branch in the bare repo (not checkout, just branch)
    await bareGit.branch([branchName]);
    
    // Create worktree for the new branch
    await bareGit.raw(['worktree', 'add', branchPath, branchName]);
    
    console.log(`Created branch '${branchName}' and worktree at ${branchPath}`);
    
    await runPostHooks(branchPath);
  } catch (error) {
    console.error(`Branch creation failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function remove(branchName: string, options: RemoveOptions = {}): Promise<void> {
  const currentPath = process.cwd();
  let barePath = join(currentPath, '.bare');
  
  // Check current directory for .bare, then check parent directory
  if (!(await directoryExists('.bare'))) {
    // Not in main repo directory, check if we're in a worktree
    const parentPath = join(currentPath, '..');
    const parentBarePath = join(parentPath, '.bare');
    
    if (await directoryExists(parentBarePath)) {
      // We're in a worktree directory, use parent's .bare
      barePath = parentBarePath;
    } else {
      console.error('Not in a tm-managed repository (no .bare directory found)');
      console.error('Looking for .bare in current and parent directories');
      process.exit(1);
    }
  }
  
  const actualRepoPath = barePath.replace('/.bare', '');
  const branchPath = join(actualRepoPath, branchName);
  
  if (!(await directoryExists(branchPath))) {
    console.error(`Worktree ${branchName} does not exist`);
    process.exit(1);
  }
  
  try {
    const bareGit = simpleGit({
      baseDir: barePath,
      binary: 'git'
    });

    // simple-git doesn't have worktree methods, need to use raw for worktree
    await bareGit.raw(['worktree', 'remove', branchPath]);
    console.log(`Removed worktree at ${branchPath}`);
    
    if (options.deleteBranch) {
      await bareGit.branch(['-D', branchName]);
      console.log(`Deleted branch '${branchName}'`);
    }
  } catch (error) {
    console.error(`Remove failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'clone':
      if (!args[1]) {
        console.error('Usage: tm clone <repo-url-or-user/repo>');
        console.error('Examples:');
        console.error('  tm clone https://github.com/user/reponame.git');
        console.error('  tm clone user/reponame');
        process.exit(1);
      }
      await clone(args[1]);
      break;
      
    case 'branch':
      if (!args[1]) {
        console.error('Usage: tm branch <branch-name>');
        process.exit(1);
      }
      await branch(args[1]);
      break;
      
    case 'rm':
      if (!args[1]) {
        console.error('Usage: tm rm <branch-name> [-D]');
        process.exit(1);
      }
      const deleteBranch = args.includes('-D');
      await remove(args[1], { deleteBranch });
      break;
      
    default:
      console.error('Usage: tm <command>');
      console.error('Commands:');
      console.error('  clone <repo>    Clone repository with worktree structure');
      console.error('                   Accepts URLs or "user/repo" format');
      console.error('  branch <name>   Create new branch and worktree');
      console.error('  rm <name> [-D]  Remove worktree (and optionally branch)');
      process.exit(1);
  }
}

main().catch((error: Error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});