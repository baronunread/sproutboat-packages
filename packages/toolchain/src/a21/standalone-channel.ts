import { CURRENT_ALPHA, type PorfforA21Channel } from "./pin";

/**
 * Which Porffor channel a standalone build uses. The toolchain supports one alpha at a time:
 * `CURRENT_ALPHA` (alpha 25), composed in sproutd's worker shape and served by the vendored uWebSockets shim over
 * the flat native-fetch bridge. `SPROUTBOAT_PORFFOR_CHANNEL` may name it; alpha 19 (which the CLI's removed
 * `--with-restore` build used), 21, 22, 23 and 24 are no longer supported: the variable names them in an error
 * instead of building something else under their name. The CLI, the runtime's native tests and
 * `scripts/test-native.ts` all resolve the channel here, so they cannot disagree about the default.
 */
export type StandaloneChannel = PorfforA21Channel;

export const STANDALONE_DEFAULT_CHANNEL: StandaloneChannel = CURRENT_ALPHA;
export const STANDALONE_CHANNEL_ENV = "SPROUTBOAT_PORFFOR_CHANNEL";

export function standaloneChannel(env: Record<string, string | undefined> = process.env): StandaloneChannel {
  const raw = env[STANDALONE_CHANNEL_ENV];
  if (!raw) return STANDALONE_DEFAULT_CHANNEL;
  if (raw === CURRENT_ALPHA) return raw;
  const retired = /^alpha-(19|2[1234])$/.test(raw)
    ? `; ${raw} is no longer supported, the toolchain keeps one alpha`
    : "";
  throw new Error(`${STANDALONE_CHANNEL_ENV}=${raw}: expected ${CURRENT_ALPHA}${retired}`);
}

/** The compiler channel a standalone channel renders with (the same one: there is one alpha). */
export function standaloneA21Channel(channel: StandaloneChannel): PorfforA21Channel {
  return channel;
}
