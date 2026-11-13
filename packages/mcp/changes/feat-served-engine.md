### Changed

- Design replays run on one sx-geom process for the whole server when its sx-geom has a serve mode (`sx-geom serve`, which answers HELLO). That process is started on the first design call and kept while the server runs. Exact bodies stay there between tool calls, held by number, so no solid text goes back and forth for each step. A process that stops takes its bodies with it: the next call starts a new process, and the design replays from its history. An sx-geom with no serve mode runs once per call, as before. Tool answers are unchanged.
