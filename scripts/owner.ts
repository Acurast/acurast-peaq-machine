// Owner-side helper, run on your own computer (never on the processor).
// Gas Station 2FA needs a TOTP code from your authenticator app, and the bond top-up
// needs the owner key, so neither belongs in the Acurast deployment.
//
//   npm run owner keygen                 create MACHINE_PRIVATE_KEY in .env
//   npm run owner 2fa-setup              enrol the owner address with the Gas Station
//   npm run owner 2fa-confirm <code>     confirm enrolment
//   npm run owner fund <code>            Gas Station sends gas to the machine wallet
//   npm run owner topup                  owner sends the tier bond to the machine wallet
//   npm run owner status [device]        machine wallet, activation state, MCR
process.env.PEAQOS_TELEMETRY = "0";

import { appendFileSync } from "node:fs";
import { PeaqosClient, confirmFaucet2FA, fundFromGasStation, setupFaucet2FA, type SubscriptionTier } from "@peaqos/peaq-os-sdk";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveNetwork } from "../src/networks.js";

const FAUCET_URL = "https://depinstation.peaq.xyz";
const env = process.env;
const network = resolveNetwork(env);
const chain = defineChain({
  id: network.chainId,
  name: network.deploymentId,
  nativeCurrency: { name: "PEAQ", symbol: "PEAQ", decimals: 18 },
  rpcUrls: { default: { http: [network.rpcUrl] } },
});
const rpc = createPublicClient({ chain, transport: http() });

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}
const ownerKey = () => required("OWNER_PRIVATE_KEY") as Hex;
const ownerAddress = () => privateKeyToAccount(ownerKey()).address;
const machineAddress = () => privateKeyToAccount(required("MACHINE_PRIVATE_KEY") as Hex).address;
const machineClient = () =>
  new PeaqosClient<"tokenomics20">({
    rpcUrl: network.rpcUrl,
    privateKey: required("MACHINE_PRIVATE_KEY"),
    contracts: network.contracts,
    tokenomics20: { deploymentId: network.deploymentId },
  });

const [command, arg] = process.argv.slice(2);

switch (command) {
  case "keygen": {
    if (env.MACHINE_PRIVATE_KEY) throw new Error(`MACHINE_PRIVATE_KEY already set (address ${machineAddress()})`);
    const kp = PeaqosClient.generateKeypair();
    appendFileSync(".env", `\nMACHINE_PRIVATE_KEY=${kp.privateKey}\n`);
    console.log("Machine wallet:", kp.address, "(key written to .env; back it up, it cannot be recovered)");
    break;
  }

  case "2fa-setup": {
    const enrollment = await setupFaucet2FA(ownerAddress(), FAUCET_URL);
    console.log("Add this to your authenticator app (QR link expires in ~2 min):");
    console.log(" URI:", enrollment.otpauthUri);
    console.log(" QR: ", enrollment.qrImageUrl);
    break;
  }

  case "2fa-confirm": {
    if (!arg) throw new Error("usage: npm run owner 2fa-confirm <totp-code>");
    await confirmFaucet2FA(ownerAddress(), FAUCET_URL, arg);
    console.log("Gas Station 2FA confirmed for", ownerAddress());
    break;
  }

  case "fund": {
    if (!arg) throw new Error("usage: npm run owner fund <totp-code>");
    const res = await fundFromGasStation(
      { ownerAddress: ownerAddress(), targetWalletAddress: machineAddress(), chainId: "peaq", twoFactorCode: arg },
      FAUCET_URL,
    );
    console.log(res.status === "success" ? `Funded, tx ${res.txHash}` : `Skipped: ${JSON.stringify(res)}`);
    break;
  }

  case "topup": {
    // The bond is per tier, not per machine, so a placeholder machine ID quotes it.
    const target = machineAddress();
    const preview = await machineClient().previewMachineActivation({
      controller: target,
      verificationMethods: [],
      authentication: [],
      serviceEndpoints: [],
      machineType: "quote",
      credentialSubject: "0x00",
      manufacturer: target,
      tier: Number(env.MACHINE_TIER ?? 0) as SubscriptionTier,
    });
    const want = preview.netPeaqAmount + parseEther(env.TOPUP_GAS_PEAQ || "1");
    const have = await rpc.getBalance({ address: target });
    console.log(`Tier ${preview.tier} bond ${formatEther(preview.netPeaqAmount)} PEAQ; machine holds ${formatEther(have)} PEAQ`);
    if (have >= want) break;
    const wallet = createWalletClient({ account: privateKeyToAccount(ownerKey()), chain, transport: http() });
    const hash = await wallet.sendTransaction({ to: target, value: want - have });
    await rpc.waitForTransactionReceipt({ hash });
    console.log(`Sent ${formatEther(want - have)} PEAQ to ${target}, tx ${hash}`);
    break;
  }

  case "status": {
    const machine = machineClient();
    const address = machineAddress();
    console.log("Network:        ", network.deploymentId);
    console.log("Machine wallet: ", address, `${formatEther(await rpc.getBalance({ address }))} PEAQ`);
    // The processor logs its device address on every run; pass it to look the machine up.
    const credentialSubject = (env.MACHINE_CREDENTIAL_SUBJECT as Hex) || (arg && stringToHex(`acurast:${arg}`));
    if (!credentialSubject) {
      console.log("Pass the processor's device address to look up its machine: npm run owner status <device>");
      break;
    }
    const machineId = await machine.computeMachineId(env.MACHINE_TYPE || "AcurastProcessor", credentialSubject);
    console.log("peaqID:         ", `did:peaq:${machineId}`);
    try {
      const state = await machine.getMachineActivationState(machineId);
      console.log("Activated:      ", state.subscription.periodStart !== 0n, `(tier ${state.subscription.tier}, owner ${state.owner})`);
    } catch (err) {
      console.log("Activated:      ", false, `(${(err as Error).message})`);
      break;
    }
    if (network.hasMcr) {
      const mcr = await machine.queryMcr(`did:peaq:${machineId}`).catch((err: Error) => err.message);
      console.log("MCR:            ", typeof mcr === "string" ? mcr : `${mcr.mcr} (score ${mcr.mcrScore}, ${mcr.eventCount} events)`);
    }
    break;
  }

  default:
    console.log("commands: keygen | 2fa-setup | 2fa-confirm <code> | fund <code> | topup | status [device]");
}
