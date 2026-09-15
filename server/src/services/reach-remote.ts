/**
 * The things worth tagging that are not on this machine.
 *
 * The mirror can only offer what exists as a file. A Jira issue and a pull
 * request are neither, and materialising every one of them would be a sync
 * problem nobody asked for — there are thousands, and they change without us.
 *
 * So the rule the picker follows is: **a local thing is tagged with a path, a
 * remote thing is tagged with the command that fetches it.** Picking a ticket
 * types `/reach-ticket ABC-123` rather than a path, and the fetch happens when
 * the message is sent — at which point `/reach-ticket` also writes the issue
 * into `.station/tickets/`, so the *second* mention of it is a path after all.
 *
 * Everything here is best effort and time-bounded: a picker that hangs because
 * Jira is slow is worse than a picker with one section missing.
 */
import { searchIssues } from "./jira";
import { githubConfig, listPulls } from "./gh";
import type { ReachAsset } from "./reach-assets";

/** Same shape as a local asset; only the `insert` differs in kind. */
export type RemoteSuggestion = ReachAsset;

const BUDGET_MS = 6_000;

/** Give up rather than make the picker wait on someone else's server. */
function bounded<T>(work: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), BUDGET_MS)),
  ]).catch(() => fallback);
}

export async function remoteSuggestions(): Promise<RemoteSuggestion[]> {
  const [issues, pulls] = await Promise.all([
    bounded(
      searchIssues(
        "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
        20,
      ),
      [],
    ),
    bounded(openPulls(), []),
  ]);

  return [
    ...issues.map((issue) => ({
      label: `${issue.key} ${issue.summary}`,
      kind: "ticket" as const,
      insert: `/reach-ticket ${issue.key}`,
      hint: issue.status,
    })),
    ...pulls,
  ];
}

/**
 * Open pull requests across the configured repos.
 *
 * Qualified with `owner/name#n` when there is more than one repo, because that
 * is the form `/reach-pr` needs to answer about the right one.
 */
async function openPulls(): Promise<RemoteSuggestion[]> {
  const repos = githubConfig().repos;
  if (repos.length === 0) return [];
  const out: RemoteSuggestion[] = [];

  for (const repo of repos.slice(0, 3)) {
    try {
      const { items } = await listPulls(repo, { state: "open" });
      for (const pr of items.slice(0, 10)) {
        out.push({
          label: `#${pr.number} ${pr.title}`,
          kind: "pr",
          insert: `/reach-pr ${repos.length > 1 ? `${repo}#${pr.number}` : pr.number}`,
          hint: repos.length > 1 ? repo : (pr.author ?? "open"),
        });
      }
    } catch {
      // One unreachable repo must not take the others' pull requests with it.
    }
  }
  return out;
}
