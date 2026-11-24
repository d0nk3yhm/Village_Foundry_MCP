extends Node2D
## A focused HTTP/JSON-RPC client for Village Foundry's local MCP endpoint.
## Keep the local browser workbench open with Follow MCP changes enabled.
## This is an example client, not a general-purpose MCP implementation.

@export var base_url: String = "http://127.0.0.1:8787"
@export var output_directory: String = "user://generated"
@export_range(10, 600) var export_wait_seconds: int = 120

const PROTOCOL := "2025-11-25"
var _json_headers := PackedStringArray([
	"Content-Type: application/json",
	"Accept: application/json, text/event-stream",
	"MCP-Protocol-Version: " + PROTOCOL,
])
var _next_id: int = 1
var _status: Label
var _check_only: bool = false
var _queue_only: bool = false

func _ready() -> void:
	_status = Label.new()
	_status.position = Vector2(18, 16)
	_status.size = Vector2(604, 100)
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(_status)
	var args := OS.get_cmdline_user_args()
	_check_only = args.has("--check-only")
	_queue_only = args.has("--queue-only")
	for arg in args:
		if arg.begins_with("--url="):
			base_url = arg.trim_prefix("--url=")
		elif arg.begins_with("--output="):
			output_directory = arg.trim_prefix("--output=")
	base_url = base_url.trim_suffix("/")
	var local_origin := RegEx.new()
	local_origin.compile("^http://(127\\.0\\.0\\.1|localhost)(:[0-9]{1,5})?$")
	if local_origin.search(base_url) == null:
		_finish(_failure("Use the loopback origin, such as http://127.0.0.1:8787."))
		return
	var result := await _run_example()
	_finish(result)

func _run_example() -> Dictionary:
	_status.text = "Connecting to the local Village Foundry MCP endpoint…"
	var hello := await _rpc("initialize", {
		"protocolVersion": PROTOCOL, "capabilities": {},
		"clientInfo": {"name": "godot-foundry-example", "version": "1.0.0"},
	})
	if hello.has("_error"):
		return hello
	var notification := await _http("/mcp", HTTPClient.METHOD_POST,
		JSON.stringify({"jsonrpc": "2.0", "method": "notifications/initialized"}), _json_headers)
	if notification.has("_error"):
		return notification
	var tools := await _rpc("tools/list", {})
	if tools.has("_error"):
		return tools
	var names: Array[String] = []
	for tool in tools.get("tools", []):
		names.append(str(tool.get("name", "")))
	print("MCP tools: ", ", ".join(names))
	var current := await _tool("get_scene", {})
	if current.has("_error"):
		return current
	if _check_only:
		return {"checked": true, "tool_count": names.size(), "revision": current.get("revision"), "scene_format": current.get("scene", {}).get("format")}
	var previous_job: Dictionary = current.get("exportJob", {}) if current.get("exportJob") is Dictionary else {}
	if previous_job.get("status") == "pending":
		return _failure("An export is already pending. Finish it in the browser or cancel it before running this demo.")
	# Running the demo intentionally replaces the current local scene with a house.
	var created := await _tool("generate_house", {
		"params": {"preset": "village", "seed": 742, "width": 4.8, "depth": 6, "floors": 2},
		"expectedRevision": int(current.get("revision", 0)),
	})
	if created.has("_error"):
		return created
	var queued := await _tool("request_export", {
		"options": {"resolution": 512, "scale": 1, "style": "illustrated",
			"sizeMode": "fixed", "width": 256, "height": 320, "padding": 8, "fit": "contain"},
		"expectedRevision": int(created.get("revision", 0)),
	})
	if queued.has("_error"):
		return queued
	var job: Dictionary = queued.get("exportJob", {})
	var job_id := str(job.get("id", ""))
	if job_id.is_empty():
		return _failure("The server did not return an export job ID.")
	print("Export queued: ", job_id)
	if _queue_only:
		return {"queued": job_id}
	_status.text = "Waiting for the local browser to render the PNG. Enable Follow MCP changes in that tab."
	var deadline := Time.get_ticks_msec() + export_wait_seconds * 1000
	while Time.get_ticks_msec() < deadline:
		var state := await _tool("get_scene", {})
		if state.has("_error"):
			return state
		job = state.get("exportJob", {}) if state.get("exportJob") is Dictionary else {}
		if job.get("id") != job_id:
			return _failure("The export queue changed before this job finished.")
		if job.get("status") == "ready":
			return await _download_png(job)
		if job.get("status") == "failed":
			var failure: Dictionary = job.get("error", {}) if job.get("error") is Dictionary else {}
			return _failure("Export failed: " + str(failure.get("message", "The renderer could not complete this job.")))
		if job.get("status") == "cancelled":
			return _failure("The export was cancelled.")
		await get_tree().create_timer(1.0).timeout
	return _failure("Timed out waiting for the browser renderer. The job is still pending; enable Follow MCP changes or cancel it in the workbench.")

func _rpc(method: String, params: Dictionary) -> Dictionary:
	var request_id := _next_id
	_next_id += 1
	var reply := await _http("/mcp", HTTPClient.METHOD_POST,
		JSON.stringify({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}), _json_headers)
	if reply.has("_error"):
		return reply
	var parsed: Variant = JSON.parse_string(reply.body.get_string_from_utf8())
	if not parsed is Dictionary:
		return _failure("The MCP endpoint returned invalid JSON.")
	if parsed.has("error"):
		return _failure(str(parsed.error.get("message", "JSON-RPC error")))
	if parsed.get("id") != request_id or not parsed.get("result") is Dictionary:
		return _failure("The JSON-RPC response did not match the request.")
	return parsed.result

func _tool(name: String, arguments: Dictionary) -> Dictionary:
	var reply := await _rpc("tools/call", {"name": name, "arguments": arguments})
	if reply.has("_error"):
		return reply
	var value: Variant = reply.get("structuredContent")
	if reply.get("isError", false):
		return _failure(JSON.stringify(value if value != null else reply.get("content", [])))
	if not value is Dictionary:
		return _failure("The tool did not return structured scene data.")
	return value

func _http(path: String, method: HTTPClient.Method, body: String = "", headers: PackedStringArray = []) -> Dictionary:
	var http := HTTPRequest.new()
	http.timeout = 15.0
	http.body_size_limit = 17 * 1024 * 1024
	http.max_redirects = 0
	add_child(http)
	var started := http.request(base_url + path, headers, method, body)
	if started != OK:
		http.queue_free()
		return _failure("Could not start HTTP request: " + error_string(started))
	var response: Array = await http.request_completed
	http.queue_free()
	if response[0] != HTTPRequest.RESULT_SUCCESS:
		return _failure("HTTP transport failed (%s). Is the local server running?" % response[0])
	var code: int = response[1]
	var bytes: PackedByteArray = response[3]
	if code < 200 or code >= 300:
		return _failure("HTTP %s: %s" % [code, bytes.get_string_from_utf8().left(600)])
	return {"status": code, "body": bytes}

func _download_png(job: Dictionary) -> Dictionary:
	var expected_path := "/api/exports/" + str(job.id)
	if job.get("url") != expected_path:
		return _failure("The completed export returned an unexpected download URL.")
	var response := await _http(expected_path, HTTPClient.METHOD_GET)
	if response.has("_error"):
		return response
	var image := Image.new()
	if image.load_png_from_buffer(response.body) != OK:
		return _failure("The completed export was not a readable PNG.")
	if not (output_directory.begins_with("user://") or output_directory.begins_with("res://")):
		return _failure("Choose a user:// or res:// output directory.")
	var directory_error := DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(output_directory))
	if directory_error != OK:
		return _failure("Could not create the output directory: " + error_string(directory_error))
	# A job ID makes each filename unique; rerunning the example retains earlier assets.
	var path := output_directory.path_join("village-house-" + str(job.id) + ".png")
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return _failure("Could not write the PNG: " + error_string(FileAccess.get_open_error()))
	file.store_buffer(response.body)
	file.close()
	var metadata_file := FileAccess.open(path.get_basename() + ".json", FileAccess.WRITE)
	if metadata_file == null:
		return _failure("The PNG was saved at %s, but its metadata file could not be written: %s" % [path, error_string(FileAccess.get_open_error())])
	metadata_file.store_string(JSON.stringify({"recipe": job.scene, "metadata": job.metadata}, "\t"))
	metadata_file.close()
	var sprite := Sprite2D.new()
	sprite.texture = ImageTexture.create_from_image(image)
	sprite.centered = false
	var anchor: Variant = job.get("metadata", {}).get("anchorPixels")
	sprite.offset = -Vector2(float(anchor[0]), float(anchor[1])) if anchor is Array and anchor.size() == 2 else -Vector2(image.get_size()) * 0.5
	sprite.position = Vector2(320, 410)
	add_child(sprite)
	return {"saved": path, "absolute_path": ProjectSettings.globalize_path(path), "width": image.get_width(), "height": image.get_height()}

func _failure(message: String) -> Dictionary:
	return {"_error": message}

func _finish(result: Dictionary) -> void:
	var failed := result.has("_error")
	if failed:
		_status.text = str(result._error)
	elif result.has("saved"):
		_status.text = "Saved: " + str(result.saved)
	elif result.has("queued"):
		_status.text = "Export queued. The local browser will render it."
	else:
		_status.text = "MCP check complete. See the Output panel."
	if failed:
		push_error(_status.text)
	else:
		print(JSON.stringify(result))
	if DisplayServer.get_name() == "headless":
		get_tree().quit(1 if failed else 0)
