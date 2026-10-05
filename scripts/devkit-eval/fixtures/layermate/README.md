# LayerMate (stand-in)

A tiny host app for the kit eval, in Node and HTML with no dependencies. It lists the models in `./models`
and has an "Open in slicer" button. The button runs `editionCommand` from `layermate.config.json` with the
model's absolute path as the last argument: a program path, or an array of the program and fixed arguments.
Setting it to the installed slicer's executable is the whole launch hookup. A second launch hands the file
to a running slicer.

    node main.mjs                      the app on http://127.0.0.1:4173
    node open-in-edition.mjs <model>   the same launch from a shell
