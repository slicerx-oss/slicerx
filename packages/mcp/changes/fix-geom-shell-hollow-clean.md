### Fixed

- `slicerx_geom_shell` on a curved body open at a face, such as a lofted vase open at the top, makes a wall whose faces no longer cross, so the next join or cut on it goes through. Before, a twisted vase shelled with 1.6, 2.4 or 2.6 mm walls took the shell and then refused a bottom joined under it with "the result is unsafe at mesh storage precision (intersecting faces); change the cut or placement".
- `slicerx_geom_shell` refuses a shell that would not store cleanly at the shell step, in its own words: "a 2 mm wall does not work on this body, since its inner faces would cross once stored; try a wall a little thinner or thicker". Before, such a shell went through and the next step on it was refused, asking to change a cut or placement that step did not have.
