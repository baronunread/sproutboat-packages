/** Opt-in, versioned native primitives for the offline LTX restore build. */
export const NATIVE_BYTES_MARKER = "sproutboat: native bytes ABI v1";
export const NATIVE_BYTES_LAYOUT =
  "// typedarray layout: length (i32, -1 if dynamic), dataPtr (i32, buffer + 4 + byteOffset), byteOffset (i32), fixed length (i32, -1 if length-tracking)";
export const NATIVE_BYTES_RENDER_ANCHOR = "  const funcByName = new Map();\n";
export const NATIVE_BYTES_RENDER_GUARD = String.raw`  // sproutboat: native bytes ABI v1
  const sbNativeBytes = funcs.some(f => f?.internal && f.name.startsWith('__Porffor_sproutboat_'));
  if (sbNativeBytes) {
    if (prefs.sbNativeBytesV1 !== true)
      throw new Error('Sproutboat native bytes v1 is disabled; only a trusted restore build may set --sb-native-bytes-v1');
    if (!prefs.nativeFetch || !/\bstatic\s+uint64_t\s+sb_ltx_crc\s*\(\s*uint64_t\s+\w+\s*,\s*const\s+void\s*\*\s*\w+\s*,\s*size_t\s+\w+\s*\)\s*\{/.test(prefs.rawHead || ''))
      throw new Error('Sproutboat native bytes v1 requires the sb_ltx_crc provider in the actual embedded transport');
  }
`;

// Compiler-owned helpers resolve views through the pinned compiler's typed-array
// implementation. Raw pointers never escape a synchronous, non-allocating C call.
export const NATIVE_BYTES_SOURCE =
  String.raw`// sproutboat: native bytes ABI v1
import type {} from './porffor.d.ts';

export const __Porffor_sproutboat_view_v1 = (data: any, offset: number, length: number, writable: boolean): i32 => {
  if (Porffor.type(data) != Porffor.TYPES.uint8array) throw new TypeError('native bytes v1 requires Uint8Array');
  const size: i32 = __Porffor_typedArray_validate(data);
  const buffer: i32 = __Porffor_typedArray_buffer(data);
  if (Porffor.IR.loadI32(data, 0) < 0 || Porffor.IR.loadI32(buffer, 4) != 0x7fffffff)
    throw new TypeError('native bytes v1 requires a fixed, non-shared mutable ArrayBuffer');
  if (writable) __Porffor_typedArray_validateWrite(data);
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 ||
      length > 1048576 || offset > size || length > size - offset)
    throw new RangeError('native bytes v1 view bounds');
  return Porffor.IR.loadI32(data, 4) + 4 + offset;
};

export const __Porffor_sproutboat_fd_v1 = (fd: number): void => {
  if (!Number.isInteger(fd) || fd < 0 || fd > 2147483647) throw new RangeError('native bytes v1 file descriptor');
};

export const __Porffor_sproutboat_position_v1 = (position: number, length: number): void => {
  if (!Number.isSafeInteger(position) || position < 0 || position > 9007199254740991 - length)
    throw new RangeError('native bytes v1 file position');
};

// State is the raw, uncomplemented CRC in eight big-endian bytes (initially FF).
export const __Porffor_sproutboat_crc64_v1 = (state: any, data: any, offset: number, length: number): void => {
  const statePtr: i32 = __Porffor_sproutboat_view_v1(state, 0, 8, true);
  const dataPtr: i32 = __Porffor_sproutboat_view_v1(data, offset, length, false);
  const nativeLength: i32 = length;
  Porffor.c` +
  "`" +
  String.raw`
    unsigned char *s = MEM + (u32)statePtr;
    const unsigned char *p = MEM + (u32)dataPtr;
    uint64_t crc = 0;
    for (int i = 0; i < 8; i++) crc = (crc << 8) | s[i];
    crc = sb_ltx_crc(crc, p, (size_t)nativeLength);
    for (int i = 7; i >= 0; i--) { s[i] = (unsigned char)crc; crc >>= 8; }
  ` +
  "`" +
  String.raw`;
};

// 0 = pread, 1 = pwrite. EOF returns the short count; errors return -errno,
// including an error after partial progress. Never retain a view pointer.
export const __Porffor_sproutboat_file_io_v1 = (operation: number, fd: number, data: any, offset: number, length: number, position: number): number => {
  if (!Number.isInteger(operation) || operation < 0 || operation > 1) throw new RangeError('native bytes v1 I/O operation');
  __Porffor_sproutboat_fd_v1(fd);
  __Porffor_sproutboat_position_v1(position, length);
  const ptr: i32 = __Porffor_sproutboat_view_v1(data, offset, length, operation == 0);
  if (length > 131072) throw new RangeError('native bytes v1 I/O chunk exceeds 128 KiB');
  const nativeOp: i32 = operation;
  const nativeFd: i32 = fd;
  const nativePosition: f64 = position;
  const nativeLength: i32 = length;
  let result: number = 0;
  Porffor.c` +
  "`" +
  String.raw`
    unsigned char *p = MEM + (u32)ptr;
    size_t done = 0;
    while (done < (size_t)nativeLength) {
      ssize_t n = nativeOp == 0 ? pread(nativeFd, p + done, (size_t)nativeLength - done, (off_t)nativePosition + done)
                                 : pwrite(nativeFd, p + done, (size_t)nativeLength - done, (off_t)nativePosition + done);
      if (n < 0 && errno == EINTR) continue;
      if (n < 0) { result = -(f64)errno; break; }
      if (n == 0) { result = (f64)done; break; }
      done += (size_t)n;
      result = (f64)done;
    }
  ` +
  "`" +
  String.raw`;
  return result;
};

// 0 = open read, 1 = open create/truncate, 2 = size, 3 = close,
// 4 = fsync, 5 = truncate. Native failures return -errno.
export const __Porffor_sproutboat_file_ctl_v1 = (operation: number, path: any, fd: number, position: number): number => {
  if (!Number.isInteger(operation) || operation < 0 || operation > 5) throw new RangeError('native bytes v1 control operation');
  if (operation < 2) {
    const type: i32 = Porffor.type(path);
    if (type != Porffor.TYPES.string && type != Porffor.TYPES.bytestring) throw new TypeError('native bytes v1 path must be a string');
    if (path.length > 4095) throw new RangeError('native bytes v1 path too long');
  } else __Porffor_sproutboat_fd_v1(fd);
  if (operation == 5) __Porffor_sproutboat_position_v1(position, 0);
  const nativeOp: i32 = operation;
  let nativeFd: i32 = 0;
  let nativePosition: f64 = 0;
  if (operation >= 2) nativeFd = fd;
  if (operation == 5) nativePosition = position;
  let result: number = 0;
  Porffor.c` +
  "`" +
  String.raw`
    if (nativeOp < 2) {
      const char *text = NULL; char *owned = NULL; size_t n = 0;
      if (porf_native_fetch_read_value(path, &text, &n, &owned) || n == 0 || n > 4095 || memchr(text, 0, n)) result = -EINVAL;
      else {
        char *name = malloc(n + 1);
        if (!name) result = -ENOMEM;
        else {
          memcpy(name, text, n); name[n] = 0;
          int flags = nativeOp == 0 ? O_RDONLY | O_NONBLOCK : O_RDWR | O_CREAT | O_NONBLOCK;
          int opened = open(name, flags | O_NOFOLLOW | O_CLOEXEC, 0600);
          free(name);
          if (opened < 0) result = -(f64)errno;
          else {
            struct stat st;
            if (fstat(opened, &st)) { int saved = errno; close(opened); result = -(f64)saved; }
            else if (!S_ISREG(st.st_mode)) { close(opened); result = -EINVAL; }
            else if (nativeOp == 1 && ftruncate(opened, 0)) { int saved = errno; close(opened); result = -(f64)saved; }
            else result = opened;
          }
        }
      }
      if (owned) free(owned);
    } else if (nativeOp == 2) {
      struct stat st;
      if (fstat(nativeFd, &st)) result = -(f64)errno;
      else if (st.st_size < 0 || st.st_size > INT64_C(9007199254740991)) result = -EOVERFLOW;
      else result = (f64)st.st_size;
    } else {
      int rc = nativeOp == 3 ? close(nativeFd) : nativeOp == 4 ? fsync(nativeFd) : ftruncate(nativeFd, (off_t)nativePosition);
      result = rc < 0 ? -(f64)errno : 0;
    }
  ` +
  "`" +
  String.raw`;
  return result;
};
`;
