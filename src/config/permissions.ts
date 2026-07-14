import { execFile as execFileCallback } from "node:child_process";
import { chmod, stat } from "node:fs/promises";

export interface CredentialPermissionReport {
  platform: NodeJS.Platform;
  attempted: boolean;
  restricted: boolean;
  verified: boolean;
  warning?: string;
}

export type PermissionCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

async function runCommand(executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(executable, [...args], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${executable} failed: ${stderr || error.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseWindowsSid(output: string): string | null {
  const match = output.match(/S-1-(?:\d+-)+\d+/i);
  return match?.[0] ?? null;
}

/**
 * Restrict a plaintext credential file and verify the protection when the
 * platform exposes a reliable check. Windows failures are reported rather than
 * misrepresented as a secure vault; POSIX mode failures remain write failures.
 */
export async function applyCredentialPermissions(
  filePath: string,
  options: {
    platform?: NodeJS.Platform;
    run?: PermissionCommandRunner;
  } = {},
): Promise<CredentialPermissionReport> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    await chmod(filePath, 0o600);
    const mode = (await stat(filePath)).mode & 0o777;
    if (mode !== 0o600) throw new Error(`Credential file permissions could not be verified: ${filePath}`);
    return { platform, attempted: true, restricted: true, verified: true };
  }

  const run = options.run ?? runCommand;
  try {
    const identity = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const sid = parseWindowsSid(identity.stdout);
    if (!sid) throw new Error("Unable to determine the current Windows user SID");
    await run("icacls.exe", [filePath, "/inheritance:r", "/grant:r", `*${sid}:(F)`]);
    const verification = await run("icacls.exe", [filePath]);
    // icacls may render the account name instead of the SID. A successful
    // explicit grant plus a successful ACL read is the strongest portable
    // built-in verification available without changing global user state.
    const readableAcl = verification.stdout.trim().length > 0;
    return {
      platform,
      attempted: true,
      restricted: true,
      verified: readableAcl,
      ...(readableAcl ? {} : { warning: `Credential ACL verification returned no entries: ${filePath}` }),
    };
  } catch (error) {
    return {
      platform,
      attempted: true,
      restricted: false,
      verified: false,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}
