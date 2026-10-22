Malware scan: TLA+ specifications (`.tla`) are now scanned as text, like
other source files. Before this, a TLA+ spec was flagged HIGH as "disguised
code", which wrongly blocked docforum-escrow #225. Every line rule still
applies to `.tla` files.
