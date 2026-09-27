import type { Address } from "viem";

// peaq network presets, from https://docs.peaq.xyz/peaqos/install.
// The Economics 2.0 contracts ship inside the SDK's deployment record; the
// Tokenomics 1.0 addresses below are only required by the SDK constructor.
// `eventRegistry` is the one that matters: 2.0 machines must write to the 2.0 registry.
export interface PeaqNetwork {
  rpcUrl: string;
  deploymentId: "peaq-mainnet" | "agung-2026-08-28";
  chainId: number;
  /** false on agung: it has no Economics 2.0 MCR API. */
  hasMcr: boolean;
  contracts: {
    identityRegistry: Address;
    identityStaking: Address;
    eventRegistry: Address;
    machineNft: Address;
    didRegistry: Address;
    batchPrecompile: Address;
  };
}

const PRECOMPILES = {
  didRegistry: "0x0000000000000000000000000000000000000800",
  batchPrecompile: "0x0000000000000000000000000000000000000805",
} as const;

export const NETWORKS: Record<"mainnet" | "agung", PeaqNetwork> = {
  mainnet: {
    rpcUrl: "https://quicknode1.peaq.xyz",
    deploymentId: "peaq-mainnet",
    chainId: 3338,
    hasMcr: true,
    contracts: {
      identityRegistry: "0xb53Af985765031936311273599389b5B68aC9956",
      identityStaking: "0x11c05A650704136786253e8685f56879A202b1C7",
      eventRegistry: "0xA1e7F1d7B24dAb55Dc92491e6d9B89F6E925Ad1e", // Economics 2.0 EventRegistry
      machineNft: "0x2943F80e9DdB11B9Dd275499C661Df78F5F691F9",
      ...PRECOMPILES,
    },
  },
  agung: {
    rpcUrl: "https://peaq-agung.api.onfinality.io/public",
    deploymentId: "agung-2026-08-28",
    chainId: 9990,
    hasMcr: false,
    contracts: {
      identityRegistry: "0x9E9463a65c7B74623b3b6Cdc39F71be7274e5971",
      identityStaking: "0x55f336714aDb0749DbFE33b057a1702405564E3d",
      // Tokenomics 1.0 registry: the docs publish no 2.0 EventRegistry for agung, so
      // events for a 2.0 machine revert here. Override with EVENT_REGISTRY_ADDRESS.
      eventRegistry: "0x2DAD8905380993940e340C5cE6d313d5c2780040",
      machineNft: "0xB41C2A4f1c19b6B06beaAce0F5CD8439e77C4b1c",
      ...PRECOMPILES,
    },
  },
};

export function resolveNetwork(env: Record<string, string | undefined>): PeaqNetwork {
  const name = (env.PEAQ_NETWORK ?? "mainnet") as keyof typeof NETWORKS;
  const preset = NETWORKS[name];
  if (!preset) throw new Error(`PEAQ_NETWORK must be "mainnet" or "agung", got "${name}"`);
  return {
    ...preset,
    rpcUrl: env.PEAQOS_RPC_URL || preset.rpcUrl,
    contracts: {
      ...preset.contracts,
      eventRegistry: (env.EVENT_REGISTRY_ADDRESS as Address) || preset.contracts.eventRegistry,
    },
  };
}
