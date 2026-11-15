import { expect, test } from "bun:test";
import { STANDALONE_DEFAULT_CHANNEL, standaloneA21Channel, standaloneChannel } from "./standalone-channel";

test("standalone builds default to alpha 24", () => {
  expect(STANDALONE_DEFAULT_CHANNEL).toBe("alpha-24");
  expect(standaloneChannel({})).toBe("alpha-24");
  expect(standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "" })).toBe("alpha-24");
  expect(standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "alpha-24" })).toBe("alpha-24");
});

test("alpha 19 stays selectable (the frozen native-fetch build, the CLI's --with-restore)", () => {
  expect(standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "alpha-19" })).toBe("alpha-19");
});

test("alpha 21, 22 and 23 are errors that say so, not another alpha under their name", () => {
  for (const alpha of ["alpha-21", "alpha-22", "alpha-23"])
    expect(() => standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: alpha })).toThrow(/no longer supported/);
});

test("every standalone channel renders with the current alpha on the alpha 21 line", () => {
  expect(standaloneA21Channel("alpha-24")).toBe("alpha-24");
  expect(standaloneA21Channel("alpha-19")).toBe("alpha-24");
});

test("an unknown channel is an error, not a silent default", () => {
  expect(() => standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "alpha-25" })).toThrow(/expected alpha-24/);
});
