---
name: Bug report
about: Report a reproducible defect in existing behavior — not a new feature or a task.
title: "[Bug]: "
labels: bug
---

<!--
Per drips.network's "Creating Meaningful Issues" guide: a bug report earns
its Wave points the same way a feature issue does — real impact, clear
context, and honest complexity tagging, not just "here's a repro."
-->

**Complexity:** Trivial (100 pts) | Medium (150 pts) | High (200 pts) —
pick one honestly. A fix that also needs a regression test and touches a
correctness-critical path (booking, referrals, orders, or any contract
logic — see AGENTS.md) is rarely Trivial, even if the patch itself is
small.

## Description
<!-- 1-2 sentences: what's happening vs. what you expected. -->
<!-- Why this matters, not just what's broken — a bug that silently
     corrupts data or double-books a slot is a different priority than a
     cosmetic misalignment. Say which kind this is. -->

## Steps to Reproduce
<!-- Numbered, explicit, starting from a fresh state. -->
1. Go to '...'
2. Click on '...'
3. Scroll down to '...'
4. See error

## Expected Behavior
<!-- What the system should do. -->

## Actual Behavior
<!-- What it's actually doing. -->

## Environment
- **OS:**
- **Browser / Node / Rust version** (whichever applies):
- **App version / commit hash:**
- **Network** (if relevant — testnet, mainnet, local): 

## Minimal Reproducible Example
<!-- Link to a minimal repo, CodeSandbox, or a short standalone snippet —
     if the bug needs actual code execution to see, not just a UI click-through. -->

## Logs, Stack Traces, Screenshots
<!-- Paste terminal output / browser console errors / stack traces inside
     a fenced code block. Add screenshots or a short GIF for anything
     visual or hard to describe in words. -->
```

```

## Known Workaround
<!-- If you found a temporary fix, say so — so others aren't fully
     blocked while this is open. Leave blank if none. -->

## Additional Context
<!-- Anything else worth knowing — when this started, related issues,
     whether it's intermittent, etc. -->

---

**Definition of done:**
- [ ] Root cause identified, not just the symptom patched
- [ ] Regression test added covering the actual failure (not just "it works now" — see AGENTS.md's testing rules)
- [ ] `ROADMAP.md` updated if this closes or blocks a tracked item

**How this will be reviewed:**


**Not blocked by:** this issue should not depend on any other open issue completing first.
