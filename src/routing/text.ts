// Strict UTF-8 percent-encoding and decoding for the routing library
// (conformance/routing/README.md). Pure and total: text that is not valid
// UTF-16 (a lone surrogate) or bytes that are not valid UTF-8 give null, never
// an exception and never a replacement character. Written out by hand rather
// than with TextEncoder/TextDecoder, which replace invalid input silently and
// strip a byte-order mark, so the TypeScript and F# libraries agree byte for byte.

const isUnreserved = (byte: number): boolean =>
  (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)
  || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e;

/** UTF-16 text → UTF-8 bytes, or null for a lone surrogate. */
export const utf8Encode = (text: string): readonly number[] | null => {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes.push(unit);
    else if (unit < 0x800) bytes.push(0xc0 | (unit >> 6), 0x80 | (unit & 0x3f));
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = index + 1 < text.length ? text.charCodeAt(index + 1) : -1;
      if (low < 0xdc00 || low > 0xdfff) return null;
      const point = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
      bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
    else bytes.push(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f));
  }
  return bytes;
};

const continuation = (bytes: readonly number[], index: number): number | null => {
  const byte = bytes[index];
  return byte !== undefined && (byte & 0xc0) === 0x80 ? byte & 0x3f : null;
};

/** UTF-8 bytes → text, or null for anything that is not well-formed UTF-8. */
export const utf8Decode = (bytes: readonly number[]): string | null => {
  const units: number[] = [];
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index] ?? 0;
    const width = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    if (width === 0) return null;
    let point = width === 1 ? lead : lead & (0x7f >> width);
    for (let offset = 1; offset < width; offset += 1) {
      const bits = continuation(bytes, index + offset);
      if (bits === null) return null;
      point = (point << 6) | bits;
    }
    const minimum = width === 1 ? 0 : width === 2 ? 0x80 : width === 3 ? 0x800 : 0x10000;
    if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
    if (point >= 0x10000) units.push(0xd800 + ((point - 0x10000) >> 10), 0xdc00 + ((point - 0x10000) & 0x3ff));
    else units.push(point);
    index += width;
  }
  return units.map((unit) => String.fromCharCode(unit)).join("");
};

const HEX = "0123456789ABCDEF";

/** Every UTF-8 byte except A–Z a–z 0–9 - . _ ~ as %XX (upper case); null for a lone surrogate. */
export const percentEncode = (value: string): string | null => {
  const bytes = utf8Encode(value);
  return bytes === null
    ? null
    : bytes.map((byte) => (isUnreserved(byte) ? String.fromCharCode(byte) : `%${HEX[byte >> 4] ?? ""}${HEX[byte & 0xf] ?? ""}`)).join("");
};

const hexValue = (char: string | undefined): number | null => {
  if (char === undefined || char.length !== 1) return null;
  const code = char.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return null;
};

/**
 * Strict percent-decoding as UTF-8. An invalid or truncated escape, a lone
 * surrogate or invalid UTF-8 is null. `plusIsSpace` applies to query text.
 */
export const percentDecode = (plusIsSpace: boolean, value: string): string | null => {
  const bytes: number[] = [];
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char === "%") {
      const high = index + 2 < value.length ? hexValue(value[index + 1]) : null;
      const low = index + 2 < value.length ? hexValue(value[index + 2]) : null;
      if (high === null || low === null) return null;
      bytes.push(high * 16 + low);
      index += 3;
    } else if (plusIsSpace && char === "+") {
      bytes.push(0x20);
      index += 1;
    } else {
      let end = index;
      while (end < value.length && value[end] !== "%" && !(plusIsSpace && value[end] === "+")) end += 1;
      const run = utf8Encode(value.slice(index, end));
      if (run === null) return null;
      bytes.push(...run);
      index = end;
    }
  }
  return utf8Decode(bytes);
};

/** Ordinal (UTF-16 code unit) comparison, as String.CompareOrdinal. */
export const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Distinct, keeping the first occurrence. */
export const distinct = (items: readonly string[]): readonly string[] => items.filter((item, index) => items.indexOf(item) === index);
