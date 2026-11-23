// The pairing code as a QR code: what "Show a code" puts in the QR, and what a phone's "Scan the code" reads.
// It carries exactly what a person would type (the code, and this computer's addresses), so scanning is no
// more and no less trusted than typing: the code works for 10 minutes, once (src/core.ts startPairing).
//
//   tandem:pair?code=K7QF-2M9X-TB4H&at=192.168.1.20,100.64.0.3:47811

const PREFIX = "tandem:pair?";

/** The text of the QR code for `code`, reachable at `addresses` (host or host:port). */
export function pairLink(code: string, addresses: readonly string[]): string {
  const q = new URLSearchParams({ code, at: addresses.join(",") });
  return PREFIX + q.toString().replaceAll("%2C", ",").replaceAll("%3A", ":");
}

/** The code and addresses in a scanned text, or null when it isn't a Tandem pairing code. */
export function parsePairLink(text: string): { code: string; addresses: string[] } | null {
  if (!text.startsWith(PREFIX)) return null;
  const q = new URLSearchParams(text.slice(PREFIX.length));
  const code = q.get("code")?.trim() ?? "";
  const addresses = (q.get("at") ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  return code && addresses.length ? { code, addresses } : null;
}
