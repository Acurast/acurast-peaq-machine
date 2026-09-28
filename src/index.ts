// Entry point that runs on the Acurast Processor, once per execution.
// Every step is idempotent, so each interval execution does:
//   1. derive the machine ID from this processor's identity
//   2. activate the machine on peaq if it is not active yet (peaqID + Machine NFT + tier bond)
//   3. submit one processor-signed activity event to the EventRegistry (Qualify)
//   4. log the machine's current MCR
process.env.PEAQOS_TELEMETRY = "0"; // the SDK phones home to PostHog by default

import {
  EVENT_TYPE_ACTIVITY,
  PeaqosClient,
  SUPPORTED_CHAIN_IDS,
  TRUST_HARDWARE_SIGNED,
  TRUST_SELF_REPORTED,
  computeDataHash,
  type ActivateMachineParams,
  type SubscriptionTier,
} from "@peaqos/peaq-os-sdk";
import { base58 } from "@scure/base";
import { formatEther, parseEther, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { padGasEstimates } from "./gas.js";
import { resolveNetwork } from "./networks.js";
import { getStd, onProcessor } from "./std.js";

const std = getStd();
const env = std.env;

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const toJson = (data: unknown) => JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v));

// Optional remote log sink. Every line is POSTed to WEBHOOK_URL as JSON; `run` groups
// the lines of one execution. Pending posts are awaited before the script exits.
const webhookUrl = env.WEBHOOK_URL;
const run = { startedAt: new Date().toISOString(), seq: 0, device: undefined as string | undefined, job: undefined as string | undefined };
const pending: Promise<unknown>[] = [];

function log(msg: string, data?: unknown, level: "info" | "error" = "info") {
  (level === "error" ? console.error : console.log)(`[peaq-machine] ${msg}`, data === undefined ? "" : toJson(data));
  if (!webhookUrl) return;
  const body = toJson({ level, msg, data, seq: run.seq++, at: new Date().toISOString(), run: { startedAt: run.startedAt, device: run.device, job: run.job, onProcessor } });
  pending.push(
    fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) }).catch(
      (err: Error) => console.error("[peaq-machine] webhook failed:", err.message),
    ),
  );
}

async function main() {
  const network = resolveNetwork(env);
  // Key custody note: MACHINE_PRIVATE_KEY is a plain software key. It reaches the processor as
  // an encrypted environment variable and is decrypted into this process's memory. It is not
  // generated in, or held by, a secure enclave or hardware keystore on the device, because the
  // peaqOS SDK signs transactions with a raw private key. Treat it as a hot key, and keep only
  // the bond and some gas in its wallet.
  const machineKey = required("MACHINE_PRIVATE_KEY") as Hex;
  const machineAddress = privateKeyToAccount(machineKey).address;
  const dryRun = env.DRY_RUN === "1";

  const machine = new PeaqosClient<"tokenomics20">({
    rpcUrl: network.rpcUrl,
    privateKey: machineKey,
    contracts: network.contracts,
    tokenomics20: { deploymentId: network.deploymentId },
  });
  padGasEstimates(machine);

  // Processor identity. The device address is stable per phone. The secp256k1 key is the
  // per-deployment job key that the Acurast runtime manages and signs with through `_STD_`.
  // This PoC does not verify where or how the runtime stores that key.
  const deviceAddress = std.device.getAddress();
  const processorPubKey = std.job.getPublicKeys().secp256k1;
  const job = std.job.getId();
  run.device = deviceAddress;
  run.job = `${job.origin.source}:${job.id}`;

  // machineType + credentialSubject fix the machine ID forever. By default the anchor is
  // the processor's device address: one peaq machine per Acurast processor.
  const machineType = env.MACHINE_TYPE || "AcurastProcessor";
  const credentialSubject = (env.MACHINE_CREDENTIAL_SUBJECT as Hex) || stringToHex(`acurast:${deviceAddress}`);
  const machineId = await machine.computeMachineId(machineType, credentialSubject);
  const did = `did:peaq:${machineId}`;
  log("identity", { onProcessor, network: network.deploymentId, machineAddress, deviceAddress, processorPubKey, job, did });

  // 2. Activate if needed.
  if (!(await isActivated(machine, machineId))) {
    const params: ActivateMachineParams = {
      controller: machineAddress,
      verificationMethods: [
        {
          id: "#acurast-processor",
          methodType: "EcdsaSecp256k1VerificationKey2019",
          controller: machineAddress,
          // multibase base58btc ("z") of the compressed secp256k1 public key
          publicKeyMultibase: `z${base58.encode(Buffer.from(processorPubKey, "hex"))}`,
        },
      ],
      authentication: [0n],
      serviceEndpoints: [
        { id: "#acurast-device", serviceType: "AcurastProcessor", serviceEndpoint: `acurast:processor:${deviceAddress}` },
        { id: "#acurast-deployment", serviceType: "AcurastDeployment", serviceEndpoint: `acurast:deployment:${job.origin.source}:${job.id}` },
      ],
      machineType,
      credentialSubject,
      manufacturer: (env.MACHINE_MANUFACTURER as Hex) || machineAddress,
      tier: Number(env.MACHINE_TIER ?? 0) as SubscriptionTier,
      expectedMachineId: machineId,
      // Safety cap: never bond more than this, whatever the oracle says.
      maxNetPeaqAmount: parseEther(env.MAX_BOND_PEAQ || "1"),
    };

    const preview = await machine.previewMachineActivation(params);
    log("activation preview", {
      tier: preview.tier,
      bond: formatEther(preview.bondAmount),
      net: formatEther(preview.netPeaqAmount),
      balance: formatEther(preview.balance),
      approvalRequired: preview.approvalRequired,
    });
    if (preview.balance < preview.netPeaqAmount) {
      log(`not funded: send at least ${formatEther(preview.netPeaqAmount)} PEAQ plus gas to ${machineAddress}; retrying next execution`);
      return;
    }
    if (dryRun) return log("DRY_RUN=1, stopping before activation");

    const result = await machine.activateMachine(params);
    log("activated", { machineId: result.machineId, bonded: formatEther(result.bondAmount), paid: formatEther(result.netPeaqAmount) });
  }

  // 3. Qualify: one activity event per execution, signed by the processor key.
  // The chain stores keccak256(rawData); the processor signs that same hash and the
  // signature travels in `metadata`, verifiable against #acurast-processor in the DID doc.
  const rawData = new TextEncoder().encode(
    JSON.stringify({ kind: "heartbeat", deviceAddress, job: `${job.origin.source}:${job.id}`, at: new Date().toISOString() }),
  );
  const dataHash = computeDataHash(rawData);
  const signature = std.signers.secp256k1.sign(dataHash.slice(2));
  const metadata = new TextEncoder().encode(JSON.stringify({ alg: "ES256K", key: "#acurast-processor", pub: processorPubKey, sig: signature }));

  if (dryRun) {
    log("DRY_RUN=1, skipping event submission", { dataHash, signature });
  } else {
    // The registry rejects timestamps ahead of the chain, and a phone's clock can run ahead,
    // so the event is dated from the latest block instead of the device clock.
    const { timestamp: blockTime } = await machine.publicClient.getBlock();
    const event = await machine.submitEvent({
      machineId,
      eventType: EVENT_TYPE_ACTIVITY,
      value: 0,
      currency: "",
      timestamp: Number(blockTime) - 10,
      rawData,
      // The trust level the PoC asks for, not an attestation: events from a processor are
      // signed by the runtime's job key, local runs by a mock key.
      trustLevel: onProcessor ? TRUST_HARDWARE_SIGNED : TRUST_SELF_REPORTED,
      sourceChainId: SUPPORTED_CHAIN_IDS.peaq,
      sourceTxHash: null,
      metadata,
    });
    log("activity event submitted", event);
  }

  // 4. Report the rating (Provisioned until enough history has accrued).
  if (network.hasMcr) {
    try {
      const mcr = await machine.queryMcr(did);
      log("mcr", { rating: mcr.mcr, score: mcr.mcrScore, events: mcr.eventCount, bond: mcr.bondStatus });
    } catch (err) {
      log("mcr not available yet", { error: (err as Error).message });
    }
  }
}

async function isActivated(machine: PeaqosClient<"tokenomics20">, machineId: bigint): Promise<boolean> {
  try {
    const state = await machine.getMachineActivationState(machineId);
    // tier 0 is valid, so the docs say to test periodStart, never the tier
    return state.subscription.periodStart !== 0n;
  } catch (err) {
    if ((err as { code?: string }).code === "MACHINE_NOT_FOUND") return false;
    throw err;
  }
}

main()
  .catch((err) => {
    log("failed", { error: (err as Error).message, code: (err as { code?: string }).code, stack: (err as Error).stack }, "error");
    process.exitCode = 1;
  })
  .finally(() => Promise.allSettled(pending));
