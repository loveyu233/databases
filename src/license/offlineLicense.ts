import * as crypto from "node:crypto";
import * as vscode from "vscode";

const PRODUCT_ID = "loveyu.loveyu-database-workbench";
const LICENSE_PREFIX = "DBW_PRO_V1";
const LICENSE_SECRET_KEY = "databaseWorkbench.proLicense";

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAsMI1YKULi4YTncO7SirLpGPfZG0oZCkYTs2Q83sT6eU=
-----END PUBLIC KEY-----`;

export type ProFeature = "ai" | "logs" | "schemaCompare";

export type LicensePayload = {
  schema: number;
  product: string;
  licenseId: string;
  email?: string;
  machine: string;
  plan: "pro";
  kind: "lifetime";
  features: string[];
  issuedAt: string;
  maxMajorVersion?: number;
};

type LicenseCheckResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; message: string };

const featureLabels: Record<ProFeature, string> = {
  ai: "AI 能力",
  logs: "操作日志能力",
  schemaCompare: "表结构对比能力",
};

export function registerOfflineLicenseCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("databaseWorkbench.showMachineCode", async () => {
      const machineCode = formatMachineCode(getMachineFingerprint());
      await vscode.env.clipboard.writeText(machineCode);
      vscode.window.showInformationMessage(`Database Workbench 机器码：${machineCode}，已复制到剪贴板。`);
      return machineCode;
    }),
    vscode.commands.registerCommand("databaseWorkbench.activatePro", async () => {
      const input = await vscode.window.showInputBox({
        title: "激活 Database Workbench Pro",
        prompt: "请输入作者发给你的离线许可证",
        ignoreFocusOut: true,
        password: true,
      });
      if (!input) {
        return false;
      }

      const licenseText = extractLicenseText(input);
      const result = checkLicense(licenseText, context);
      if (!result.ok) {
        vscode.window.showErrorMessage(`Pro 激活失败：${result.message}`);
        return false;
      }

      await context.secrets.store(LICENSE_SECRET_KEY, licenseText);
      vscode.window.showInformationMessage(`Pro 激活成功，许可证编号：${result.payload.licenseId}。`);
      return true;
    }),
    vscode.commands.registerCommand("databaseWorkbench.deactivateProForTesting", async () => {
      const confirmed = await vscode.window.showWarningMessage(
        "取消激活仅用于测试。确认后会删除本机保存的 Pro 许可证，插件会回到非激活状态。",
        { modal: true },
        "确认取消激活"
      );
      if (confirmed !== "确认取消激活") {
        return false;
      }

      await context.secrets.delete(LICENSE_SECRET_KEY);
      vscode.window.showInformationMessage("Database Workbench Pro 已取消激活，当前已回到非激活状态。");
      return true;
    }),
    vscode.commands.registerCommand("databaseWorkbench.showProStatus", async () => {
      const status = await getProStatus(context);
      if (!status.ok) {
        const action = await vscode.window.showInformationMessage(
          `Database Workbench Pro 未激活：${status.message}`,
          "显示机器码",
          "输入许可证"
        );
        if (action === "显示机器码") {
          await vscode.commands.executeCommand("databaseWorkbench.showMachineCode");
        }
        if (action === "输入许可证") {
          await vscode.commands.executeCommand("databaseWorkbench.activatePro");
        }
        return;
      }

      vscode.window.showInformationMessage(
        `Database Workbench Pro 已激活：${status.payload.licenseId}，功能：${status.payload.features.join(", ")}。`
      );
    }),
  ];
}

export function getMachineFingerprint(): string {
  return crypto
    .createHash("sha256")
    .update(`${PRODUCT_ID}:${vscode.env.machineId}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
}

export function formatMachineCode(machine: string): string {
  return normalizeMachineCode(machine).match(/.{1,4}/g)?.join("-") ?? normalizeMachineCode(machine);
}

export async function hasProFeature(context: vscode.ExtensionContext, feature: ProFeature): Promise<boolean> {
  const status = await getProStatus(context);
  return status.ok && hasFeature(status.payload, feature);
}

export async function requireProFeature(
  context: vscode.ExtensionContext,
  feature: ProFeature,
  featureName = featureLabels[feature]
): Promise<boolean> {
  if (await hasProFeature(context, feature)) {
    return true;
  }

  const machineCode = formatMachineCode(getMachineFingerprint());
  const action = await vscode.window.showWarningMessage(
    `${featureName} 是 Pro 功能。请付款后把机器码 ${machineCode} 发给作者，获取离线许可证后激活。`,
    "复制机器码",
    "输入许可证",
    "取消"
  );

  if (action === "复制机器码") {
    await vscode.env.clipboard.writeText(machineCode);
    vscode.window.showInformationMessage("机器码已复制到剪贴板。");
  }
  if (action === "输入许可证") {
    await vscode.commands.executeCommand("databaseWorkbench.activatePro");
    return hasProFeature(context, feature);
  }

  return false;
}

export async function getProStatus(context: vscode.ExtensionContext): Promise<LicenseCheckResult> {
  const licenseText = await context.secrets.get(LICENSE_SECRET_KEY);
  if (!licenseText) {
    return { ok: false, message: "尚未输入离线许可证" };
  }
  return checkLicense(licenseText, context);
}

function checkLicense(licenseText: string, context: vscode.ExtensionContext): LicenseCheckResult {
  try {
    const payload = verifyLicense(licenseText, getMachineFingerprint(), getExtensionMajorVersion(context));
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function verifyLicense(licenseText: string, currentMachine: string, currentMajorVersion: number): LicensePayload {
  const parts = extractLicenseText(licenseText).split(".");
  if (parts.length !== 3) {
    throw new Error("许可证格式不正确");
  }

  const [prefix, payloadPart, signaturePart] = parts;
  if (prefix !== LICENSE_PREFIX) {
    throw new Error("许可证前缀不正确");
  }

  const signatureValid = crypto.verify(
    null,
    Buffer.from(payloadPart, "utf8"),
    PUBLIC_KEY,
    fromBase64url(signaturePart)
  );
  if (!signatureValid) {
    throw new Error("许可证签名无效");
  }

  const payload = JSON.parse(fromBase64url(payloadPart).toString("utf8")) as LicensePayload;
  if (payload.schema !== 1) {
    throw new Error("许可证版本不支持");
  }
  if (payload.product !== PRODUCT_ID) {
    throw new Error("许可证不属于当前插件");
  }
  if (payload.plan !== "pro" || payload.kind !== "lifetime") {
    throw new Error("许可证类型不支持");
  }
  if (normalizeMachineCode(payload.machine) !== normalizeMachineCode(currentMachine)) {
    throw new Error(
      `许可证与当前机器不匹配。当前机器码：${formatMachineCode(currentMachine)}，许可证机器码：${formatMachineCode(String(payload.machine || ""))}`
    );
  }
  if (payload.maxMajorVersion && currentMajorVersion > payload.maxMajorVersion) {
    throw new Error("许可证不适用于当前插件大版本");
  }
  if (!Array.isArray(payload.features) || payload.features.length === 0) {
    throw new Error("许可证未包含可用功能");
  }

  return payload;
}

function hasFeature(payload: LicensePayload, feature: ProFeature): boolean {
  return payload.features.includes("pro") || payload.features.includes(feature);
}

function normalizeMachineCode(machine: string): string {
  return machine.replace(/[^0-9a-f]/gi, "").toUpperCase();
}

function extractLicenseText(input: string): string {
  const compact = input.replace(/\s+/g, "");
  const match = compact.match(new RegExp(`${LICENSE_PREFIX}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+`));
  return (match?.[0] ?? compact).trim();
}

function fromBase64url(input: string): Buffer {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, "=");
  return Buffer.from(padded, "base64");
}

function getExtensionMajorVersion(context: vscode.ExtensionContext): number {
  const version = String(context.extension.packageJSON.version || "1.0.0");
  return Number(version.split(".")[0] || "1") || 1;
}
