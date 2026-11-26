import { Octokit } from "octokit";
import type { AppConfig } from "../config.js";
import type { CollectContext, SourceAdapter, SourceItem } from "../types.js";
import { isStableVersion } from "../content-policy.js";

export class GithubRepositorySource implements SourceAdapter {
  readonly source: string;
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;

  constructor(
    private readonly config: Omit<AppConfig["sources"]["github"]["repositories"][number], "issue_include_labels" | "issue_exclude_labels" | "max_releases"> & {
      issue_include_labels?: string[];
      issue_exclude_labels?: string[];
      max_releases?: number;
    },
    token?: string,
    octokit?: Octokit,
  ) {
    this.octokit = octokit ?? new Octokit(token ? { auth: token } : {});
    const [owner, repo] = config.repository.split("/");
    if (!owner || !repo) throw new Error(`Invalid repository: ${config.repository}`);
    this.owner = owner;
    this.repo = repo;
    this.source = config.id;
    this.maxReleases = config.max_releases ?? 30;
    this.maxMergedPrs = config.max_merged_prs;
    this.maxIssues = config.max_issues;
    this.issueIncludeLabels = normalizedLabelSet(config.issue_include_labels);
    this.issueExcludeLabels = normalizedLabelSet(config.issue_exclude_labels);
  }

  private readonly maxReleases: number;
  private readonly maxMergedPrs: number;
  private readonly maxIssues: number;
  private readonly issueIncludeLabels: Set<string>;
  private readonly issueExcludeLabels: Set<string>;

  async collect(context: CollectContext): Promise<SourceItem[]> {
    const [releases, pullRequests, issues] = await Promise.all([
      this.config.releases ? this.collectReleases(context) : Promise.resolve([]),
      this.config.merged_prs ? this.collectMergedPullRequests(context) : Promise.resolve([]),
      this.config.issues ? this.collectIssues(context) : Promise.resolve([]),
    ]);
    return [...releases, ...pullRequests, ...issues];
  }

  async check(): Promise<void> {
    await Promise.all([
      this.octokit.rest.rateLimit.get(),
      this.octokit.rest.repos.get({ owner: this.owner, repo: this.repo }),
    ]);
  }

  private async collectReleases(context: CollectContext): Promise<SourceItem[]> {
    const response = await this.octokit.rest.repos.listReleases({ owner: this.owner, repo: this.repo, per_page: this.maxReleases });
    return response.data
      .filter((release) => !release.draft && (this.config.prereleases || isStableVersion({
        title: release.name || release.tag_name, url: release.html_url,
        metadata: { prerelease: release.prerelease, tagName: release.tag_name },
      })) && release.published_at && new Date(release.published_at) >= context.since)
      .map((release) => ({
        source: this.source,
        streamId: `${this.source}:release`,
        kind: "release" as const,
        externalId: String(release.id),
        title: release.name || release.tag_name,
        url: release.html_url,
        publishedAt: new Date(release.published_at!),
        ...(release.body ? { content: release.body.slice(0, 8_000) } : {}),
        metadata: { repository: this.config.repository, tagName: release.tag_name, prerelease: release.prerelease },
      }));
  }

  private async collectMergedPullRequests(context: CollectContext): Promise<SourceItem[]> {
    const items: SourceItem[] = [];
    for (let page = 1; page <= 5 && items.length < this.maxMergedPrs; page += 1) {
      const response = await this.octokit.rest.pulls.list({
        owner: this.owner,
        repo: this.repo,
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: 100,
        page,
      });
      if (response.data.length === 0) break;
      let reachedOldItems = false;
      for (const pull of response.data) {
        if (new Date(pull.updated_at) < context.since) reachedOldItems = true;
        if (!pull.merged_at || new Date(pull.merged_at) < context.since) continue;
        items.push({
          source: this.source,
          streamId: `${this.source}:pull_request`,
          kind: "pull_request",
          externalId: String(pull.id),
          title: pull.title,
          url: pull.html_url,
          publishedAt: new Date(pull.merged_at),
          ...(pull.body ? { content: pull.body.slice(0, 4_000) } : {}),
          metadata: {
            repository: this.config.repository,
            number: pull.number,
            author: pull.user?.login ?? null,
            labels: pull.labels.map((label) => (typeof label === "string" ? label : label.name)),
          },
        });
        if (items.length >= this.maxMergedPrs) break;
      }
      if (reachedOldItems || response.data.length < 100) break;
    }
    return items;
  }

  private async collectIssues(context: CollectContext): Promise<SourceItem[]> {
    const items: SourceItem[] = [];
    for (let page = 1; page <= 5 && items.length < this.maxIssues; page += 1) {
      const response = await this.octokit.rest.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: "all",
        sort: "updated",
        direction: "desc",
        since: context.since.toISOString(),
        per_page: 100,
        page,
      });
      if (response.data.length === 0) break;
      for (const issue of response.data) {
        if (issue.pull_request) continue;
        const labels = issue.labels
          .map((label) => typeof label === "string" ? label : label.name)
          .filter((label): label is string => Boolean(label));
        if (!this.matchesIssueLabels(labels)) continue;
        const events: Array<{ action: "opened" | "closed"; at: string | null }> = [
          { action: "opened", at: issue.created_at },
          { action: "closed", at: issue.closed_at },
        ];
        for (const event of events) {
          if (!event.at || new Date(event.at) < context.since || items.length >= this.maxIssues) continue;
          items.push({
            source: this.source,
            streamId: `${this.source}:issue`,
            kind: "issue",
            externalId: `issue:${issue.id}:${event.action}`,
            title: `${event.action === "opened" ? "Opened" : "Closed"} #${issue.number}: ${issue.title}`,
            url: issue.html_url,
            publishedAt: new Date(event.at),
            ...(issue.body ? { content: issue.body.slice(0, 4_000) } : {}),
            metadata: {
              repository: this.config.repository,
              number: issue.number,
              action: event.action,
              author: issue.user?.login ?? null,
              labels,
              comments: issue.comments,
            },
          });
        }
      }
      if (response.data.length < 100) break;
    }
    return items;
  }

  private matchesIssueLabels(labels: string[]): boolean {
    const normalized = normalizedLabelSet(labels);
    if ([...this.issueExcludeLabels].some((label) => normalized.has(label))) return false;
    return this.issueIncludeLabels.size === 0 || [...this.issueIncludeLabels].some((label) => normalized.has(label));
  }
}

function normalizedLabelSet(labels: readonly string[] | undefined): Set<string> {
  return new Set((labels ?? []).map((label) => label.trim().toLocaleLowerCase()).filter(Boolean));
}

export { GithubRepositorySource as CodexSource };
