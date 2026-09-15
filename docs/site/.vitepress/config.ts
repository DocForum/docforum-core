import { defineConfig } from 'vitepress';

// GitHub Pages project site — served at /docforum-core/, not domain root.
// Only set when building for Pages (see .github/workflows/deploy-docs.yml)
// so local `npm run dev`/`preview` still work at plain "/".
const base = process.env.GITHUB_PAGES ? '/docforum-core/' : '/';

export default defineConfig({
  base,
  title: 'DocForum Docs',
  description:
    'Documentation for the DocForum organization — docforum-core, docforum-web, docforum-escrow.',
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    [
      'link',
      {
        href: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap',
        rel: 'stylesheet',
      },
    ],
  ],

  themeConfig: {
    logo: '/favicon.svg',

    nav: [
      { text: 'Product', link: '/product/prd' },
      { text: 'Architecture', link: '/architecture/overview' },
      { text: 'API', link: '/api/reference' },
      { text: 'Roadmap', link: '/roadmap/core' },
      { text: 'Repos', link: '/repos/core' },
    ],

    sidebar: {
      '/product/': [{ text: 'Product', items: [{ text: 'PRD', link: '/product/prd' }] }],

      '/architecture/': [
        {
          text: 'Architecture',
          items: [
            { text: 'Overview', link: '/architecture/overview' },
            { text: 'Essentials (quick reference)', link: '/architecture/essentials' },
          ],
        },
        {
          text: 'Architecture Decision Records',
          items: [
            { text: '0001 — Modular monolith', link: '/architecture/adr/0001-modular-monolith' },
            {
              text: '0002 — Stellar escrow as a library',
              link: '/architecture/adr/0002-stellar-escrow-for-fulfillment-payout',
            },
            {
              text: '0003 — Render preview deployment',
              link: '/architecture/adr/0003-render-preview-deployment',
            },
            {
              text: '0004 — Custodial payments v1',
              link: '/architecture/adr/0004-custodial-payments-v1',
            },
          ],
        },
      ],

      '/api/': [{ text: 'API', items: [{ text: 'Reference', link: '/api/reference' }] }],

      '/roadmap/': [
        {
          text: 'Roadmap',
          items: [
            { text: 'docforum-core', link: '/roadmap/core' },
            { text: 'docforum-web', link: '/repos/web/roadmap' },
            { text: 'docforum-escrow', link: '/repos/escrow/roadmap' },
          ],
        },
      ],

      '/repos/': [
        {
          text: 'The three repos',
          items: [
            { text: 'Overview', link: '/repos/core' },
            { text: 'docforum-core', link: '/repos/core' },
            { text: 'docforum-web', link: '/repos/web/overview' },
            { text: 'docforum-escrow', link: '/repos/escrow/overview' },
          ],
        },
        {
          text: 'docforum-web docs',
          items: [
            { text: 'README', link: '/repos/web/readme' },
            { text: 'Architecture essentials', link: '/repos/web/architecture' },
            { text: 'Roadmap', link: '/repos/web/roadmap' },
          ],
        },
        {
          text: 'docforum-escrow docs',
          items: [
            { text: 'README', link: '/repos/escrow/readme' },
            { text: 'Architecture essentials', link: '/repos/escrow/architecture' },
            { text: 'Roadmap', link: '/repos/escrow/roadmap' },
            { text: 'ADR 0001 — Generic escrow', link: '/repos/escrow/adr-0001' },
            { text: 'ADR 0002 — Per-escrow releaser', link: '/repos/escrow/adr-0002' },
            { text: 'ADR 0003 — SDK distribution', link: '/repos/escrow/adr-0003' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/DocForum' }],

    search: { provider: 'local' },

    footer: {
      message: 'Docs are synced from each repo\'s own files at build time — see docs/site/scripts/sync-docs.mjs.',
      copyright: 'DocForum · Apache-2.0',
    },
  },
});
