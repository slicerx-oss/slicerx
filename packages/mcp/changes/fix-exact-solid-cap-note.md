### Fixed

- A step on an exact design (`exact: true`, with the developer opt-in) whose part's exact solid grows past the largest solid a part keeps is refused, saying the part is too detailed to stay an exact solid, with its size and the limit, and the design is unchanged. Before, the part quietly stopped being exact and its later steps ran on the mesh.
