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
} from "./connection/Connection.ts";
export { type Download } from "./files/Files.ts";
export {
  admitFiles,
  type FileProblem,
  type LocalFile,
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
export {
  ClientStorage,
  CredentialStorageError,
  CredentialStore,
  type DeviceCredential,
  FileTransfer,
  type LocalTable,
  LocalStorageError,
  Network,
  type NetworkStatus,
  ServerAddress,
  TransferFailed,
  type UploadRequest,
  type UploadResponse,
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
export { type BotDraft, freshStartAction } from "./stores/Details.ts";
export { Devices } from "./stores/Devices.ts";
export { type Draft, type DraftFile, type DraftSendResult } from "./stores/Drafts.ts";
export { EngineStatus } from "./stores/EngineStatus.ts";
export { Presence } from "./stores/Presence.ts";
export type { Loaded } from "./stores/reads.ts";
export { needsOperator, Roster, rosterRows } from "./stores/Roster.ts";
export { Settings, type SettingsChanges } from "./stores/Settings.ts";
export type { Synced } from "./stores/synced.ts";
export { WorkSteps, type WorkStepsState } from "./stores/WorkSteps.ts";
