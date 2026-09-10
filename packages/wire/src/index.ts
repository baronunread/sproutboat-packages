// @sproutboat/wire: broker frame protocol and JSON validation utilities.
//
// Moved verbatim from sproutboat-cli/src/broker.ts, broker.test.ts and
// json.ts. The broker is a trust boundary process; this package is its
// protocol and storage behavior, shared by the CLI dev broker and the
// platform's edge/supervisor side.
export * from "./broker";
export * from "./json";
