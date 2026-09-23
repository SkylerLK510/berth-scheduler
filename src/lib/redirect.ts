// Where to send someone after signing in. Only paths on this site: anything that could
// resolve to another host ("//evil", "/\\evil", "/<tab>/evil", "https://evil") becomes "/".

const BASE = "https://berth-scheduler.invalid";

export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  // Browsers strip tabs and newlines and treat "\" like "/", which is how "/\t/evil.example"
  // turns into "//evil.example". Refuse control characters and backslashes outright.
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return "/";
  }
  // Removing dot segments can turn a local path into a protocol-relative URL when
  // the pathname is passed to the router again (e.g. /a/..//another-host).
  if (url.origin !== BASE || url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
