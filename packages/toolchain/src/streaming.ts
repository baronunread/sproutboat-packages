/**
 * Streamed responses for standalone sprouts (sproutd B19), patched into Porffor's
 * uWebSockets shim (compiler/uwebsockets.js) by patchStreamingResponses.
 *
 * The prelude opens a stream (sb_stream_open), marks its Response with the internal
 * x-sb-stream: <id> header and returns at once with an empty body. The writer sees the
 * marker, sends the status and headers, and attaches the uWS response to the stream
 * instead of ending it. The prelude then pumps the ReadableStream: each chunk goes out with
 * sb_stream_write (chunked transfer encoding), and sb_stream_end finishes the response.
 * Chunks that arrive before the writer attaches (they can, while microtasks drain) are kept
 * and flushed on attach. A client that goes away marks the stream aborted, and the next
 * write returns -1 so the prelude cancels the source.
 *
 * Hosts without this shim (sproutd's workers) get the weak STREAM_STUBS: sb_stream_supported
 * returns 0 and the prelude keeps buffering the body.
 */

/** Inserted before write_response_value. C++ inside a JS template literal: no backticks, no ${. */
export const STREAM_REGISTRY = String.raw`// sproutboat B19: streamed responses
struct SbStream {
  uWS::HttpResponse<false>* res = nullptr;
  std::string pending;
  bool attached = false, ended = false, aborted = false;
};
static std::unordered_map<u32, SbStream> sb_streams;
static u32 sb_stream_next = 1;

extern "C" int sb_stream_supported(void) { return 1; }

extern "C" u32 sb_stream_open(void) {
  const u32 id = sb_stream_next++;
  sb_streams[id] = SbStream();
  return id;
}

extern "C" int sb_stream_write(u32 id, const char* data, size_t len) {
  auto it = sb_streams.find(id);
  if (it == sb_streams.end() || it->second.aborted) return -1;
  SbStream& s = it->second;
  if (!s.attached) { s.pending.append(data, len); return 0; }
  auto* res = s.res;
  res->cork([res, data, len]() { res->write(std::string_view(data, len)); });
  return 0;
}

extern "C" void sb_stream_end(u32 id) {
  auto it = sb_streams.find(id);
  if (it == sb_streams.end()) return;
  SbStream& s = it->second;
  if (!s.attached && !s.aborted) { s.ended = true; return; }
  if (!s.aborted) {
    auto* res = s.res;
    res->cork([res]() { res->end(); });
  }
  sb_streams.erase(it);
}

static void sb_stream_attach(u32 id, uWS::HttpResponse<false>* res) {
  auto it = sb_streams.find(id);
  if (it == sb_streams.end()) { res->end(); return; }
  SbStream& s = it->second;
  s.res = res;
  s.attached = true;
  res->onAborted([id]() {
    auto found = sb_streams.find(id);
    if (found == sb_streams.end()) return;
    found->second.aborted = true;
    found->second.res = nullptr;
  });
  if (!s.pending.empty()) { res->write(std::string_view(s.pending)); s.pending.clear(); }
  if (s.ended) { res->end(); sb_streams.erase(it); }
}

`;

export const STREAM_FORBIDDEN_ANCHOR =
  '         key == "x-sb-raw-body"; // sproutboat #176: internal signal, never sent\n';
export const STREAM_FORBIDDEN_INJECT =
  '         key == "x-sb-raw-body" || // sproutboat #176: internal signal, never sent\n' +
  '         key == "x-sb-stream"; // sproutboat B19: internal signal, never sent\n';

export const STREAM_SCAN_ANCHOR =
  '      if (std::string_view(scan_buf, scan_bytes) == "x-sb-raw-body") raw_body = true;\n';
export const STREAM_SCAN_INJECT =
  STREAM_SCAN_ANCHOR +
  '      if (std::string_view(scan_buf, scan_bytes) == "x-sb-stream") {\n' +
  "        const struct jsval stream_value = unpack_jsval(*((u64*)(porf_mem + scan_entries + i * 16 + 8)));\n" +
  "        const char* id_buf = nullptr;\n" +
  "        size_t id_len = 0;\n" +
  "        char* id_owned = nullptr;\n" +
  "        porf_native_fetch_read_value(stream_value, &id_buf, &id_len, &id_owned);\n" +
  "        stream_id = (u32)strtoul(std::string(id_buf, id_len).c_str(), nullptr, 10);\n" +
  "        if (id_owned) free(id_owned);\n" +
  "      }\n";

/** The scan loop above stops at the raw-body header; the stream id needs its own flag. */
export const STREAM_FLAG_ANCHOR = "  bool raw_body = false;\n";
export const STREAM_FLAG_INJECT = "  bool raw_body = false;\n  u32 stream_id = 0; // sproutboat B19\n";

export const STREAM_CORK_ANCHOR = "    res->cork([res, status, headers_entries_ptr, body_buf, body_len]() {\n";
export const STREAM_CORK_INJECT = "    res->cork([res, status, headers_entries_ptr, body_buf, body_len, stream_id]() {\n";

export const STREAM_END_ANCHOR = "      res->end(std::string_view(body_buf, body_len));\n";
export const STREAM_END_INJECT =
  "      if (stream_id) sb_stream_attach(stream_id, res); // sproutboat B19: the prelude pumps the body\n" +
  "      else res->end(std::string_view(body_buf, body_len));\n";

export const STREAM_REGISTRY_ANCHOR =
  "static void write_response_value(uWS::HttpResponse<false>* res, struct jsval response, bool* aborted) {\n";

/**
 * Weak fallbacks for the runtime C that render.js emits (compiler/render.js), inserted before
 * porf_native_fetch_read_raw_bytes. The shim's strong definitions above replace them in a
 * standalone server; everywhere else (sproutd's workers) sb_stream_supported() returns 0 and
 * the prelude buffers. Weak definitions, not weak undefined references: Mach-O will not link
 * an undefined weak reference without -U, while a weak definition links on ELF and Mach-O.
 */
export const STREAM_STUBS =
  "// sproutboat B19: streaming fallbacks, overridden by the native server's shim\n" +
  "__attribute__((weak)) int sb_stream_supported(void) { return 0; }\n" +
  "__attribute__((weak)) unsigned int sb_stream_open(void) { return 0; }\n" +
  "__attribute__((weak)) int sb_stream_write(unsigned int id, const char* data, size_t len) { (void)id; (void)data; (void)len; return -1; }\n" +
  "__attribute__((weak)) void sb_stream_end(unsigned int id) { (void)id; }\n\n";

export const STREAM_STUBS_ANCHOR = "// sproutboat #176: zero-copy passthrough";
