/**
 * The one JSON contract the CLI decodes external payloads through: registry
 * responses, control-plane responses, broker request bodies. Parse at the I/O
 * boundary with `parseJsonValue`, then narrow with these guards — nothing
 * downstream should see an unparsed value.
 */
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export function isString(value: JsonValue | undefined): value is string {
  return value !== undefined && value === String(value);
}

export function isSafeInteger(value: JsonValue | undefined): value is number {
  return Number.isSafeInteger(value);
}

export function isBoolean(value: JsonValue | undefined): value is boolean {
  return value === true || value === false;
}

export function parseJsonValue(source: string): JsonValue {
  const value = JSON.parse(source);
  if (
    value === null ||
    value === true ||
    value === false ||
    value === String(value) ||
    Number.isFinite(value) ||
    value instanceof Object
  )
    return value;
  throw new Error("response was not valid JSON");
}

export function jsonObject(value: JsonValue): JsonObject | undefined {
  return value instanceof Object && !Array.isArray(value) ? value : undefined;
}
