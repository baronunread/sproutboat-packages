import { CURRENT_ALPHA, type PorfforA21Channel } from "./pin";

/**
 * Which Porffor channel a standalone build uses. The alpha 21 line's compiler (one alpha at a time:
 * `CURRENT_ALPHA`, composed in sproutd's worker shape and served by the alpha 19 uWebSockets shim over the
 * alpha 22 bridge) is the default. `SPROUTBOAT_PORFFOR_CHANNEL=alpha-19` still selects the older native-fetch
 * build, which the CLI's `--with-restore` needs and which is frozen. Alpha 21, 22 and 23 are no longer
 * supported: the variable names them in an error instead of building something else under their name.
 * The CLI, the runtime's native tests and `scripts/test-native.ts` all resolve the channel here, so they
 * cannot disagree about the default.
 */
export type StandaloneChannel = "alpha-19" | PorfforA21Channel;

export const STANDALONE_DEFAULT_CHANNEL: StandaloneChannel = CURRENT_ALPHA;
export const STANDALONE_FALLBACK_CHANNEL: StandaloneChannel = "alpha-19";
export const STANDALONE_CHANNEL_ENV = "SPROUTBOAT_PORFFOR_CHANNEL";

export function standaloneChannel(env: Record<string, string | undefined> = process.env): StandaloneChannel {
  const raw = env[STANDALONE_CHANNEL_ENV];
  if (!raw) return STANDALONE_DEFAULT_CHANNEL;
  if (raw === "alpha-19" || raw === CURRENT_ALPHA) return raw;
  const retired = /^alpha-2[123]$/.test(raw) ? `; ${raw} is no longer supported, the toolchain keeps one alpha` : "";
  throw new Error(
    `${STANDALONE_CHANNEL_ENV}=${raw}: expected ${CURRENT_ALPHA} (default) or alpha-19 (frozen)${retired}`,
  );
}

/** The alpha 21 line's channel for a standalone channel: alpha 19 has none, so it gets the current alpha. */
export function standaloneA21Channel(_channel: StandaloneChannel): PorfforA21Channel {
  return CURRENT_ALPHA;
}
