Add Zod request validation to unvalidated order controllers
([issue #317](https://github.com/DocForum/docforum-core/issues/317)).
`createPharmacyOrder` and `fulfillPharmacyOrder` now parse their request bodies
through `createPharmacyOrderSchema` and `fulfillPharmacyOrderSchema`
(`pharmacy-orders/validation.ts`). `createLabOrder` and `fulfillLabOrder` get
the equivalent schemas in a new `lab-orders/validation.ts`. The admin
`resolveDispute` and `listDisputes` handlers use `resolveDisputeSchema` and
`listDisputesQuerySchema` added to `orders/validation.ts`. All controllers also
use `getParam(req, 'id')` and `getParam(req, 'orderId')` instead of raw
`req.params.id as string`.
