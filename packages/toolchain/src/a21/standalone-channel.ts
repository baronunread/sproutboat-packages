/**
 * Which Porffor channel a standalone build uses. Alpha 24 (the alpha 21 line's compiler, composed in
 * sproutd's worker shape and served by the alpha 19 uWebSockets shim over the alpha 22 bridge) is the
 * default; `SPROUTBOAT_PORFFOR_CHANNEL=alpha-23` selects the previous default for one release as a fallback,
 * `=alpha-22` the compiler before it, and `=alpha-19` the older native-fetch build. The CLI, the runtime's native tests and
 * `scripts/test-native.ts` all resolve the channel here, so they cannot disagree about the default.
 */
export type StandaloneChannel = "alpha-19" | "alpha-22" | "alpha-23" | "alpha-24";

export const STANDALONE_DEFAULT_CHANNEL: StandaloneChannel = "alpha-24";
export const STANDALONE_FALLBACK_CHANNEL: StandaloneChannel = "alpha-19";
export const STANDALONE_CHANNEL_ENV = "SPROUTBOAT_PORFFOR_CHANNEL";

export function standaloneChannel(env: Record<string, string | undefined> = process.env): StandaloneChannel {
  const raw = env[STANDALONE_CHANNEL_ENV];
  if (!raw) return STANDALONE_DEFAULT_CHANNEL;
  if (raw === "alpha-19" || raw === "alpha-22" || raw === "alpha-23" || raw === "alpha-24") return raw;
  throw new Error(
    `${STANDALONE_CHANNEL_ENV}=${raw}: expected alpha-24 (default), alpha-23, alpha-22 or alpha-19 (fallback)`,
  );
}

/** The alpha 21 line's channel for a standalone channel: alpha 19 has none, so it gets the default line. */
export function standaloneA21Channel(channel: StandaloneChannel): "alpha-22" | "alpha-23" | "alpha-24" {
  return channel === "alpha-22" || channel === "alpha-23" ? channel : "alpha-24";
}
