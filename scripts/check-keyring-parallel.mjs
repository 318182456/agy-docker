import { spawn } from "node:child_process";
const children = [];
try {
  await Promise.all(
    Array.from(
      { length: 3 },
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ["scripts/check-keyring.mjs"], {
            stdio: "inherit",
          });
          children.push(child);
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0
              ? resolve()
              : reject(
                  Error("Parallel keyring self-test failed, exit=" + code),
                ),
          );
        }),
    ),
  );
  console.log("Three concurrent isolated keyring lifecycles: PASS");
} finally {
  for (const child of children)
    if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
}
