import { describe, expect, it } from "vitest";
import { remoteToWebUrl } from "../git-remote";

const aliases: Record<string, string> = { "thedn-openlab": "github.com", work: "gitlab.com" };
const resolve = async (host: string) => aliases[host] ?? host;

describe("remoteToWebUrl", () => {
  it("keeps an https remote, minus .git", async () => {
    expect(await remoteToWebUrl("https://github.com/o/r.git", resolve)).toBe("https://github.com/o/r");
  });

  it("converts a plain scp-like SSH remote", async () => {
    expect(await remoteToWebUrl("git@github.com:o/r.git", resolve)).toBe("https://github.com/o/r");
  });

  it("maps an ~/.ssh/config alias to its real host", async () => {
    expect(await remoteToWebUrl("git@thedn-openlab:vnopenlab/chorus-shortdrama.git", resolve)).toBe(
      "https://github.com/vnopenlab/chorus-shortdrama",
    );
  });

  it("handles an alias without a user", async () => {
    expect(await remoteToWebUrl("work:group/sub/r.git", resolve)).toBe("https://gitlab.com/group/sub/r");
  });

  it("handles ssh:// URLs with a port", async () => {
    expect(await remoteToWebUrl("ssh://git@work:2222/o/r.git", resolve)).toBe("https://gitlab.com/o/r");
  });

  it("falls back to the written host when resolving fails", async () => {
    const failing = async () => {
      throw new Error("no ssh");
    };
    expect(await remoteToWebUrl("git@thedn-openlab:o/r.git", failing)).toBe("https://thedn-openlab/o/r");
  });

  it("returns null for a local path or unknown scheme", async () => {
    expect(await remoteToWebUrl("/srv/git/r.git", resolve)).toBeNull();
    expect(await remoteToWebUrl("file:///srv/git/r.git", resolve)).toBeNull();
  });
});
