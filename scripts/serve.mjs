import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = new URL("../dist/", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
const port = 4173;
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  let filePath = normalize(join(root, pathname));

  if (!filePath.startsWith(normalize(root))) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) filePath = join(filePath, "index.html");
    await stat(filePath);
  } catch {
    filePath = join(root, "404.html");
    response.statusCode = 404;
  }

  response.setHeader("Content-Type", contentTypes[extname(filePath)] ?? "application/octet-stream");
  createReadStream(filePath).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Blog preview: http://127.0.0.1:${port}`);
});
