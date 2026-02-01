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

interface WorktreeInfo {
  path: string;
  branch: string;
  isBare: boolean;
  exists: boolean;
}

async function getBarePath(): Promise<string | null> {
  const currentPath = process.cwd();
  
  if (await directoryExists(join(currentPath, '.bare'))) {
    return join(currentPath, '.bare');
  }
  
  const parentPath = join(currentPath, '..');
  const parentBarePath = join(parentPath, '.bare');
  
  if (await directoryExists(parentBarePath)) {
    return parentBarePath;
  }
  
  return null;
}

async function listWorktrees(): Promise<void> {
  const barePath = await getBarePath();
  
  if (!barePath) {
    console.error('Not in a tm-managed repository (no .bare directory found)');
    process.exit(1);
  }
  
  try {
    const bareGit = simpleGit({
      baseDir: barePath,
      binary: 'git'
    });
    
    // Get worktree list
    const worktreeOutput = await bareGit.raw(['worktree', 'list', '--porcelain']);
    const worktrees: WorktreeInfo[] = [];
    
    const entries = worktreeOutput.trim().split('\n\n');
    for (const entry of entries) {
      const lines = entry.split('\n');
      const pathLine = lines.find(l => l.startsWith('worktree '));
      const branchLine = lines.find(l => l.startsWith('branch '));
      const bareLine = lines.find(l => l === 'bare');
      
      if (pathLine) {
        const path = pathLine.replace('worktree ', '');
        const branch = branchLine ? branchLine.replace('branch ', '').replace('refs/heads/', '') : '(detached)';
        const isBare = !!bareLine;
        const exists = await directoryExists(path);
        
        worktrees.push({ path, branch, isBare, exists });
      }
    }
    
    const actualRepoPath = barePath.replace('/.bare', '');
    const currentCwd = process.cwd();
    
    console.log('Worktrees:');
    console.log('');
    
    for (const wt of worktrees) {
      if (wt.isBare) continue;
      
      const branchName = wt.branch;
      const worktreeGit = simpleGit({ baseDir: wt.path, binary: 'git' });
      
      // Check status
      let status = '';
      try {
        const statusSummary = await worktreeGit.status();
        if (statusSummary.files.length > 0) {
          status = ` [${statusSummary.files.length} modified]`;
        }
      } catch {
        // Ignore status errors
      }
      
      // Check if ahead/behind
      let syncStatus = '';
      try {
        const branchSummary = await worktreeGit.branch(['-v']);
        const currentBranchInfo = branchSummary.current;
        if (currentBranchInfo) {
          // Check if ahead or behind
          try {
            const revParse = await worktreeGit.raw(['rev-parse', '--abbrev-ref', '@{upstream}']);
            if (revParse.trim()) {
              const aheadBehind = await worktreeGit.raw(['rev-list', '--left-right', '--count', `HEAD...@{upstream}`]);
              const [ahead, behind] = aheadBehind.trim().split('\t').map(Number);
              if (ahead > 0 && behind > 0) {
                syncStatus = ` [ahead ${ahead}, behind ${behind}]`;
              } else if (ahead > 0) {
                syncStatus = ` [ahead ${ahead}]`;
              } else if (behind > 0) {
                syncStatus = ` [behind ${behind}]`;
              }
            }
          } catch {
            // No upstream configured
          }
        }
      } catch {
        // Ignore branch errors
      }
      
      // Mark current worktree
      const isCurrent = currentCwd.startsWith(wt.path);
      const marker = isCurrent ? '* ' : '  ';
      
      // Mark if directory doesn't exist (orphaned)
      const orphanMarker = wt.exists ? '' : ' [ORPHANED]';
      
      console.log(`${marker}${branchName}${status}${syncStatus}${orphanMarker}`);
      console.log(`    ${wt.path}`);
      console.log('');
    }
  } catch (error) {
    console.error(`List failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function addWorktree(branchName: string): Promise<void> {
  const barePath = await getBarePath();
  
  if (!barePath) {
    console.error('Not in a tm-managed repository (no .bare directory found)');
    process.exit(1);
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
    
    // Check if branch exists (locally or remotely)
    const { all: allBranches } = await bareGit.branch(['-a']);
    const branchExists = allBranches.some(b => 
      b === branchName || b === `remotes/origin/${branchName}`
    );
    
    if (!branchExists) {
      console.error(`Branch '${branchName}' does not exist locally or remotely`);
      process.exit(1);
    }
    
    // If branch only exists remotely, create local tracking branch
    const localBranches = await bareGit.branch(['-l']);
    const hasLocalBranch = localBranches.all.includes(branchName);
    
    if (!hasLocalBranch) {
      await bareGit.raw(['branch', '--track', branchName, `origin/${branchName}`]);
    }
    
    // Create worktree for the branch
    await bareGit.raw(['worktree', 'add', branchPath, branchName]);
    
    console.log(`Created worktree for branch '${branchName}' at ${branchPath}`);
    
    await runPostHooks(branchPath);
  } catch (error) {
    console.error(`Add worktree failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function pruneWorktrees(): Promise<void> {
  const barePath = await getBarePath();
  
  if (!barePath) {
    console.error('Not in a tm-managed repository (no .bare directory found)');
    process.exit(1);
  }
  
  try {
    const bareGit = simpleGit({
      baseDir: barePath,
      binary: 'git'
    });
    
    // Get worktree list
    const worktreeOutput = await bareGit.raw(['worktree', 'list', '--porcelain']);
    const orphanedWorktrees: { path: string; branch: string }[] = [];
    
    const entries = worktreeOutput.trim().split('\n\n');
    for (const entry of entries) {
      const lines = entry.split('\n');
      const pathLine = lines.find(l => l.startsWith('worktree '));
      const branchLine = lines.find(l => l.startsWith('branch '));
      const bareLine = lines.find(l => l === 'bare');
      
      if (pathLine && !bareLine) {
        const path = pathLine.replace('worktree ', '');
        const branch = branchLine ? branchLine.replace('branch ', '').replace('refs/heads/', '') : '';
        
        // Check if directory still exists
        const exists = await directoryExists(path);
        if (!exists) {
          orphanedWorktrees.push({ path, branch });
        }
      }
    }
    
    if (orphanedWorktrees.length === 0) {
      console.log('No orphaned worktrees found');
      return;
    }
    
    console.log(`Found ${orphanedWorktrees.length} orphaned worktree(s):`);
    for (const wt of orphanedWorktrees) {
      console.log(`  - ${wt.branch} (${wt.path})`);
    }
    
    // Remove orphaned worktrees
    for (const wt of orphanedWorktrees) {
      try {
        await bareGit.raw(['worktree', 'remove', wt.path]);
        console.log(`Pruned orphaned worktree: ${wt.branch}`);
      } catch (error) {
        console.error(`Failed to prune ${wt.branch}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    console.error(`Prune failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function syncWorktrees(): Promise<void> {
  const barePath = await getBarePath();
  
  if (!barePath) {
    console.error('Not in a tm-managed repository (no .bare directory found)');
    process.exit(1);
  }
  
  try {
    const bareGit = simpleGit({
      baseDir: barePath,
      binary: 'git'
    });
    
    // First fetch all updates
    console.log('Fetching updates from origin...');
    await bareGit.fetch(['origin']);
    
    // Get worktree list
    const worktreeOutput = await bareGit.raw(['worktree', 'list', '--porcelain']);
    const worktrees: { path: string; branch: string }[] = [];
    
    const entries = worktreeOutput.trim().split('\n\n');
    for (const entry of entries) {
      const lines = entry.split('\n');
      const pathLine = lines.find(l => l.startsWith('worktree '));
      const branchLine = lines.find(l => l.startsWith('branch '));
      const bareLine = lines.find(l => l === 'bare');
      
      if (pathLine && !bareLine) {
        const path = pathLine.replace('worktree ', '');
        const branch = branchLine ? branchLine.replace('branch ', '').replace('refs/heads/', '') : '';
        worktrees.push({ path, branch });
      }
    }
    
    console.log(`\nSyncing ${worktrees.length} worktree(s)...\n`);
    
    for (const wt of worktrees) {
      const worktreeGit = simpleGit({ baseDir: wt.path, binary: 'git' });
      
      try {
        // Check if there are uncommitted changes
        const status = await worktreeGit.status();
        if (status.files.length > 0) {
          console.log(`⚠️  ${wt.branch}: Skipped (uncommitted changes)`);
          continue;
        }
        
        // Try to pull
        await worktreeGit.pull();
        console.log(`✓ ${wt.branch}: Synced`);
      } catch (error) {
        console.log(`✗ ${wt.branch}: Failed - ${(error as Error).message}`);
      }
    }
    
    console.log('\nSync complete');
  } catch (error) {
    console.error(`Sync failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function switchWorktree(branchName: string): Promise<void> {
  const barePath = await getBarePath();
  
  if (!barePath) {
    console.error('Not in a tm-managed repository (no .bare directory found)');
    process.exit(1);
  }
  
  const actualRepoPath = barePath.replace('/.bare', '');
  const branchPath = join(actualRepoPath, branchName);
  
  if (!(await directoryExists(branchPath))) {
    console.error(`Worktree '${branchName}' does not exist`);
    console.error(`Use 'tm add ${branchName}' to create it from an existing branch`);
    console.error(`Or use 'tm branch ${branchName}' to create a new branch`);
    process.exit(1);
  }
  
  // Output the path - useful for shell wrappers like:
  //   cd $(tm switch branch-name)
  console.log(branchPath);
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
      
    case 'list':
      await listWorktrees();
      break;
      
    case 'add':
      if (!args[1]) {
        console.error('Usage: tm add <branch-name>');
        console.error('Creates worktree from existing branch');
        process.exit(1);
      }
      await addWorktree(args[1]);
      break;
      
    case 'prune':
      await pruneWorktrees();
      break;
      
    case 'sync':
      await syncWorktrees();
      break;
      
    case 'switch':
      if (!args[1]) {
        console.error('Usage: tm switch <branch-name>');
        console.error('Outputs path to worktree (use with cd):');
        console.error('  cd $(tm switch <branch-name>)');
        process.exit(1);
      }
      await switchWorktree(args[1]);
      break;
      
    default:
      console.error('Usage: tm <command>');
      console.error('');
      console.error('Commands:');
      console.error('  clone <repo>       Clone repository with worktree structure');
      console.error('                      Accepts URLs or "user/repo" format');
      console.error('  branch <name>      Create new branch and worktree');
      console.error('  add <name>         Create worktree from existing branch');
      console.error('  rm <name> [-D]     Remove worktree (and optionally branch)');
      console.error('  list               List all worktrees with status');
      console.error('  prune              Remove orphaned worktrees');
      console.error('  sync               Pull latest changes to all worktrees');
      console.error('  switch <name>      Output worktree path (for cd wrapper)');
      process.exit(1);
  }
}

main().catch((error: Error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});