# Two computers on the network

Code: `src/secure.ts` (the cryptography), `src/peer.ts` (the listener), `src/remote.ts` (the caller),
`src/discovery.ts` (finding each other). Tests: `tests/net.test.ts`, `tests/core.test.ts`.

This design uses only standard pieces from `node:crypto` (scrypt, X25519, HKDF, HMAC-SHA256, AES-256-GCM),
combined in the usual way. **It has not been reviewed by a cryptographer.** It is meant for a home or office
network, against other people and devices on that network.

## What an outsider on the network can do

- See that a computer runs Tandem, its name, and that it is showing a pairing code (the broadcast and
  `GET /hello`). Nothing else.
- Not read, change or replay anything two paired computers say to each other.
- Not pair without the code, and not find the code by recording a pairing.
- Slow things down (it is a network).

## Finding each other

While Tandem is open it broadcasts a small UDP message every two seconds on port 47810: its id, name and
the port it listens on. It proves nothing and carries no secret; it only tells where to knock. Networks that
block broadcasts (some guest and campus Wi-Fi) still work: the window shows this computer's address, to type
on the other one.

The listener is on TCP port 47811 (another one if it is taken). On Windows the firewall asks once whether to
allow Tandem on private networks: answer yes. On Linux with a strict firewall, open TCP 47811 and UDP 47810
for the local network (Fedora Workstation's default zone already allows them).

## Pairing

Computer A shows a code of 12 letters and digits (60 bits), valid ten minutes, once. The user types it on B.

1. Both turn the code into a key with scrypt (N=2^15), salted with A's id. Recording the exchange and
   trying every code offline would take 2^60 slow guesses.
2. B sends a fresh X25519 public key and proves it knows the code (HMAC over the request).
3. A checks the proof, answers with its own fresh key and its own proof. Five wrong proofs burn the code.
4. Both derive the pair's long-term key from the X25519 secret, the code's key and everything exchanged
   (HKDF). The key never travels, and the code is useless afterwards.

Each side verifies the other's proof, so nobody in the middle can pair with either.

## Talking

1. **Session.** The caller sends a fresh X25519 key, signed with the pair's key (HMAC). The listener
   answers the same way. Both derive two session keys (one per direction) from the fresh secret and the
   pair's key. A key file stolen later does not open traffic recorded today. A recorded session request
   sent again is refused, and a session changes nothing (not even the caller's remembered address) until
   its first valid message.
2. **Messages.** Each question and answer is one AES-256-GCM message. The nonce is a counter that only
   grows, the session id and direction are authenticated with it. A repeated, reordered or redirected
   message is refused.
3. **What can be asked** (`src/core.ts`, `#answer`, protocol 2):
   - its status: folder name, the change numbers of its list and of its record of this pair, whether its
     list follows its disk, its list of files left out. Answered from memory, nothing read from the disk;
   - the changes of its list since a change number, in pages (with a scan of its disk first, for a sync);
     the same for its record of this pair;
   - read a piece of a file, write a file (small ones whole in one message; same rules as local writes:
     temporary name, hash check, old version kept), move a file to the old versions, flush what was written,
     and add this sync's changes to its record.

   Every path goes through `cleanRel` (`src/names.ts`) and is refused if it passes through a link. Nothing
   else on the computer can be reached. Old versions made by another computer's request are dated by this
   computer's own clock. Writes carry the history id of the list they were planned on, and are refused when
   its folder was changed since.

Two computers must run the same protocol: a Tandem of protocol 1 is shown as "runs another version".

A paired computer is trusted with the synced folder: it can read all of it and replace any file (the
replaced one is kept as an old version). Pair only with your own computers. Removing a copy in the settings
forgets its key at once.

## Not covered

- A program running under the same user account can read the keys (`config.json`, mode 600).
- The device name and the fact of syncing are visible on the network.
- No protection against a paired computer that turns hostile, beyond the old versions.
