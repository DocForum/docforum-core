---
layout: home

hero:
  name: DocForum
  text: One thread, three repos.
  tagline: Booking, referral, order, and escrow-secured fulfillment — a hospital visit collapsed into a single continuous digital thread. Docs for the whole org, sourced from each repo's own files.
  actions:
    - theme: brand
      text: Read the PRD
      link: /product/prd
    - theme: alt
      text: Architecture
      link: /architecture/overview
    - theme: alt
      text: The three repos
      link: /repos/core

features:
  - title: docforum-core
    details: The hub — backend modular monolith, owns Postgres and all PHI, owns the PRD/architecture/roadmap the other two repos are scoped against.
    link: /repos/core
    linkText: Read more
  - title: docforum-web
    details: React/Vite frontend. Talks only to docforum-core's API — never to docforum-escrow or Stellar directly.
    link: /repos/web/overview
    linkText: Read more
  - title: docforum-escrow
    details: Rust/Soroban escrow contract + TypeScript SDK. Generic, healthcare-agnostic, consumed by docforum-core as a library — never a network call.
    link: /repos/escrow/overview
    linkText: Read more
---
