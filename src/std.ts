import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

// The subset of the Acurast Processor runtime (`_STD_`) this PoC uses.
// Reference: https://docs.acurast.com/docs/developers/build/nodejs-runtime-environment
export interface AcurastStd {
  env: Record<string, string | undefined>;
  device: { getAddress(): string };
  job: {
    getId(): { origin: { kind: string; source: string }; id: string };
    /** Public parts of the per-deployment job keys, compressed hex. */
    getPublicKeys(): { secp256k1: string; p256?: string; ed25519?: string };
  };
  signers: {
    /** Signs a 32-byte digest (hex, no 0x). Returns raw r||s hex, low-s, no recovery byte. */
    secp256k1: { sign(digestHex: string): string };
  };
}

declare const _STD_: AcurastStd | undefined;

export const onProcessor = typeof _STD_ !== "undefined";

/**
 * Returns the real `_STD_` on a processor. Off-processor (local runs) it returns a
 * stand-in whose processor key is derived from the machine key, so repeated local
 * runs map to the same machine ID.
 */
export function getStd(): AcurastStd {
  if (onProcessor) return _STD_!;

  const seed = process.env.MACHINE_PRIVATE_KEY ?? "local";
  const processorKey = keccak_256(utf8ToBytes(`acurast-peaq-machine/mock-processor/${seed}`));
  return {
    env: process.env,
    device: { getAddress: () => `local-${bytesToHex(keccak_256(processorKey)).slice(0, 16)}` },
    job: {
      getId: () => ({ origin: { kind: "Local", source: "0x00" }, id: "0" }),
      getPublicKeys: () => ({ secp256k1: bytesToHex(secp256k1.getPublicKey(processorKey, true)) }),
    },
    signers: {
      secp256k1: {
        sign: (digestHex) => bytesToHex(secp256k1.sign(hexToBytes(digestHex), processorKey, { prehash: false })),
      },
    },
  };
}
