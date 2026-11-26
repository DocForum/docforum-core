Docs: the jobs README now reflects every job the process actually starts
([issue #355](https://github.com/DocForum/docforum-core/issues/355)).
`backend/src/jobs/README.md` lists the escrow event poller, unconfirmed-order
expiry, lab-order expiry, follow-up expiry, consultation sign-off and
notification fan-out, marks which timers are created inline in `src/server.ts`
(the login-throttle, access-log and idempotency-key prunes share one interval
there; lab-order expiry is a hard-coded hourly timer), and gives each row its
interval, controlling env var, what it changes and whether it is safe with
more than one process. Documentation only — no behaviour, schema or endpoint
changes.
