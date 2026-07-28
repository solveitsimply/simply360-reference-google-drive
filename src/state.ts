import type {
  ExternalFileLink,
  GoogleCredential,
  InstallationRegistration,
  InstallationStatus,
  NotificationChannel,
} from './contracts.js';
import type { ExplicitSelection } from './ports.js';

export interface StoredNotification {
  readonly channel: NotificationChannel;
  readonly lastMessageNumber?: string;
}

export interface PendingExport {
  readonly operationKey: string;
  readonly uploadId: string;
  readonly nextOffset: number;
  readonly destinationDriveFolderId: string;
  readonly simply360FileSimplyId: string;
  readonly simply360VersionNumber: number;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256Base64: string;
}

export interface PendingGoogleAuthorization {
  readonly stateSha256: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly expiresAt: string;
}

export interface InstallationState {
  readonly installation: InstallationRegistration;
  readonly status: InstallationStatus;
  readonly googleCredential?: GoogleCredential;
  readonly googleConnectionStatus?: 'ACTIVE' | 'REVOKED';
  readonly pendingGoogleAuthorization?: PendingGoogleAuthorization;
  readonly selections: readonly ExplicitSelection[];
  readonly links: readonly ExternalFileLink[];
  readonly notifications: readonly StoredNotification[];
  readonly pendingExports: readonly PendingExport[];
  readonly changeCursor?: string;
  readonly registeredAt: string;
  readonly updatedAt: string;
}

export class InMemoryStateStore {
  readonly states = new Map<string, InstallationState>();

  async load(installationSimplyId: string): Promise<InstallationState | undefined> {
    return structuredClone(this.states.get(installationSimplyId));
  }

  async save(installationSimplyId: string, state: InstallationState): Promise<void> {
    this.states.set(installationSimplyId, structuredClone(state));
  }
}
