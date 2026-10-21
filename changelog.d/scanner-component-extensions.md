Malware scan: `.vue`, `.svelte`, `.astro`, `.less`, `.sass`, `.go`,
`go.mod` and `go.sum` files are now scanned as code. Before this, a Vue
single-file component was flagged HIGH as "disguised code" (JavaScript
inside a file with a non-code extension), which wrongly blocked
docforum-core #207. The same line rules still apply to these files.
