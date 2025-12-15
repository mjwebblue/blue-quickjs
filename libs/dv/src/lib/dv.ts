const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const MAX_SAFE_INT = Number.MAX_SAFE_INTEGER;
const MIN_SAFE_INT = Number.MIN_SAFE_INTEGER;

const CBOR_MAJOR_UINT = 0;
const CBOR_MAJOR_NINT = 1;
const CBOR_MAJOR_TEXT = 3;
const CBOR_MAJOR_ARRAY = 4;
const CBOR_MAJOR_MAP = 5;
const CBOR_MAJOR_SIMPLE = 7;

export type DV = DVPrimitive | DVArray | DVObject;
export type DVPrimitive = null | boolean | number | string;
export type DVArray = DV[];
export type DVObject = { [key: string]: DV };

export interface DvLimits {
  maxDepth: number;
  maxEncodedBytes: number;
  maxStringBytes: number;
  maxArrayLength: number;
  maxMapLength: number;
}

export const DV_LIMIT_DEFAULTS: Readonly<DvLimits> = {
  maxDepth: 64,
  maxEncodedBytes: 1_048_576,
  maxStringBytes: 262_144,
  maxArrayLength: 65_535,
  maxMapLength: 65_535,
};

type PartialLimits = Partial<DvLimits>;

export interface DvEncodeOptions {
  limits?: PartialLimits;
}

export type DvDecodeOptions = DvEncodeOptions;
export type DvValidateOptions = DvEncodeOptions;

export type DvErrorCode =
  | 'UNSUPPORTED_TYPE'
  | 'NAN_OR_INF'
  | 'INTEGER_OUT_OF_RANGE'
  | 'INVALID_STRING'
  | 'STRING_TOO_LONG'
  | 'ARRAY_TOO_LONG'
  | 'MAP_TOO_LONG'
  | 'DEPTH_EXCEEDED'
  | 'ENCODED_TOO_LARGE'
  | 'NON_CANONICAL_INTEGER'
  | 'NON_CANONICAL_FLOAT'
  | 'NON_CANONICAL_LENGTH'
  | 'INVALID_UTF8'
  | 'DUPLICATE_KEY'
  | 'KEY_ORDER'
  | 'UNSUPPORTED_CBOR'
  | 'TRUNCATED'
  | 'TRAILING_BYTES';

export class DvError extends Error {
  constructor(
    public readonly code: DvErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DvError';
  }
}

export function encodeDv(value: unknown, options?: DvEncodeOptions): Uint8Array {
  const limits = normalizeLimits(options?.limits);
  const builder = new ByteBuilder(limits.maxEncodedBytes);
  encodeValue(value, builder, limits, 0);
  return builder.toUint8Array();
}

export function decodeDv(
  input: ArrayBufferView | ArrayBuffer | Uint8Array,
  options?: DvDecodeOptions,
): DV {
  const limits = normalizeLimits(options?.limits);
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

  if (bytes.length > limits.maxEncodedBytes) {
    throw dvError(
      'ENCODED_TOO_LARGE',
      `encoded DV exceeds maxEncodedBytes (${bytes.length} > ${limits.maxEncodedBytes})`,
    );
  }

  const reader = new CborReader(bytes);
  const value = readValue(reader, limits, 0);

  if (!reader.isEOF()) {
    throw dvError('TRAILING_BYTES', 'unexpected trailing bytes after DV value');
  }

  return value;
}

export function validateDv(value: unknown, options?: DvValidateOptions): asserts value is DV {
  // Encoding performs full validation, including size/limit checks.
  encodeDv(value, options);
}

export function isDv(value: unknown, options?: DvValidateOptions): value is DV {
  try {
    validateDv(value, options);
    return true;
  } catch {
    return false;
  }
}

function normalizeLimits(limits?: PartialLimits): DvLimits {
  return {
    maxDepth: limits?.maxDepth ?? DV_LIMIT_DEFAULTS.maxDepth,
    maxEncodedBytes: limits?.maxEncodedBytes ?? DV_LIMIT_DEFAULTS.maxEncodedBytes,
    maxStringBytes: limits?.maxStringBytes ?? DV_LIMIT_DEFAULTS.maxStringBytes,
    maxArrayLength: limits?.maxArrayLength ?? DV_LIMIT_DEFAULTS.maxArrayLength,
    maxMapLength: limits?.maxMapLength ?? DV_LIMIT_DEFAULTS.maxMapLength,
  };
}

class ByteBuilder {
  private readonly chunks: number[] = [];
  private size = 0;

  constructor(private readonly maxBytes: number) {}

  pushByte(byte: number): void {
    this.ensure(1);
    this.chunks.push(byte & 0xff);
    this.size += 1;
  }

  pushBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    for (const b of bytes) {
      this.chunks.push(b);
    }
    this.size += bytes.length;
  }

  pushUint(value: number | bigint, width: 1 | 2 | 4 | 8): void {
    this.ensure(width);
    const view = new DataView(new ArrayBuffer(width));
    if (width === 1) {
      view.setUint8(0, Number(value));
    } else if (width === 2) {
      view.setUint16(0, Number(value), false);
    } else if (width === 4) {
      view.setUint32(0, Number(value), false);
    } else {
      view.setBigUint64(0, BigInt(value), false);
    }
    this.pushBytes(new Uint8Array(view.buffer));
  }

  pushFloat64(value: number): void {
    this.ensure(8);
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, false);
    this.pushBytes(new Uint8Array(view.buffer));
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }

  private ensure(additional: number): void {
    if (this.size + additional > this.maxBytes) {
      throw dvError(
        'ENCODED_TOO_LARGE',
        `encoded DV exceeds maxEncodedBytes (${this.size + additional} > ${this.maxBytes})`,
      );
    }
  }
}

function dvError(code: DvErrorCode, message: string): DvError {
  return new DvError(code, message);
}

function encodeValue(value: unknown, builder: ByteBuilder, limits: DvLimits, depth: number): void {
  if (value === null) {
    builder.pushByte(0xf6);
    return;
  }

  const type = typeof value;
  if (type === 'boolean') {
    builder.pushByte(value ? 0xf5 : 0xf4);
    return;
  }

  if (type === 'number') {
    encodeNumber(value as number, builder);
    return;
  }

  if (type === 'string') {
    encodeString(value as string, builder, limits);
    return;
  }

  if (Array.isArray(value)) {
    encodeArray(value as DVArray, builder, limits, depth);
    return;
  }

  if (isPlainObject(value)) {
    encodeMap(value as Record<string, unknown>, builder, limits, depth);
    return;
  }

  throw dvError('UNSUPPORTED_TYPE', `unsupported DV type: ${type}`);
}

function encodeNumber(value: number, builder: ByteBuilder): void {
  if (!Number.isFinite(value)) {
    throw dvError('NAN_OR_INF', 'DV numbers must be finite');
  }

  if (Object.is(value, -0)) {
    value = 0;
  }

  if (Number.isInteger(value)) {
    if (value > MAX_SAFE_INT || value < MIN_SAFE_INT) {
      throw dvError(
        'INTEGER_OUT_OF_RANGE',
        `integer is outside safe range (${value} not in [${MIN_SAFE_INT}, ${MAX_SAFE_INT}])`,
      );
    }
    encodeInteger(value, builder);
    return;
  }

  builder.pushByte(0xfb);
  builder.pushFloat64(value);
}

function encodeInteger(value: number, builder: ByteBuilder): void {
  if (value >= 0) {
    encodeTypeAndLength(builder, CBOR_MAJOR_UINT, value);
  } else {
    encodeTypeAndLength(builder, CBOR_MAJOR_NINT, -1 - value);
  }
}

function encodeString(value: string, builder: ByteBuilder, limits: DvLimits): void {
  if (!isWellFormedString(value)) {
    throw dvError('INVALID_STRING', 'string contains lone surrogate code points');
  }
  const bytes = textEncoder.encode(value);
  if (bytes.length > limits.maxStringBytes) {
    throw dvError(
      'STRING_TOO_LONG',
      `string exceeds maxStringBytes (${bytes.length} > ${limits.maxStringBytes})`,
    );
  }
  encodeTypeAndLength(builder, CBOR_MAJOR_TEXT, bytes.length);
  builder.pushBytes(bytes);
}

function encodeArray(
  value: DVArray,
  builder: ByteBuilder,
  limits: DvLimits,
  depth: number,
): void {
  const nextDepth = depth + 1;
  if (nextDepth > limits.maxDepth) {
    throw dvError('DEPTH_EXCEEDED', `maxDepth ${limits.maxDepth} exceeded`);
  }
  if (value.length > limits.maxArrayLength) {
    throw dvError(
      'ARRAY_TOO_LONG',
      `array length exceeds maxArrayLength (${value.length} > ${limits.maxArrayLength})`,
    );
  }

  encodeTypeAndLength(builder, CBOR_MAJOR_ARRAY, value.length);
  for (const element of value) {
    encodeValue(element, builder, limits, nextDepth);
  }
}

function encodeMap(
  value: Record<string, unknown>,
  builder: ByteBuilder,
  limits: DvLimits,
  depth: number,
): void {
  const keys = Object.keys(value);
  const nextDepth = depth + 1;

  if (nextDepth > limits.maxDepth) {
    throw dvError('DEPTH_EXCEEDED', `maxDepth ${limits.maxDepth} exceeded`);
  }
  if (keys.length > limits.maxMapLength) {
    throw dvError(
      'MAP_TOO_LONG',
      `map entries exceed maxMapLength (${keys.length} > ${limits.maxMapLength})`,
    );
  }

  const encodedKeys = keys.map((key) => {
    const keyBytes = encodeStringBytes(key, limits);
    const header = typeAndLengthBytes(CBOR_MAJOR_TEXT, keyBytes.length);
    const full = concat(header, keyBytes);
    return { key, encoded: full };
  });

  encodedKeys.sort((a, b) => compareCanonicalKeys(a.encoded, b.encoded));

  for (let i = 1; i < encodedKeys.length; i += 1) {
    if (compareCanonicalKeys(encodedKeys[i - 1].encoded, encodedKeys[i].encoded) === 0) {
      throw dvError('DUPLICATE_KEY', `map contains duplicate key "${encodedKeys[i].key}"`);
    }
  }

  encodeTypeAndLength(builder, CBOR_MAJOR_MAP, encodedKeys.length);
  for (const entry of encodedKeys) {
    builder.pushBytes(entry.encoded);
    encodeValue(value[entry.key], builder, limits, nextDepth);
  }
}

function encodeStringBytes(value: string, limits: DvLimits): Uint8Array {
  if (!isWellFormedString(value)) {
    throw dvError('INVALID_STRING', 'string contains lone surrogate code points');
  }
  const bytes = textEncoder.encode(value);
  if (bytes.length > limits.maxStringBytes) {
    throw dvError(
      'STRING_TOO_LONG',
      `string exceeds maxStringBytes (${bytes.length} > ${limits.maxStringBytes})`,
    );
  }
  return bytes;
}

function typeAndLengthBytes(major: number, length: number | bigint): Uint8Array {
  const builder = new ByteBuilder(Number.MAX_SAFE_INTEGER);
  encodeTypeAndLength(builder, major, length);
  return builder.toUint8Array();
}

function encodeTypeAndLength(
  builder: ByteBuilder,
  major: number,
  length: number | bigint,
): void {
  if (typeof length === 'number' && (!Number.isInteger(length) || length < 0)) {
    throw dvError('NON_CANONICAL_LENGTH', `length must be a non-negative integer: ${length}`);
  }

  const value = typeof length === 'bigint' ? length : BigInt(length);

  if (value <= 23n) {
    builder.pushByte((major << 5) | Number(value));
  } else if (value <= 0xffn) {
    builder.pushByte((major << 5) | 24);
    builder.pushUint(value, 1);
  } else if (value <= 0xffffn) {
    builder.pushByte((major << 5) | 25);
    builder.pushUint(value, 2);
  } else if (value <= 0xffffffffn) {
    builder.pushByte((major << 5) | 26);
    builder.pushUint(value, 4);
  } else {
    builder.pushByte((major << 5) | 27);
    builder.pushUint(value, 8);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isWellFormedString(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= value.length) {
        return false;
      }
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

class CborReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  readByte(): number {
    if (this.offset >= this.bytes.length) {
      throw dvError('TRUNCATED', 'unexpected end of buffer');
    }
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value;
  }

  readUint8(): number {
    return this.readByte();
  }

  readUint16(): number {
    if (this.offset + 2 > this.bytes.length) {
      throw dvError('TRUNCATED', 'unexpected end of buffer');
    }
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      2,
    );
    const value = view.getUint16(0, false);
    this.offset += 2;
    return value;
  }

  readUint32(): number {
    if (this.offset + 4 > this.bytes.length) {
      throw dvError('TRUNCATED', 'unexpected end of buffer');
    }
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4,
    );
    const value = view.getUint32(0, false);
    this.offset += 4;
    return value;
  }

  readUint64(): bigint {
    if (this.offset + 8 > this.bytes.length) {
      throw dvError('TRUNCATED', 'unexpected end of buffer');
    }
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8,
    );
    const value = view.getBigUint64(0, false);
    this.offset += 8;
    return value;
  }

  readFloat64(): number {
    if (this.offset + 8 > this.bytes.length) {
      throw dvError('TRUNCATED', 'unexpected end of buffer');
    }
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8,
    );
    const value = view.getFloat64(0, false);
    this.offset += 8;
    return value;
  }

  takeSlice(start: number, end: number): Uint8Array {
    return this.bytes.slice(start, end);
  }

  position(): number {
    return this.offset;
  }

  isEOF(): boolean {
    return this.offset === this.bytes.length;
  }
}

function readValue(reader: CborReader, limits: DvLimits, depth: number): DV {
  const initial = reader.readByte();
  const major = initial >> 5;
  const additional = initial & 0x1f;

  switch (major) {
    case CBOR_MAJOR_UINT:
      return readUnsigned(additional, reader);
    case CBOR_MAJOR_NINT:
      return readNegative(additional, reader);
    case CBOR_MAJOR_TEXT:
      return readText(additional, reader, limits);
    case CBOR_MAJOR_ARRAY:
      return readArray(additional, reader, limits, depth);
    case CBOR_MAJOR_MAP:
      return readMap(additional, reader, limits, depth);
    case CBOR_MAJOR_SIMPLE:
      return readSimpleOrFloat(additional, reader);
    default:
      throw dvError('UNSUPPORTED_CBOR', `unsupported CBOR major type ${major}`);
  }
}

function readUnsigned(additional: number, reader: CborReader): number {
  const value = readLengthValue(additional, reader);
  if (value > MAX_SAFE_INT) {
    throw dvError(
      'INTEGER_OUT_OF_RANGE',
      `integer is outside safe range (${value} > ${MAX_SAFE_INT})`,
    );
  }
  return Number(value);
}

function readNegative(additional: number, reader: CborReader): number {
  const value = readLengthValue(additional, reader);
  if (value >= BigInt(MAX_SAFE_INT)) {
    throw dvError(
      'INTEGER_OUT_OF_RANGE',
      `integer is outside safe range (-1 - ${value} < ${MIN_SAFE_INT})`,
    );
  }
  return -1 - Number(value);
}

function readText(additional: number, reader: CborReader, limits: DvLimits): string {
  const length = readLength(additional, reader);
  if (length > limits.maxStringBytes) {
    throw dvError(
      'STRING_TOO_LONG',
      `string exceeds maxStringBytes (${length} > ${limits.maxStringBytes})`,
    );
  }
  const start = reader.position();
  for (let i = 0; i < length; i += 1) {
    reader.readByte();
  }
  const bytes = reader.takeSlice(start, start + length);
  let decoded: string;
  try {
    decoded = textDecoder.decode(bytes);
  } catch {
    throw dvError('INVALID_UTF8', 'invalid UTF-8 in string');
  }
  const roundTrip = textEncoder.encode(decoded);
  if (!bytesEqual(bytes, roundTrip)) {
    throw dvError('INVALID_UTF8', 'invalid UTF-8 in string');
  }
  return decoded;
}

function readArray(
  additional: number,
  reader: CborReader,
  limits: DvLimits,
  depth: number,
): DVArray {
  const length = readLength(additional, reader);
  const nextDepth = depth + 1;
  if (nextDepth > limits.maxDepth) {
    throw dvError('DEPTH_EXCEEDED', `maxDepth ${limits.maxDepth} exceeded`);
  }
  if (length > limits.maxArrayLength) {
    throw dvError(
      'ARRAY_TOO_LONG',
      `array length exceeds maxArrayLength (${length} > ${limits.maxArrayLength})`,
    );
  }
  const result: DVArray = [];
  for (let i = 0; i < length; i += 1) {
    result.push(readValue(reader, limits, nextDepth));
  }
  return result;
}

function readMap(
  additional: number,
  reader: CborReader,
  limits: DvLimits,
  depth: number,
): DVObject {
  const length = readLength(additional, reader);
  const nextDepth = depth + 1;

  if (nextDepth > limits.maxDepth) {
    throw dvError('DEPTH_EXCEEDED', `maxDepth ${limits.maxDepth} exceeded`);
  }
  if (length > limits.maxMapLength) {
    throw dvError(
      'MAP_TOO_LONG',
      `map entries exceed maxMapLength (${length} > ${limits.maxMapLength})`,
    );
  }

  const result: DVObject = Object.create(null);
  let previousKey: Uint8Array | undefined;

  for (let i = 0; i < length; i += 1) {
    const keyStart = reader.position();
    const keyInitial = reader.readByte();
    const keyMajor = keyInitial >> 5;
    if (keyMajor !== CBOR_MAJOR_TEXT) {
      throw dvError('UNSUPPORTED_CBOR', 'map keys must be text strings');
    }
    const key = readText(keyInitial & 0x1f, reader, limits);
    const keyEnd = reader.position();
    const encodedKey = reader.takeSlice(keyStart, keyEnd);

    if (previousKey) {
      const ordering = compareCanonicalKeys(previousKey, encodedKey);
      if (ordering === 0) {
        throw dvError('DUPLICATE_KEY', `map contains duplicate key "${key}"`);
      }
      if (ordering > 0) {
        throw dvError('KEY_ORDER', 'map keys are not in canonical order');
      }
    }

    previousKey = encodedKey;
    result[key] = readValue(reader, limits, nextDepth);
  }

  return result;
}

function readSimpleOrFloat(additional: number, reader: CborReader): DVPrimitive {
  if (additional === 20) {
    return false;
  }
  if (additional === 21) {
    return true;
  }
  if (additional === 22) {
    return null;
  }
  if (additional === 27) {
    const value = reader.readFloat64();
    if (!Number.isFinite(value)) {
      throw dvError('NAN_OR_INF', 'DV numbers must be finite');
    }
    if (Number.isInteger(value)) {
      throw dvError('NON_CANONICAL_FLOAT', 'integers must use CBOR integer encoding');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (additional === 31) {
    throw dvError('NON_CANONICAL_LENGTH', 'indefinite lengths are not allowed');
  }
  if (additional === 24 || additional === 25 || additional === 26) {
    throw dvError('NON_CANONICAL_FLOAT', 'only float64 is allowed');
  }
  throw dvError('UNSUPPORTED_CBOR', `unsupported simple value ${additional}`);
}

function readLength(additional: number, reader: CborReader): number {
  const value = readLengthValue(additional, reader);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw dvError('NON_CANONICAL_LENGTH', 'length exceeds supported range');
  }
  return Number(value);
}

function readLengthValue(additional: number, reader: CborReader): bigint {
  if (additional <= 23) {
    return BigInt(additional);
  }
  if (additional === 24) {
    const value = reader.readUint8();
    if (value < 24) {
      throw dvError('NON_CANONICAL_LENGTH', 'length not using shortest encoding');
    }
    return BigInt(value);
  }
  if (additional === 25) {
    const value = reader.readUint16();
    if (value <= 0xff) {
      throw dvError('NON_CANONICAL_LENGTH', 'length not using shortest encoding');
    }
    return BigInt(value);
  }
  if (additional === 26) {
    const value = reader.readUint32();
    if (value <= 0xffff) {
      throw dvError('NON_CANONICAL_LENGTH', 'length not using shortest encoding');
    }
    return BigInt(value);
  }
  if (additional === 27) {
    const value = reader.readUint64();
    if (value <= 0xffffffffn) {
      throw dvError('NON_CANONICAL_LENGTH', 'length not using shortest encoding');
    }
    return value;
  }
  if (additional === 31) {
    throw dvError('NON_CANONICAL_LENGTH', 'indefinite lengths are not allowed');
  }
  throw dvError('UNSUPPORTED_CBOR', `unsupported additional info ${additional}`);
}

function compareCanonicalKeys(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
