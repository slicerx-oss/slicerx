### Fixed

- With the app open and its link on, a design tool that the app answers as failed (a failed sketch check, an undo with nothing to undo, a design check with checks failing) now comes back failed here too, with `isError` set and the app's words. Before, the reply lost its failure and read as a success.
