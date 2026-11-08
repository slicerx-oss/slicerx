### Changed

- `slicerx_mimir_tab` 1.3.0 lists `capped`: over the provider's tool limit (mimir cloud and OpenAI-style APIs take 128 tools a request), what the open chat's last request sent: `cap`, `offered`, `sent`, the toolsets sent whole (`toolsets`), the ones left out (`leftOut`, with `partial` for one partly sent) and `loader`, the tool mimir calls to load a left-out toolset for its next step. `null` when every tool went. A capped chat now keeps its toolsets from message to message, so the list changes only when a new message needs room.
