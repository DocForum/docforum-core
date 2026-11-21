CI: `Docs fragments` now fails only when a PR adds lines straight to a shared
doc, which is the rule that prevents conflicts. A fragment that wouldn't fold
(unknown heading, ambiguous `after:`, missing front matter) is a warning with a
suggested fix (closest headings, or the shared doc that has the heading), shown
inline on the PR, and a maintainer corrects it when folding. Problems in
fragments already on main are never blamed on a PR. Maintainer mode (fold PRs)
stays strict. Same change as docforum-web#364.
