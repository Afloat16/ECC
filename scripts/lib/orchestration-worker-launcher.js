'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildTemplateVariables, renderTemplate } = require('./tmux-worktree-orchestrator');
const { createGitRunner } = require('./worktree-lifecycle/git');

const TASK_PREFIX = '.ecc-orchestration-task-';
const TASK_IGNORE_RULE = '/' + TASK_PREFIX + '*/';

function ignoreStagedTasks(worktreePath, git) {
  const result = git.run(['rev-parse', '--git-path', 'info/exclude']);
  if (result.status !== 0) {
    throw new Error('Cannot locate worktree Git exclusions: ' + result.stderr.trim());
  }
  const excludePath = path.resolve(worktreePath, result.stdout.replace(/\r?\n$/, ''));
  let existing;
  try {
    existing = fs.readFileSync(excludePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    existing = '';
  }
  if (existing.split(/\r?\n/).includes(TASK_IGNORE_RULE)) return;
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  // One append preserves existing bytes and concurrent writers. Duplicate rules
  // from simultaneous first launches are harmless; never rewrite this shared file.
  fs.appendFileSync(excludePath, '\n' + TASK_IGNORE_RULE + '\n');
}

function sameFile(candidate, expected, directory) {
  if (!expected) return false;
  try {
    const current = fs.lstatSync(candidate);
    return (directory ? current.isDirectory() : current.isFile())
      && current.dev === expected.dev && current.ino === expected.ino;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function removeStagedTask(staged) {
  if (!staged || !sameFile(staged.directory, staged.directoryStat, true)) return;
  // Do not follow replacements or recursively delete files a worker added.
  if (sameFile(staged.task, staged.taskStat, false)) fs.unlinkSync(staged.task);
  try {
    fs.rmdirSync(staged.directory);
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
  }
}

function recordPreparationFailure(variables, error) {
  const updated = new Date().toISOString();
  const message = JSON.stringify(error.message || String(error));
  fs.writeFileSync(variables.status_file, [
    '# Status', '', '- State: failed', '- Updated: ' + updated,
    '- Branch: ' + variables.branch_name, '- Worktree: ' + variables.worktree_path,
    '', '- Error: worker task preparation failed: ' + message, ''
  ].join('\n'));
  fs.writeFileSync(variables.handoff_file, [
    '# Handoff', '', '- Failed: ' + updated, '',
    '## Remaining Risks', '- Worker task preparation failed: ' + message, ''
  ].join('\n'));
}

/** Stage the plan's own task only after its worktree and overlays exist. */
function launchWorkerTask({ launcherCommand, variables }) {
  let staged;
  let launched = false;
  try {
    if (!fs.lstatSync(variables.task_file).isFile()) {
      throw new Error('The canonical worker task must be a regular file');
    }
    const git = createGitRunner(variables.worktree_path);
    ignoreStagedTasks(variables.worktree_path, git);
    const directory = fs.mkdtempSync(path.join(variables.worktree_path, TASK_PREFIX));
    staged = { directory, directoryStat: fs.lstatSync(directory), task: path.join(directory, 'task.md') };
    fs.copyFileSync(variables.task_file, staged.task, fs.constants.COPYFILE_EXCL);
    staged.taskStat = fs.lstatSync(staged.task);
    // Tracked .gitignore rules have higher precedence than info/exclude.
    // Do not launch if a project negation would expose this task to git add.
    if (git.run(['check-ignore', '--quiet', '--', staged.task]).status !== 0) {
      throw new Error('The staged worker task is not ignored by Git');
    }
    const command = renderTemplate(launcherCommand, buildTemplateVariables({
      ...variables,
      task_file: staged.task
    }));
    // The existing templates are shell commands. Preserve the configured POSIX
    // shell; native Windows callers use the Bash required by the worker script.
    const shell = process.platform === 'win32' ? 'bash' : (process.env.SHELL || '/bin/sh');
    const result = spawnSync(shell, ['-c', command], {
      cwd: variables.worktree_path,
      stdio: 'inherit'
    });
    if (result.error) throw result.error;
    launched = true;
    return result.status === null ? 1 : result.status;
  } catch (error) {
    if (!launched) {
      try {
        recordPreparationFailure(variables, error);
      } catch (reportError) {
        error.message += '; could not record worker failure: ' + reportError.message;
      }
    }
    throw error;
  } finally {
    removeStagedTask(staged);
  }
}

if (require.main === module) {
  try {
    process.exitCode = launchWorkerTask(JSON.parse(process.argv[2]));
  } catch (error) {
    console.error('[orchestration-worker] ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = { launchWorkerTask };
