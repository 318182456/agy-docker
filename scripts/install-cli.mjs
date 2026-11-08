import { createHash } from "node:crypto";
import { rootCertificates } from "node:tls";
import { writeFile, mkdir, readFile } from "node:fs/promises";
const version = "1.5.3";
const digests = {
  x64: "1b4850599cce73a17f94ffb422df3bf9531531b77dbddc40c1a435e0c2c16807",
  arm64: "2d50060c7b1327995e5c81ec58829c91c2564ebb9fec165d3f9f1325ec188675",
};
if (!digests[process.arch]) throw Error("Unsupported architecture");
const assetIds = { x64: 720124204, arm64: 720124206 };
const url = `https://api.github.com/repos/google-antigravity/antigravity-cli/releases/assets/${assetIds[process.arch]}`;
const sizes = { x64: 73694700, arm64: 69843447 };
let archive;
try {
  archive = await readFile("/build-context/.agy-offline.tgz");
  console.log("Using supplied official CLI archive");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const direct = `https://github.com/google-antigravity/antigravity-cli/releases/download/${version}/agy_cli_linux_${process.arch}.tar.gz`;
  let downloadUrl, lastError;
  for (let attempt = 0; attempt < 3 && !downloadUrl; attempt++) {
    for (const endpoint of [direct, url]) {
      try {
        const metadata = await fetch(endpoint, {
          headers: {
            accept: "application/octet-stream",
            "user-agent": "agy-docker",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
        });
        const location = metadata.headers.get("location");
        await metadata.body?.cancel();
        if (metadata.status !== 302 || !location)
          throw Error("Official CLI endpoint HTTP " + metadata.status);
        const target = new URL(location);
        if (
          target.protocol !== "https:" ||
          target.hostname !== "release-assets.githubusercontent.com"
        )
          throw Error("Unexpected official asset host");
        downloadUrl = target.href;
        break;
      } catch (error) {
        lastError = error;
        console.log(error.message);
      }
    }
  }
  if (!downloadUrl) throw lastError;
  const size = sizes[process.arch],
    count = 32,
    span = Math.ceil(size / count),
    parts = new Array(count);
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < count) {
        const i = next++,
          start = i * span,
          end = Math.min(size - 1, start + span - 1);
        let part;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch(downloadUrl, {
              headers: { range: `bytes=${start}-${end}` },
              signal: AbortSignal.timeout(45000),
            });
            if (response.status !== 206) {
              await response.body?.cancel();
              throw Error("Range download HTTP " + response.status);
            }
            part = Buffer.from(await response.arrayBuffer());
            if (part.length !== end - start + 1)
              throw Error("Invalid download range length");
            break;
          } catch (error) {
            if (attempt === 2) throw error;
          }
        }
        parts[i] = part;
        console.log("Official CLI download part " + (i + 1) + "/" + count);
      }
    }),
  );
  archive = Buffer.concat(parts);
}

if (
  createHash("sha256").update(archive).digest("hex") !== digests[process.arch]
)
  throw Error("CLI SHA-256 mismatch");
await writeFile("/tmp/agy.tar.gz", archive);
await mkdir("/etc/ssl/certs", { recursive: true });
await writeFile(
  "/etc/ssl/certs/ca-certificates.crt",
  rootCertificates.join("\n") + "\n",
);
console.log("Official agy " + version + " SHA-256 verified");
