import { describe, expect, it } from "vitest";
import { isPublicNetworkAddress } from "../../src/runtime/safeExternalHttps.js";

describe("safe external HTTPS address policy", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => {
      expect(isPublicNetworkAddress(address)).toBe(true);
    },
  );
});
