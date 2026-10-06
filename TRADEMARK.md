# The SlicerX name and logo

The SlicerX code is open source. The SlicerX name and logo are trademarks of the SlicerX project, and this page says how forks and white-label editions may use them.

## What you can do

You can take SlicerX, change it and ship it as your own product under its licenses (Apache-2.0 for the code, AGPL-3.0-or-later for the stock printer profiles, printer images and Bambu certificates). That includes a white-label edition: your name, your logo, your colors, your backend. `docs/integrating.md` shows how, and the edition config does the renaming for you.

## What you cannot do

- Name your product SlicerX, or a name that contains it or reads as a version of it ("SlicerX Pro", "Slicer X for Acme").
- Use the SlicerX logo, the layered X mark or the SlicerX wordmark as your product's logo, app icon or mark.
- Suggest that the SlicerX project makes, endorses or supports your product.

The edition config checker refuses a fork that uses the SlicerX name, logo, `slicerx://` link scheme or `app.slicerx.*` identifiers.

## The credit we expect

Show "Made possible by SlicerX" with a link to https://slicerx.app/support. Keep it small, on your About screen and in your docs, and leave it out of your app bar, splash screen and store listing title. Every edition shows exactly this line on About, and the edition config checker refuses any other wording or link. You can add your own sentence beside it, such as "Harbor Slice is built on SlicerX", but the credit line stays.

## Naming SlicerX is fine when it is true

You can say your product is built on SlicerX, compare it with SlicerX, or link to the project. You can also name the file formats: `.sx3mf` projects and `.sxlock` locked projects keep their names in every edition, so files open the same way everywhere.

## Questions

If you are unsure whether a use is fine, open an issue on the repository and ask.
