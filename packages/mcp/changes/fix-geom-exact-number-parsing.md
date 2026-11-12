### Fixed

- The CAD and mesh tools that run the sx-geom program read every number in a request correctly rounded, as JavaScript's JSON.parse and the desktop app do. Before, a number with more than about 15 significant digits, such as a stored corner radius of 0.9999999999977263 sent back from an earlier answer, could be read one unit in the last place off, and an answer that built on it could differ from the app's for the same request. Short numbers such as 0.2 or 3.5 read as before.
