import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const content =
  "PORT=18861\nBIND_ADDRESS=0.0.0.0\nADMIN_PASSWORD=" +
  randomBytes(32).toString("base64url") +
  "\nAPI_KEY=" +
  randomBytes(32).toString("base64url") +
  "\nTASK_TIMEOUT_SECONDS=180\nQUEUE_LIMIT=32\nIMAGE_TAG=0.1.0\nDATA_PATH=/volume1/docker/agy-data\nMAX_CONCURRENCY=1\nTRAEFIK_SUBDOMAIN=agy-docker\nTRAEFIK_CONTAINER_PORT=18861\n";
try {
  await writeFile(".env", content, { flag: "wx", mode: 0o600 });
  console.log(
    "已创建 .env；请在本机编辑器查看管理密码和 API 密钥。",
  );
} catch (e) {
  if (e.code === "EEXIST") console.log(".env 已存在，保留现有配置。");
  else throw e;
}
