// bun shot.ts <url> <out.png> <profile dir>: headless Chrome screenshot once the page has loaded and its network has gone quiet.
const [url, out, profile] = process.argv.slice(2);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const deadline = Date.now() + 30000;

const chrome = Bun.spawn([CHROME, "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars", "--no-first-run", "--mute-audio",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,720", "about:blank"], { stdout: "ignore", stderr: "pipe" });

async function devtools(): Promise<string> {
  const reader = chrome.stderr.getReader();
  let text = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
    if (m) return m[1];
  }
  throw new Error("chrome didn't start");
}

try {
  const port = new URL(await devtools()).port;
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(pages.find((p: any) => p.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const waiting = new Map<number, (v: any) => void>();
  const inflight = new Set<string>();
  let loaded = false;
  let lastNet = Date.now();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id) return waiting.get(m.id)?.(m.result);
    if (m.method === "Page.loadEventFired") loaded = true;
    if (m.method === "Network.requestWillBeSent") inflight.add(m.params.requestId);
    if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") inflight.delete(m.params.requestId);
    if (m.method?.startsWith("Network.")) lastNet = Date.now();
    if (process.env.SHOT_DEBUG && /exceptionThrown|consoleAPICalled|loadingFailed/.test(m.method ?? "")) console.error(m.method, JSON.stringify(m.params).slice(0, 300));
  };
  const send = (method: string, params = {}) => new Promise<any>((r) => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send("Page.enable");
  await send("Network.enable");
  if (process.env.SHOT_DEBUG) await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  const quietFor = 1200;
  while (Date.now() < deadline - 3000 && !(loaded && inflight.size <= 1 && Date.now() - lastNet > quietFor)) await Bun.sleep(100);
  await Bun.sleep(1500);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await Bun.write(out, Buffer.from(data, "base64"));
  console.log(`bytes written to file ${out}`);
} finally {
  chrome.kill();
}
process.exit(0);
