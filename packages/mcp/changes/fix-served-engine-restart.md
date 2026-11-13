### Fixed

- On a served sx-geom, a design replay is told bodies are held only while the engine's process is up. When the process stops and does not start again, a replay runs as one per call does, and a call of a replay that was holding bodies is refused with "The geometry engine stopped and did not start again, so this step did not run. Try it again." Before, such a call went per call and failed with "brep: no body in the reply".
