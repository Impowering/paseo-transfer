import type {
  PluginClientContext,
  PluginHostSummary,
} from "@getpaseo/plugin/client";
import { hostIdentity } from "../shared/connected";

export type HostRpc = PluginClientContext["rpc"];
interface Endpoint {
  rpc: HostRpc;
  generation: number;
}

/** All host installations share this client realm; no addresses or credentials enter it. */
export function createFederation() {
  const endpoints = new Map<string, Endpoint>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const notify = () => {
    revision++;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => revision,
    get: (id: string) => endpoints.get(id),
    register(id: string, rpc: HostRpc) {
      const endpoint = { rpc, generation: revision + 1 };
      endpoints.set(id, endpoint);
      notify();
      return () => {
        if (endpoints.get(id) === endpoint) {
          endpoints.delete(id);
          notify();
        }
      };
    },
  };
}

const registryKey = Symbol.for("Impowering.paseo-transfer.federation.v2");
const realm = globalThis as typeof globalThis & {
  [registryKey]?: ReturnType<typeof createFederation>;
};
export const federation = (realm[registryKey] ??= createFederation());

/** Resolve the transport afresh for every request, so reloads release old capabilities. */
export function rpcForHost(id: string): HostRpc {
  return (contract, input) => {
    const endpoint = federation.get(id);
    if (!endpoint)
      throw new Error(
        "Transfer is unavailable on this host. Connect it in Paseo and install or update paseo-transfer there.",
      );
    return endpoint.rpc(contract, input);
  };
}

export function registerHost(client: Pick<PluginClientContext, "rpc">) {
  let disposed = false,
    pending = false;
  let unregister: (() => void) | undefined;
  const identify = async () => {
    if (disposed || pending || unregister) return;
    pending = true;
    try {
      const identity = await client.rpc(hostIdentity, {});
      if (!disposed)
        unregister = federation.register(identity.serverId, (contract, input) =>
          client.rpc(contract, input),
        );
    } catch {
      /* Reconnect/catalog loading can precede server readiness. Retry while alive. */
    } finally {
      pending = false;
    }
  };
  void identify();
  const timer = setInterval(() => {
    void identify();
  }, 5_000);
  return () => {
    disposed = true;
    clearInterval(timer);
    unregister?.();
  };
}

export function hostAvailability(hosts: readonly PluginHostSummary[]) {
  return hosts.map((host) => ({
    ...host,
    generation: federation.get(host.serverId)?.generation ?? 0,
    ready: host.status === "online" && Boolean(federation.get(host.serverId)),
  }));
}
export type SearchHost = ReturnType<typeof hostAvailability>[number];
