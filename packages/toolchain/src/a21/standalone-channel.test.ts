import { expect, test } from "bun:test";
import { STANDALONE_DEFAULT_CHANNEL, standaloneChannel } from "./standalone-channel";

test("standalone builds default to alpha 22", () => {
  expect(STANDALONE_DEFAULT_CHANNEL).toBe("alpha-22");
  expect(standaloneChannel({})).toBe("alpha-22");
  expect(standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "" })).toBe("alpha-22");
  expect(standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "alpha-22" })).toBe("alpha-22");
});

test("alpha 19 stays selectable as the fallback pin", () => {
  expect(standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "alpha-19" })).toBe("alpha-19");
});

test("an unknown channel is an error, not a silent default", () => {
  expect(() => standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "alpha-21" })).toThrow(/expected alpha-22/);
});
