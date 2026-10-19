// Generator input only. Native modules use the generated, import-free block.
// One static assignment per class, not a loop over the exports: Porffor resolves a bare
// identifier such as ReadableStream at compile time from the globalThis.X assignments it
// can see. Where the prelude is a separate unit (sproutd), a dynamic install compiled
// `new ReadableStream()` in the app to a ReferenceError. gen-streams.ts checks the list.
import * as streams from "web-streams-polyfill";
if (globalThis.ByteLengthQueuingStrategy == null) globalThis.ByteLengthQueuingStrategy = streams.ByteLengthQueuingStrategy;
if (globalThis.CountQueuingStrategy == null) globalThis.CountQueuingStrategy = streams.CountQueuingStrategy;
if (globalThis.ReadableByteStreamController == null) globalThis.ReadableByteStreamController = streams.ReadableByteStreamController;
if (globalThis.ReadableStream == null) globalThis.ReadableStream = streams.ReadableStream;
if (globalThis.ReadableStreamBYOBReader == null) globalThis.ReadableStreamBYOBReader = streams.ReadableStreamBYOBReader;
if (globalThis.ReadableStreamBYOBRequest == null) globalThis.ReadableStreamBYOBRequest = streams.ReadableStreamBYOBRequest;
if (globalThis.ReadableStreamDefaultController == null) globalThis.ReadableStreamDefaultController = streams.ReadableStreamDefaultController;
if (globalThis.ReadableStreamDefaultReader == null) globalThis.ReadableStreamDefaultReader = streams.ReadableStreamDefaultReader;
if (globalThis.TransformStream == null) globalThis.TransformStream = streams.TransformStream;
if (globalThis.TransformStreamDefaultController == null) globalThis.TransformStreamDefaultController = streams.TransformStreamDefaultController;
if (globalThis.WritableStream == null) globalThis.WritableStream = streams.WritableStream;
if (globalThis.WritableStreamDefaultController == null) globalThis.WritableStreamDefaultController = streams.WritableStreamDefaultController;
if (globalThis.WritableStreamDefaultWriter == null) globalThis.WritableStreamDefaultWriter = streams.WritableStreamDefaultWriter;
