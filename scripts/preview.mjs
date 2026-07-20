import { spawn } from "node:child_process";

const previewUrl = "http://127.0.0.1:4173/";
const shouldOpenBrowser = !process.argv.includes("--no-open");

const isPreviewRunning = async () => {
  try {
    const response = await fetch(previewUrl);
    return response.ok;
  } catch {
    return false;
  }
};

const waitForPreview = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await isPreviewRunning()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Preview did not start: ${previewUrl}`);
};

const openBrowser = () => {
  const commands = {
    darwin: ["open", [previewUrl]],
    linux: ["xdg-open", [previewUrl]],
    win32: ["cmd", ["/c", "start", "", previewUrl]],
  };
  const [command, args] = commands[process.platform] ?? commands.linux;
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
};

await import("./build.mjs");

if (await isPreviewRunning()) {
  console.log(`Preview refreshed: ${previewUrl}`);
} else {
  await import("./serve.mjs");
  await waitForPreview();
}

if (shouldOpenBrowser) openBrowser();
