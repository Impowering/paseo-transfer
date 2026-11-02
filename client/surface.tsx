import {
  gitHistoryDescription,
  type GitHistoryScope,
} from "../shared/git-history";
import { hostIdentity } from "../shared/connected";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  useRpc,
  useHosts,
  type PluginSurfaceProps,
  type PluginButtonContentProps,
} from "@getpaseo/plugin/client";
import {
  hostsRpc,
  listRpc,
  previewStartRpc,
  previewStatusRpc,
  runRpc,
  statusRpc,
} from "../shared/rpc";
import { waitForSshPreview } from "./ssh-preview";
import type { Plan } from "../shared/types";
import { federation, hostAvailability, rpcForHost } from "./federation";
import { connectedTransfer, type ConnectedPlan } from "./connected-transfer";

const popupRuns = new Map<string, string>();

export function TransferPopover(props: PluginButtonContentProps) {
  return (
    <TransferSurface
      {...props}
      initialWorkspaceId={props.workspaceId}
      workspaceScoped
    />
  );
}

export function TransferSurface({
  theme,
  layout,
  host,
  navigation,
  initialWorkspaceId = "",
  workspaceScoped = false,
}: PluginSurfaceProps & {
  initialWorkspaceId?: string;
  workspaceScoped?: boolean;
}) {
  const colors = theme.colors;
  const hosts = useRpc(hostsRpc),
    list = useRpc(listRpc),
    previewStart = useRpc(previewStartRpc),
    previewStatus = useRpc(previewStatusRpc),
    run = useRpc(runRpc),
    status = useRpc(statusRpc),
    identity = useRpc(hostIdentity);
  const [remote, setRemote] = useState("");
  const inventory = useHosts();
  const hostRevision = useSyncExternalStore(
    federation.subscribe,
    federation.snapshot,
    federation.snapshot,
  );
  const connectedHosts = hostAvailability(inventory).filter(
    (item) => item.serverId !== host.id,
  );
  const [transport, setTransport] = useState<"connected" | "ssh">("connected");
  const [remoteId, setRemoteId] = useState("");
  const selectedHost = connectedHosts.find(
    (item) => item.serverId === remoteId,
  );
  const remoteReady =
    transport === "connected"
      ? Boolean(selectedHost?.ready)
      : Boolean(remote.trim());
  const remoteLabel =
    transport === "connected"
      ? (selectedHost?.label ?? "another host")
      : remote.trim();
  const [home, setHome] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [direction, setDirection] = useState<"push" | "pull">("push");
  const sourceId = direction === "push" ? host.id : remoteId;
  const targetId = direction === "push" ? remoteId : host.id;
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [destination, setDestination] = useState("");
  const [gitHistoryScope, setGitHistoryScope] =
    useState<GitHistoryScope>("repository");
  const [mode, setMode] = useState<"copy" | "move">("copy");
  const [plan, setPlan] = useState<Plan | null>(null);
  const popupKey = workspaceScoped ? `${host.id}:${initialWorkspaceId}` : "";
  const [runId, setRunId] = useState(() => popupRuns.get(popupKey) ?? "");
  const [advanced, setAdvanced] = useState(false);

  const endpoint = {
    target: remote.trim(),
    ...(home.trim() ? { home: home.trim() } : {}),
    ...(identityFile.trim() ? { identityFile: identityFile.trim() } : {}),
  };
  const source = direction === "push" ? { target: "" } : endpoint,
    target = direction === "push" ? endpoint : { target: "" };
  const suggestions = useQuery({
    queryKey: ["transfer", host.id, "hosts"],
    queryFn: () => hosts({}),
    staleTime: 60_000,
    enabled: transport === "ssh",
  });
  const workspaces = useQuery({
    queryKey: [
      "transfer",
      host.id,
      "workspaces",
      transport,
      sourceId,
      selectedHost?.generation,
      source,
    ],
    queryFn: () =>
      transport === "connected" && direction === "pull"
        ? rpcForHost(sourceId)(listRpc, { endpoint: { target: "" } })
        : list({ endpoint: source }),
    enabled: direction === "push" || remoteReady,
    retry: 1,
  });
  const makePreview = useMutation({
    mutationFn: () =>
      transport === "connected"
        ? connectedTransfer.preview({
            sourceId,
            targetId,
            workspaceId,
            destination,
            mode,
            gitHistoryScope,
          })
        : waitForSshPreview(
            { source, target, workspaceId, destination, mode, gitHistoryScope },
            previewStart,
            previewStatus,
            undefined,
            undefined,
            () => identity({}),
          ),
    onSuccess: (data) => {
      setPlan(data);
      setRunId("");
      if (popupKey) popupRuns.delete(popupKey);
    },
  });
  const transfer = useMutation({
    mutationFn: async () =>
      "connected" in plan!
        ? connectedTransfer.start(plan as ConnectedPlan)
        : run({ planId: plan!.id }),
    onSuccess: (data) => {
      setRunId(data.runId);
      if (popupKey) popupRuns.set(popupKey, data.runId);
      setPlan(null);
    },
  });
  const progress = useQuery({
    queryKey: ["transfer", host.id, "run", runId],
    queryFn: async () =>
      runId.startsWith("connected-")
        ? { ...connectedTransfer.status(runId) }
        : status({ runId }),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.state === "running" ? 1000 : false),
  });
  const running =
    !!runId &&
    !progress.isError &&
    (!progress.data || progress.data.state === "running");
  const locked = running || transfer.isPending || makePreview.isPending;
  useEffect(() => {
    setPlan(null);
    makePreview.reset();
    transfer.reset();
  }, [
    remote,
    remoteId,
    transport,
    home,
    identityFile,
    direction,
    workspaceId,
    destination,
    mode,
    gitHistoryScope,
  ]);
  useEffect(() => {
    if (plan && "connected" in plan)
      return () => {
        void connectedTransfer.discard(plan as ConnectedPlan);
      };
  }, [plan]);
  useEffect(() => {
    if (!remoteId && connectedHosts.filter((item) => item.ready).length === 1)
      setRemoteId(connectedHosts.find((item) => item.ready)!.serverId);
  }, [remoteId, inventory, hostRevision]);
  useEffect(() => {
    setWorkspaceId(direction === "push" ? initialWorkspaceId : "");
    setPlan(null);
    if (!workspaceScoped) setRunId("");
  }, [
    host.id,
    direction,
    direction === "pull" ? remote : "",
    direction === "pull" ? remoteId : "",
    home,
    initialWorkspaceId,
    workspaceScoped,
    transport,
  ]);
  const selectedWorkspace = workspaces.data?.workspaces.find(
    (item) => item.workspaceId === workspaceId,
  );
  useEffect(() => {
    if (workspaceScoped && selectedWorkspace && !destination) {
      setDestination(
        `~/Projects/${selectedWorkspace.cwd.split("/").filter(Boolean).pop()}-transfer`,
      );
    }
  }, [workspaceScoped, selectedWorkspace, destination]);
  const error =
    makePreview.error ??
    transfer.error ??
    progress.error ??
    workspaces.error ??
    (transport === "ssh" ? suggestions.error : null);
  const label = (text: string) => (
    <Text
      style={{
        color: colors.foreground,
        fontSize: layout.compact ? 16 : 14,
        fontWeight: "600",
        marginBottom: 8,
      }}
    >
      {text}
    </Text>
  );
  const input = (
    value: string,
    change: (s: string) => void,
    placeholder: string,
    title: string,
  ) => (
    <TextInput
      accessibilityLabel={title}
      value={value}
      onChangeText={change}
      placeholder={placeholder}
      placeholderTextColor={colors.foregroundMuted}
      editable={!locked}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        color: colors.foreground,
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 12,
        paddingVertical: 11,
        fontSize: layout.compact ? 16 : 14,
        minHeight: 44,
      }}
    />
  );
  const button = (
    text: string,
    action: () => void,
    disabled = false,
    selected = false,
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={action}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.border,
        backgroundColor: selected ? colors.accent : colors.surface1,
        opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      <Text
        style={{
          fontSize: 14,
          fontWeight: "600",
          color: selected ? colors.accentForeground : colors.foreground,
        }}
      >
        {text}
      </Text>
    </Pressable>
  );
  if (workspaceScoped && (plan || runId)) {
    const result = progress.data?.result;
    return (
      <View>
        <View style={{ gap: 16 }}>
          <Text
            accessibilityRole="header"
            style={{
              color: colors.foreground,
              fontSize: 20,
              fontWeight: "700",
            }}
          >
            {plan ? `Ready to ${plan.mode}` : "Workspace transfer"}
          </Text>
          {plan ? (
            <>
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 14,
                  lineHeight: 21,
                }}
              >
                From {host.label} to {remoteLabel}
              </Text>
              <View style={{ gap: 8 }}>
                <Text
                  style={{
                    color: colors.foreground,
                    fontSize: 14,
                    fontWeight: "600",
                  }}
                >
                  {plan.workspace.name}
                </Text>
                <Text
                  selectable
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: 14,
                    lineHeight: 21,
                  }}
                >
                  {plan.destination}
                </Text>
                <Text
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: 14,
                    lineHeight: 21,
                  }}
                >
                  {plan.files} files · {plan.sessions} conversations ·{" "}
                  {(plan.bytes / 1024 / 1024).toFixed(1)} MiB
                  {plan.branch ? ` · ${plan.branch}` : ""}
                </Text>
                <Text
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: 14,
                    lineHeight: 21,
                  }}
                >
                  {gitHistoryDescription(plan.gitHistoryScope)}
                </Text>
              </View>
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 14,
                  lineHeight: 21,
                }}
              >
                {plan.mode === "move"
                  ? "Archive the source only after verification. Paseo may remove a managed source worktree."
                  : "The source workspace stays open. The receiving host gets an independent checkout."}
              </Text>
              {error && (
                <Text
                  accessibilityRole="alert"
                  style={{ color: colors.statusDanger }}
                >
                  {error.message}
                </Text>
              )}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {button("Edit transfer", () => setPlan(null), locked)}
                {button(
                  transfer.isPending
                    ? "Starting transfer…"
                    : `${plan.mode === "move" ? "Move" : "Copy"} workspace`,
                  () => transfer.mutate(),
                  locked,
                  true,
                )}
              </View>
            </>
          ) : (
            <>
              <Text
                accessibilityLiveRegion="polite"
                style={{
                  color:
                    progress.data?.state === "failed" || progress.error
                      ? colors.statusDanger
                      : colors.foreground,
                  fontSize: 14,
                  lineHeight: 21,
                }}
              >
                {progress.error?.message ??
                  progress.data?.message ??
                  "Starting transfer…"}
              </Text>
              {result && (
                <Text
                  selectable
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: 14,
                    lineHeight: 21,
                  }}
                >
                  {result.cwd}
                </Text>
              )}
              {running ? (
                <Text
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: 13,
                    lineHeight: 20,
                  }}
                >
                  {runId.startsWith("connected-")
                    ? "You can close this popup. Keep Paseo open and both hosts connected until the transfer finishes."
                    : `You can close this popup. The transfer continues on ${host.label}; reopen Transfer to check progress.`}
                </Text>
              ) : (
                <View style={{ alignSelf: "flex-start" }}>
                  {progress.data?.state === "done" &&
                    progress.data.result &&
                    navigation &&
                    button("Open workspace", () =>
                      navigation.openWorkspace({
                        workspaceId: progress.data!.result!.workspaceId,
                        serverId: runId.startsWith("connected-")
                          ? connectedTransfer.status(runId).targetId
                          : host.id,
                      }),
                    )}
                  {progress.error
                    ? button("Retry status", () => void progress.refetch())
                    : button("Start another transfer", () => {
                        setRunId("");
                        popupRuns.delete(popupKey);
                      })}
                </View>
              )}
            </>
          )}
        </View>
      </View>
    );
  }
  const form = (
    <View
      style={{
        maxWidth: 760,
        width: "100%",
        alignSelf: "center",
        gap: workspaceScoped ? 16 : 24,
      }}
    >
      <View style={{ gap: 8 }}>
        <Text
          accessibilityRole="header"
          style={{
            color: colors.foreground,
            fontSize: workspaceScoped ? 20 : 26,
            fontWeight: "700",
          }}
        >
          {workspaceScoped ? "Transfer workspace" : "Continue on another host"}
        </Text>
        <Text
          style={{
            color: colors.foregroundMuted,
            fontSize: 14,
            lineHeight: 21,
          }}
        >
          Bring a workspace’s Git history, local changes, and conversations with
          you.
        </Text>
      </View>
      {!workspaceScoped && (
        <View style={{ gap: 12 }}>
          {label("Transfer direction")}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {button(
              `From ${host.label}`,
              () => setDirection("push"),
              locked,
              direction === "push",
            )}
            {button(
              `To ${host.label}`,
              () => setDirection("pull"),
              locked,
              direction === "pull",
            )}
          </View>
        </View>
      )}
      {workspaceScoped && (
        <View style={{ gap: 4 }}>
          <Text
            style={{
              color: colors.foreground,
              fontSize: 14,
              fontWeight: "600",
            }}
          >
            {selectedWorkspace?.name ?? "Loading this workspace…"}
          </Text>
          <Text
            numberOfLines={1}
            style={{ color: colors.foregroundMuted, fontSize: 12 }}
          >
            {selectedWorkspace?.cwd ?? `From ${host.label}`}
          </Text>
          {!workspaces.isPending && !workspaces.error && !selectedWorkspace && (
            <Text
              accessibilityRole="alert"
              style={{ color: colors.statusDanger }}
            >
              This workspace is no longer open. Refresh the workspace and try
              again.
            </Text>
          )}
        </View>
      )}
      <View style={{ gap: 10 }}>
        {label(direction === "push" ? "Target host" : "Source host")}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {button(
            "Paseo hosts",
            () => setTransport("connected"),
            locked,
            transport === "connected",
          )}
          {button(
            "Use SSH",
            () => setTransport("ssh"),
            locked,
            transport === "ssh",
          )}
        </View>
        {transport === "connected" ? (
          <>
            {connectedHosts.length ? (
              connectedHosts.map((item) => (
                <Pressable
                  key={item.serverId}
                  accessibilityRole="radio"
                  accessibilityLabel={`${item.label}: ${item.ready ? "Connected" : item.status !== "online" ? "Offline — connect in Paseo" : "Install or update paseo-transfer"}`}
                  accessibilityState={{
                    selected: remoteId === item.serverId,
                    disabled: locked || !item.ready,
                  }}
                  disabled={locked || !item.ready}
                  onPress={() => setRemoteId(item.serverId)}
                  style={({ pressed }) => ({
                    minHeight: 52,
                    padding: 12,
                    gap: 4,
                    borderWidth: 1,
                    borderRadius: 6,
                    borderColor:
                      remoteId === item.serverId
                        ? colors.accent
                        : colors.border,
                    backgroundColor: pressed
                      ? colors.surface2
                      : colors.surface1,
                  })}
                >
                  <Text
                    style={{
                      color: colors.foreground,
                      fontSize: 14,
                      fontWeight: "600",
                    }}
                  >
                    {item.label}
                    {remoteId === item.serverId ? " · Selected" : ""}
                  </Text>
                  <Text
                    style={{
                      color: colors.foregroundMuted,
                      fontSize: 13,
                      lineHeight: 19,
                    }}
                  >
                    {item.ready
                      ? "Connected through Paseo"
                      : item.status !== "online"
                        ? "Connect this host in Paseo to transfer."
                        : "Install or update paseo-transfer on this host."}
                  </Text>
                </Pressable>
              ))
            ) : (
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 14,
                  lineHeight: 21,
                }}
              >
                Add your other host in Paseo, then install paseo-transfer there.
                It will appear here automatically.
              </Text>
            )}
            <Text
              style={{
                color: colors.foregroundMuted,
                fontSize: 13,
                lineHeight: 19,
              }}
            >
              Uses your existing Paseo connections. Keep the app open and both
              hosts connected while transferring.
            </Text>
          </>
        ) : (
          <>
            {input(remote, setRemote, "SSH alias or user@host", "SSH host")}
            {!!suggestions.data?.hosts.length && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {suggestions.data.hosts.map((item) => (
                  <View key={item.target}>
                    {button(
                      item.label,
                      () => setRemote(item.target),
                      locked,
                      remote === item.target,
                    )}
                  </View>
                ))}
              </View>
            )}
            <Text
              style={{
                color: colors.foregroundMuted,
                fontSize: 12,
                lineHeight: 18,
              }}
            >
              Uses your SSH config and keys. Suggestions come from SSH config
              and online Tailscale peers.
            </Text>
            {workspaceScoped && (
              <View style={{ alignSelf: "flex-start" }}>
                {button(
                  advanced ? "Hide connection options" : "Connection options",
                  () => setAdvanced(!advanced),
                  locked,
                )}
              </View>
            )}
            {(!workspaceScoped || advanced) && (
              <View
                style={{
                  flexDirection:
                    workspaceScoped || layout.compact ? "column" : "row",
                  gap: 12,
                }}
              >
                <View style={{ flex: 1 }}>
                  {label("Paseo home (optional)")}
                  {input(
                    home,
                    setHome,
                    "Default on the other host",
                    "Remote Paseo home",
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  {label("SSH key (optional)")}
                  {input(
                    identityFile,
                    setIdentityFile,
                    "Use SSH config",
                    "SSH identity file",
                  )}
                </View>
              </View>
            )}
          </>
        )}
      </View>
      {!workspaceScoped && (
        <View style={{ gap: 8 }}>
          {label("Workspace")}
          {direction === "pull" && !remoteReady ? (
            <Text style={{ color: colors.foregroundMuted }}>
              Choose a source host to load its workspaces.
            </Text>
          ) : workspaces.isPending ? (
            <Text style={{ color: colors.foregroundMuted }}>
              Loading workspaces…
            </Text>
          ) : !workspaces.data?.workspaces.length ? (
            <Text style={{ color: colors.foregroundMuted }}>
              No open workspaces. Choose a reachable source host and refresh.
            </Text>
          ) : (
            <View
              style={{
                maxHeight: 280,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 6,
              }}
            >
              <ScrollView nestedScrollEnabled>
                {workspaces.data.workspaces.map((item) => (
                  <Pressable
                    key={item.workspaceId}
                    accessibilityRole="radio"
                    accessibilityState={{
                      selected: item.workspaceId === workspaceId,
                      disabled: locked,
                    }}
                    disabled={locked}
                    onPress={() => {
                      setWorkspaceId(item.workspaceId);
                      setDestination(
                        `~/Projects/${item.cwd.split("/").filter(Boolean).pop()}-transfer`,
                      );
                    }}
                    style={({ pressed }) => ({
                      padding: 12,
                      gap: 4,
                      backgroundColor:
                        item.workspaceId === workspaceId
                          ? colors.surface2
                          : pressed
                            ? colors.surface1
                            : colors.surface0,
                      borderBottomWidth: 1,
                      borderBottomColor: colors.border,
                    })}
                  >
                    <Text
                      style={{
                        color:
                          item.workspaceId === workspaceId
                            ? colors.accent
                            : colors.foreground,
                        fontSize: 14,
                        fontWeight: "600",
                      }}
                    >
                      {item.name}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{ color: colors.foregroundMuted, fontSize: 12 }}
                    >
                      {item.cwd}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}
          <View style={{ alignSelf: "flex-start" }}>
            {button(
              "Refresh workspaces",
              () => {
                void workspaces.refetch();
              },
              locked || (direction === "pull" && !remoteReady),
            )}
          </View>
        </View>
      )}
      <View>
        {label("New directory on the target host")}
        {input(
          destination,
          setDestination,
          "~/Projects/my-workspace",
          "Destination directory",
        )}
        <Text
          style={{
            color: colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
            marginTop: 8,
          }}
        >
          Choose a directory that does not exist. The transferred checkout is
          independent. Git-ignored files stay on the source.
        </Text>
      </View>
      <View style={{ gap: 12 }}>
        {label("Git history")}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {button(
            "Full repository",
            () => setGitHistoryScope("repository"),
            locked,
            gitHistoryScope === "repository",
          )}
          {button(
            "This workspace",
            () => setGitHistoryScope("workspace"),
            locked,
            gitHistoryScope === "workspace",
          )}
        </View>
        <Text
          style={{
            color: colors.foregroundMuted,
            fontSize: 14,
            lineHeight: 21,
          }}
        >
          {gitHistoryDescription(gitHistoryScope)}
        </Text>
      </View>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {button("Copy", () => setMode("copy"), locked, mode === "copy")}
          {button("Move", () => setMode("move"), locked, mode === "move")}
        </View>
        <Text
          style={{
            color: colors.foregroundMuted,
            fontSize: 14,
            lineHeight: 21,
          }}
        >
          {mode === "move"
            ? "Archive the source workspace after the destination is verified. Paseo may remove a managed source worktree."
            : "Keep the source workspace open."}
        </Text>
      </View>
      {error && (
        <Text
          accessibilityRole="alert"
          style={{ color: colors.statusDanger, fontSize: 14, lineHeight: 21 }}
        >
          {error.message}
        </Text>
      )}
      <View style={{ alignSelf: "flex-start" }}>
        {button(
          makePreview.isPending ? "Preparing preview…" : "Preview transfer",
          () => makePreview.mutate(),
          locked ||
            !remoteReady ||
            !workspaceId ||
            !destination.trim() ||
            (workspaceScoped && !selectedWorkspace),
          !plan,
        )}
      </View>
      {plan && (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.border,
            paddingTop: 20,
            gap: 12,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{
              color: colors.foreground,
              fontSize: 18,
              fontWeight: "600",
            }}
          >
            Ready to {plan.mode}
          </Text>
          <Text
            selectable
            style={{ color: colors.foreground, fontSize: 14, lineHeight: 21 }}
          >
            {plan.workspace.name}
            {"\n"}
            {plan.destination}
          </Text>
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: 14,
              lineHeight: 21,
            }}
          >
            {plan.files} files · {plan.sessions} conversations ·{" "}
            {(plan.bytes / 1024 / 1024).toFixed(1)} MiB
            {plan.branch ? ` · ${plan.branch}` : ""}
          </Text>
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: 14,
              lineHeight: 21,
            }}
          >
            {gitHistoryDescription(plan.gitHistoryScope)}
          </Text>
          <View style={{ alignSelf: "flex-start" }}>
            {button(
              `${plan.mode === "move" ? "Move" : "Copy"} workspace`,
              () => transfer.mutate(),
              locked,
              true,
            )}
          </View>
        </View>
      )}
      {!!runId && (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.border,
            paddingTop: 20,
            gap: 12,
          }}
        >
          <Text
            accessibilityLiveRegion="polite"
            style={{
              color:
                progress.data?.state === "failed"
                  ? colors.statusDanger
                  : colors.foreground,
              fontSize: 14,
              lineHeight: 21,
            }}
          >
            {progress.data?.message ?? "Starting transfer…"}
          </Text>
          {progress.data?.result && (
            <Text
              selectable
              style={{ color: colors.foregroundMuted, fontSize: 13 }}
            >
              {progress.data.result.cwd}
            </Text>
          )}
          {progress.data?.state === "done" &&
            (direction === "pull" || runId.startsWith("connected-")) &&
            navigation &&
            progress.data.result && (
              <View style={{ alignSelf: "flex-start" }}>
                {button("Open workspace", () =>
                  navigation.openWorkspace({
                    workspaceId: progress.data!.result!.workspaceId,
                    serverId: runId.startsWith("connected-")
                      ? connectedTransfer.status(runId).targetId
                      : host.id,
                  }),
                )}
              </View>
            )}
        </View>
      )}
      {workspaceScoped && running && (
        <Text
          style={{
            color: colors.foregroundMuted,
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          You can close this popup. The transfer continues on {host.label};
          reopen Transfer to check progress.
        </Text>
      )}
    </View>
  );
  return workspaceScoped ? (
    form
  ) : (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 16 : 28,
        paddingBottom: 56,
      }}
    >
      {form}
    </ScrollView>
  );
}
