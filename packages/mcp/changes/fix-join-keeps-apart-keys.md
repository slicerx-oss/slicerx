### Fixed

- `slicerx_geom_faces` 1.6.1 (from 1.6.0) on a design built as exact solids: a face that lies in the same plane as a face of a shape joined to it, but never touches it, keeps its key after the join and gives no `from`, and its `madeBy` is the step that made it. Before, the join cleared its key, the face gave `from` in its place, and a saved reference to it by key asked for repair. Faces in one plane that meet still lose their keys and give `from`, and where the kernel merges two of them into one face, that face gives one `from`.
