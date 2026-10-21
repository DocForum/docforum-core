Malware scan: closed three gaps found in the malicious docforum-web #137,
which only had three of its nine problems flagged. Code pushed off-screen by
leading whitespace is now flagged (`api.js` hid its payload behind 315 tabs).
A `package.json` script such as `dev` or `build` that now also runs
`node <file>` (or bun, deno, sh, bash, python) alongside its original command
is flagged as `script-hijack`. The `global['!'] = …` marker of the loader used
in escrow #163 and web #137 is flagged as `known-payload`. The whole-line
heuristics no longer stop the per-line rules from running on the same file.
