import { contributeAgentTools } from "./server/native-tools";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { hostsRpc, listRpc, previewRpc, runRpc, statusRpc } from "./shared/rpc";
import { transferLimits, limitsSchema } from "./shared/limits";
import { displayPreferences } from "./shared/display";
import { contributeConnected } from "./server/connected";
import {
  hosts,
  list,
  preview,
  start,
  status,
  dispose,
  configureLimits,
} from "./server/handlers";
export default function contribute(server: PluginServerContext) {
  const removeTools = contributeAgentTools(server);
  const settings = server.registerSettings(transferLimits);
  const getLimits = async () => {
    const state = await settings.read();
    if (state.status !== "ready")
      throw new Error("Transfer limits settings are invalid.");
    return limitsSchema.parse(state.values);
  };
  configureLimits(getLimits);
  const releaseConnected = contributeConnected(server, getLimits);
  server.registerSettings(displayPreferences);
  server.handle(hostsRpc, hosts);
  server.handle(listRpc, list);
  server.handle(previewRpc, preview);
  server.handle(runRpc, start);
  server.handle(statusRpc, status);
  return async () => {
    removeTools();
    dispose();
    await releaseConnected();
  };
}
