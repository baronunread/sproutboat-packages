/**
 * Which Porffor channel a standalone build uses. Alpha 22 (the alpha 21 line's compiler, composed in
 * sproutd's worker shape and served by the alpha 19 uWebSockets shim over the alpha 22 bridge) is the
 * default; `SPROUTBOAT_PORFFOR_CHANNEL=alpha-19` keeps the previous native-fetch build for one release
 * as a fallback pin. The CLI, the runtime's native tests and `scripts/test-native.ts` all resolve the
 * channel here, so they cannot disagree about the default.
 */
export type StandaloneChannel = "alpha-19" | "alpha-22";

export const STANDALONE_DEFAULT_CHANNEL: StandaloneChannel = "alpha-22";
export const STANDALONE_FALLBACK_CHANNEL: StandaloneChannel = "alpha-19";
export const STANDALONE_CHANNEL_ENV = "SPROUTBOAT_PORFFOR_CHANNEL";

export function standaloneChannel(env: Record<string, string | undefined> = process.env): StandaloneChannel {
  const raw = env[STANDALONE_CHANNEL_ENV];
  if (!raw) return STANDALONE_DEFAULT_CHANNEL;
  if (raw === "alpha-19" || raw === "alpha-22") return raw;
  throw new Error(`${STANDALONE_CHANNEL_ENV}=${raw}: expected alpha-22 (default) or alpha-19 (fallback)`);
}
