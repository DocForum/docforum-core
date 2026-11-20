Tests: `medications` and `two-factor` integration tests move to their own
embedded-Postgres ports (5472, 5473). They had reused 5470 and 5471, already
taken by `automatic-settlement` and `lab-result-escalation`, so whichever test
started second could time out in `beforeAll`.
