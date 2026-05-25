// System clipboard write. macOS uses `pbcopy`; other platforms fall back to
// OSC 52 (a terminal escape sequence supported by iTerm2, Kitty, Alacritty,
// WezTerm, modern xterm — but NOT macOS Terminal.app). The OSC 52 path also
// works through SSH if the local terminal allows it.
export async function writeClipboard(text: string): Promise<boolean> {
  if (process.platform === "darwin") {
    try {
      const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
      proc.stdin.write(text);
      await proc.stdin.end();
      const code = await proc.exited;
      return code === 0;
    } catch {
      // fall through to OSC 52
    }
  }
  try {
    const b64 = Buffer.from(text, "utf8").toString("base64");
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
    return true;
  } catch {
    return false;
  }
}
