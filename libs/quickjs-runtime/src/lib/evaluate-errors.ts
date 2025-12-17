import type { CanonicalAbiManifest } from '@blue-quickjs/abi-manifest';

export type EvaluateVmErrorDetail =
  | {
      kind: 'host-error';
      code: string;
      tag: string;
      message: string;
    }
  | {
      kind: 'out-of-gas';
      code: 'OOG';
      tag: 'vm/out_of_gas';
      message: string;
    }
  | {
      kind: 'manifest-error';
      code: string;
      tag: 'vm/manifest';
      message: string;
    }
  | {
      kind: 'js-exception';
      code: 'JS_EXCEPTION';
      tag: 'vm/js_exception';
      name: string;
      message: string;
    }
  | {
      kind: 'unknown';
      code: 'UNKNOWN';
      tag: 'vm/unknown';
      message: string;
      name?: string;
    };

export type EvaluateInvalidOutputDetail = {
  kind: 'invalid-output';
  code: 'INVALID_OUTPUT';
  message: string;
  cause?: unknown;
};

export function mapVmError(
  payload: string,
  manifest: CanonicalAbiManifest,
): EvaluateVmErrorDetail {
  const { name, message } = parseErrorNameAndMessage(payload);
  const normalizedMessage = message || payload.trim();

  if (name === 'HostError') {
    const tag = normalizedMessage || 'host/error';
    return {
      kind: 'host-error',
      code: lookupHostErrorCode(tag, manifest),
      tag,
      message: tag,
    };
  }

  if (name === 'OutOfGas' || normalizedMessage === 'out of gas') {
    const detailMessage = normalizedMessage || 'out of gas';
    return {
      kind: 'out-of-gas',
      code: 'OOG',
      tag: 'vm/out_of_gas',
      message: detailMessage,
    };
  }

  if (name === 'ManifestError') {
    const detailMessage = normalizedMessage || 'manifest error';
    return {
      kind: 'manifest-error',
      code: deriveManifestErrorCode(normalizedMessage),
      tag: 'vm/manifest',
      message: detailMessage,
    };
  }

  if (name && name !== 'Error') {
    return {
      kind: 'js-exception',
      code: 'JS_EXCEPTION',
      tag: 'vm/js_exception',
      name,
      message: normalizedMessage,
    };
  }

  return {
    kind: 'unknown',
    code: 'UNKNOWN',
    tag: 'vm/unknown',
    name: name || undefined,
    message: normalizedMessage,
  };
}

export function createInvalidOutputError(
  message: string,
  cause: unknown,
): EvaluateInvalidOutputDetail {
  return {
    kind: 'invalid-output',
    code: 'INVALID_OUTPUT',
    message,
    cause,
  };
}

function parseErrorNameAndMessage(payload: string): {
  name: string;
  message: string;
} {
  const trimmed = payload.trim();
  const separator = trimmed.indexOf(':');
  if (separator < 0) {
    return { name: trimmed || 'Error', message: '' };
  }
  const name = trimmed.slice(0, separator).trim() || 'Error';
  const message = trimmed.slice(separator + 1).trim();
  return { name, message };
}

function lookupHostErrorCode(
  tag: string,
  manifest: CanonicalAbiManifest,
): string {
  if (tag === 'host/transport') {
    return 'HOST_TRANSPORT';
  }
  if (tag === 'host/envelope_invalid') {
    return 'HOST_ENVELOPE_INVALID';
  }
  for (const fn of manifest.functions) {
    for (const entry of fn.error_codes) {
      if (entry.tag === tag) {
        return entry.code;
      }
    }
  }
  return 'HOST_ERROR';
}

function deriveManifestErrorCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('abi manifest hash mismatch')) {
    return 'ABI_MANIFEST_HASH_MISMATCH';
  }
  return 'MANIFEST_ERROR';
}
