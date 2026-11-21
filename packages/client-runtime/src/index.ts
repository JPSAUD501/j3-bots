// SPDX-License-Identifier: AGPL-3.0-or-later
export {
  type ConversationHandle,
  createJ3Client,
  type DownloadResult,
  type J3Client,
  layer,
  type LoadedHandle,
  type PairResult,
  type Platform,
  type WorkStepsHandle,
} from "./client.ts";
export {
  backoffDelay,
  Connection,
  type ConnectionState,
  type J3RpcClient,
  normalizePairingCode,
  NotPaired,
  PairingFailed,
  type PairingFailure,
  ReconnectPolicy,
  type ReconnectSettings,
  type UnpairedReason,
} from "./connection/Connection.ts";
export { type Download } from "./files/Files.ts";
export {
  admitFiles,
  type FileProblem,
  InvalidMessage,
  type LocalFile,
  messageProblem,
  MessageProblem,
  normalizeMediaType,
} from "./files/limits.ts";
export {
  Actions,
  type ActionState,
  cardAction,
  type IntentFailure,
  type IntentResult,
  retryAction,
  stopAction,
} from "./intents/Actions.ts";
export { type SignOutResult } from "./intents/SignOut.ts";
export {
  ClientStorage,
  CredentialStorageError,
  CredentialStore,
  type DeviceCredential,
  FileTransfer,
  type LocalRecord,
  LocalTable,
  LocalStorageError,
  makeInProcessLocks,
  Network,
  type NetworkStatus,
  ServerAddress,
  TransferFailed,
  type UploadRequest,
  type UploadResponse,
  WindowLocks,
} from "./ports.ts";
export { Cell, type Readable, waitFor } from "./Store.ts";
export {
  type CardAnswer,
  type Conversation,
  type ConversationItem,
  Conversations,
  type ConversationState,
  messageStatus,
  type MessageStatus,
  type OutgoingMessage,
  type SecretAnswer,
  targetKey,
} from "./stores/Conversations.ts";
export {
  type BotChanges,
  type BotDraft,
  freshStartAction,
  type MemoryEdit,
  memorySaveKey,
  type Save,
  type SaveResult,
} from "./stores/Details.ts";
export { Devices, type RevokeResult } from "./stores/Devices.ts";
export {
  type Draft,
  type DraftChangedElsewhere,
  type DraftFile,
  type DraftSendResult,
} from "./stores/Drafts.ts";
export { EngineStatus } from "./stores/EngineStatus.ts";
export { Presence } from "./stores/Presence.ts";
export type { Loaded } from "./stores/reads.ts";
export { needsOperator, Roster, rosterRows } from "./stores/Roster.ts";
export {
  Settings,
  type ProfileChanges,
  type SettingsChange,
  type SettingsSave,
  type SettingsSaves,
} from "./stores/Settings.ts";
export type { Synced } from "./stores/synced.ts";
export { WorkSteps, type WorkStepsState } from "./stores/WorkSteps.ts";
