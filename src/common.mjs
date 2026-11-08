import { createHash, timingSafeEqual } from "node:crypto";
export class AppError extends Error {
  constructor(status, message, code = "request_failed") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function equalSecret(a, b) {
  return timingSafeEqual(
    createHash("sha256")
      .update(String(a || ""))
      .digest(),
    createHash("sha256")
      .update(String(b || ""))
      .digest(),
  );
}
export function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError(400, "请求必须是 JSON 对象");
  return value;
}
export function accountId(value) {
  if (typeof value !== "string" || !/^a_[a-f0-9]{16}$/.test(value))
    throw new AppError(400, "账号 ID 无效");
  return value;
}
export function modelId(value) {
  if (value == null || value === "") return "";
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)
  )
    throw new AppError(400, "模型名称无效");
  return value;
}
export function classifyFailure(text) {
  if (/violation of terms|TOS_VIOLATION|service has been disabled/i.test(text))
    return new AppError(
      403,
      "Google 已停用此账号的服务，请通过官方渠道申诉",
      "account_suspended",
    );
  if (
    /authentication required|not authenticated|sign.?in required|login required|please (?:log|sign) in/i.test(
      text,
    )
  )
    return new AppError(
      401,
      "此账号尚未登录或授权尚未完成，请在当前账号的“登录 agy”详情中完成官方授权",
      "login_required",
    );
  if (/429|quota.exhaust|rate.limit|resource.exhaust/i.test(text))
    return new AppError(
      429,
      "此账号当前限流或额度不足，请查看官方额度",
      "rate_limited",
    );
  return new AppError(
    502,
    "agy 未正常完成任务；请检查登录状态、模型权限和官方客户端",
    "cli_failed",
  );
}
