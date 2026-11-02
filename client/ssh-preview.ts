import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  previewRpc,
  previewStartRpc,
  previewStatusRpc,
} from "../shared/rpc";

/** Each RPC stays short; the configured worker budget covers a long SSH export. */
export async function waitForSshPreview(
  input: RpcInput<typeof previewRpc>,
  start: (
    input: RpcInput<typeof previewStartRpc>,
  ) => Promise<RpcOutput<typeof previewStartRpc>>,
  status: (
    input: RpcInput<typeof previewStatusRpc>,
  ) => Promise<RpcOutput<typeof previewStatusRpc>>,
  pause = () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
  now = Date.now,
) {
  const started = await start(input);
  const deadline = now() + started.timeoutSeconds * 1000;
  while (now() < deadline) {
    const state = await status({ previewId: started.previewId });
    if (state.state === "failed") throw new Error(state.message);
    if (state.state === "done" && state.plan) return state.plan;
    await pause();
  }
  throw new Error(
    `SSH preview timed out (${started.previewId}). Check its status before previewing again.`,
  );
}
