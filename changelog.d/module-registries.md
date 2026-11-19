Modules now register themselves instead of every PR editing the same two
files: each module mounts its routes in `src/modules/<module>/mount.ts`
(listed once, alphabetically, in `src/mounts.ts`), and each config section
lives in its own file under `src/config/sections/` (listed in
`sections/index.ts`). `app.ts` and `config/index.ts` no longer change when a
feature adds routes or settings. No route, setting or default changed.
