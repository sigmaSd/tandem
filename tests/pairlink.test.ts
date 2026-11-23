import "./_env.ts";
import { expect, test } from "vite-plus/test";
import { pairLink, parsePairLink } from "../src/pairlink.ts";

test("pairlink: the QR text gives back the code and every address", () => {
  const text = pairLink("K7QF-2M9X-TB4H", ["192.168.1.20", "100.64.0.3:47811"]);
  expect(text).toBe("tandem:pair?code=K7QF-2M9X-TB4H&at=192.168.1.20,100.64.0.3:47811");
  expect(parsePairLink(text)).toEqual({
    code: "K7QF-2M9X-TB4H",
    addresses: ["192.168.1.20", "100.64.0.3:47811"],
  });
});

test("pairlink: any other QR code is not a pairing code", () => {
  expect(parsePairLink("https://example.com/")).toBeNull();
  expect(parsePairLink("tandem:pair?code=K7QF-2M9X-TB4H")).toBeNull(); // no address to reach
  expect(parsePairLink("tandem:pair?at=192.168.1.20")).toBeNull(); // no code
});
