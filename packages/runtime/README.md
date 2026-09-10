# `@sproutboat/runtime`

Single source of truth for the sprout runtime: the binding/trigger wrapper,
handler source validation, both transports (broker and embedded), and the
native-fetch prelude. These move as one because `wrap.ts` locates the
prelude and transports by file URL beside itself.
