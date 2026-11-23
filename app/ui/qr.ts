// The pairing code as a QR code (src/pairlink.ts): drawn under the code on "Show a code", and read by the
// camera on a phone ("Scan the code", shown when the core says it can: Tandem on Android, through nodeapk).
// Reading uses the page's own BarcodeDetector (Android's WebView has it), so no decoder is bundled.

import { toString as qrSvg } from "qrcode";

/**
 * An image that fills itself with the QR code of `text`. An <img>, not inline SVG: the page styles every svg
 * as a line icon (round, thick strokes), which smears a QR code drawn with strokes.
 */
export function qrCode(text: string): HTMLElement {
  const img = document.createElement("img");
  img.className = "qr";
  img.alt = "";
  void qrSvg(text, { type: "svg", margin: 2, errorCorrectionLevel: "M" }).then((svg) => {
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  return img;
}

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

/**
 * Open the camera full screen and resolve with the first QR code's text, or null when cancelled. Rejects
 * when there is no camera or it was refused.
 */
export async function scanQr(help: string, cancel: string): Promise<string | null> {
  const Ctor = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => Detector })
    .BarcodeDetector;
  if (!Ctor || !navigator.mediaDevices) throw new Error("no QR reader here");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  });
  const detector = new Ctor({ formats: ["qr_code"] });

  const overlay = document.createElement("div");
  overlay.className = "scanner";
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  const note = document.createElement("p");
  note.textContent = help;
  const button = document.createElement("button");
  button.textContent = cancel;
  overlay.append(video, note, button);
  document.body.append(overlay);

  return new Promise((resolve) => {
    let done = false;
    const finish = (text: string | null) => {
      if (done) return;
      done = true;
      for (const track of stream.getTracks()) track.stop();
      overlay.remove();
      resolve(text);
    };
    button.onclick = () => finish(null);
    const look = async () => {
      if (done) return;
      try {
        const [found] = video.readyState >= 2 ? await detector.detect(video) : [];
        if (found) return finish(found.rawValue);
      } catch {
        /* a frame it couldn't read: try the next one */
      }
      setTimeout(() => void look(), 200);
    };
    void video.play().then(look);
  });
}
