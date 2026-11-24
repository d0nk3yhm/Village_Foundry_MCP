# Godot 4 → local Village Foundry

This is a small runnable HTTP/JSON-RPC example. It does not install an editor plugin or assume that Godot is itself a general MCP client.

## Run it

1. Start Village Foundry from the repository root with `npm run local`, `start-local.cmd` on Windows, or `start-local.command` on macOS.
2. Open **http://127.0.0.1:8787**. In **MCP scene controls**, enable **Follow MCP changes** and leave that local browser tab open.
3. Import this folder's `project.godot` into Godot 4 and run `Main.tscn`.
4. The example creates a village house, queues a transparent **256 × 320** PNG, waits for the browser renderer, downloads the image, and displays it. The Output panel prints its saved path.

**Running the example replaces the saved local scene with the sample house.** It checks for an existing pending export and stops instead of discarding that job. The sample uses optimistic `expectedRevision` checks; if another client changes the scene concurrently, the server reports a conflict rather than silently overwriting it.

The files are saved to `user://generated`, using the export job ID to keep filenames unique. Each PNG has a JSON sidecar containing the scene recipe and export metadata. For asset development inside an editable Godot project, set the scene's `output_directory` property to `res://generated`. Use `user://` in exported games because the resource bundle may not be writable. The example creates its `ImageTexture` from downloaded bytes, so it does not depend on the editor importing a newly written PNG before display.

## What the client does

The complete example is [`village_foundry_demo.gd`](village_foundry_demo.gd). Its request sequence is:

1. `initialize` with protocol `2025-11-25`, followed by `notifications/initialized`.
2. `tools/list` to read the available tools.
3. `tools/call` → `get_scene` to obtain the current revision.
4. `tools/call` → `generate_house` with structured parameters.
5. `tools/call` → `request_export` with exact canvas dimensions.
6. Poll `tools/call` → `get_scene` until the matching `exportJob.status` becomes `ready`.
7. GET the same local origin plus `exportJob.url`, which is `/api/exports/<job-id>`.

For example, the tool-call body for a house is:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "generate_house",
    "arguments": {
      "params": {"preset": "village", "seed": 742, "width": 4.8, "depth": 6, "floors": 2}
    }
  }
}
```

The transport is stateless JSON POST at `/mcp`. A local Godot client needs no bearer token, `Origin`, or session ID header. Replies to `tools/call` contain `result.structuredContent`; the example checks both JSON-RPC errors and `result.isError`. This is the current Village Foundry endpoint contract, not an implementation of every MCP transport or feature.

The server queues one different export at a time. An identical pending snapshot/options request returns the existing job. Jobs have `pending`, `ready`, `failed`, or `cancelled` status. A failed job provides `exportJob.error.message`; the sample stops polling and reports that reason. Reduce detail or adjust the scene as indicated before requesting a new export. A timeout in this sample does **not** cancel the server job: reopen or unpause the local renderer tab to finish it, or use **Cancel pending MCP export** in the workbench. `cancel_export` is also available through `tools/call`.

## Customize it

Edit the `generate_house` arguments in `_run_example()` to change the architecture. To generate another asset type, use the corresponding tool and its schema from `tools/list`:

- `generate_interior` uses `arguments.config`.
- `generate_map` uses `arguments.config`.
- `generate_character` uses `arguments.config`.

Keep `request_export` for a still PNG. Character sprite sheets use `request_animation_export`; their frame/direction counts and cell metadata require a sprite-sheet importer, which is outside this small example.

A completed still export provides `exportJob.metadata.anchorPixels`. The sample sets `Sprite2D.centered = false` and subtracts that anchor from the sprite offset, so the node position represents the asset's ground contact. If an older result lacks anchor metadata, it falls back to the image center.

## Command-line checks

From the repository root, the first command checks script syntax. The second starts the scene and performs read-only protocol checks against a running local server:

```bash
godot --headless --path examples/godot --script res://village_foundry_demo.gd --check-only
godot --headless --path examples/godot -- --check-only
```

To queue the sample export and exit before rendering:

```bash
godot --headless --path examples/godot -- --queue-only
```

To run the complete download flow headlessly while the local browser renderer is open:

```bash
godot --headless --path examples/godot
```

After the `--` separator, `--url=http://127.0.0.1:9000` selects a different local port and `--output=res://generated` selects the project asset folder. The default renderer wait is 120 seconds; edit the `export_wait_seconds` property if a large scene needs longer. The script creates one `HTTPRequest` per request and awaits completion before continuing.

## Godot references

- [HTTPRequest: requests, completion results, and image download example](https://docs.godotengine.org/en/stable/classes/class_httprequest.html)
- [FileAccess: saving bytes and error handling](https://docs.godotengine.org/en/stable/classes/class_fileaccess.html)
- [Image: decoding PNG data](https://docs.godotengine.org/en/stable/classes/class_image.html#class-image-method-load-png-from-buffer)
- [File paths: `res://` and `user://`](https://docs.godotengine.org/en/stable/tutorials/io/data_paths.html)
