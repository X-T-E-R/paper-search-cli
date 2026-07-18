import { sanitizeForPersistence, sanitizeUrlsForPersistenceInText } from "./sanitizeUrl.js";

export interface IoStreams {
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
}

export interface Io {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  writeLine(text: string): void;
  writeError(text: string): void;
  writeJson(value: unknown): void;
}

export function createIo(streams: IoStreams = {}): Io {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;

  return {
    stdout,
    stderr,
    writeLine(text: string): void {
      stdout.write(`${sanitizeUrlsForPersistenceInText(text)}\n`);
    },
    writeError(text: string): void {
      stderr.write(`${sanitizeUrlsForPersistenceInText(text)}\n`);
    },
    writeJson(value: unknown): void {
      stdout.write(`${JSON.stringify(sanitizeForPersistence(value), null, 2)}\n`);
    },
  };
}
