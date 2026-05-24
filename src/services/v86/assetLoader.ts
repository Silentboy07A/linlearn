// src/services/v86/assetLoader.ts
import { log } from "./logger";

export async function validateBinaryResponse(response: Response, name: string): Promise<ArrayBuffer> {
  if (!response.ok) {
    throw new Error(`Failed to load ${name}: HTTP status ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const ctLower = contentType.toLowerCase();
  if (ctLower.includes("text/html") || ctLower.includes("application/xhtml+xml") || ctLower.includes("text/xml")) {
    throw new Error(`Failed to load ${name}: received HTML/XML instead of binary stream (probable 404 page redirect)`);
  }

  const buffer = await response.arrayBuffer();
  if (!buffer || !(buffer instanceof ArrayBuffer)) {
    throw new Error(`Failed to load ${name}: response is not a valid ArrayBuffer`);
  }

  if (buffer.byteLength === 0) {
    throw new Error(`Failed to load ${name}: asset is empty (0 bytes)`);
  }

  return buffer;
}

export async function loadAsset(url: string, name: string): Promise<ArrayBuffer> {
  log("debug", `Fetching asset: ${name} from ${url}`);
  try {
    const response = await fetch(url);
    const buffer = await validateBinaryResponse(response, name);
    log("info", `Loaded asset: ${name}, size: ${buffer.byteLength} bytes`);
    return buffer;
  } catch (err: unknown) {
    const errorMsg = `Failed to load ${name}: ${err instanceof Error ? err.message : String(err)}`;
    log("error", errorMsg);
    throw new Error(errorMsg);
  }
}
