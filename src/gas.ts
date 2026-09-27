import type { PeaqosClient } from "@peaqos/peaq-os-sdk";

// peaq's eth_estimateGas under-counts its Substrate precompiles: the bond's transferFrom on
// the PEAQ token (0x…0809) ran out of gas on-chain with the estimated limit, although eth_call
// passes with it. The SDK sends writes without a gas limit, so pad the estimate here. Only the
// gas actually used is charged.
export const GAS_PADDING = 3n;

export function padGasEstimates(machine: PeaqosClient<"tokenomics20">) {
  const wallet = machine.walletClient;
  const writeContract = wallet.writeContract.bind(wallet);
  wallet.writeContract = (async (args: Parameters<typeof wallet.writeContract>[0]) => {
    if (args.gas !== undefined) return writeContract(args);
    const estimate = await machine.publicClient.estimateContractGas({ ...args, account: args.account ?? wallet.account! } as never);
    return writeContract({ ...args, gas: estimate * GAS_PADDING });
  }) as typeof wallet.writeContract;
}
