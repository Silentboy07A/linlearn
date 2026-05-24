// src/persistence/compressor.ts

/**
 * Compresses an ArrayBuffer using native browser CompressionStream (GZIP).
 */
export async function compressBuffer(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof CompressionStream === "undefined") {
    console.warn("CompressionStream is not supported in this browser. Storing uncompressed.");
    return buffer;
  }
  const blob = new Blob([buffer]);
  const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

/**
 * Decompresses a gzipped ArrayBuffer using native browser DecompressionStream.
 */
export async function decompressBuffer(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof DecompressionStream === "undefined") {
    console.warn("DecompressionStream is not supported in this browser. Returning buffer raw.");
    return buffer;
  }
  const blob = new Blob([buffer]);
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}
