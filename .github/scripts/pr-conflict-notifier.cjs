// Labels open PRs that conflict with the default branch and tells the author,
// once per push, how to rebase. Clears the label when the conflict is gone.
//
// Runs from the base repo on push/schedule only. It reads PR metadata through
// the API and never checks out or executes PR code, so a malicious PR cannot
// influence it.

const MARKER = '<!-- pr-conflict-notifier -->';
const LABEL = 'needs-rebase';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async ({ github, context, core, dryRun = false }) => {
  const { owner, repo } = context.repo;
  const { data: repoInfo } = await github.rest.repos.get({ owner, repo });
  const base = repoInfo.default_branch;

  if (!dryRun) await ensureLabel(github, owner, repo);

  const cause = await latestMergedPr(github, owner, repo, base);
  const prs = (await github.paginate(github.rest.pulls.list, {
    owner, repo, state: 'open', base, per_page: 100,
  })).filter((pr) => !pr.draft);

  // GitHub computes mergeability lazily: the first request starts the job,
  // later requests return the result. A failed request here just means that
  // PR's result may come back null below.
  await Promise.allSettled(prs.map((pr) => github.rest.pulls.get({ owner, repo, pull_number: pr.number })));
  await sleep(15000);

  const tally = { notified: [], labelledOnly: [], cleared: [], unknown: [], errored: [] };
  for (const pr of prs) {
    // One PR's API error (GitHub returns the odd 500/503 even after the
    // client's retries) must not stop the rest; it's picked up next run.
    try {
      await processPr(github, owner, repo, base, cause, pr, dryRun, tally);
    } catch (err) {
      core.warning(`#${pr.number}: ${err.status || ''} ${err.message}`.trim());
      tally.errored.push(pr.number);
    }
  }

  const fmt = (list) => (list.length ? list.map((n) => `#${n}`).join(', ') : 'none');
  const lines = [
    `${dryRun ? '[dry run] ' : ''}Checked ${prs.length} open PRs against \`${base}\`.`,
    `Notified (new conflict since last push): ${fmt(tally.notified)}`,
    `Still conflicting, author already notified: ${fmt(tally.labelledOnly)}`,
    `Conflict resolved, label removed: ${fmt(tally.cleared)}`,
    `Mergeability not computed yet, retried next run: ${fmt(tally.unknown)}`,
    `API error, retried next run: ${fmt(tally.errored)}`,
  ];
  lines.forEach((line) => core.info(line));
  if (core.summary) await core.summary.addRaw(lines.join('\n\n')).write();
  return tally;
};

async function processPr(github, owner, repo, base, cause, pr, dryRun, tally) {
  const mergeable = await readMergeable(github, owner, repo, pr.number);
  const hasLabel = pr.labels.some((l) => l.name === LABEL);

  if (mergeable === null) {
    tally.unknown.push(pr.number);
    return;
  }

  if (mergeable === false) {
    if (!hasLabel && !dryRun) {
      await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: [LABEL] });
    }
    if (await notifiedSinceLastPush(github, owner, repo, pr)) {
      tally.labelledOnly.push(pr.number);
      return;
    }
    if (!dryRun) {
      await github.rest.issues.createComment({
        owner, repo, issue_number: pr.number, body: commentBody(pr, base, cause),
      });
    }
    tally.notified.push(pr.number);
  } else if (hasLabel) {
    if (!dryRun) {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: pr.number, name: LABEL });
    }
    tally.cleared.push(pr.number);
  }
}

async function ensureLabel(github, owner, repo) {
  try {
    await github.rest.issues.getLabel({ owner, repo, name: LABEL });
  } catch (err) {
    if (err.status !== 404) throw err;
    await github.rest.issues.createLabel({
      owner, repo, name: LABEL, color: 'd93f0b', description: 'Has merge conflicts with main; the author needs to rebase',
    });
  }
}

async function readMergeable(github, owner, repo, number) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data } = await github.rest.pulls.get({ owner, repo, pull_number: number });
    if (data.mergeable !== null) return data.mergeable;
    await sleep(5000);
  }
  return null;
}

// True when someone has already told the author about conflicts after their
// latest push, so a conflict that persists across runs is announced only once,
// and a fresh conflict after a rebase is announced again.
async function notifiedSinceLastPush(github, owner, repo, pr) {
  const { data: head } = await github.rest.repos.getCommit({ owner, repo, ref: pr.head.sha });
  const pushedAt = new Date(head.commit.committer.date);
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: pr.number, since: pushedAt.toISOString(), per_page: 100,
  });
  return comments.some((c) => new Date(c.created_at) >= pushedAt
    && c.user.login !== pr.user.login
    && (c.body.includes(MARKER) || /merge conflicts?/i.test(c.body)));
}

async function latestMergedPr(github, owner, repo, base) {
  const { data: commit } = await github.rest.repos.getCommit({ owner, repo, ref: base });
  const { data: pulls } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
    owner, repo, commit_sha: commit.sha,
  });
  const merged = pulls.find((p) => p.merged_at);
  return merged ? { number: merged.number, title: merged.title } : null;
}

function commentBody(pr, base, cause) {
  const because = cause && cause.number !== pr.number
    ? `, most likely because #${cause.number} (${cause.title}) was just merged`
    : '';
  return `${MARKER}
@${pr.user.login} This PR now has merge conflicts with \`${base}\`${because}, so it can't be merged until it's rebased:

\`\`\`bash
git fetch upstream            # upstream = https://github.com/${pr.base.repo.full_name}.git
git rebase upstream/${base}
# resolve the conflicts, re-run the tests, then:
git push --force-with-lease
\`\`\`

The usual culprits are shared files like \`ROADMAP.md\` and \`ARCHITECTURE*.md\`. CI re-runs when you push, and the \`${LABEL}\` label is removed automatically once the conflicts are resolved.

<sub>Automated message. It won't repeat unless the PR conflicts again after your next push.</sub>`;
}
