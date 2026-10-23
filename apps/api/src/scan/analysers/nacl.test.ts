import { describe, expect, it } from "vitest";
import { blockedByNacl, type NaclEntry } from "./nacl.js";

const rule = (
  ruleNumber: number,
  action: "allow" | "deny",
  egress: boolean,
  ports: [number, number] | null = null,
  cidr = "0.0.0.0/0",
  protocol = ports ? "6" : "-1",
): NaclEntry => ({
  ruleNumber,
  action,
  egress,
  protocol,
  cidr,
  fromPort: ports?.[0] ?? null,
  toPort: ports?.[1] ?? null,
});

/** The default ACL: everything in, everything out. */
const OPEN = [
  rule(100, "allow", false),
  rule(100, "allow", true),
  rule(32767, "deny", false),
  rule(32767, "deny", true),
];
const ssh = { protocol: "tcp", fromPort: 22, toPort: 22 };

describe("blockedByNacl", () => {
  it("lets traffic through the default ACL", () => {
    expect(blockedByNacl(OPEN, ssh)).toBeNull();
  });

  it("lets a lower-numbered deny win over a broad allow", () => {
    const entries = [rule(50, "deny", false, [22, 22]), ...OPEN];
    expect(blockedByNacl(entries, ssh)).toBe("inbound rule 50 denies it");
  });

  it("lets a lower-numbered allow win over a later deny", () => {
    const entries = [
      rule(10, "allow", false, [22, 22]),
      rule(20, "deny", false),
      rule(100, "allow", true),
    ];
    expect(blockedByNacl(entries, ssh)).toBeNull();
  });

  it("needs the reply to get out, because ACLs are stateless", () => {
    const entries = [rule(100, "allow", false), rule(100, "allow", true, [80, 443])];
    expect(blockedByNacl(entries, ssh)).toContain("ephemeral");
  });

  it("does not count an allow for one range as exposure to the internet", () => {
    const entries = [
      rule(100, "allow", false, [22, 22], "203.0.113.0/24"),
      rule(100, "allow", true),
    ];
    expect(blockedByNacl(entries, ssh)).toBe(
      "no inbound rule allows it, so the default deny applies",
    );
  });

  it("matches protocols by number, as ACLs spell them", () => {
    const udpOnly = [
      rule(100, "allow", false, [53, 53], "0.0.0.0/0", "17"),
      rule(100, "allow", true),
    ];
    expect(blockedByNacl(udpOnly, { protocol: "udp", fromPort: 53, toPort: 53 })).toBeNull();
    expect(blockedByNacl(udpOnly, { protocol: "tcp", fromPort: 53, toPort: 53 })).not.toBeNull();
  });
});
