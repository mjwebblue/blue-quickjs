export type DeterministicOutputKind = 'RESULT' | 'ERROR';

export interface DeterministicOutput {
  kind: DeterministicOutputKind;
  payload: string;
  gasUsed: bigint;
  gasRemaining: bigint;
}

export function parseDeterministicOutput(raw: string): DeterministicOutput {
  const trimmed = raw.trim();
  const match =
    /^(RESULT|ERROR)\s+(.+?)\s+GAS\s+remaining=(\d+)\s+used=(\d+)/.exec(
      trimmed,
    );
  if (!match) {
    throw new Error(`Unable to parse deterministic output: ${trimmed}`);
  }
  const [, kind, payload, remaining, used] = match;
  return {
    kind: kind as DeterministicOutputKind,
    payload,
    gasRemaining: BigInt(remaining),
    gasUsed: BigInt(used),
  };
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('hex string must have an even length');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`invalid hex at position ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}
