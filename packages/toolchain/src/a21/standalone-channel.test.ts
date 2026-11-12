import { expect, test } from "bun:test";
import { STANDALONE_DEFAULT_CHANNEL, standaloneA21Channel, standaloneChannel } from "./standalone-channel";

test("standalone builds default to alpha 23", () => {
  expect(STANDALONE_DEFAULT_CHANNEL).toBe("alpha-23");
  expect(standaloneChannel({})).toBe("alpha-23");
  expect(standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "" })).toBe("alpha-23");
  expect(standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "alpha-23" })).toBe("alpha-23");
});

test("alpha 22 and alpha 19 stay selectable", () => {
  expect(standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "alpha-22" })).toBe("alpha-22");
  expect(standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "alpha-19" })).toBe("alpha-19");
});

test("the alpha 21 line's channel for a standalone channel", () => {
  expect(standaloneA21Channel("alpha-23")).toBe("alpha-23");
  expect(standaloneA21Channel("alpha-22")).toBe("alpha-22");
  expect(standaloneA21Channel("alpha-19")).toBe("alpha-23");
});

test("an unknown channel is an error, not a silent default", () => {
  expect(() => standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "alpha-21" })).toThrow(/expected alpha-23/);
});
