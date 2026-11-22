// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DocumentPicker from "expo-document-picker";
import { File as DeviceFile } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";

/** A file to attach: its name, and its bytes as the runtime uploads them. */
export interface PickedFile {
  readonly name: string;
  readonly body: Blob;
}

/**
 * A file on the device as a `Blob`, with the media type and size the system
 * reported for it. Its bytes are read natively when the upload asks for
 * them, never through a base64 string.
 */
export class DeviceBlob implements Blob {
  readonly #file: DeviceFile;
  readonly type: string;
  readonly size: number;

  constructor(uri: string, type: string | undefined, size: number | undefined) {
    this.#file = new DeviceFile(uri);
    this.type = type ?? this.#file.type;
    this.size = size ?? this.#file.size;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.#file.arrayBuffer();
  }

  bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return this.#file.bytes();
  }

  text(): Promise<string> {
    return this.#file.text();
  }

  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return this.#file.stream();
  }

  slice(start?: number, end?: number, contentType?: string): Blob {
    return this.#file.slice(start, end, contentType);
  }
}

/** The name of the file at `uri`, from its path, when the system gave none. */
const lastSegment = (uri: string) => decodeURIComponent(uri.split("/").pop() ?? "");

/**
 * Photos and videos picked from the system's photo picker, which asks for no
 * permission. Empty when the operator picks nothing.
 */
export async function pickPhotos(): Promise<ReadonlyArray<PickedFile>> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images", "videos"],
    allowsMultipleSelection: true,
    quality: 1,
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    name: asset.fileName ?? lastSegment(asset.uri),
    body: new DeviceBlob(asset.uri, asset.mimeType, asset.fileSize),
  }));
}

/** Any files picked from the system's document picker. Empty when the operator picks nothing. */
export async function pickDocuments(): Promise<ReadonlyArray<PickedFile>> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    // A copy the app can read for as long as the upload takes.
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    name: asset.name,
    body: new DeviceBlob(asset.uri, asset.mimeType, asset.size),
  }));
}
