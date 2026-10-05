---
disable-model-invocation: true
description: List SlicerX actions waiting for your approval, and the permission policy
---

Call `slicerx_pending_approvals` and `slicerx_get_policy`. For each pending request, show its title, details, permission class and expiry, and ask the user whether to approve or decline it. Call `slicerx_approve` only with the user's explicit answer for that request. Then summarize the policy: which classes are Allow, Ask first and Off, and any per-printer exceptions, and remind the user that they change it by editing the policy file.
