// src/security/outputSanitizer.ts
import { OutputSanitizerResult } from "../lib/types";

const MAX_OUTPUT_SIZE_BYTES = 50 * 1024;

export class OutputSanitizer {
  public static sanitize(output: string): OutputSanitizerResult {
    const originalSize = new Blob([output]).size;
    let sanitized = output;

    const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
    sanitized = sanitized.replace(ansiRegex, "");

    sanitized = sanitized.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uD7FF\uE000-\uFFFD]/g, "");

    let isTruncated = false;
    if (sanitized.length > MAX_OUTPUT_SIZE_BYTES) {
      sanitized = sanitized.substring(0, MAX_OUTPUT_SIZE_BYTES) + "\n\n[Output truncated due to size limits]";
      isTruncated = true;
    }

    const sanitizedSize = new Blob([sanitized]).size;

    return {
      sanitizedOutput: sanitized,
      isTruncated,
      originalSize,
      sanitizedSize,
    };
  }

  public static sanitizeError(errorMsg: string): string {
    const { sanitizedOutput } = this.sanitize(errorMsg);
    return sanitizedOutput.replace(/(?:\/[a-zA-Z0-9_.-]+)+/g, (path) => {
      const segments = path.split("/");
      return `.../${segments[segments.length - 1]}`;
    });
  }
}
