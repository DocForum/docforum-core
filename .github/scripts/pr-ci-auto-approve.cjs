// Approves a fork PR's pending CI runs once the PR has passed security review.
//
// Fork PRs from every external contributor need a maintainer to approve their
// workflow runs (repo setting: all_external_contributors). That gate stays on.
// This script does the approval automatically, but only when every check below
// passes for the exact commit that was scanned. Anything it isn't sure about
// is left for a maintainer: the PR gets the `ci-needs-manual-approval` label
// and the reasons go in the job summary.
//
// Checks, all of which must pass:
//   1. `PR malware scan` succeeded on this head (the workflow only runs then).
//   2. The PR has no `security-review` label.
//   3. A fresh scanner run (dry run) finds no high findings and no warnings.
//   4. The PR diff touches nothing the scanner can't judge on its own:
//      workflows, editor/devcontainer config, fonts, odd executables, files
//      named like known payload loaders, .gitignore payload markers, npm
//      lifecycle/dev/build/start scripts, lockfile entries from outside the
//      npm registry or crates.io, Go module `replace` directives.
//   5. The same path checks pass for every commit in the PR's history except
//      GitHub's own update-branch merges, so a payload added and then deleted
//      still holds the PR. For a contributor's own merge of `main`, only what
//      the merge adds beyond both parents is judged (see introducedPaths).
//   6. Every commit was authored and committed by the PR author, a known AI
//      coding tool identity, or GitHub itself (an update-branch merge). A
//      commit from anyone else (a third-party pusher, a forged maintainer
//      identity, another contributor's work) needs a maintainer.
//
// Like the scanner, this treats the PR purely as data read through the API.
// It runs from `main` via workflow_run and never checks out or executes the
// PR. Never add a step that does.

// CommonJS on purpose: actions/github-script loads these scripts with require().
// eslint-disable-next-line @typescript-eslint/no-require-imports
const scan = require('./pr-malware-scan.cjs');

const LABEL = 'ci-needs-manual-approval';
const SECURITY_LABEL = 'security-review';

// Accounts that commit on contributors' behalf through AI coding tools. Their
// commits are still scanned like any other; they just don't count as a
// different person pushing to the branch.
const TOOL_ACCOUNTS = new Set(['Copilot', 'codebuff-team']);

const PATH_RULES = [
  { re: /^\.github\//, why: 'changes GitHub workflows or scripts' },
  { re: /(^|\/)\.(vscode|devcontainer|idea)\//, why: 'adds editor or devcontainer config (autorun tasks)' },
  { re: /\.(woff2?|ttf|otf|eot)$|(^|\/)fonts\//i, why: 'adds or changes font files (payloads have been disguised as fonts)' },
  { re: /\.(lfk|lkf|lff|bat|cmd|ps1|exe|dll|so|dylib|scr|vbs|jar)$/i, why: 'adds an executable or disguised-payload file type' },
  { re: /^([\w.-]+\/)?(init|api\.js)$/, why: 'adds a file named like a known payload loader (`init`, `api.js`)' },
];

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const run = context.payload.workflow_run;
  const sha = run.head_sha;

  const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
  const pr = open.find((p) => p.head.sha === sha);
  if (!pr) {
    core.info(`No open PR has head ${sha}; it was probably pushed again since. Nothing to do.`);
    return;
  }
  if (pr.head.repo && pr.head.repo.full_name === `${owner}/${repo}`) {
    core.info(`#${pr.number} is a branch in this repo; its runs never need approval.`);
    return;
  }

  let reasons;
  try {
    reasons = await review({ github, owner, repo, pr });
  } catch (err) {
    reasons = [`the review itself errored (${err.message}), so nothing was approved`];
  }

  // Re-read the PR: if it moved while we were reviewing, this result is stale.
  const { data: now } = await github.rest.pulls.get({ owner, repo, pull_number: pr.number });
  if (now.head.sha !== sha) {
    core.info(`#${pr.number} moved to ${now.head.sha} during review; the next scan handles it.`);
    return;
  }

  if (reasons.length) {
    const list = reasons.map((r) => `- ${r}`).join('\n');
    core.info(`#${pr.number} left for manual approval:\n${list}`);
    await core.summary.addRaw(`### #${pr.number} needs manual CI approval\n\nCommit \`${sha.slice(0, 8)}\`:\n\n${list}\n`).write();
    await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: [LABEL] });
    return;
  }

  if (pr.labels.some((l) => l.name === LABEL)) {
    await github.rest.issues.removeLabel({ owner, repo, issue_number: pr.number, name: LABEL }).catch(() => {});
  }

  // CI runs are created a little after the push, sometimes after the scan has
  // finished. Keep approving for a few minutes, until a couple of quiet polls.
  let approved = 0;
  let quiet = 0;
  for (let i = 0; i < 18 && quiet < 3; i++) {
    const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, { owner, repo, head_sha: sha, per_page: 100 });
    const pending = runs.filter((r) => r.head_sha === sha && r.event === 'pull_request'
      && (r.conclusion === 'action_required' || r.status === 'action_required'));
    for (const r of pending) {
      await github.rest.actions.approveWorkflowRun({ owner, repo, run_id: r.id });
      core.info(`Approved "${r.name}" (run ${r.id}).`);
      approved++;
    }
    quiet = pending.length ? 0 : (approved ? quiet + 1 : quiet);
    await new Promise((resolve) => setTimeout(resolve, 20000));
  }
  await core.summary.addRaw(`### #${pr.number}: approved ${approved} run(s) on \`${sha.slice(0, 8)}\`\n`).write();
};

async function review({ github, owner, repo, pr }) {
  const reasons = [];
  const author = pr.user.login;

  if (pr.labels.some((l) => l.name === SECURITY_LABEL)) reasons.push(`has the \`${SECURITY_LABEL}\` label`);

  const quietCore = { info: () => {}, summary: null, setFailed: null };
  const result = await scan({ github, context: { repo: { owner, repo } }, core: quietCore, pr, dryRun: true });
  if (result.high.length) reasons.push(`malware scan reports ${result.high.length} high-severity finding(s)`);
  for (const w of result.warn) reasons.push(`scanner note: ${w.file}${w.line ? `:${w.line}` : ''} ${w.rule}: ${w.msg}`);

  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 });
  for (const f of files) {
    if (f.status === 'removed') continue;
    reasons.push(...pathReasons(f.filename, 'diff'));
    reasons.push(...patchReasons(f.filename, f.patch || ''));
  }

  const commits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: pr.number, per_page: 100 });
  for (const c of commits) {
    const short = c.sha.slice(0, 8);
    const isUpdateMerge = c.parents.length > 1 && c.committer && c.committer.login === 'web-flow' && c.commit.verification.verified;
    if (!isUpdateMerge) {
      for (const who of [c.author, c.committer]) {
        const login = who && who.login;
        if (login === author || (login && TOOL_ACCOUNTS.has(login)) || login === 'web-flow') continue;
        reasons.push(`commit ${short} is by ${login ? `@${login}` : `an identity not linked to any GitHub account (${c.commit.author.name})`}, not the PR author`);
        break;
      }
      // History: payload files that were added and later removed.
      for (const path of await introducedPaths({ github, owner, repo, commit: c })) {
        reasons.push(...pathReasons(path, `commit ${short}`));
      }
    }
  }

  return [...new Set(reasons)];
}

// Paths a commit adds or changes that the path rules should judge.
//
// For an ordinary commit that's every file it touches. A contributor's own
// merge of `main` is different: GitHub lists its files against the first
// parent (the PR branch), so everything `main` changed in between shows up as
// if the contributor had written it, and any workflow change on `main` would
// hold the PR. For a two-parent merge, only a file that differs from BOTH
// parents counts: a conflict resolution, a file both sides edited, or
// something slipped into the merge. A file identical to one parent's version
// came from that side unchanged: `main`'s side is trusted, and the PR side's
// commits are listed in the PR and checked one by one.
//
// When the comparison can't be complete (octopus merges, or more files than
// the compare API returns), every file counts, as before.
async function introducedPaths({ github, owner, repo, commit }) {
  const { data: detail } = await github.rest.repos.getCommit({ owner, repo, ref: commit.sha });
  const changed = (detail.files || []).filter((f) => f.status !== 'removed');
  if (commit.parents.length !== 2) return changed.map((f) => f.filename);

  const COMPARE_FILE_LIMIT = 300;
  const { data: cmp } = await github.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead: `${commit.parents[1].sha}...${commit.sha}`, per_page: 100,
  });
  const fromSecond = cmp.files || [];
  if (fromSecond.length >= COMPARE_FILE_LIMIT) return changed.map((f) => f.filename);

  const differsFromSecond = new Set(fromSecond.filter((f) => f.status !== 'removed').map((f) => f.filename));
  return changed.map((f) => f.filename).filter((p) => differsFromSecond.has(p));
}

function pathReasons(path, where) {
  return PATH_RULES.filter((r) => r.re.test(path)).map((r) => `${where}: \`${path}\` ${r.why}`);
}

function patchReasons(path, patch) {
  const out = [];
  const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
  if (/(^|\/)\.gitignore$/.test(path) && added.some((l) => /temp_auto_push|branch_structure\.json|^\s*\.gitignore\s*$/.test(l))) {
    out.push(`diff: \`${path}\` adds lines seen in earlier payload PRs`);
  }
  if (/(^|\/)package\.json$/.test(path) && added.some((l) => /^\s*"(pre|post)?(install|prepare|prepublish|dev|build|start|test)(:[\w:-]+)?"\s*:/.test(l))) {
    out.push(`diff: \`${path}\` changes install, dev, build, start or test scripts`);
  }
  if (/(^|\/)package-lock\.json$/.test(path)) {
    const hosts = new Set(added.map((l) => (l.match(/"resolved":\s*"(\w+:\/\/[^/"]+)/) || [])[1]).filter(Boolean));
    for (const h of hosts) if (h !== 'https://registry.npmjs.org') out.push(`diff: \`${path}\` resolves packages from ${h}`);
  }
  if (/(^|\/)Cargo\.lock$/.test(path)) {
    const sources = new Set(added.map((l) => (l.match(/^source\s*=\s*"([^"]+)"/) || [])[1]).filter(Boolean));
    for (const src of sources) if (!src.startsWith('registry+https://github.com/rust-lang/crates.io-index') && src !== 'sparse+https://index.crates.io/') out.push(`diff: \`${path}\` pulls crates from ${src}`);
  }
  if (/(^|\/)go\.mod$/.test(path) && added.some((l) => /^\s*replace\b|=>/.test(l))) {
    out.push(`diff: \`${path}\` adds a module \`replace\` directive`);
  }
  return out;
}

module.exports.review = review;
module.exports.introducedPaths = introducedPaths;
module.exports.patchReasons = patchReasons;
