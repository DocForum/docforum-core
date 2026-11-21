Phase 2: allow closing an open consultation record ([issue #303](https://github.com/DocForum/docforum-core/issues/303)).
`POST /appointments/:id/consultation` can now close a consultation opened earlier without an outcome via a conditional database update matching `outcome IS NULL`, retaining existing encrypted notes if new notes are not provided.
