import type { ReadStream, WriteStream } from "node:tty";

export interface CredentialInputOptions {
  stdin?: boolean;
  fromEnv?: string;
}

export async function readHiddenCredential(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stderr,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function" || !output.isTTY) {
    throw new Error("Interactive credential input requires a TTY; use --stdin or --from-env <name>");
  }
  output.write("Credential: ");
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  let value = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: string | Buffer) => {
        const text = String(chunk);
        for (const character of text) {
          if (character === "\u0003") {
            cleanup();
            reject(new Error("Credential input cancelled"));
            return;
          }
          if (character === "\r" || character === "\n") {
            cleanup();
            resolve(value);
            return;
          }
          if (character === "\b" || character === "\u007f") {
            value = value.slice(0, -1);
          } else if (character >= " ") {
            value += character;
          }
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        input.off("data", onData);
        input.off("error", onError);
      };
      input.on("data", onData);
      input.on("error", onError);
    });
  } finally {
    input.setRawMode(false);
    input.pause();
    output.write("\n");
  }
}

export async function readCredentialInput(
  options: CredentialInputOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (options.stdin && options.fromEnv) {
    throw new Error("Choose only one credential input: --stdin or --from-env <name>");
  }
  let value: string;
  if (options.fromEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.fromEnv)) {
      throw new Error(`Invalid environment variable name: ${options.fromEnv}`);
    }
    const fromEnvironment = env[options.fromEnv];
    if (typeof fromEnvironment !== "string") {
      throw new Error(`Environment variable is not set: ${options.fromEnv}`);
    }
    value = fromEnvironment;
  } else if (options.stdin) {
    process.stdin.setEncoding("utf8");
    value = "";
    for await (const chunk of process.stdin) value += chunk;
    value = value.replace(/\r?\n$/, "");
  } else {
    value = await readHiddenCredential();
  }
  if (!value) throw new Error("Credential value must not be empty");
  return value;
}
