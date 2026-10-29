/**
 * The compatibility date from which `crypto.subtle` follows workerd's surface (RSA, ECDSA, Ed25519,
 * AES, key import and export, DOMException errors). A placeholder: the maintainers choose the
 * date. Keep it equal to `__SB_SUBTLE_DATE` in `native-fetch-prelude.js`; a test checks that.
 */
export const SUBTLE_DATE = "2026-11-06";
