import { decodeDv, type DV } from '@blue-quickjs/dv';

export type DeterministicEvalOutput =
  | {
      kind: 'result';
      value: DV;
      gasRemaining: bigint;
      gasUsed: bigint;
      raw: string;
    }
  | {
      kind: 'error';
      error: string;
      gasRemaining: bigint;
      gasUsed: bigint;
      raw: string;
    };

const GAS_MARKER = ' GAS remaining=';

export function parseDeterministicEvalOutput(
  raw: string,
): DeterministicEvalOutput {
  const normalized = raw.trim();
  const markerIndex = normalized.lastIndexOf(GAS_MARKER);
  if (markerIndex < 0) {
    throw new Error(`Missing gas trailer in output: ${normalized}`);
  }

  const prefix = normalized.slice(0, markerIndex);
  const trailer = normalized.slice(markerIndex + GAS_MARKER.length);
  const firstSpace = prefix.indexOf(' ');
  if (firstSpace < 0) {
    throw new Error(`Malformed output prefix: ${normalized}`);
  }

  const kind = prefix.slice(0, firstSpace);
  const payload = prefix.slice(firstSpace + 1);
  const { remaining, used } = parseGasTrailer(trailer);

  if (kind === 'RESULT') {
    const bytes = parseHexToBytes(payload);
    const value = decodeDv(bytes);
    return {
      kind: 'result',
      value,
      gasRemaining: remaining,
      gasUsed: used,
      raw: normalized,
    };
  }

  if (kind === 'ERROR') {
    return {
      kind: 'error',
      error: payload,
      gasRemaining: remaining,
      gasUsed: used,
      raw: normalized,
    };
  }

  throw new Error(`Unknown output kind: ${kind}`);
}

function parseGasTrailer(trailer: string): { remaining: bigint; used: bigint } {
  const usedMarker = ' used=';
  const usedIndex = trailer.indexOf(usedMarker);
  if (usedIndex < 0) {
    throw new Error(`Malformed gas trailer: ${trailer}`);
  }
  const remainingStr = trailer.slice(0, usedIndex).trim();
  const usedPart = trailer.slice(usedIndex + usedMarker.length).trim();
  const usedStr = usedPart.split(' ')[0];

  return {
    remaining: parseUint64(remainingStr, 'remaining'),
    used: parseUint64(usedStr, 'used'),
  };
}

function parseUint64(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${label} value: ${value}`);
  }
  return BigInt(value);
}

function parseHexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim();
  if (normalized.length % 2 !== 0) {
    throw new Error('Hex payload must have even length');
  }
  if (!/^[0-9a-f]+$/i.test(normalized)) {
    throw new Error('Hex payload contains non-hex characters');
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
